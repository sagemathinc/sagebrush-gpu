"""The VM gate (DESIGN.md section 1.6; SEC's VM-mode rulings, Nov 25): what must hold inside a VM before it announces
itself to control (so before any boot token exists), and again just before the agent enrolls.  The launcher runs it as
root after locking the VM down (sshd masked, keys removed); the gate only checks, it changes nothing.

  ssh        ssh.service, sshd.service and ssh.socket each resolve, through systemd's unit search path (runtime and
             persistent; aliases followed, any other linked unit file counted as present), to a mask or to nothing;
             no sshd, sshd-session or sshd-auth runs; every user's authorized_keys and authorized_keys2 is absent or
             an empty regular file, reached without following any link and without crossing into another mount
             unless the image allowlist pins it; /etc/passwd rows are strict (7 fields, UTF-8, absolute homes)
  listeners  no socket at all on local port 22, TCP or UDP, any state; nothing listening or bound off loopback, IPv4
             or IPv6; on loopback only the image allowlist's exact {process, protocol, address, port}
  processes  every process (kernel threads aside) runs an executable on the image allowlist
  secrets    no process's environment or command line holds a credential shape (a closed list), or a known value (the
             launch nonce; after issuance, the boot token), matched by digest so the value itself never reaches the gate
  provider   no provider guest agent: no hyperstack-agent unit, user, process or install directory
  imds       nothing answers on the link-local metadata address and no config drive is attached: until the provider's
             exact contents are reviewed, any answer fails closed

The image allowlist is data, reviewed per image.  Known values come on stdin as JSON, {"known": [{"sha256", "bytes"}]}:
digests and lengths only.  Every read is bounded; anything unreadable, malformed or vanishing fails the gate unless the
process demonstrably exited, and the process listing is repeated until it is stable, so a process born during the scan
is scanned too.  The gate's whole work is bounded too, not only each file: processes scanned, directory entries
(enumerated one by one), fds, and bytes hashed; each is charged before the work, and running out fails the gate
("gate-budget"), it never skips the rest and passes.  Environments and command lines are checked as they are read
and only the words kept.  The gate prints one line, `SBGPU-GATE {"v":1,"pass":bool,"fail":[...]}`, failures from a fixed
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
    "provider-agent", "imds", "config-drive", "gate-budget", "mount-crossing", "unreadable",
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
KNOWN_BYTES_MAX = 64             # (a known value's length: the nonce is 22 bytes, the boot token 43)

# ---- systemd's unit search path, highest priority first (runtime and persistent; systemd.unit(5))
UNIT_PATH = (
    "etc/systemd/system.control", "run/systemd/system.control", "run/systemd/transient", "run/systemd/generator.early",
    "etc/systemd/system", "etc/systemd/system.attached", "run/systemd/system", "run/systemd/system.attached",
    "run/systemd/generator", "usr/local/lib/systemd/system", "lib/systemd/system", "usr/lib/systemd/system",
    "run/systemd/generator.late",
)
SSH_UNITS = ("ssh.service", "sshd.service", "ssh.socket")
SSHD_NAMES = ("sshd", "sshd-session", "sshd-auth")  # (OpenSSH 9.8+ splits sshd into these: any of them is sshd)
PROVIDER_AGENTS = ("hyperstack-agent",)
PROVIDER_DIRS = ("opt/hyperstack-agent",)
PF_KTHREAD = 0x00200000
IMDS_ADDRESS = ("169.254.169.254", 80)
IMDS_TIMEOUT_S = 2.0
CONFIG_DRIVE_LABELS = ("config-2", "CONFIG-2", "cidata", "CIDATA")
NO_HOMES_UNDER = ("/proc", "/sys", "/dev", "/run")
MOUNTINFO_MAX = 1024 * 1024

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
        chunks, got = [], 0
        while got <= limit:  # (until EOF: a short read is not the end; one byte past the limit is enough to refuse)
            chunk = os.read(fd, limit + 1 - got)
            if not chunk:
                break
            chunks.append(chunk)
            got += len(chunk)
        data = b"".join(chunks)
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
            # (an alias names another unit: bare, in the same directory, or by an absolute path inside the search
            # path.  Any other link is a linked unit file systemd loads from wherever it points: present.)
            alias = os.path.basename(target)
            inside = "/" not in target or any(target == "/" + d + "/" + alias for d in UNIT_PATH)
            if inside and alias != name and alias.endswith(name[name.rindex("."):]) and depth < 4:
                return unit_state(root, alias, depth + 1)
        return "present"
    return "absent"


def _homes(root):
    """Every home in a bounded, regular /etc/passwd, plus /root: absolute, normalized and not under a virtual tree."""
    data = _read_bounded(os.path.join(root, "etc/passwd"), PASSWD_MAX)
    homes = {"/root"}
    for line in data.split(b"\n"):
        if not line:
            continue
        parts = line.split(b":")
        if len(parts) != 7:
            raise Unreadable("passwd row")  # (a malformed row is refused, never skipped)
        try:
            home = parts[5].decode("utf-8", "strict")
        except UnicodeDecodeError:
            raise Unreadable("passwd home")
        if not home.startswith("/") or os.path.normpath(home) != home or "\x00" in home:
            raise Unreadable("passwd home")
        homes.add(home)
    return sorted(h for h in homes if not any(h == v or h.startswith(v + "/") for v in NO_HOMES_UNDER))


def mount_points(proc="/proc"):
    """Every mount point in the gate's own mount namespace (/proc/self/mountinfo, bounded; a malformed line is
    Unreadable), as paths."""
    data = _read_bounded(os.path.join(proc, "self", "mountinfo"), MOUNTINFO_MAX, regular=False)
    out = set()
    for line in data.split(b"\n"):
        if not line:
            continue
        fields = line.split(b" ")
        if len(fields) < 10 or b"-" not in fields[6:]:
            raise Unreadable("mountinfo")
        try:
            point = re.sub(rb"\\([0-7]{3})", lambda m: bytes([int(m.group(1), 8)]), fields[4]).decode("utf-8", "strict")
        except UnicodeDecodeError:
            raise Unreadable("mountinfo")
        if not point.startswith("/"):
            raise Unreadable("mountinfo")
        out.add(point)
    return out


def _keys_state(root, home, mounts, pinned):
    """"ok" (absent or empty regular files), "keys", or "mount": each component of home/.ssh is opened without
    following any link, and the walk refuses to cross into another mount (a mount point at a component or at a key
    file, or a device change from the directory before) unless the image allowlist pins that exact path."""
    fds = []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        fds.append(fd)
        dev = os.fstat(fd).st_dev
        path = ""
        for part in [p for p in home.split("/") if p] + [".ssh"]:
            path += "/" + part
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
            here = os.fstat(fd).st_dev
            if path not in pinned and (path in mounts or here != dev):
                return "mount"
            dev = here
        for name in ("authorized_keys", "authorized_keys2"):
            try:
                st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if path + "/" + name not in pinned and (path + "/" + name in mounts or st.st_dev != dev):
                return "mount"  # (a key file mounted over, a bind mount on the same device included)
            if not stat.S_ISREG(st.st_mode) or st.st_size != 0:
                return "keys"
        return "ok"
    finally:
        for f in fds:
            os.close(f)


def check_ssh(root, procs, proc="/proc", pinned=()):
    out = set()
    for unit in SSH_UNITS:
        if unit_state(root, unit) == "present":
            out.add("ssh-unit")
    for p in procs.values():
        if p["comm"] in SSHD_NAMES or os.path.basename(p["exe"]) in SSHD_NAMES:
            out.add("ssh-running")
    mounts = mount_points(proc)
    for home in _homes(root):
        state = _keys_state(root, home, mounts, set(pinned))
        if state == "keys":
            out.add("authorized-keys")
        elif state == "mount":
            out.add("mount-crossing")
    return out


# ---- the gate's work budget: every count is charged before the work it pays for, and running out fails the gate
MAX_PROCS = 8192                 # (entries a /proc listing may hold, and processes scanned in all)
MAX_FDS = 4096                   # (fd entries per process)
MAX_FDS_TOTAL = 262144           # (fd entries across all processes)
MAX_HASH_BYTES = 256 * 1024 * 1024  # (bytes hashed in all, looking for known values)
UNIT_DIR_MAX = 4096              # (entries in each unit directory)
LABELS_MAX = 256                 # (entries in /dev/disk/by-label)


class OverBudget(Exception):
    """The gate's work budget ran out: it fails ("gate-budget"), it never skips the rest and passes."""


class Budget:
    def __init__(self):
        self.procs = 0
        self.fds = 0
        self.hashed = 0

    def proc(self):
        self.procs += 1
        if self.procs > MAX_PROCS:
            raise OverBudget("processes")

    def fd(self):
        self.fds += 1
        if self.fds > MAX_FDS_TOTAL:
            raise OverBudget("fds")

    def hash(self, n):
        self.hashed += n
        if self.hashed > MAX_HASH_BYTES:
            raise OverBudget("hashing")


def _entries(path, limit):
    """A directory's entry names, enumerated one by one and refused past `limit` (never a whole listing first)."""
    names = []
    with os.scandir(path) as it:
        for e in it:
            names.append(e.name)
            if len(names) > limit:
                raise OverBudget(path)
    return names


# ---- secrets in environments and command lines
def _by_length(known):
    """The known digests grouped by length: {bytes: set of sha256 hex}."""
    out = {}
    for k in known:
        out.setdefault(k["bytes"], set()).add(k["sha256"])
    return out


def _matches_known(data, by_len, budget):
    """Whether any window of data, of a known length within a base64url run, has a known sha256 for that length.
    Each window is hashed once whatever the number of digests, and its bytes are charged before it is hashed."""
    for n, digests in by_len.items():
        for m in re.finditer(_B64URL_RUN + b"{%d,}" % n, data):
            s = m.group(0)
            windows = len(s) - n + 1
            budget.hash(windows * n)
            for i in range(windows):
                if hashlib.sha256(s[i:i + n]).hexdigest() in digests:
                    return True
    return False


def _secrets(data, by_len, budget):
    """The secrets words for one environ or cmdline."""
    out = set()
    if any(r.search(data) for r in CREDENTIAL_SHAPES):
        out.add("credential-shape")
    if by_len and _matches_known(data, by_len, budget):
        out.add("known-value")
    return out


def check_secrets(procs, known=None):
    """The words found while the processes were scanned (each environ and cmdline is checked as it is read, and only
    these words are kept, never the bytes)."""
    out = set()
    for p in procs.values():
        out |= p["secrets"]
    return out


# ---- processes
def _one(proc, pid, by_len, budget):
    """A process's facts (its environ and cmdline checked on the spot, only the words kept), or None if it
    demonstrably exited; Unreadable otherwise."""
    base = os.path.join(proc, str(pid))
    try:
        st = _read_bounded(os.path.join(base, "stat"), STAT_MAX, regular=False)
        fields = st[st.rfind(b")") + 2:].split()
        if int(fields[6]) & PF_KTHREAD:
            return {"kthread": True}
        comm = _read_bounded(os.path.join(base, "comm"), COMM_MAX, regular=False).strip().decode("utf-8", "replace")
        exe = os.readlink(os.path.join(base, "exe"))
        secrets = set()
        for name in ("environ", "cmdline"):
            secrets |= _secrets(_read_bounded(os.path.join(base, name), ARGS_MAX, regular=False), by_len, budget)
        socks = set()
        for fd in _entries(os.path.join(base, "fd"), MAX_FDS):
            budget.fd()
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
    return {"kthread": False, "comm": comm, "exe": exe, "secrets": secrets, "sockets": socks}


def _pids(proc):
    return {int(n) for n in _entries(proc, MAX_PROCS + 512) if n.isdigit()}


def processes(proc="/proc", self_pid=None, known=(), budget=None):
    """Every user-space process but the gate itself: {pid: facts}.  The listing is repeated until no new process
    appears (at most PROC_SCANS times; still changing is Churn).  Every process scanned is charged to the budget
    before it is read; running out raises OverBudget."""
    self_pid = os.getpid() if self_pid is None else self_pid
    budget = budget or Budget()
    by_len = _by_length(known)
    out = {}
    seen = set()
    for _ in range(PROC_SCANS):
        new = _pids(proc) - seen - {self_pid}
        if not new:
            return {pid: p for pid, p in out.items() if not p["kthread"]}
        for pid in sorted(new):
            budget.proc()
            p = _one(proc, pid, by_len, budget)
            seen.add(pid)
            if p is not None:
                out[pid] = p
    raise Churn()


class Churn(Exception):
    """Processes kept appearing across PROC_SCANS listings."""


def check_processes(procs, allow):
    allowed = set(allow["processes"])
    return {"process"} if any(p["exe"] not in allowed for p in procs.values()) else set()


# ---- listeners
def sockets(proc="/proc"):
    """Every listening TCP socket, every unconnected bound UDP socket, and every socket of any kind on local port 22:
    [(proto, ip, port, inode)]."""
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
            if int(lport, 16) == 22:
                found.append((proto, _addr(lip), 22, int(inode)))  # (local port 22 in any state, client or not)
                continue
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
    for d in UNIT_PATH:
        try:
            names = _entries(os.path.join(root, d), UNIT_DIR_MAX)
        except FileNotFoundError:
            continue
        except OSError:
            raise Unreadable(d)
        for agent in PROVIDER_AGENTS:
            if any(n == agent or n.startswith(agent + ".") or n.startswith(agent + "@") for n in names):
                out.add("provider-agent")
    for agent in PROVIDER_AGENTS:
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
        names = _entries(os.path.join(root, "dev/disk/by-label"), LABELS_MAX)
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
          and isinstance(allow.get("mounts"), list)
          and all(isinstance(m, str) and m.startswith("/") and m != "/" and os.path.normpath(m) == m for m in allow["mounts"])
          and isinstance(allow.get("loopback"), list)
          and all(isinstance(a, dict) and set(a) == {"process", "proto", "address", "port"} and a["proto"] in ("tcp", "udp")
                  and _loopback(str(a["address"])) and type(a["port"]) is int and 0 < a["port"] < 65536 and a["port"] != 22
                  for a in allow["loopback"]))
    if not ok:
        raise ValueError("not an image allowlist")
    return allow


def load_known(data):
    """The known values' digests: {"known": [{"sha256": 64 hex, "bytes": 16..KNOWN_BYTES_MAX}]}, at most KNOWN_MAX (the
    launch nonce is 22 bytes and the boot token 43)."""
    obj = json.loads(data) if data.strip() else {"known": []}
    known = obj.get("known") if isinstance(obj, dict) and set(obj) == {"known"} else None
    if not (isinstance(known, list) and len(known) <= KNOWN_MAX and all(
            isinstance(k, dict) and set(k) == {"sha256", "bytes"} and isinstance(k["sha256"], str)
            and re.fullmatch(r"[0-9a-f]{64}", k["sha256"]) and type(k["bytes"]) is int and 16 <= k["bytes"] <= KNOWN_BYTES_MAX
            for k in known)):
        raise ValueError("not a list of known values")
    return known


# ---- the gate
def run(allow, known=(), root="/", proc="/proc", connect=None, self_pid=None):
    """(pass, sorted failure words)."""
    fails = set()
    try:
        procs = processes(proc, self_pid, known)
    except OverBudget:
        procs = None
        fails.add("gate-budget")
    except Churn:
        procs = None
        fails.add("process-churn")
    except (Unreadable, OSError):
        procs = None
        fails.add("unreadable")
    checks = [lambda: check_imds(connect), lambda: check_config_drive(root)]
    if procs is not None:
        checks = [lambda: check_ssh(root, procs, proc, allow["mounts"]), lambda: check_processes(procs, allow),
                  lambda: check_secrets(procs, known), lambda: check_listeners(sockets(proc), procs, allow),
                  lambda: check_provider(root, procs)] + checks
    else:
        fails.add("process")  # (without a complete process scan nothing below it can pass)
    for check in checks:
        try:
            fails |= check()
        except OverBudget:
            fails.add("gate-budget")
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
