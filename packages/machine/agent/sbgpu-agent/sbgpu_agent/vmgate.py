"""The VM gate (DESIGN.md section 1.6; SEC's VM-mode rulings, Nov 25): what must hold inside a VM before it announces
itself to control (so before any boot token exists), and again just before the agent enrolls.  The launcher runs it as
root after locking the VM down (sshd masked, keys removed); the gate only checks, it changes nothing.

  ssh        ssh.service, sshd.service and ssh.socket each resolve, through systemd's unit search path (runtime and
             persistent, following aliases), to a mask or to nothing; no sshd runs; every user's authorized_keys and
             authorized_keys2 is absent or an empty regular file, reached without following any link
  listeners  nothing listening or bound on port 22, on any address; nothing listening or bound off loopback, IPv4 or
             IPv6, TCP or UDP; on loopback only the image allowlist's exact {process, protocol, address, port}
  processes  every process (kernel threads aside) runs an executable on the image allowlist
  secrets    no process's environment or command line holds a credential shape (a closed list), or a known value (the
             launch nonce; after issuance, the boot token), matched by digest so the value itself never reaches the gate
  provider   no provider guest agent: no hyperstack-agent unit, user, process or install directory
  imds       nothing answers on the link-local metadata address and no config drive is attached: until the provider's
             exact contents are reviewed, any answer fails closed

The image allowlist is data, reviewed per image.  Known values come on stdin as JSON, {"known": [{"sha256", "bytes"}]}:
digests and lengths only.  Every read is bounded; anything unreadable, malformed or vanishing fails the gate unless the
process demonstrably exited, and the process listing is repeated until it is stable, so a process born during the scan
is scanned too.  The gate prints one line, `SBGPU-GATE {"v":1,"pass":bool,"fail":[...]}`, failures from a fixed
vocabulary only (never a path, name, address or value), and exits 0 only when every check passed.
"""

import hashlib
import json
import os
import re
import socket
import stat
import sys

WORDS = (
    "ssh-unit", "ssh-running", "authorized-keys",
    "listener-22", "listener-public", "listener-loopback",
    "process", "process-churn", "credential-shape", "known-value",
    "provider-agent", "imds", "config-drive", "unreadable",
)

# ---- limits
PASSWD_MAX = 1024 * 1024
NET_MAX = 4 * 1024 * 1024        # (bytes read from each socket table)
STAT_MAX = 4096
COMM_MAX = 64
ARGS_MAX = 1024 * 1024           # (bytes of a process's environ or cmdline; more fails closed)
PROC_SCANS = 5                   # (listings until the set of processes is stable)
ALLOW_MAX = 256 * 1024
KNOWN_MAX = 16

# ---- systemd's unit search path, highest priority first (runtime and persistent; systemd.unit(5))
UNIT_PATH = (
    "etc/systemd/system.control", "run/systemd/system.control", "run/systemd/transient", "run/systemd/generator.early",
    "etc/systemd/system", "etc/systemd/system.attached", "run/systemd/system", "run/systemd/system.attached",
    "run/systemd/generator", "usr/local/lib/systemd/system", "lib/systemd/system", "usr/lib/systemd/system",
    "run/systemd/generator.late",
)
SSH_UNITS = ("ssh.service", "sshd.service", "ssh.socket")
PROVIDER_AGENTS = ("hyperstack-agent",)
PROVIDER_DIRS = ("opt/hyperstack-agent",)
PF_KTHREAD = 0x00200000
IMDS_ADDRESS = ("169.254.169.254", 80)
IMDS_TIMEOUT_S = 2.0
CONFIG_DRIVE_LABELS = ("config-2", "CONFIG-2", "cidata", "CIDATA")
NO_HOMES_UNDER = ("/proc", "/sys", "/dev", "/run")

# Credential shapes: a closed list, matched on raw environ/cmdline bytes.
CREDENTIAL_SHAPES = (
    re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(rb"\b(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) AAAA[0-9A-Za-z+/]{40,}"),
    re.compile(rb"\beyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}"),  # (a JWT)
    re.compile(rb"(?i)\bauthorization\s*[:=]\s*bearer\s+\S{16,}"),
    re.compile(rb"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
)
_B64URL_RUN = rb"[0-9A-Za-z_-]"

_ROW = re.compile(rb"\s*\d+:\s+([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})\s+([0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})\s+"
                  rb"([0-9A-F]{2})\s+[0-9A-F]{8}:[0-9A-F]{8}\s+[0-9A-F]{2}:[0-9A-F]{8}\s+[0-9A-F]{8}\s+\d+\s+\d+\s+(\d+)\s")
TCP_LISTEN = b"0A"
UDP_UNCONNECTED = b"07"


class Unreadable(Exception):
    """Something the gate must read and can't: the check fails closed."""


def _read_bounded(path, limit, dir_fd=None, regular=True):
    """At most `limit` bytes of a file opened without following a link (nor blocking on a special file); more than
    `limit` is Unreadable."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd)
    except FileNotFoundError:
        raise
    except OSError:
        raise Unreadable(path)
    try:
        if regular and not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Unreadable(path)
        data = os.read(fd, limit + 1)
    except OSError:
        raise Unreadable(path)
    finally:
        os.close(fd)
    if len(data) > limit:
        raise Unreadable(path)
    return data


# ---- addresses
def _addr(hexaddr):
    """A /proc/net address (32-bit words in host order: little-endian here) as an IP string."""
    raw = bytes.fromhex(hexaddr.decode("ascii"))
    words = b"".join(raw[i:i + 4][::-1] for i in range(0, len(raw), 4))
    return socket.inet_ntop(socket.AF_INET if len(words) == 4 else socket.AF_INET6, words)


def _loopback(ip):
    if ":" not in ip:
        return ip.startswith("127.")
    return ip == "::1" or ip.startswith("::ffff:127.")


# ---- ssh
def unit_state(root, name, depth=0):
    """How systemd resolves this unit name: "masked", "absent" or "present" (aliases followed, at most 4 deep)."""
    for d in UNIT_PATH:
        path = os.path.join(root, d, name)
        if not os.path.lexists(path):
            continue
        if os.path.islink(path):
            target = os.readlink(path)
            if target == "/dev/null":
                return "masked"
            alias = os.path.basename(target)
            if alias != name and depth < 4:
                return unit_state(root, alias, depth + 1)
        return "present"
    return "absent"


def _homes(root):
    """Every home in a bounded, regular /etc/passwd, plus /root: absolute, normalized and not under a virtual tree."""
    data = _read_bounded(os.path.join(root, "etc/passwd"), PASSWD_MAX)
    homes = {"/root"}
    for line in data.splitlines():
        parts = line.split(b":")
        if len(parts) < 7:
            continue
        home = parts[5].decode("utf-8", "replace")
        if not home.startswith("/") or os.path.normpath(home) != home:
            raise Unreadable("passwd home")
        homes.add(home)
    return sorted(h for h in homes if not any(h == v or h.startswith(v + "/") for v in NO_HOMES_UNDER))


def _keys_state(root, home):
    """"ok" (absent or empty regular files) or "keys", walking each component without following any link."""
    fds = []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        fds.append(fd)
        for part in [p for p in home.split("/") if p] + [".ssh"]:
            try:
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            except FileNotFoundError:
                return "ok"
            except NotADirectoryError:
                return "keys"  # (a component that isn't a directory, a link included: refused)
            except OSError as e:
                if e.errno == 40:  # (ELOOP: a link)
                    return "keys"
                raise Unreadable(home)
            fds.append(fd)
        for name in ("authorized_keys", "authorized_keys2"):
            try:
                st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(st.st_mode) or st.st_size != 0:
                return "keys"
        return "ok"
    finally:
        for f in fds:
            os.close(f)


def check_ssh(root, procs):
    out = set()
    for unit in SSH_UNITS:
        if unit_state(root, unit) == "present":
            out.add("ssh-unit")
    for p in procs.values():
        if p["comm"] == "sshd" or os.path.basename(p["exe"]) == "sshd":
            out.add("ssh-running")
    for home in _homes(root):
        if _keys_state(root, home) != "ok":
            out.add("authorized-keys")
    return out


# ---- processes
def _one(proc, pid):
    """A process's facts, or None if it demonstrably exited; Unreadable otherwise."""
    base = os.path.join(proc, str(pid))
    try:
        st = _read_bounded(os.path.join(base, "stat"), STAT_MAX, regular=False)
        fields = st[st.rfind(b")") + 2:].split()
        kthread = bool(int(fields[6]) & PF_KTHREAD)
        if kthread:
            return {"kthread": True}
        comm = _read_bounded(os.path.join(base, "comm"), COMM_MAX, regular=False).strip().decode("utf-8", "replace")
        exe = os.readlink(os.path.join(base, "exe"))
        environ = _read_bounded(os.path.join(base, "environ"), ARGS_MAX, regular=False)
        cmdline = _read_bounded(os.path.join(base, "cmdline"), ARGS_MAX, regular=False)
        socks = set()
        for fd in os.listdir(os.path.join(base, "fd")):
            try:
                m = re.fullmatch(r"socket:\[(\d+)\]", os.readlink(os.path.join(base, "fd", fd)))
            except FileNotFoundError:
                continue  # (that fd closed meanwhile)
            if m:
                socks.add(int(m.group(1)))
    except (OSError, Unreadable, ValueError, IndexError):
        if not os.path.exists(base):
            return None  # (exited)
        raise Unreadable(base)
    return {"kthread": False, "comm": comm, "exe": exe, "environ": environ, "cmdline": cmdline, "sockets": socks}


def _pids(proc):
    return {int(n) for n in os.listdir(proc) if n.isdigit()}


def processes(proc="/proc", self_pid=None):
    """Every user-space process but the gate itself: {pid: facts}.  The listing is repeated until no new process
    appears (at most PROC_SCANS times; still changing is Unreadable as "process-churn")."""
    self_pid = os.getpid() if self_pid is None else self_pid
    out = {}
    seen = set()
    for _ in range(PROC_SCANS):
        new = _pids(proc) - seen - {self_pid}
        if not new:
            return {pid: p for pid, p in out.items() if not p["kthread"]}
        for pid in sorted(new):
            p = _one(proc, pid)
            seen.add(pid)
            if p is not None:
                out[pid] = p
    raise Churn()


class Churn(Exception):
    """Processes kept appearing across PROC_SCANS listings."""


def check_processes(procs, allow):
    allowed = set(allow["processes"])
    return {"process"} if any(p["exe"] not in allowed for p in procs.values()) else set()


# ---- secrets in environments and command lines
def _matches_known(data, known):
    """Whether any window of data, of a known value's length within a base64url run, has its sha256."""
    for k in known:
        n = k["bytes"]
        for m in re.finditer(_B64URL_RUN + b"{%d,}" % n, data):
            s = m.group(0)
            for i in range(len(s) - n + 1):
                if hashlib.sha256(s[i:i + n]).hexdigest() == k["sha256"]:
                    return True
    return False


def check_secrets(procs, known):
    out = set()
    for p in procs.values():
        for data in (p["environ"], p["cmdline"]):
            if any(r.search(data) for r in CREDENTIAL_SHAPES):
                out.add("credential-shape")
            if known and _matches_known(data, known):
                out.add("known-value")
    return out


# ---- listeners
def sockets(proc="/proc"):
    """Every listening TCP socket and every unconnected bound UDP socket: [(proto, ip, port, inode)]."""
    found = []
    for proto, table, state in (("tcp", "tcp", TCP_LISTEN), ("tcp", "tcp6", TCP_LISTEN),
                                ("udp", "udp", UDP_UNCONNECTED), ("udp", "udp6", UDP_UNCONNECTED)):
        try:
            data = _read_bounded(os.path.join(proc, "net", table), NET_MAX, regular=False)
        except FileNotFoundError:
            raise Unreadable(table)
        rows = data.split(b"\n")
        if rows[0].split()[:1] != [b"sl"]:
            raise Unreadable(table)
        for row in rows[1:]:
            if not row.strip():
                continue
            m = _ROW.match(row)
            if not m:
                raise Unreadable(table)
            lip, lport, rip, rport, st, inode = m.groups()
            if st != state:
                continue  # (a connected UDP socket is 01, ESTABLISHED: a client, not a listener)
            found.append((proto, _addr(lip), int(lport, 16), int(inode)))
    return found


def check_listeners(found, procs, allow):
    out = set()
    owner = {}
    for p in procs.values():
        for inode in p["sockets"]:
            owner[inode] = p["exe"]
    allowed = {(a["process"], a["proto"], a["address"], int(a["port"])) for a in allow["loopback"]}
    for proto, ip, port, inode in found:
        if port == 22:
            out.add("listener-22")
        elif not _loopback(ip):
            out.add("listener-public")
        elif (owner.get(inode, ""), proto, ip, port) not in allowed:
            out.add("listener-loopback")  # (an unknown owner too: a socket whose process wasn't scanned fails)
    return out


# ---- provider agents
def check_provider(root, procs):
    out = set()
    data = _read_bounded(os.path.join(root, "etc/passwd"), PASSWD_MAX)
    users = {line.split(b":")[0] for line in data.splitlines()}
    for agent in PROVIDER_AGENTS:
        for d in UNIT_PATH:
            try:
                names = os.listdir(os.path.join(root, d))
            except FileNotFoundError:
                continue
            except OSError:
                raise Unreadable(d)
            if any(n == agent or n.startswith(agent + ".") or n.startswith(agent + "@") for n in names):
                out.add("provider-agent")
        if agent.encode() in users:
            out.add("provider-agent")
        for p in procs.values():
            if p["comm"] == agent[:15] or os.path.basename(p["exe"]) == agent:
                out.add("provider-agent")
    for d in PROVIDER_DIRS:
        if os.path.lexists(os.path.join(root, d)):
            out.add("provider-agent")
    return out


# ---- metadata service and config drive
def check_imds(connect=None):
    """Anything accepting a connection on the metadata address fails (fail closed until its exact contents are
    reviewed)."""
    connect = connect or (lambda: socket.create_connection(IMDS_ADDRESS, timeout=IMDS_TIMEOUT_S))
    try:
        s = connect()
    except OSError:
        return set()
    s.close()
    return {"imds"}


def check_config_drive(root):
    try:
        names = os.listdir(os.path.join(root, "dev/disk/by-label"))
    except FileNotFoundError:
        return set()
    except OSError:
        raise Unreadable("by-label")
    return {"config-drive"} if any(n in CONFIG_DRIVE_LABELS for n in names) else set()


# ---- inputs
def load_allowlist(path):
    allow = json.loads(_read_bounded(path, ALLOW_MAX))
    ok = (isinstance(allow, dict) and allow.get("v") == 1 and isinstance(allow.get("processes"), list)
          and all(isinstance(x, str) and x.startswith("/") for x in allow["processes"])
          and isinstance(allow.get("loopback"), list)
          and all(isinstance(a, dict) and set(a) == {"process", "proto", "address", "port"} and a["proto"] in ("tcp", "udp")
                  and _loopback(str(a["address"])) and type(a["port"]) is int and 0 < a["port"] < 65536 and a["port"] != 22
                  for a in allow["loopback"]))
    if not ok:
        raise ValueError("not an image allowlist")
    return allow


def load_known(data):
    """The known values' digests: {"known": [{"sha256": 64 hex, "bytes": 16..4096}]}, at most KNOWN_MAX."""
    obj = json.loads(data) if data.strip() else {"known": []}
    known = obj.get("known") if isinstance(obj, dict) and set(obj) == {"known"} else None
    if not (isinstance(known, list) and len(known) <= KNOWN_MAX and all(
            isinstance(k, dict) and set(k) == {"sha256", "bytes"} and isinstance(k["sha256"], str)
            and re.fullmatch(r"[0-9a-f]{64}", k["sha256"]) and type(k["bytes"]) is int and 16 <= k["bytes"] <= 4096
            for k in known)):
        raise ValueError("not a list of known values")
    return known


# ---- the gate
def run(allow, known=(), root="/", proc="/proc", connect=None, self_pid=None):
    """(pass, sorted failure words)."""
    fails = set()
    try:
        procs = processes(proc, self_pid)
    except Churn:
        procs = None
        fails.add("process-churn")
    except (Unreadable, OSError):
        procs = None
        fails.add("unreadable")
    checks = [lambda: check_imds(connect), lambda: check_config_drive(root)]
    if procs is not None:
        checks = [lambda: check_ssh(root, procs), lambda: check_processes(procs, allow),
                  lambda: check_secrets(procs, known), lambda: check_listeners(sockets(proc), procs, allow),
                  lambda: check_provider(root, procs)] + checks
    else:
        fails.add("process")  # (without a complete process scan nothing below it can pass)
    for check in checks:
        try:
            fails |= check()
        except (Unreadable, OSError, ValueError):
            fails.add("unreadable")
    words = sorted(w for w in fails if w in WORDS)
    return not words, words


def line(ok, words):
    return "SBGPU-GATE " + json.dumps({"v": 1, "pass": bool(ok), "fail": list(words)}, separators=(",", ":"))


def main(argv=None, stdin=None, stdout=None):
    argv = sys.argv[1:] if argv is None else argv
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    try:
        allow = load_allowlist(argv[0])
        known = load_known(stdin.read(64 * 1024))
    except (IndexError, OSError, ValueError, Unreadable):
        stdout.write(line(False, ["unreadable"]) + "\n")
        return 1
    ok, words = run(allow, known)
    stdout.write(line(ok, words) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
