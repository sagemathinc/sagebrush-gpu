"""The VM launcher's children (sbgpu_agent/vmboot.py) and the clock they read (sbgpu_agent/boottime.py): the one
announce and what it accepts, /run/sbgpu made only fresh, the two files written with the deadline D checked around every
blocking call (a suspend across D, modelled at the clock, is refused), gate.json, and the scrub."""

import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sbgpu_agent import boottime, vmboot as B  # noqa: E402

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(AGENT_DIR, "..", "..", "fixtures", "vm-announce.json")
TOKEN = "T" * 20 + "o-_" + "k" * 20
NONCE = "N" * 10 + "-_" + "n" * 10
MACHINE = "mch_0123456789abcdefghjk"
SCRIPT_SHA = "5" * 64
AGENT_SHA = "a" * 64
URL = "https://control.example.com"
T0 = 1_000_000  # CLOCK_BOOTTIME ms at the start of each run
NOW = 1_800_000_000.0  # the wall clock, epoch seconds


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(int(t))) + ".%03dZ" % round((t - int(t)) * 1000)


class Clock:
    """The stub CLOCK_BOOTTIME: what boottime.boottime_ms() returns, moved only by the test."""

    def __init__(self, ms=T0):
        self.ms = ms

    def __call__(self):
        return self.ms


class FakeResponse:
    def __init__(self, status, body, chunk=1000):
        self.status = status
        self.body = body
        self.chunk = chunk

    def read1(self, n):
        out, self.body = self.body[:min(n, self.chunk)], self.body[min(n, self.chunk):]
        return out


class FakeSock:
    def __init__(self, conn):
        self.conn = conn

    def settimeout(self, t):
        self.conn.timeouts.append(t)


class Server:
    """Stands in for control: records every connection and request; answers as told."""

    def __init__(self, status=200, body=None, clock=None):
        self.status = status
        self.body = body
        self.clock = clock
        self.conns = []
        self.requests = []
        self.connect_error = None
        self.chunk = 1000  # (bytes per read of the body)
        self.on_response = None  # (called as the status arrives: a test moves the clock here)

    def issue(self, life=120.0, token=TOKEN):
        self.body = json.dumps({"bootToken": token, "expiresAt": iso(NOW + life)}).encode()

    def factory(self, host, port, timeout, context):
        server = self

        class Conn:
            def __init__(self):
                self.host, self.port, self.timeouts = host, port, [timeout]
                self.sock = None
                server.conns.append(self)

            def connect(self):
                if server.connect_error:
                    raise server.connect_error
                self.sock = FakeSock(self)

            def request(self, method, path, body, headers):
                server.requests.append((method, self.host, self.port, path, body, headers))

            def getresponse(self):
                if server.on_response:
                    server.on_response()
                return FakeResponse(server.status, server.body, server.chunk)

            def close(self):
                pass

        return Conn()


def make_root(tmpfs=True):
    """A test prefix with /run, /var/lib and a mountinfo that says /run is (or isn't) a tmpfs on its own device."""
    root = tempfile.mkdtemp(prefix="sbgpu-vmboot-")
    os.makedirs(root + "/run")
    os.makedirs(root + "/proc/self")
    dev = os.stat(root + "/run").st_dev
    write_mountinfo(root, "%d:%d" % (os.major(dev), os.minor(dev)), "tmpfs" if tmpfs else "ext4")
    return root


def write_mountinfo(root, majmin, fstype, extra=""):
    with open(root + "/proc/self/mountinfo", "w") as f:
        f.write("22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n")
        f.write("25 22 %s / /run rw,nosuid,nodev shared:5 - %s tmpfs rw,mode=755\n" % (majmin, fstype))
        f.write(extra)


def tree(root):
    """Every path under root (but /proc) with its type, mode and content: to compare before and after."""
    out = {}
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if os.path.join(dirpath, d) != root + "/proc"]
        for name in dirs + files:
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            body = os.readlink(p) if stat.S_ISLNK(st.st_mode) else (open(p, "rb").read() if stat.S_ISREG(st.st_mode) else None)
            out[p[len(root):]] = (stat.S_IFMT(st.st_mode), stat.S_IMODE(st.st_mode), body)
    return out


def holding(root, needle):
    """Every file under root whose bytes contain needle."""
    hits = []
    for dirpath, _, files in os.walk(root):
        for name in files:
            p = os.path.join(dirpath, name)
            if not os.path.islink(p) and needle.encode() in open(p, "rb").read():
                hits.append(p[len(root):])
    return sorted(hits)


class Base(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.root = make_root()
        self.server = Server(clock=self.clock)
        self.server.issue()
        for target, value in ((boottime, ("boottime_ms", self.clock)), (B, ("HTTPS", self.server.factory)),
                              (B, ("wall_s", lambda: NOW)), (B, ("undumpable", lambda: None))):
            p = mock.patch.object(target, value[0], value[1])
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        subprocess.run(["rm", "-rf", self.root])

    def announce(self, nonce=NONCE + "\n", url=URL):
        out = io.StringIO()
        code = B.announce(self.root, url, MACHINE, SCRIPT_SHA, AGENT_SHA, io.BytesIO(nonce.encode()), out)
        return code, out.getvalue()


class TestClock(unittest.TestCase):
    def test_reads_clock_boottime_and_nothing_else(self):
        ns = {time.CLOCK_BOOTTIME: 5_000_123_456, time.CLOCK_MONOTONIC: 7_000_000_000, time.CLOCK_REALTIME: 9_000_000_000}
        with mock.patch.object(time, "clock_gettime_ns", lambda c: ns[c]), \
                mock.patch.object(time, "clock_gettime", lambda c: ns[c] / 1e9), \
                mock.patch.object(time, "monotonic", lambda: 11.0), mock.patch.object(time, "monotonic_ns", lambda: 11 * 10**9), \
                mock.patch.object(time, "time", lambda: 13.0), mock.patch.object(time, "time_ns", lambda: 13 * 10**9):
            self.assertEqual(boottime.boottime_ms(), 5000)

    def test_the_real_clock_is_boottime(self):
        a = boottime.boottime_ms()
        b = time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000
        self.assertLessEqual(a, b)
        self.assertLess(b - a, 1000)


class TestUndumpable(unittest.TestCase):
    def test_sets_and_reads_back(self):
        code = ("import sys, ctypes; sys.path.insert(0, sys.argv[1]); from sbgpu_agent import vmboot; "
                "print(ctypes.CDLL(None).prctl(3, 0, 0, 0, 0)); vmboot.undumpable(); print(ctypes.CDLL(None).prctl(3, 0, 0, 0, 0))")
        out = subprocess.run([sys.executable, "-I", "-S", "-c", code, AGENT_DIR], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.split(), ["1", "0"])

    def test_owner(self):
        self.assertEqual(B.owner_uid(""), 0)
        self.assertEqual(B.owner_uid("/tmp/x"), os.geteuid())


class TestAnnounce(Base):
    def test_success(self):
        code, out = self.announce()
        self.assertEqual(code, 0)
        d = os.stat(self.root + "/run/sbgpu")
        token_sha = hashlib.sha256(TOKEN.encode()).hexdigest()
        self.assertEqual(out, "dir %d %d\nok %s %d\n" % (d.st_dev, d.st_ino, token_sha, T0 + 80_000))
        self.assertEqual(stat.S_IMODE(d.st_mode), 0o700)
        with open(self.root + "/run/sbgpu/boot.json", "rb") as f:
            self.assertEqual(json.loads(f.read()), {"controlUrl": URL, "mode": "vm", "bootToken": TOKEN,
                                                    "agentSha256": AGENT_SHA, "enrollByBoottimeMs": T0 + 80_000})
        self.assertEqual(stat.S_IMODE(os.stat(self.root + "/run/sbgpu/boot.json").st_mode), 0o600)
        self.assertEqual(sorted(os.listdir(self.root + "/run/sbgpu")), ["boot.json"])
        self.assertEqual(holding(self.root, TOKEN), ["/run/sbgpu/boot.json"])
        self.assertEqual(holding(self.root, NONCE), [])
        self.assertNotIn(TOKEN, out)
        self.assertNotIn(NONCE, out)

    def test_exactly_one_post_of_exactly_the_fixture_shape(self):
        self.assertEqual(self.announce()[0], 0)
        self.assertEqual(len(self.server.conns), 1)
        self.assertEqual(len(self.server.requests), 1)
        method, host, port, path, body, headers = self.server.requests[0]
        self.assertEqual((method, host, port, path), ("POST", "control.example.com", 443, "/v1/agent/announce"))
        self.assertEqual(json.loads(body), {"machineId": MACHINE, "nonce": NONCE, "bootScriptSha256": SCRIPT_SHA})
        self.assertEqual(headers["content-type"], "application/json")
        with open(FIXTURE, "rb") as f:
            fixture = f.read()
        values = json.loads(fixture)
        self.assertEqual(B.announce_body(values["machineId"], values["nonce"], values["bootScriptSha256"]) + b"\n", fixture)

    def test_a_base_path_and_port(self):
        self.assertEqual(self.announce(url="https://c.example.com:8443/base/")[0], 0)
        self.assertEqual(self.server.requests[0][1:4], ("c.example.com", 8443, "/base/v1/agent/announce"))

    def test_the_nonce_without_a_newline(self):
        self.assertEqual(self.announce(nonce=NONCE)[0], 0)

    def test_a_bad_nonce_never_posts(self):
        for nonce in ("", NONCE[:-1], NONCE + "x", NONCE[:-1] + "=", NONCE + "\n\n", "x" * 65):
            self.assertEqual(self.announce(nonce=nonce)[0], 3, nonce)
        self.assertEqual(self.server.conns, [])

    def test_undumpable_first(self):
        with mock.patch.object(B, "undumpable", mock.Mock(side_effect=B.Refused("dumpable"))):
            self.assertEqual(self.announce()[0], 3)
        self.assertEqual(self.server.conns, [])

    def assert_refused(self, why):
        before = len(self.server.requests)
        code, out = self.announce()
        self.assertEqual((code, out), (3, ""), why)
        self.assertFalse(os.path.exists(self.root + "/run/sbgpu"), why)
        self.assertLessEqual(len(self.server.requests) - before, 1, why)

    def test_every_status_but_200(self):
        for status in (201, 204, 301, 302, 307, 308, 400, 403, 404, 500, 503):
            self.server.status = status
            self.assert_refused(status)

    def test_the_network(self):
        self.server.connect_error = OSError("refused")
        self.assert_refused("connect")
        self.server.connect_error = TimeoutError()
        self.assert_refused("timeout")

    def test_the_body(self):
        bodies = {
            "oversized": json.dumps({"bootToken": TOKEN, "expiresAt": iso(NOW + 120), "x": "y" * 4096}).encode(),
            "4097 bytes": b" " * (4097 - len(json.dumps({"bootToken": TOKEN, "expiresAt": iso(NOW + 120)})))
            + json.dumps({"bootToken": TOKEN, "expiresAt": iso(NOW + 120)}).encode(),
            "empty": b"",
            "not json": b"{",
            "not utf-8": b"\xff",
            "array": b"[]",
            "extra key": json.dumps({"bootToken": TOKEN, "expiresAt": iso(NOW + 120), "x": 1}).encode(),
            "missing key": json.dumps({"bootToken": TOKEN}).encode(),
            "duplicate key": ('{"bootToken":"%s","bootToken":"%s","expiresAt":"%s"}' % (TOKEN, TOKEN, iso(NOW + 120))).encode(),
            "short token": json.dumps({"bootToken": TOKEN[:-1], "expiresAt": iso(NOW + 120)}).encode(),
            "long token": json.dumps({"bootToken": TOKEN + "x", "expiresAt": iso(NOW + 120)}).encode(),
            "padded token": json.dumps({"bootToken": TOKEN[:-1] + "=", "expiresAt": iso(NOW + 120)}).encode(),
            "token not a string": json.dumps({"bootToken": 1, "expiresAt": iso(NOW + 120)}).encode(),
            "no milliseconds": json.dumps({"bootToken": TOKEN, "expiresAt": iso(NOW + 120)[:-5] + "Z"}).encode(),
            "microseconds": json.dumps({"bootToken": TOKEN, "expiresAt": iso(NOW + 120)[:-1] + "000Z"}).encode(),
            "offset": json.dumps({"bootToken": TOKEN, "expiresAt": iso(NOW + 120)[:-1] + "+00:00"}).encode(),
            "invalid date": json.dumps({"bootToken": TOKEN, "expiresAt": "2027-02-30T00:00:00.000Z"}).encode(),
            "non-ascii digits": json.dumps({"bootToken": TOKEN, "expiresAt": "٢027-01-15T08:00:00.000Z"}).encode(),
            "expiresAt not a string": json.dumps({"bootToken": TOKEN, "expiresAt": 1}).encode(),
        }
        for why, body in bodies.items():
            self.server.body = body
            self.assert_refused(why)

    def test_the_body_read_in_pieces(self):
        self.server.chunk = 7
        self.assertEqual(self.announce()[0], 0)
        self.assertEqual(json.loads(open(self.root + "/run/sbgpu/boot.json").read())["bootToken"], TOKEN)

    def test_the_lifetime(self):
        for life, ok in ((90.0, True), (130.0, True), (89.999, False), (130.001, False), (-5.0, False), (3600.0, False)):
            self.tearDown()
            self.root = make_root()
            self.server.issue(life=life)
            self.assertEqual(self.announce()[0], 0 if ok else 3, life)

    def test_a_wall_clock_jump_after_receipt_changes_nothing(self):
        jumps = iter([NOW, NOW + 3600, NOW - 3600])
        with mock.patch.object(B, "wall_s", lambda: next(jumps)):
            code, out = self.announce()
        self.assertEqual(code, 0)
        self.assertTrue(out.endswith(" %d\n" % (T0 + 80_000)))

    def test_the_budget_is_thirty_seconds_and_each_wait_is_what_is_left(self):
        def later():
            self.clock.ms = T0 + 12_000
        self.server.on_response = later
        self.assertEqual(self.announce()[0], 0)
        timeouts = self.server.conns[0].timeouts
        self.assertGreaterEqual(len(timeouts), 4)  # (and one before each read of the body)
        self.assertEqual(timeouts[:3], [30.0, 30.0, 30.0])
        self.assertEqual(timeouts[3:], [18.0] * (len(timeouts) - 3))
        # D counts from the moment the status arrived
        self.assertTrue(open(self.root + "/run/sbgpu/boot.json").read().endswith('"enrollByBoottimeMs":%d}' % (T0 + 92_000)))

    def test_the_budget_runs_out(self):
        for at, ok in ((T0 + 30_000, False), (T0 + 45_000, False), (T0 + 29_999, True)):
            def wait(at=at):
                self.clock.ms = at
            self.server.on_response = wait
            self.clock.ms = T0
            if ok:
                self.assertEqual(self.announce()[0], 0, at)
            else:
                self.assert_refused(at)

    def test_a_non_https_url_never_connects(self):
        for url in ("http://control.example.com", "https://", "https://c.example.com/?x=1", "https://c.example.com/#x"):
            code, out = self.announce(url=url)
            self.assertEqual(code, 3, url)
        self.assertEqual(self.server.conns, [])


class TestTheDirectory(Base):
    """H2: /run/sbgpu is made fresh or the boot stops (exit 2, after the 200, so the token is spent); nothing that was
    there is touched."""

    def assert_bootfile(self, why):
        before = tree(self.root)
        code, out = self.announce()
        self.assertEqual((code, out), (2, ""), why)
        self.assertEqual(tree(self.root), before, why)
        self.assertEqual(holding(self.root, TOKEN), [], why)

    def test_already_there_as_a_directory(self):
        os.mkdir(self.root + "/run/sbgpu", 0o700)
        open(self.root + "/run/sbgpu/keep", "w").write("x")
        self.assert_bootfile("dir")

    def test_already_there_as_a_link(self):
        os.mkdir(self.root + "/elsewhere")
        open(self.root + "/elsewhere/keep", "w").write("x")
        os.symlink(self.root + "/elsewhere", self.root + "/run/sbgpu")
        self.assert_bootfile("link")

    def test_already_there_as_a_file(self):
        open(self.root + "/run/sbgpu", "w").write("x")
        self.assert_bootfile("file")

    def test_run_not_a_tmpfs(self):
        dev = os.stat(self.root + "/run").st_dev
        for majmin, fstype, extra in (("%d:%d" % (os.major(dev), os.minor(dev)), "ext4", ""),
                                      ("%d:%d" % (os.major(dev), os.minor(dev) + 1), "tmpfs", ""),
                                      ("%d:%d" % (os.major(dev), os.minor(dev)), "tmpfs",
                                       "30 25 0:99 / /run rw - ext4 /dev/x rw\n"),
                                      ("%d:%d" % (os.major(dev), os.minor(dev)), "tmpfs", "garbage\n")):
            write_mountinfo(self.root, majmin, fstype, extra)
            self.assert_bootfile((majmin, fstype, extra))

    def test_no_run_entry(self):
        with open(self.root + "/proc/self/mountinfo", "w") as f:
            f.write("22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n")
        self.assert_bootfile("no /run")

    def test_run_a_link(self):
        os.rename(self.root + "/run", self.root + "/realrun")
        os.symlink(self.root + "/realrun", self.root + "/run")
        self.assert_bootfile("run link")

    def test_a_mount_point_there(self):
        # (a directory on another device: here, a mountinfo whose /run is the tmpfs, and the made directory's device
        # reported as different, the way a mount there would be)
        real = os.fstat

        def fstat(fd):
            st = real(fd)
            if stat.S_ISDIR(st.st_mode) and st.st_ino == getattr(self, "made", None):
                return os.stat_result((st.st_mode, st.st_ino, st.st_dev + 1) + tuple(st)[3:])
            return st
        real_mkdir = os.mkdir

        def mkdir(name, mode=0o777, *, dir_fd=None):
            real_mkdir(name, mode, dir_fd=dir_fd)
            self.made = os.stat(name, dir_fd=dir_fd).st_ino
        with mock.patch.object(os, "fstat", fstat), mock.patch.object(os, "mkdir", mkdir):
            code, out = self.announce()
        self.assertEqual((code, out), (2, ""))
        self.assertEqual(holding(self.root, TOKEN), [])

    def test_replaced_between_mkdir_and_open(self):
        real_mkdir = os.mkdir

        def swap_link(name, mode=0o777, *, dir_fd=None):
            real_mkdir(name, mode, dir_fd=dir_fd)
            os.rmdir(name, dir_fd=dir_fd)
            os.symlink("/tmp", name, dir_fd=dir_fd)

        def swap_open(name, mode=0o777, *, dir_fd=None):
            real_mkdir(name, mode, dir_fd=dir_fd)
            os.rmdir(name, dir_fd=dir_fd)
            real_mkdir(name, 0o755, dir_fd=dir_fd)
            os.chmod(name, 0o755, dir_fd=dir_fd)
        for swap in (swap_link, swap_open):
            with mock.patch.object(os, "mkdir", swap):
                code, out = self.announce()
            self.assertEqual((code, out), (2, ""), swap.__name__)
            self.assertEqual(holding(self.root, TOKEN), [])
            st = os.lstat(self.root + "/run/sbgpu")
            self.assertTrue(stat.S_ISLNK(st.st_mode) or stat.S_IMODE(st.st_mode) == 0o755, swap.__name__)
            self.tearDown()
            self.root = make_root()


STAGES = ("open", "write", "fsync", "rename", "dirsync")


class HoldingOps(B.Ops):
    """The real calls, recorded; at `hold`, the stage is held while CLOCK_BOOTTIME moves to `to` (a suspend: the stub
    BOOTTIME alone moves), then released."""

    def __init__(self, clock, hold=None, to=None):
        self.clock, self.hold, self.to, self.calls = clock, hold, to, []

    def _stage(self, name):
        self.calls.append(name)
        if name == self.hold:
            self.clock.ms = self.to

    def open(self, name, d):
        self._stage("open")
        return B.Ops.open(self, name, d)

    def write(self, fd, data):
        self._stage("write")
        B.Ops.write(self, fd, data)

    def fsync(self, fd):
        self._stage("dirsync" if self.calls and self.calls[-1] == "rename" else "fsync")
        B.Ops.fsync(self, fd)

    def rename(self, tmp, name, d):
        self._stage("rename")
        B.Ops.rename(self, tmp, name, d)


class TestSuspendAcrossD(Base):
    """H7: each blocking call of each writer is held, CLOCK_BOOTTIME alone moves past D, the call is released: the
    write is refused, nothing after the held call runs, and nothing holding a secret is left.  Each row's twin moves the
    clock to just short of D (with room for the later bounds) and must succeed."""

    D = T0 + 80_000

    def run_boot(self, hold, to):
        ops = HoldingOps(self.clock, hold, to)
        with mock.patch.object(B, "OPS", ops):
            code, out = self.announce()
        return code, out, ops.calls

    def test_boot_json_held_across_d(self):
        for hold in STAGES:
            code, out, calls = self.run_boot(hold, self.D + 1000)
            self.assertEqual(code, 2, hold)
            self.assertNotIn("ok ", out, hold)
            self.assertEqual(calls, list(STAGES[:STAGES.index(hold) + 1]), hold)
            self.assertEqual(holding(self.root, TOKEN), [], hold)
            self.assertEqual(os.listdir(self.root + "/run/sbgpu"), [], hold)
            self.tearDown()
            self.root = make_root()
            self.clock.ms = T0

    def test_boot_json_held_just_short_of_d(self):
        for hold in STAGES:
            code, out, calls = self.run_boot(hold, self.D - 45_000)
            self.assertEqual(code, 0, hold)
            self.assertEqual(calls, list(STAGES), hold)
            self.tearDown()
            self.root = make_root()
            self.clock.ms = T0

    def test_exactly_at_d_is_late(self):
        code, out, calls = self.run_boot("write", self.D)
        self.assertEqual((code, calls), (2, ["open", "write"]))
        self.tearDown()
        self.root = make_root()
        self.clock.ms = T0
        code, out, calls = self.run_boot("write", self.D - 1)
        self.assertEqual(code, 0)

    def test_already_past_d_writes_nothing(self):
        def late():
            self.clock.ms = T0 + 10
        self.server.on_response = late
        ops = HoldingOps(self.clock)
        with mock.patch.object(B, "ENROLL_BY_MS", 0), mock.patch.object(B, "OPS", ops):
            code, out = self.announce()
        self.assertEqual(code, 2)
        self.assertEqual(ops.calls, [])

    def made(self):
        code, out = self.announce()
        self.assertEqual(code, 0)
        dev, ino = (int(x) for x in out.split("\n")[0].split()[1:])
        return dev, ino

    def gatefile(self, dev, ino, line=b'SBGPU-GATE {"v":1,"pass":true,"fail":[]}\n', deadline=None):
        return B.gatefile(self.root, self.D if deadline is None else deadline, dev, ino, io.BytesIO(line))

    def test_gate_json_held_across_d(self):
        for hold in STAGES:
            dev, ino = self.made()
            ops = HoldingOps(self.clock, hold, self.D + 1000)
            with mock.patch.object(B, "OPS", ops):
                self.assertEqual(self.gatefile(dev, ino), 2, hold)
            self.assertEqual(ops.calls, list(STAGES[:STAGES.index(hold) + 1]), hold)
            self.assertEqual(os.listdir(self.root + "/run/sbgpu"), ["boot.json"], hold)
            self.tearDown()
            self.root = make_root()
            self.clock.ms = T0

    def test_gate_json_held_just_short_of_d(self):
        for hold in STAGES:
            dev, ino = self.made()
            ops = HoldingOps(self.clock, hold, self.D - 45_000)
            with mock.patch.object(B, "OPS", ops):
                self.assertEqual(self.gatefile(dev, ino), 0, hold)
            self.assertEqual(ops.calls, list(STAGES), hold)
            self.tearDown()
            self.root = make_root()
            self.clock.ms = T0


class TestGateFile(Base):
    PASS = b'SBGPU-GATE {"v":1,"pass":true,"fail":[]}\n'

    def made(self):
        code, out = self.announce()
        self.assertEqual(code, 0)
        return tuple(int(x) for x in out.split("\n")[0].split()[1:])

    def test_writes_the_line_exactly(self):
        dev, ino = self.made()
        self.assertEqual(B.gatefile(self.root, T0 + 80_000, dev, ino, io.BytesIO(self.PASS)), 0)
        p = self.root + "/run/sbgpu/gate.json"
        self.assertEqual(open(p, "rb").read(), b'{"v":1,"pass":true,"fail":[]}')
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        self.assertEqual(sorted(os.listdir(self.root + "/run/sbgpu")), ["boot.json", "gate.json"])

    def test_only_a_pass(self):
        dev, ino = self.made()
        for line in (b'SBGPU-GATE {"v":1,"pass":false,"fail":["imds"]}\n', b'SBGPU-GATE {"v":1,"pass":true,"fail":["imds"]}\n',
                     b'SBGPU-GATE {"v":1,"pass":1,"fail":[]}\n', b'SBGPU-GATE {"v":true,"pass":true,"fail":[]}\n',
                     b'SBGPU-GATE {"v":1.0,"pass":true,"fail":[]}\n', b'SBGPU-GATE {"v":2,"pass":true,"fail":[]}\n',
                     b'SBGPU-GATE {"v":1,"pass":true,"fail":[],"x":1}\n', b'SBGPU-GATE {"v":1,"pass":true}\n',
                     b'SBGPU-GATE {"v":1,"v":1,"pass":true,"fail":[]}\n', b'SBGPU-GATE []\n',
                     b'SBGPU-GATE {"v":1,"pass":true,"fail":[]}', self.PASS + self.PASS, b"x" + self.PASS,
                     b'SBGPU-GATE  {"v":1,"pass":true,"fail":[]}\n'[:0] + b"SBGPU-GATE{}\n", b"", b"\xff\n",
                     b'SBGPU-GATE {"v":1,"pass":true,"fail":[]}' + b" " * 4096 + b"\n"):
            self.assertEqual(B.gatefile(self.root, T0 + 80_000, dev, ino, io.BytesIO(line)), 2, line)
            self.assertFalse(os.path.exists(self.root + "/run/sbgpu/gate.json"), line)

    def test_only_the_directory_the_announce_made(self):
        dev, ino = self.made()
        for d, i in ((dev, ino + 1), (dev + 1, ino)):
            self.assertEqual(B.gatefile(self.root, T0 + 80_000, d, i, io.BytesIO(self.PASS)), 2)
        os.chmod(self.root + "/run/sbgpu", 0o750)
        self.assertEqual(B.gatefile(self.root, T0 + 80_000, dev, ino, io.BytesIO(self.PASS)), 2)
        self.assertFalse(os.path.exists(self.root + "/run/sbgpu/gate.json"))


class TestRemaining(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        p = mock.patch.object(boottime, "boottime_ms", self.clock)
        p.start()
        self.addCleanup(p.stop)

    def remaining(self, deadline, margin):
        out = io.StringIO()
        return B.remaining(deadline, margin, out), out.getvalue()

    def test_whole_seconds_left_before_the_margin(self):
        self.assertEqual(self.remaining(T0 + 80_000, 30), (0, "50\n"))
        self.assertEqual(self.remaining(T0 + 31_999, 30), (0, "1\n"))
        self.assertEqual(self.remaining(T0 + 31_000, 30), (0, "1\n"))
        self.assertEqual(self.remaining(T0 + 30_999, 30), (1, "0\n"))
        self.assertEqual(self.remaining(T0 + 30_000, 30), (1, "0\n"))
        self.assertEqual(self.remaining(T0 - 1, 30), (1, "0\n"))
        self.assertEqual(self.remaining(T0 + 80_000, 25), (0, "55\n"))

    def test_a_suspend_before_it_reads(self):
        self.clock.ms = T0 + 81_000
        self.assertEqual(self.remaining(T0 + 80_000, 30), (1, "0\n"))


class TestScrub(Base):
    def test_removes_our_names_only(self):
        code, out = self.announce()
        dev, ino = (int(x) for x in out.split("\n")[0].split()[1:])
        d = self.root + "/run/sbgpu/"
        for name in (".boot.json.tmp", "gate.json", ".gate.json.tmp", "other"):
            open(d + name, "w").write("x")
        self.assertEqual(B.scrub(self.root, dev + 1, ino), 1)
        self.assertEqual(len(os.listdir(d)), 5)
        self.assertEqual(B.scrub(self.root, dev, ino), 0)
        self.assertEqual(os.listdir(d), ["other"])
        self.assertEqual(B.scrub(self.root, dev, ino), 0)

    def test_a_name_it_cant_remove(self):
        code, out = self.announce()
        dev, ino = (int(x) for x in out.split("\n")[0].split()[1:])
        os.mkdir(self.root + "/run/sbgpu/gate.json")
        self.assertEqual(B.scrub(self.root, dev, ino), 1)
        self.assertFalse(os.path.exists(self.root + "/run/sbgpu/boot.json"))


class TestMain(Base):
    def main(self, *argv, stdin=b""):
        out = io.StringIO()
        return B.main(list(argv), io.BytesIO(stdin), out), out.getvalue()

    def test_digest(self):
        self.assertEqual(self.main("digest", stdin=NONCE.encode()), (0, hashlib.sha256(NONCE.encode()).hexdigest() + "\n"))
        self.assertEqual(self.main("digest", stdin=b"x" * 65)[0], 2)

    def test_arguments(self):
        self.assertEqual(self.main("announce", self.root, URL, MACHINE, SCRIPT_SHA, stdin=NONCE.encode())[0], 3)
        self.assertEqual(self.server.conns, [])
        self.assertEqual(self.main("announce", self.root, URL, MACHINE, SCRIPT_SHA, AGENT_SHA, stdin=NONCE.encode())[0], 0)
        for argv in (("remaining", "1x", "30"), ("remaining", "-1", "30"), ("remaining", "1"), ("gatefile", self.root, "1", "2"),
                     ("scrub", self.root, "1"), ("scrub", self.root, "a", "1"), ("digest", "x"), ("nothing",), ()):
            self.assertEqual(self.main(*argv)[0], 2, argv)
        self.assertEqual(self.main("remaining", str(T0 + 80_000), "30"), (0, "50\n"))


if __name__ == "__main__":
    unittest.main()
