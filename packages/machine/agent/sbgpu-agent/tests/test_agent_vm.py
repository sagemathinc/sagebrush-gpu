"""The agent in VM mode (sbgpu_agent/main.py start_vm): boot.json and gate.json read once through /run/sbgpu and removed,
the enroll deadline D held on CLOCK_BOOTTIME at the start and just before the request (a suspend across D, modelled at
the clock, sends nothing), and the enroll itself: no providerMachineId, gate 2's report."""

import asyncio
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sbgpu_agent import boottime, main, vmboot  # noqa: E402
from sbgpu_agent.control import ControlError  # noqa: E402
from test_agent import ENROLLED, FakeControl, no_gpu  # noqa: E402
from test_vmboot import CALLS, Clock, HeldResolver, Server, fake_getaddrinfo, returning_at  # noqa: E402
import socket  # noqa: E402

TOKEN = "A" * 20 + "b-_" + "9" * 20
T0 = 5_000_000
D = T0 + 80_000
GATE = b'{"v":1,"pass":true,"fail":[]}'


class VmFs:
    """/run/sbgpu as the launcher leaves it, under a temporary prefix."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="sbgpu-agent-vm-")
        self.dir = self.root + "/run/sbgpu"
        os.makedirs(self.root + "/run")
        os.mkdir(self.dir, 0o700)

    def put(self, name, data, mode=0o600):
        fd = os.open(self.dir + "/" + name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        os.write(fd, data)
        os.close(fd)
        os.chmod(self.dir + "/" + name, mode)

    def boot(self, raw=None, **over):
        boot = {"controlUrl": "https://control.example.com", "mode": "vm", "bootToken": TOKEN, "agentSha256": "a" * 64,
                "enrollByBoottimeMs": D}
        boot.update(over)
        self.put("boot.json", raw if raw is not None else json.dumps(boot).encode())

    def both(self, **over):
        self.boot(**over)
        self.put("gate.json", GATE)

    def left(self):
        return sorted(os.listdir(self.dir))

    def close(self):
        shutil.rmtree(self.root)


class VmTest(unittest.TestCase):
    def setUp(self):
        self.fs = VmFs()
        self.clock = Clock(T0)
        p = mock.patch.object(boottime, "boottime_ms", self.clock)
        p.start()
        self.addCleanup(p.stop)
        self.err = io.StringIO()
        self.sleeps = []

    def tearDown(self):
        self.fs.close()

    def start(self, control, run_gpu=no_gpu, **kw):
        async def no_sleep(s):
            await asyncio.sleep(0.01)
        kw.setdefault("max_beats", 1)  # (so a refusal that wrongly enrolls ends, and fails, at once)
        return main.start_vm(self.fs.root, transport=control, run_gpu=run_gpu, sleep=self.sleeps.append,
                             cwd=self.fs.root, relay_sleep=no_sleep, hostname=lambda: "vm-1", err=self.err.write, **kw)

    def enrolling(self):
        return FakeControl({"/v1/agent/enroll": [(200, ENROLLED)], "/v1/agent/heartbeat": [(200, {"commands": []})]})

    def timeouts(self):
        seen = []
        control = self.enrolling()
        real = control.__call__

        def transport(method, url, headers, body, timeout):
            seen.append((url.rsplit("/", 1)[1], timeout))
            return real(method, url, headers, body, timeout)
        return transport, control, seen

    def assert_failed(self, word, control, why=None):
        self.assertEqual(self.err.getvalue(), 'SBGPU-AGENT {"v":1,"fail":["%s"]}\n' % word, why)
        self.assertEqual(control.calls, [], why)
        self.assertEqual(self.fs.left(), [], why)


class TestEnroll(VmTest):
    def test_enrolls_with_no_provider_id_and_the_gate(self):
        self.fs.both()
        transport, control, seen = self.timeouts()
        self.assertEqual(self.start(transport, max_beats=1), 0)
        self.assertEqual([c[0] for c in control.calls], ["/v1/agent/enroll", "/v1/agent/heartbeat"])
        path, headers, body = control.calls[0]
        self.assertNotIn("authorization", headers)
        self.assertEqual(body, {"bootToken": TOKEN, "agentVersion": main.AGENT_VERSION, "agentSha256": "a" * 64,
                                "mode": "vm", "gate": {"v": 1, "pass": True, "fail": []}, "gpu": None, "hostname": "vm-1"})
        self.assertEqual(seen[0], ("enroll", 20))
        self.assertEqual(seen[1], ("heartbeat", 20))  # (the heartbeat's own timeout, control.TIMEOUT_S)
        self.assertEqual(self.fs.left(), [])
        self.assertEqual(self.err.getvalue(), "")

    def test_a_long_hostname_is_cut(self):
        self.fs.both()
        control = self.enrolling()
        main.start_vm(self.fs.root, transport=control, run_gpu=no_gpu, sleep=self.sleeps.append, cwd=self.fs.root,
                      hostname=lambda: "h" * 300, err=self.err.write, max_beats=1)
        self.assertEqual(control.calls[0][2]["hostname"], "h" * 253)

    def test_refused_or_bad_enroll(self):
        for answer in ((403, {}), (500, {}), (200, {"agentToken": "x"}), (200, dict(ENROLLED, relayUrl=7))):
            self.fs.both()
            self.err = io.StringIO()
            control = FakeControl({"/v1/agent/enroll": [answer]})
            self.assertEqual(self.start(control), 3, answer)
            self.assertEqual(self.err.getvalue(), 'SBGPU-AGENT {"v":1,"fail":["enroll"]}\n', answer)
            self.assertEqual(len(control.calls), 1, answer)

    def test_the_real_transport_is_bounded_by_its_timeout(self):
        p = mock.patch.object(socket, "getaddrinfo", fake_getaddrinfo)
        p.start()
        self.addCleanup(p.stop)
        server = Server(status=200, body=json.dumps(ENROLLED).encode())
        with mock.patch.object(vmboot, "HTTPS", server.factory):
            self.assertEqual(main.vm_transport("POST", "https://c.example.com/v1/agent/enroll", {}, b"{}", 7.5),
                             (200, json.dumps(ENROLLED).encode()))
        self.assertEqual(server.conns[0].timeouts[0], 7.5)
        self.assertEqual(server.requests[0][3], "/v1/agent/enroll")

        def late():
            self.clock.ms = T0 + 7_500
        server.on_response = late
        with mock.patch.object(vmboot, "HTTPS", server.factory), self.assertRaises(ControlError):
            main.vm_transport("POST", "https://c.example.com/v1/agent/enroll", {}, b"{}", 7.5)
        server.on_response = None
        # (each blocking call returning exactly at the timeout, or 1 ms past it, is late; 1 ms before it is not)
        for call in CALLS:
            for at, late in ((T0 + 7_500, True), (T0 + 7_501, True), (T0 + 7_499, False)):
                self.clock.ms = T0
                with mock.patch.object(vmboot, "HTTPS", server.factory), returning_at(server, self.clock, call, at):
                    if late:
                        with self.assertRaises(ControlError, msg=(call, at)):
                            main.vm_transport("POST", "https://c.example.com/v1/agent/enroll", {}, b"{}", 7.5)
                    else:
                        self.assertEqual(main.vm_transport("POST", "https://c.example.com/v1/agent/enroll", {}, b"{}", 7.5)[0], 200)
        # (H2: the lookup held at the timeout, or 1 ms past it: abandoned there, nothing connects; 1 ms before, it goes on)
        for at, late in ((T0 + 7_500, True), (T0 + 7_501, True), (T0 + 7_499, False)):
            self.clock.ms = T0
            held = HeldResolver(self.clock, at, release=not late)
            self.addCleanup(held.go.set)
            before = len(server.conns)
            with mock.patch.object(vmboot, "HTTPS", server.factory), mock.patch.object(socket, "getaddrinfo", held):
                if late:
                    with self.assertRaises(ControlError, msg=at):
                        main.vm_transport("POST", "https://c.example.com/v1/agent/enroll", {}, b"{}", 7.5)
                    self.assertEqual(len(server.conns), before, at)
                else:
                    self.assertEqual(main.vm_transport("POST", "https://c.example.com/v1/agent/enroll", {}, b"{}", 7.5)[0], 200)
            held.go.set()
        self.clock.ms = T0
        server.connect_error = OSError("x")
        with mock.patch.object(vmboot, "HTTPS", server.factory), self.assertRaises(ControlError):
            main.vm_transport("POST", "https://c.example.com/v1/agent/enroll", {}, b"{}", 7.5)

    def test_main_dispatches_on_vm(self):
        for argv, which in ((["sbgpu-agent", "vm"], "start_vm"), (["sbgpu-agent"], "start"), (["sbgpu-agent", "vm", "x"], "start")):
            with mock.patch.object(sys, "argv", argv), mock.patch.object(main, "start_vm", return_value=7) as vm, \
                    mock.patch.object(main, "start", return_value=8) as ct, self.assertRaises(SystemExit) as e:
                main.main()
            self.assertEqual(e.exception.code, 7 if which == "start_vm" else 8, argv)


class TestTheFiles(VmTest):
    def refuse(self, why):
        self.err = io.StringIO()
        control = self.enrolling()
        self.assertEqual(self.start(control), 3, why)
        self.assert_failed("boot-files", control, why)

    def test_boot_json(self):
        bad = {
            "providerMachineId string": {"providerMachineId": "i-1"},
            "providerMachineId empty": {"providerMachineId": ""},
            "providerMachineId null": {"providerMachineId": None},
            "extra": {"x": 1},
            "container mode": {"mode": "container"},
            "http": {"controlUrl": "http://control.example.com"},
            "url not a string": {"controlUrl": 1},
            "short token": {"bootToken": TOKEN[:-1]},
            "padded token": {"bootToken": TOKEN[:-1] + "="},
            "token not a string": {"bootToken": None},
            "short sha": {"agentSha256": "a" * 63},
            "upper sha": {"agentSha256": "A" * 64},
            "deadline a string": {"enrollByBoottimeMs": str(D)},
            "deadline a bool": {"enrollByBoottimeMs": True},
            "deadline a float": {"enrollByBoottimeMs": float(D)},
            "deadline zero": {"enrollByBoottimeMs": 0},
        }
        for why, over in bad.items():
            self.fs.both(**over)
            self.refuse(why)
        for key in main.VM_BOOT_KEYS:
            boot = {"controlUrl": "https://control.example.com", "mode": "vm", "bootToken": TOKEN, "agentSha256": "a" * 64,
                    "enrollByBoottimeMs": D}
            del boot[key]
            self.fs.boot(raw=json.dumps(boot).encode())
            self.fs.put("gate.json", GATE)
            self.refuse(key)
        for raw in (b"", b"[]", b"{", b"\xff", json.dumps({"mode": "vm", "mode ": 1}).encode(),
                    ('{"controlUrl":"https://c.example.com","mode":"vm","mode":"vm","bootToken":"%s","agentSha256":"%s",'
                     '"enrollByBoottimeMs":%d}' % (TOKEN, "a" * 64, D)).encode()):
            self.fs.boot(raw=raw)
            self.fs.put("gate.json", GATE)
            self.refuse(raw)

    def test_gate_json(self):
        for gate in (b'{"v":1,"pass":false,"fail":["imds"]}', b'{"v":1,"pass":true,"fail":["imds"]}', b'{"v":1,"pass":1,"fail":[]}',
                     b'{"v":true,"pass":true,"fail":[]}', b'{"v":1,"pass":true,"fail":[],"x":0}', b'{"v":1,"v":1,"pass":true,"fail":[]}',
                     b"", b"[]", b"SBGPU-GATE " + GATE):
            self.fs.boot()
            self.fs.put("gate.json", gate)
            self.refuse(gate)

    def test_sizes(self):
        boot = json.dumps({"controlUrl": "https://control.example.com", "mode": "vm", "bootToken": TOKEN,
                           "agentSha256": "a" * 64, "enrollByBoottimeMs": D}).encode()
        self.fs.boot(raw=boot + b" " * (main.VM_FILE_MAX - len(boot)))
        self.fs.put("gate.json", GATE + b" " * (main.VM_FILE_MAX - len(GATE)))
        control = self.enrolling()
        self.assertEqual(self.start(control, max_beats=1), 0)
        self.fs.boot(raw=boot + b" " * (main.VM_FILE_MAX + 1 - len(boot)))
        self.fs.put("gate.json", GATE)
        self.refuse("boot.json too large")
        self.fs.boot()
        self.fs.put("gate.json", GATE + b" " * (main.VM_FILE_MAX + 1 - len(GATE)))
        self.refuse("gate.json too large")

    def test_either_missing_and_both_still_removed(self):
        self.fs.boot()
        self.refuse("no gate.json")
        self.fs.put("gate.json", GATE)
        self.refuse("no boot.json")
        self.refuse("neither")

    def test_modes_owner_and_links(self):
        self.fs.boot()
        self.fs.put("gate.json", GATE, mode=0o640)
        self.refuse("gate.json 0640")
        self.fs.put("boot.json", b"{}", mode=0o644)
        self.fs.put("gate.json", GATE)
        self.refuse("boot.json 0644")
        target = self.fs.root + "/elsewhere.json"
        with open(target, "wb") as f:
            f.write(json.dumps({"controlUrl": "https://control.example.com", "mode": "vm", "bootToken": TOKEN,
                                "agentSha256": "a" * 64, "enrollByBoottimeMs": D}).encode())
        os.chmod(target, 0o600)
        os.symlink(target, self.fs.dir + "/boot.json")
        self.fs.put("gate.json", GATE)
        self.refuse("boot.json a link")
        self.assertTrue(os.path.exists(target))
        os.mkfifo(self.fs.dir + "/boot.json", 0o600)
        self.fs.put("gate.json", GATE)
        self.refuse("boot.json a fifo")
        # a file owned by someone else (reported so by fstat: the test can't chown)
        self.fs.both()
        real = os.fstat

        def fstat(fd):
            st = real(fd)
            if not os.path.isdir("/proc/self/fd/%d" % fd):
                return os.stat_result(tuple(st)[:4] + (st.st_uid + 1,) + tuple(st)[5:])
            return st
        with mock.patch.object(os, "fstat", fstat):
            self.refuse("a file of another owner")
        # the directory of another owner: refused before anything in it is touched
        self.fs.both()
        control = self.enrolling()
        self.err = io.StringIO()
        with mock.patch.object(vmboot, "owner_uid", lambda prefix: os.geteuid() + 1):
            self.assertEqual(self.start(control), 3)
        self.assertEqual(self.err.getvalue(), 'SBGPU-AGENT {"v":1,"fail":["boot-files"]}\n')
        self.assertEqual(control.calls, [])
        self.assertEqual(self.fs.left(), ["boot.json", "gate.json"])

    def test_the_directory(self):
        self.fs.both()
        os.chmod(self.fs.dir, 0o750)
        control = self.enrolling()
        self.assertEqual(self.start(control), 3)
        self.assertEqual(self.err.getvalue(), 'SBGPU-AGENT {"v":1,"fail":["boot-files"]}\n')
        self.assertEqual(control.calls, [])
        os.chmod(self.fs.dir, 0o700)
        os.rename(self.fs.dir, self.fs.root + "/real")
        os.symlink(self.fs.root + "/real", self.fs.dir)
        self.err = io.StringIO()
        self.assertEqual(self.start(control), 3)
        self.assertEqual(self.err.getvalue(), 'SBGPU-AGENT {"v":1,"fail":["boot-files"]}\n')
        self.assertEqual(sorted(os.listdir(self.fs.root + "/real")), ["boot.json", "gate.json"])


class TestTheDeadline(VmTest):
    """D, held at the agent's start (at least 20 s left) and just before the request (at least 2 s; the request's
    timeouts are what is left minus 1 s, at most 20 s)."""

    def test_at_start_exactly_20_s_proceeds(self):
        self.fs.both()
        self.clock.ms = D - 20_000
        transport, control, seen = self.timeouts()
        self.assertEqual(self.start(transport, max_beats=1), 0)
        self.assertEqual(seen[0], ("enroll", 19.0))

    def test_at_start_20_s_less_1_ms_refuses(self):
        self.fs.both()
        self.clock.ms = D - 19_999
        control = self.enrolling()
        self.assertEqual(self.start(control), 3)
        self.assert_failed("enroll-late", control)

    def gpu_then(self, to):
        def run_gpu(*a, **k):
            self.clock.ms = to
            raise FileNotFoundError("nvidia-smi")
        return run_gpu

    def test_before_the_request_exactly_2_s_proceeds_with_1_s(self):
        self.fs.both()
        transport, control, seen = self.timeouts()
        self.assertEqual(self.start(transport, run_gpu=self.gpu_then(D - 2_000), max_beats=1), 0)
        self.assertEqual(seen[0], ("enroll", 1.0))

    def test_before_the_request_less_than_2_s_sends_nothing(self):
        for to in (D - 1_999, D - 1, D, D + 1, D + 3_600_000):
            self.fs.both()
            self.err = io.StringIO()
            control = self.enrolling()
            self.clock.ms = T0
            self.assertEqual(self.start(control, run_gpu=self.gpu_then(to)), 3, to)
            self.assert_failed("enroll-late", control, to)

    def test_the_timeout_is_what_is_left_less_1_s_at_most_20(self):
        for to, want in ((T0, 20), (D - 21_000, 20), (D - 20_999, 19.999), (D - 9_500, 8.5)):
            self.fs.both()
            transport, control, seen = self.timeouts()
            self.clock.ms = T0
            self.assertEqual(self.start(transport, run_gpu=self.gpu_then(to), max_beats=1), 0, to)
            self.assertEqual(seen[0], ("enroll", want), to)

    def test_a_wall_clock_jump_changes_nothing(self):
        import time as t
        for jump in (3600.0, -3600.0):
            self.fs.both()
            transport, control, seen = self.timeouts()
            with mock.patch.object(t, "time", lambda: 1_800_000_000.0 + jump):
                self.assertEqual(self.start(transport, max_beats=1), 0, jump)
            self.assertEqual(seen[0], ("enroll", 20), jump)


class TestSuspendAcrossD(VmTest):
    """H7, the agent's two stages: held, CLOCK_BOOTTIME alone moved past D, released: no enroll request is sent.
    Each twin stops short of D (with room for the later bounds) and enrolls exactly once."""

    def test_held_at_exec_before_the_first_check(self):
        self.fs.both()
        self.clock.ms = D + 1_000  # (the exec and the interpreter's start held across D)
        control = self.enrolling()
        self.assertEqual(self.start(control), 3)
        self.assert_failed("enroll-late", control)

    def test_held_at_exec_twin(self):
        self.fs.both()
        self.clock.ms = D - 25_000
        control = self.enrolling()
        self.assertEqual(self.start(control, max_beats=1), 0)
        self.assertEqual([c[0] for c in control.calls].count("/v1/agent/enroll"), 1)

    def held_before_the_request(self, to):
        """Held after both files are read and removed, before the request (the GPU query is where it is held)."""
        self.fs.both()
        seen_files = []

        def run_gpu(*a, **k):
            seen_files.append(self.fs.left())
            self.clock.ms = to
            raise FileNotFoundError("nvidia-smi")
        control = self.enrolling()
        code = self.start(control, run_gpu=run_gpu, max_beats=1)
        self.assertEqual(seen_files, [[]])  # (both already removed when it is held)
        return code, control

    def test_held_before_the_request(self):
        code, control = self.held_before_the_request(D + 1_000)
        self.assertEqual(code, 3)
        self.assert_failed("enroll-late", control)

    def test_held_before_the_request_twin(self):
        code, control = self.held_before_the_request(D - 5_000)
        self.assertEqual(code, 0)
        self.assertEqual([c[0] for c in control.calls].count("/v1/agent/enroll"), 1)


if __name__ == "__main__":
    unittest.main()
