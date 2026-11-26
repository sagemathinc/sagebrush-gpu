"""The agent's checks before any access (DESIGN.md section 1.4): that the provider's injected API key can't have
reached anything the member will run.  The launcher replaced the environment; these checks confirm it, from the
agent itself, before enroll.  Any failed or uncertain check means abort: no relay, terminal, Jupyter or setup.

The agent never sees the key's value (the launcher's exec dropped it), so it checks names and places only.  Searching
for the value itself is the paid probe's job (section 1.5).

It also checks that nobody can get in over ssh (SEC's ruling for the container path): no sshd process, no socket on
local port 22, and no authorized_keys or authorized_keys2 with anything in it under any passwd home, walked as the VM
gate walks them (vmgate.check_keys: no link followed, no mount crossed)."""

import os

from sbgpu_agent import vmgate

# The agent's environment is exactly ENV_FIXED plus any of ENV_COPY_ALLOWLIST (bootstrap.sh; boot.ts has the same
# lists, and a test checks all three agree).
ENV_FIXED = ("PATH", "HOME", "LANG", "SBGPU_PREFIX")
ENV_COPY_ALLOWLIST = (
    "LD_LIBRARY_PATH",
    "CUDA_HOME",
    "CUDA_VERSION",
    "NVIDIA_VISIBLE_DEVICES",
    "NVIDIA_DRIVER_CAPABILITIES",
    "NVIDIA_REQUIRE_CUDA",
    "NV_CUDA_LIB_VERSION",
    "PYTORCH_VERSION",
    "TZ",
)
KEY_NAME = b"RUNPOD_API_KEY"
# Files that must not exist at all (RunPod's start script dumps the whole environment there).
FORBIDDEN_FILES = ("/etc/rp_environment",)
# Files (and directories of files) that may exist but must not mention the key.
SCANNED_FILES = ("/etc/environment", "/root/.bashrc", "/root/.profile", "/etc/bash.bashrc", "/etc/profile")
SCANNED_DIRS = ("/etc/profile.d",)
SCAN_MAX = 1024 * 1024  # bytes read per file; a bigger file is a failed check (doubt)

# Reasons the control plane accepts at abort: a fixed list, never free text from the machine.
REASONS = ("env-not-clean", "extra-process", "key-file", "ssh-access", "other")
COMM_MAX = 64  # (a comm is at most 16 bytes; more is a malformed /proc)


def _env_names(environ_bytes):
    names = []
    for entry in environ_bytes.split(b"\0"):
        if entry:
            names.append(entry.split(b"=", 1)[0].decode("utf-8", "replace"))
    return names


def check_env(proc, pid):
    """The process's own environment, as the kernel shows it: every fixed name, and nothing outside the lists."""
    with open("%s/%d/environ" % (proc, pid), "rb") as f:
        names = _env_names(f.read(SCAN_MAX + 1))
    allowed = set(ENV_FIXED) | set(ENV_COPY_ALLOWLIST)
    if len(names) != len(set(names)):
        return False
    return set(ENV_FIXED) <= set(names) and set(names) <= allowed


def check_processes(proc, pid, container):
    """In container mode the agent is PID 1 and the only process (the launcher left nothing behind)."""
    if container and pid != 1:
        return False
    others = [d for d in os.listdir(proc) if d.isdigit() and int(d) != pid]
    return not others


def _scan(path):
    """True when the file is absent, or present, readable, small enough and without the key's name."""
    try:
        with open(path, "rb") as f:
            data = f.read(SCAN_MAX + 1)
    except FileNotFoundError:
        return True
    if len(data) > SCAN_MAX:
        return False
    return KEY_NAME not in data


def check_files(root):
    for path in FORBIDDEN_FILES:
        if os.path.lexists(root + path):
            return False
    for path in SCANNED_FILES:
        if not _scan(root + path):
            return False
    for d in SCANNED_DIRS:
        try:
            entries = sorted(os.listdir(root + d))
        except FileNotFoundError:
            continue
        for name in entries:
            p = root + d + "/" + name
            if os.path.isfile(p) and not _scan(p):
                return False
    return True


def _named(proc, pid):
    """Every other process's name and executable, {pid: {"comm", "exe"}}.  A process that exits while it is read is
    skipped; anything else unreadable raises (the check fails closed)."""
    out = {}
    for d in sorted(os.listdir(proc)):
        if not d.isdigit() or int(d) == pid:
            continue
        try:
            with open("%s/%s/comm" % (proc, d), "rb") as f:
                comm = f.read(COMM_MAX + 1)
        except FileNotFoundError:
            continue  # (it exited)
        if len(comm) > COMM_MAX:
            raise ValueError("comm")
        try:
            exe = os.readlink("%s/%s/exe" % (proc, d))
        except FileNotFoundError:
            exe = ""  # (exited, or a process without an executable)
        out[int(d)] = {"comm": comm.decode("utf-8", "replace").rstrip("\n"), "exe": exe}
    return out


def check_ssh(proc, root, pid):
    """No way in over ssh: no sshd (sshd, sshd-session or sshd-auth, by name or executable), no socket of any kind on
    local port 22, and every passwd home's authorized_keys and authorized_keys2 absent or an empty regular file."""
    if vmgate.sshd_running(_named(proc, pid)):
        return False
    if any(port == 22 for _, _, port, _ in vmgate.sockets(proc)):
        return False
    return not vmgate.check_keys(root or "/", proc)


CHECKS = (
    ("env", "env-not-clean"),
    ("processes", "extra-process"),
    ("files", "key-file"),
    ("ssh", "ssh-access"),
)


def run_checks(proc="/proc", root="", pid=None, container=True):
    """Every check, each one failing closed on any error.  Returns (report, reason): report is the enroll's
    `eradication` field, and reason is None when everything passed, else the first failed check's REASONS entry."""
    pid = os.getpid() if pid is None else pid
    fns = {
        "env": lambda: check_env(proc, pid),
        "processes": lambda: check_processes(proc, pid, container),
        "files": lambda: check_files(root),
        "ssh": lambda: check_ssh(proc, root, pid),
    }
    results = []
    reason = None
    for name, why in CHECKS:
        try:
            ok = fns[name]() is True
        except Exception:
            ok = False
        results.append({"name": name, "ok": ok})
        if not ok and reason is None:
            reason = why
    return {"ok": reason is None, "checks": results}, reason
