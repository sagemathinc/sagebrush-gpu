"""VM mode's launcher children (the launcher's design note r4).  vm-launcher.sh runs each with python3 -I -S from the
pinned agent it has just unpacked; none of them is ever given a secret as an argument or in its environment.

  digest
      The sha256 of stdin (at most 64 bytes): the nonce's, for the gate's known values.
  announce PREFIX CONTROL_URL MACHINE_ID SCRIPT_SHA256 AGENT_SHA256        (the nonce on stdin)
      The one announce, then boot.json.  Prints `dir DEV INO` once it has made /run/sbgpu, then `ok TOKEN_SHA256 D`,
      D being the enroll deadline in CLOCK_BOOTTIME milliseconds.  Exit 3: no usable 200 (nothing written).  Exit 2:
      after the 200, boot.json couldn't be made by D (whatever it wrote is removed again).  The token never leaves this
      process except into boot.json.
  remaining D MARGIN_S
      Whole seconds left until D minus MARGIN_S, by CLOCK_BOOTTIME; 0 and exit 1 when there are none.
  gatefile PREFIX D DEV INO        (gate 2's line on stdin)
      gate.json, beside boot.json, when the line is exactly a pass.  Exit 2 otherwise, or at D (with gate.json and
      its temp file removed again).
  scrub PREFIX DEV INO
      After a later failure: removes boot.json, gate.json and their temp files from /run/sbgpu when it is still the
      directory the announce made (DEV INO).  Nothing else is ever removed, and /run/sbgpu itself never is.

Every deadline is read through boottime.boottime_ms(), at the moment of the check; the writer checks D before and
after each blocking call, so a stage held across D (a suspend included) is refused when it returns.
"""

import ctypes
import datetime
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import stat
import sys
import threading
import time
import urllib.parse

from sbgpu_agent import boottime

ANNOUNCE_PATH = "/v1/agent/announce"
ANNOUNCE_BUDGET_MS = 30_000  # the POST, from connect to the last byte
RESPONSE_MAX = 4096
ENROLL_BY_MS = 80_000  # D: this long after the 200 is received
LIFE_MIN_S, LIFE_MAX_S = 90, 130  # the token's remaining life by the VM's clock, when it arrives
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}")
NONCE_RE = re.compile(r"[A-Za-z0-9_-]{22}")
EXPIRES_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
NUMBER_RE = re.compile(r"[0-9]{1,20}")
NAMES = ("boot.json", "gate.json", ".boot.json.tmp", ".gate.json.tmp")
MOUNTINFO_MAX = 1024 * 1024
STDIN_MAX = 64
GATE_LINE_MAX = 4096
GATE_PREFIX = "SBGPU-GATE "
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

EXIT_LOCAL = 2
EXIT_ANNOUNCE = 3

wall_s = time.time  # (the one wall-clock read: the token's freshness when it arrives)
RESOLVE_SLICE_S = 0.05  # (how often a wait for the resolver looks at CLOCK_BOOTTIME again)


class PinnedHTTPS(http.client.HTTPSConnection):
    """An HTTPSConnection to an address resolved beforehand (resolve()), so its connect does no name lookup of its own.
    The TLS server name, the certificate's name check and the Host header are still the URL's host."""

    def __init__(self, host, port, addr, timeout, context):
        http.client.HTTPSConnection.__init__(self, host, port, timeout=timeout, context=context)
        self.addr = addr  # (family, sockaddr)
        self.tls = context

    def connect(self):
        family, sockaddr = self.addr
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            sock.settimeout(self.timeout)
            sock.connect(sockaddr)
            self.sock = self.tls.wrap_socket(sock, server_hostname=self.host)  # (the handshake, under the timeout)
        except BaseException:
            sock.close()
            raise


HTTPS = PinnedHTTPS


def tls():
    return ssl.create_default_context()


class Late(Exception):
    """A deadline has passed."""


class Refused(Exception):
    """Something isn't exactly as it must be."""


def owner_uid(prefix):
    """Who must own what the launcher made: root on a machine; under a test prefix, the user running the tests."""
    return 0 if prefix == "" else os.geteuid()


def check(deadline):
    if boottime.boottime_ms() >= deadline:
        raise Late()


def undumpable():
    """PR_SET_DUMPABLE 0, then read back (PR_GET_DUMPABLE): no core and no ptrace by another uid of this process."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
        raise Refused("dumpable")


def read_stream(f, limit):
    """All of f, to EOF; more than `limit` bytes is Refused."""
    chunks, got = [], 0
    while got <= limit:
        chunk = f.read(limit + 1 - got)
        if not chunk:
            break
        chunks.append(chunk)
        got += len(chunk)
    data = b"".join(chunks)
    if len(data) > limit:
        raise Refused("too long")
    return data


def _no_dups(pairs):
    keys = [k for k, _ in pairs]
    if len(set(keys)) != len(keys):
        raise Refused("duplicate key")
    return dict(pairs)


# ---- the one POST
def resolve(host, port, deadline):
    """(family, sockaddr): the first TCP address getaddrinfo gives for host:port.  The lookup runs in a daemon thread;
    this waits for it in slices of at most RESOLVE_SLICE_S, reading CLOCK_BOOTTIME after each, and at `deadline` it
    abandons the lookup (Late): nothing connects to anything it answers later."""
    box = {}
    done = threading.Event()

    def lookup():
        try:
            box["addrs"] = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        except BaseException as e:  # (any failure is reported to the waiter, never raised in the thread)
            box["error"] = e
        finally:
            done.set()
    threading.Thread(target=lookup, daemon=True).start()
    while not done.wait(max(0.0, min(RESOLVE_SLICE_S, (deadline - boottime.boottime_ms()) / 1000))):
        check(deadline)
    check(deadline)  # (an answer that arrives at or past the deadline is not used)
    if "error" in box:
        raise Refused("dns")
    family, _, _, _, sockaddr = box["addrs"][0]  # (no address at all: an IndexError, which refuses too)
    return family, sockaddr


def post(url, headers, body, deadline, cap):
    """(status, body, CLOCK_BOOTTIME ms when the status arrived) of one https POST; no redirect is followed (a 3xx is
    just a status).  The host's address is resolved first, by resolve(), which gives up at `deadline` however long
    the resolver takes, and the connection goes to that address.  Every blocking call after it (the connect with its
    TLS handshake, sending the request, reading the status and headers, each read of the body, its EOF included) runs
    through bounded(): its socket timeout is the time left to `deadline` (none left: Late, and the call isn't made),
    and a call that returns at or past `deadline` is Late.  So the whole request is bounded by it.  At most cap + 1
    bytes of the body are read."""
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or not u.hostname or u.query or u.fragment:
        raise Refused("url")

    def timeout():
        ms = deadline - boottime.boottime_ms()
        if ms <= 0:
            raise Late()
        return ms / 1000

    addr = resolve(u.hostname, u.port or 443, deadline)
    conn = HTTPS(u.hostname, u.port or 443, addr, timeout=timeout(), context=tls())

    def bounded(call):
        if conn.sock is None:
            conn.timeout = timeout()  # (the connect makes the socket with this timeout)
        else:
            conn.sock.settimeout(timeout())
        out = call()
        check(deadline)
        return out

    try:
        bounded(conn.connect)
        bounded(lambda: conn.request("POST", u.path or "/", body=body, headers=headers))
        resp = bounded(conn.getresponse)
        received = boottime.boottime_ms()
        chunks, got = [], 0
        while got <= cap:
            chunk = bounded(lambda: resp.read1(cap + 1 - got))
            if not chunk:
                break
            chunks.append(chunk)
            got += len(chunk)
        return resp.status, b"".join(chunks), received
    finally:
        conn.close()


def announce_body(machine_id, nonce, script_sha):
    """Exactly control's AgentAnnounceRequest, in the shared fixture's key order (fixtures/vm-announce.json)."""
    return json.dumps({"machineId": machine_id, "nonce": nonce, "bootScriptSha256": script_sha},
                      separators=(",", ":")).encode()


def parse_issued(status, data):
    """(bootToken, expiresAt as epoch seconds) from exactly a 200 of {bootToken, expiresAt}; else Refused."""
    if status != 200 or len(data) > RESPONSE_MAX:
        raise Refused("status")
    try:
        obj = json.loads(data.decode("utf-8"), object_pairs_hook=_no_dups)
    except ValueError:
        raise Refused("json")
    if not isinstance(obj, dict) or sorted(obj) != ["bootToken", "expiresAt"]:
        raise Refused("keys")
    token, exp = obj["bootToken"], obj["expiresAt"]
    if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
        raise Refused("token")
    if not isinstance(exp, str) or not EXPIRES_RE.fullmatch(exp):
        raise Refused("expiresAt")
    try:
        at = datetime.datetime.strptime(exp, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        raise Refused("expiresAt")
    return token, at.timestamp()


# ---- /run/sbgpu and its two files
def on_tmpfs(prefix, run_st):
    """Whether the mount on /run (the last one listed there, which is the one on top) is a tmpfs with the device the
    opened /run is on."""
    with open(prefix + "/proc/self/mountinfo", "rb") as f:
        data = read_stream(f, MOUNTINFO_MAX)
    top = None
    for line in data.split(b"\n"):
        if not line:
            continue
        fields = line.split(b" ")
        if len(fields) < 10 or b"-" not in fields[6:]:
            raise Refused("mountinfo")
        if fields[4] == b"/run":
            top = (fields[2], fields[fields.index(b"-", 6) + 1])
    want = ("%d:%d" % (os.major(run_st.st_dev), os.minor(run_st.st_dev))).encode()
    return top == (want, b"tmpfs")


def make_dir(prefix):
    """/run/sbgpu, made here and now (never one that already exists, as anything): (its fd, its stat)."""
    uid = owner_uid(prefix)
    run = os.open(prefix + "/run", DIR_FLAGS)
    try:
        run_st = os.fstat(run)
        if not on_tmpfs(prefix, run_st):
            raise Refused("/run isn't a tmpfs")
        os.mkdir("sbgpu", 0o700, dir_fd=run)
        d = os.open("sbgpu", DIR_FLAGS, dir_fd=run)
    finally:
        os.close(run)
    st = os.fstat(d)
    if (not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or stat.S_IMODE(st.st_mode) != 0o700
            or st.st_dev != run_st.st_dev):
        os.close(d)
        raise Refused("/run/sbgpu")
    return d, st


def open_dir(prefix, dev, ino):
    """/run/sbgpu again, only if it is the very directory make_dir made (device and inode), still as it made it."""
    uid = owner_uid(prefix)
    run = os.open(prefix + "/run", DIR_FLAGS)
    try:
        d = os.open("sbgpu", DIR_FLAGS, dir_fd=run)
    finally:
        os.close(run)
    st = os.fstat(d)
    if ((st.st_dev, st.st_ino) != (dev, ino) or not stat.S_ISDIR(st.st_mode) or st.st_uid != uid
            or stat.S_IMODE(st.st_mode) != 0o700):
        os.close(d)
        raise Refused("/run/sbgpu")
    return d


class Ops:
    """The writer's blocking calls, in one place so a test can hold each one."""

    def open(self, name, d):
        return os.open(name, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY | os.O_CLOEXEC, 0o600, dir_fd=d)

    def write(self, fd, data):
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]

    def fsync(self, fd):
        os.fsync(fd)

    def rename(self, tmp, name, d):
        os.rename(tmp, name, src_dir_fd=d, dst_dir_fd=d)


OPS = Ops()


def write_file(d, name, data, deadline):
    """`name` in the directory d: a new 0600 temp file, written, fsynced, renamed into place, the directory fsynced.
    D is checked before and after each of those blocking calls."""
    tmp = "." + name + ".tmp"
    check(deadline)
    fd = OPS.open(tmp, d)
    try:
        check(deadline)
        OPS.write(fd, data)
        check(deadline)
        OPS.fsync(fd)
        check(deadline)
    finally:
        os.close(fd)
    OPS.rename(tmp, name, d)
    check(deadline)
    OPS.fsync(d)
    check(deadline)


def scrub_fd(d):
    """Removes our files (and only those names) from the directory d.  True when none is left."""
    ok = True
    for name in NAMES:
        try:
            os.unlink(name, dir_fd=d)
        except FileNotFoundError:
            pass
        except OSError:
            ok = False
    return ok


# ---- the commands
def digest(stdin, out):
    out.write(hashlib.sha256(read_stream(stdin, STDIN_MAX)).hexdigest() + "\n")
    return 0


def announce(prefix, control_url, machine_id, script_sha, agent_sha, stdin, out):
    try:
        undumpable()
        nonce = read_stream(stdin, STDIN_MAX).decode("ascii")
        nonce = nonce[:-1] if nonce.endswith("\n") else nonce
        if not NONCE_RE.fullmatch(nonce):
            raise Refused("nonce")
        start = boottime.boottime_ms()
        status, data, received = post(control_url.rstrip("/") + ANNOUNCE_PATH,
                                      {"content-type": "application/json", "accept": "application/json"},
                                      announce_body(machine_id, nonce, script_sha), start + ANNOUNCE_BUDGET_MS,
                                      RESPONSE_MAX)
        token, expires = parse_issued(status, data)
        if not LIFE_MIN_S <= expires - wall_s() <= LIFE_MAX_S:
            raise Refused("lifetime")
    except Exception:  # (no retry: whatever went wrong, the nonce may be spent)
        return EXIT_ANNOUNCE
    deadline = received + ENROLL_BY_MS
    try:
        d, st = make_dir(prefix)
    except Exception:
        return EXIT_LOCAL
    try:
        out.write("dir %d %d\n" % (st.st_dev, st.st_ino))
        out.flush()
        boot = {"controlUrl": control_url, "mode": "vm", "bootToken": token, "agentSha256": agent_sha,
                "enrollByBoottimeMs": deadline}
        write_file(d, "boot.json", json.dumps(boot, separators=(",", ":")).encode(), deadline)
        out.write("ok %s %d\n" % (hashlib.sha256(token.encode()).hexdigest(), deadline))
        out.flush()
        return 0
    except Exception:
        scrub_fd(d)
        return EXIT_LOCAL
    finally:
        os.close(d)


def remaining(deadline, margin_s, out):
    secs = (deadline - margin_s * 1000 - boottime.boottime_ms()) // 1000
    if secs <= 0:
        out.write("0\n")
        return 1
    out.write("%d\n" % secs)
    return 0


def gatefile(prefix, deadline, dev, ino, stdin):
    try:
        text = read_stream(stdin, GATE_LINE_MAX).decode("utf-8")
        if not text.startswith(GATE_PREFIX) or not text.endswith("\n") or text.count("\n") != 1:
            raise Refused("line")
        report = text[len(GATE_PREFIX):-1]
        obj = json.loads(report, object_pairs_hook=_no_dups)
        if (not isinstance(obj, dict) or obj != {"v": 1, "pass": True, "fail": []} or type(obj["v"]) is not int
                or type(obj["pass"]) is not bool):
            raise Refused("not a pass")
        d = open_dir(prefix, dev, ino)
    except Exception:
        return EXIT_LOCAL
    try:
        write_file(d, "gate.json", report.encode(), deadline)
        return 0
    except Exception:
        for name in ("gate.json", ".gate.json.tmp"):
            try:
                os.unlink(name, dir_fd=d)
            except OSError:
                pass
        return EXIT_LOCAL
    finally:
        os.close(d)


def scrub(prefix, dev, ino):
    try:
        d = open_dir(prefix, dev, ino)
    except Exception:
        return 1
    try:
        return 0 if scrub_fd(d) else 1
    finally:
        os.close(d)


def _number(s):
    if not NUMBER_RE.fullmatch(s):
        raise ValueError(s)
    return int(s)


def main(argv=None, stdin=None, stdout=None):
    argv = sys.argv[1:] if argv is None else argv
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    cmd = argv[0] if argv else ""
    if cmd == "announce":
        return announce(*argv[1:], stdin, stdout) if len(argv) == 6 else EXIT_ANNOUNCE
    try:
        if cmd == "digest" and len(argv) == 1:
            return digest(stdin, stdout)
        if cmd == "remaining" and len(argv) == 3:
            return remaining(_number(argv[1]), _number(argv[2]), stdout)
        if cmd == "gatefile" and len(argv) == 5:
            return gatefile(argv[1], _number(argv[2]), _number(argv[3]), _number(argv[4]), stdin)
        if cmd == "scrub" and len(argv) == 4:
            return scrub(argv[1], _number(argv[2]), _number(argv[3]))
    except (ValueError, Refused):
        pass
    return EXIT_LOCAL


if __name__ == "__main__":
    raise SystemExit(main())
