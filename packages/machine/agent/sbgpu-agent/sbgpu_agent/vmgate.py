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
  provider   no provider guest agent: no hyperstack-agent unit, user, process or install directory; each agent the
             boot script neutralised (the image allowlist's list, e.g. grafana-agent) has every unit masked and no
             process, though its inert files may stay; a provider channel kept on purpose (reader (2), e.g. qemu-ga
             until it is shown safe to mask) is allowed only by exact executable under its own label
  logins     every password is locked (shadow and passwd fields); the sudo, admin and wheel groups have no member and
             no user's primary group is one of them, and every sudoers file matches the image allowlist by sha256;
             every console login unit (getty, serial-getty, autovt, console-getty, container-getty, instances
             included) is masked or absent and no agetty or login runs; no process runs as a uid >= 1000 (the
             provider's leftover sessions); no container runtime socket
  imds       our metadata reject rules are exactly in place (nft, both families), and a connection to every metadata
             address (IPv4, and IPv6 on each interface) fails at once with the reject's error: an answer, a timeout or
             any other error fails; no address or route reaches the metadata addresses outside those rules; no config
             drive is attached: until the provider's exact contents are reviewed, any of these fails closed

The image allowlist is data, reviewed per image.  Known values come on stdin as JSON, {"known": [{"sha256", "bytes"}]}:
digests and lengths only.  Every read is bounded; anything unreadable, malformed or vanishing fails the gate unless the
process demonstrably exited, and the process listing is repeated until it is stable, so a process born during the scan
is scanned too.  The gate's whole work is bounded too, not only each file: processes scanned, directory entries
(enumerated one by one), fds, and bytes hashed; each is charged before the work, and running out fails the gate
("gate-budget"), it never skips the rest and passes.  Environments and command lines are checked as they are read
and only the words kept.  The gate prints one line, `SBGPU-GATE {"v":1,"pass":bool,"fail":[...]}`, failures from a fixed
vocabulary only (never a path, name, address or value), and exits 0 only when every check passed.
"""

import errno
import hashlib
import ipaddress
import json
import os
import re
import socket
import stat
import subprocess
import sys

WORDS = (
    "ssh-unit", "ssh-running", "authorized-keys",
    "listener-22", "listener-public", "listener-loopback",
    "process", "process-churn", "credential-shape", "known-value",
    "provider-agent", "imds", "config-drive", "gate-budget", "mount-crossing", "unreadable",
    "password", "sudo", "console-login", "agent-active", "container-runtime", "user-session",
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
IMDS_TIMEOUT_S = 2.0
CONFIG_DRIVE_LABELS = ("config-2", "cidata")  # (matched in any case: config-2, CONFIG-2, Config-2, CiData...)
NO_HOMES_UNDER = ("/proc", "/sys", "/dev", "/run")
MOUNTINFO_MAX = 1024 * 1024
SHADOW_MAX = 1024 * 1024
GROUP_MAX = 1024 * 1024
SUDOERS_MAX = 64 * 1024          # (bytes of each sudoers file)
SUDOERS_D_MAX = 64               # (entries in /etc/sudoers.d)
STATUS_MAX = 8192                # (bytes of a process's status)
NET_IF_MAX = 64                  # (network interfaces probed)
NFT_MAX = 64 * 1024              # (bytes of nft's JSON listing of our table)
NFT_TIMEOUT_S = 5.0
SUDO_GROUPS = ("sudo", "admin", "wheel")
USER_UID_MIN = 1000              # (a process at or above this uid is a user session: the provider's, left over)
CONSOLE_UNITS = ("getty@.service", "serial-getty@.service", "autovt@.service", "console-getty.service",
                 "container-getty@.service")
CONSOLE_PROCS = ("agetty", "login")
CONTAINER_SOCKETS = ("run/docker.sock", "run/containerd/containerd.sock")
# Our metadata reject rules (the boot script's N9): table inet sbgpu_meta, one output chain, exactly these rejects.
META_TABLE = "sbgpu_meta"
META_CHAIN = {"type": "filter", "hook": "output", "prio": -300, "policy": "accept"}
META_RULES = frozenset({("ip", "169.254.0.0", 16), ("ip6", "fe80::a9fe:a9fe", 128), ("ip6", "fd00:ec2::254", 128)})
META_V4 = ("169.254.169.254", 80)
META_V6 = ("fe80::a9fe:a9fe", "fd00:ec2::254")  # (link-local on every interface; the EC2-style alias)
REJECTED = (errno.ECONNREFUSED, errno.EACCES, errno.EPERM, errno.ENETUNREACH)  # (a prompt local refusal, or no route)

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


def _keys_state(root, home, mounts, pinned, seen=None):
    """"ok" (absent or empty regular files), "keys", or "mount": each component of home/.ssh is opened without
    following any link, and the walk refuses to cross into another mount (a mount point at a component or at a key
    file, or a device change from the directory before) unless the image allowlist pins that exact path.  `seen` maps
    each home directory already scanned, by (st_dev, st_ino), to its path: the same directory is scanned once, and a
    second path reaching it (a bind alias) is "mount" unless that path is pinned."""
    seen = {} if seen is None else seen
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
            st = os.fstat(fd)
            here = st.st_dev
            if path not in pinned and (path in mounts or here != dev):
                return "mount"
            dev = here
            if path == home:
                key = (st.st_dev, st.st_ino)
                if key in seen:
                    return "ok" if seen[key] == home or home in pinned else "mount"
                seen[key] = home
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
    seen = {}
    for home in _homes(root):
        state = _keys_state(root, home, mounts, set(pinned), seen)
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
        uids = None
        for ln in _read_bounded(os.path.join(base, "status"), STATUS_MAX, regular=False).split(b"\n"):
            if ln.startswith(b"Uid:"):
                uids = [int(x) for x in ln.split()[1:]]
        if not uids or len(uids) != 4:
            raise Unreadable(base)
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
    return {"kthread": False, "comm": comm, "exe": exe, "uids": uids, "secrets": secrets, "sockets": socks}


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
    allowed = set(allow["processes"]) | set(allow["providerReader2"])  # (reader (2) channels: exact, labelled)
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
def unit_names(root):
    """Every unit file name in the unit search path (each directory enumerated with a cap)."""
    out = set()
    for d in UNIT_PATH:
        try:
            out.update(_entries(os.path.join(root, d), UNIT_DIR_MAX))
        except FileNotFoundError:
            continue
        except OSError:
            raise Unreadable(d)
    return out


def check_provider(root, procs, names=None):
    out = set()
    data = _read_bounded(os.path.join(root, "etc/passwd"), PASSWD_MAX)
    users = {line.split(b":")[0] for line in data.splitlines()}
    names = unit_names(root) if names is None else names
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


def check_neutralised(root, procs, allow, names):
    """Each agent the boot script neutralised: every one of its units (service, socket, timer, path, @ instances and
    templates) masked, its .service masked or absent, and no process by its name.  Its inert files may stay."""
    out = set()
    for a in allow["neutralisedAgents"]:
        unit = a["unit"]
        own = {n for n in names if n in (unit + ".service", unit + ".socket", unit + ".timer", unit + ".path")
               or n.startswith(unit + "@")}
        if any(unit_state(root, n) != "masked" for n in own) or unit_state(root, unit + ".service") == "present":
            out.add("agent-active")
        if any(p["comm"] == a["process"][:15] or os.path.basename(p["exe"]) == a["process"] for p in procs.values()):
            out.add("agent-active")
    return out


# ---- logins: passwords, sudo, consoles, user sessions, container runtimes
def _rows(path, limit, fields):
    """The rows of a bounded, regular colon file, each exactly `fields` fields of strict UTF-8 (else Unreadable)."""
    out = []
    for line in _read_bounded(path, limit).split(b"\n"):
        if not line:
            continue
        parts = line.split(b":")
        if len(parts) != fields:
            raise Unreadable(path)
        try:
            out.append([x.decode("utf-8", "strict") for x in parts])
        except UnicodeDecodeError:
            raise Unreadable(path)
    return out


def _locked(field):
    return field != "" and field[0] in "!*"


def check_passwords(root):
    """Every shadow password locked ("!" or "*" first; an empty one is a password-less login), and no hash in passwd."""
    out = set()
    if any(not _locked(r[1]) for r in _rows(os.path.join(root, "etc/shadow"), SHADOW_MAX, 9)):
        out.add("password")
    if any(r[1] != "x" and not _locked(r[1]) for r in _rows(os.path.join(root, "etc/passwd"), PASSWD_MAX, 7)):
        out.add("password")
    return out


def _gid(field):
    """A group id as a number: decimal digits only (libc reads 27, 027 and 0027 alike, so the text can't be compared);
    anything else is Unreadable."""
    if not re.fullmatch(r"[0-9]{1,10}", field):
        raise Unreadable("gid")
    return int(field)


def check_sudo(root, allow):
    """No member of a sudo group, nobody's primary group one, and every sudoers file exactly as the image allowlist
    has it (by sha256; one not on it, or not a regular file, fails)."""
    out = set()
    groups = _rows(os.path.join(root, "etc/group"), GROUP_MAX, 4)
    gids = {_gid(g[2]) for g in groups if g[0] in SUDO_GROUPS}
    if any(g[0] in SUDO_GROUPS and g[3] != "" for g in groups):
        out.add("sudo")
    if any(_gid(r[3]) in gids for r in _rows(os.path.join(root, "etc/passwd"), PASSWD_MAX, 7)):
        out.add("sudo")
    files = ["/etc/sudoers"]
    try:
        files += ["/etc/sudoers.d/" + n for n in _entries(os.path.join(root, "etc/sudoers.d"), SUDOERS_D_MAX)]
    except FileNotFoundError:
        pass
    for f in files:
        try:
            data = _read_bounded(os.path.join(root, f[1:]), SUDOERS_MAX)
        except FileNotFoundError:
            continue
        except Unreadable:
            out.add("sudo")  # (a sudoers path that isn't a regular file, or too big)
            continue
        if allow["sudoers"].get(f) != hashlib.sha256(data).hexdigest():
            out.add("sudo")
    return out


def check_consoles(root, procs, names):
    """Every console login unit, and every instance of one, masked or absent; no agetty or login running."""
    out = set()
    templates = tuple(u.split("@")[0] + "@" for u in CONSOLE_UNITS if "@" in u)
    for n in set(CONSOLE_UNITS) | {n for n in names if n.startswith(templates)}:
        if unit_state(root, n) == "present":
            out.add("console-login")
    if any(p["comm"] in CONSOLE_PROCS or os.path.basename(p["exe"]) in CONSOLE_PROCS for p in procs.values()):
        out.add("console-login")
    return out


def check_sessions(procs):
    return {"user-session"} if any(max(p["uids"]) >= USER_UID_MIN for p in procs.values()) else set()


def check_containers(root):
    return {"container-runtime"} if any(os.path.lexists(os.path.join(root, s)) for s in CONTAINER_SOCKETS) else set()


# ---- metadata service and config drive
def _nft_listing():
    r = subprocess.run(["nft", "-j", "list", "table", "inet", META_TABLE], stdin=subprocess.DEVNULL,
                       capture_output=True, timeout=NFT_TIMEOUT_S, check=False)
    if r.returncode != 0 or len(r.stdout) > NFT_MAX:
        raise Unreadable("nft")
    return r.stdout


def _meta_rule(expr):
    """A rule's expressions as (family, address, prefix length) when it is exactly "<ip|ip6> daddr X reject"."""
    if not (isinstance(expr, list) and len(expr) == 2 and expr[1] == {"reject": None}):
        return None
    m = expr[0].get("match") if isinstance(expr[0], dict) else None
    if not (isinstance(m, dict) and m.get("op") == "==" and isinstance(m.get("left"), dict)):
        return None
    pl = m["left"].get("payload")
    if not (isinstance(pl, dict) and pl.get("field") == "daddr" and pl.get("protocol") in ("ip", "ip6")):
        return None
    right = m.get("right")
    if isinstance(right, str):
        return (pl["protocol"], right, 32 if pl["protocol"] == "ip" else 128)
    pre = right.get("prefix") if isinstance(right, dict) else None
    if isinstance(pre, dict) and isinstance(pre.get("addr"), str) and type(pre.get("len")) is int:
        return (pl["protocol"], pre["addr"], pre["len"])
    return None


def meta_rules_exact(listing):
    """Whether nft's JSON listing is exactly our table (inet sbgpu_meta), its one output chain, and exactly META_RULES
    in that chain: every rule must name that family, table and chain (a reject in any other chain does nothing)."""
    try:
        objs = json.loads(listing)["nftables"]
    except (ValueError, KeyError, TypeError):
        raise Unreadable("nft")
    tables, chains, rules, other = [], [], [], 0
    for o in objs if isinstance(objs, list) else []:
        kind = next(iter(o), None) if isinstance(o, dict) and len(o) == 1 else None
        if kind == "table":
            tables.append(o["table"])
        elif kind == "chain":
            chains.append(o["chain"])
        elif kind == "rule":
            rules.append(o["rule"])
        elif kind != "metainfo":
            other += 1
    if other or len(tables) != 1 or len(chains) != 1:
        return False
    table, chain = tables[0], chains[0]
    if not (isinstance(table, dict) and table.get("family") == "inet" and table.get("name") == META_TABLE):
        return False
    if not (isinstance(chain, dict) and chain.get("family") == "inet" and chain.get("table") == META_TABLE
            and isinstance(chain.get("name"), str) and all(chain.get(k) == v for k, v in META_CHAIN.items())):
        return False
    found = []
    for r in rules:
        if not (isinstance(r, dict) and r.get("family") == "inet" and r.get("table") == META_TABLE
                and r.get("chain") == chain["name"]):
            return False  # (a rule elsewhere, or with no identity: not ours)
        found.append(_meta_rule(r.get("expr")))
    return None not in found and len(found) == len(META_RULES) and set(found) == META_RULES


def _probe(connect, family, address):
    """Whether one metadata address is refused at once (the reject's error, or no route at all)."""
    try:
        s = connect(family, address)
    except OSError as e:
        return e.errno in REJECTED  # (a timeout carries no such errno: it fails)
    s.close()
    return False


def _connect(family, address):
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(IMDS_TIMEOUT_S)
    try:
        s.connect(address)
    except BaseException:
        s.close()
        raise
    return s


def _covered(family, ip):
    """Whether an address is inside one of our metadata reject rules."""
    a = ipaddress.ip_address(ip)
    return any(f == family and a in ipaddress.ip_network("%s/%d" % (addr, n)) for f, addr, n in META_RULES)


def _meta_reachable(proc):
    """Routes (IPv4 and IPv6) and local IPv4 addresses that reach a metadata address outside our rules."""
    for line in _read_bounded(os.path.join(proc, "net", "route"), NET_MAX, regular=False).split(b"\n")[1:]:
        f = line.split()
        if not f:
            continue
        if len(f) < 8:
            raise Unreadable("route")
        dest = _addr(f[1])
        mask = bin(int(f[7], 16)).count("1")
        net = ipaddress.ip_network("%s/%d" % (dest, mask), strict=False)
        if net.overlaps(ipaddress.ip_network("169.254.0.0/16")) and mask >= 16 and not _covered("ip", dest):
            return True
    for line in _read_bounded(os.path.join(proc, "net", "ipv6_route"), NET_MAX, regular=False).split(b"\n"):
        f = line.split()
        if not f:
            continue
        if len(f) != 10 or len(f[0]) != 32:
            raise Unreadable("ipv6_route")
        dest = str(ipaddress.ip_address(bytes.fromhex(f[0].decode("ascii"))))
        if dest in META_V6 and not _covered("ip6", dest):
            return True
    trie = _read_bounded(os.path.join(proc, "net", "fib_trie"), NET_MAX, regular=False).decode("ascii", "replace")
    for ip in re.findall(r"\|-- (169\.254\.\d+\.\d+)\n\s+/32 host LOCAL", trie):
        if not _covered("ip", ip):
            return True
    return False


def interfaces(root):
    """Every network interface but loopback, with its index (/sys/class/net, capped)."""
    out = []
    for name in sorted(_entries(os.path.join(root, "sys/class/net"), NET_IF_MAX)):
        if name == "lo":
            continue
        idx = _read_bounded(os.path.join(root, "sys/class/net", name, "ifindex"), 32, regular=False).strip()
        if not idx.isdigit():
            raise Unreadable("ifindex")
        out.append((name, int(idx)))
    return out


def check_imds(root="/", proc="/proc", connect=None, nft=None):
    """Our reject rules exactly in place; every metadata address refused at once (IPv4, the IPv6 alias, and IPv6
    link-local on each interface: an answer, a timeout or any other error fails); and nothing reaching a metadata
    address outside the rules.  Any of these failing is "imds" (fail closed until the exact contents are reviewed)."""
    connect = connect or _connect
    out = set()
    try:
        exact = meta_rules_exact((nft or _nft_listing)())
    except Unreadable:
        exact = False  # (no table of ours, or a listing that doesn't parse: the rules aren't in place)
    if not exact:
        out.add("imds")
    targets = [(socket.AF_INET, META_V4), (socket.AF_INET6, (META_V6[1], 80, 0, 0))]
    targets += [(socket.AF_INET6, (META_V6[0], 80, 0, idx)) for _, idx in interfaces(root)]
    if not all(_probe(connect, fam, addr) for fam, addr in targets):
        out.add("imds")
    if _meta_reachable(proc):
        out.add("imds")
    return out


def check_config_drive(root):
    try:
        names = _entries(os.path.join(root, "dev/disk/by-label"), LABELS_MAX)
    except FileNotFoundError:
        return set()
    except OSError:
        raise Unreadable("by-label")
    return {"config-drive"} if any(n.lower() in CONFIG_DRIVE_LABELS for n in names) else set()


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
                  for a in allow["loopback"])
          and isinstance(allow.get("providerReader2"), list)
          and all(isinstance(x, str) and x.startswith("/") and x not in allow["processes"] for x in allow["providerReader2"])
          and isinstance(allow.get("neutralisedAgents"), list)
          and all(isinstance(a, dict) and set(a) == {"unit", "process"} and all(
                  isinstance(a[k], str) and re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", a[k]) for k in a)
                  and a["unit"] not in PROVIDER_AGENTS and a["process"] not in PROVIDER_AGENTS
                  and all(os.path.basename(x) != a["process"] for x in allow["providerReader2"])
                  for a in allow["neutralisedAgents"])
          and isinstance(allow.get("sudoers"), dict)
          and all(re.fullmatch(r"/etc/sudoers(\.d/[^/\x00]+)?", k) and isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v)
                  for k, v in allow["sudoers"].items()))
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
def run(allow, known=(), root="/", proc="/proc", connect=None, self_pid=None, nft=None):
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
    checks = [lambda: check_imds(root, proc, connect, nft), lambda: check_config_drive(root),
              lambda: check_passwords(root), lambda: check_sudo(root, allow), lambda: check_containers(root)]
    if procs is not None:
        names = {}

        def units():
            if "n" not in names:
                names["n"] = unit_names(root)
            return names["n"]
        checks = [lambda: check_ssh(root, procs, proc, allow["mounts"]), lambda: check_processes(procs, allow),
                  lambda: check_secrets(procs, known), lambda: check_listeners(sockets(proc), procs, allow),
                  lambda: check_provider(root, procs, units()), lambda: check_neutralised(root, procs, allow, units()),
                  lambda: check_consoles(root, procs, units()), lambda: check_sessions(procs)] + checks
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
