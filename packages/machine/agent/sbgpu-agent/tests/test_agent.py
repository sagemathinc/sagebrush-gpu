"""The agent's unit tests: python3 -m unittest discover -s tests (from packages/machine/agent/sbgpu-agent;
src/agent.test.ts runs them inside the package's node tests)."""

import json
import os
import shutil
import tempfile
import unittest

from sbgpu_agent import eradication, main
from sbgpu_agent.control import Control, ControlError

TOKEN = "A" * 20 + "b-_" + "9" * 20


def clean_environ(extra=()):
    names = list(eradication.ENV_FIXED) + list(extra)
    return b"".join(("%s=x\0" % n).encode() for n in names)


class Fs:
    """A fake /proc and / under a temporary directory."""

    def __init__(self, environ=None, pids=(1,)):
        self.dir = tempfile.mkdtemp(prefix="sbgpu-agent-")
        self.proc = self.dir + "/proc"
        self.root = self.dir + "/root"
        for pid in pids:
            os.makedirs("%s/%d" % (self.proc, pid))
            with open("%s/%d/environ" % (self.proc, pid), "wb") as f:
                f.write(clean_environ() if environ is None else environ)
        os.makedirs(self.root + "/run/sbgpu")
        os.makedirs(self.proc + "/sys")  # a non-numeric entry, as in a real /proc

    def write(self, path, data):
        os.makedirs(os.path.dirname(self.root + path), exist_ok=True)
        with open(self.root + path, "wb") as f:
            f.write(data)

    def boot(self, **over):
        boot = {"controlUrl": "https://control.example.com", "mode": "container", "bootToken": TOKEN,
                "providerMachineId": "pod-1", "agentSha256": "a" * 64}
        boot.update(over)
        self.write("/run/sbgpu/boot.json", json.dumps(boot).encode())

    def close(self):
        shutil.rmtree(self.dir)


class EradicationTest(unittest.TestCase):
    def setUp(self):
        self.fs = None

    def tearDown(self):
        if self.fs:
            self.fs.close()

    def checks(self, fs, pid=1, container=True):
        self.fs = fs
        return eradication.run_checks(proc=fs.proc, root=fs.root, pid=pid, container=container)

    def test_clean(self):
        report, reason = self.checks(Fs(environ=clean_environ(["CUDA_VERSION", "TZ"])))
        self.assertIsNone(reason)
        self.assertEqual(report, {"ok": True, "checks": [{"name": "env", "ok": True}, {"name": "processes", "ok": True}, {"name": "files", "ok": True}]})

    def test_env_extra_name(self):
        for extra in (["RUNPOD_API_KEY"], ["SBGPU_BOOT_TOKEN"], ["PUBLIC_KEY"], ["PATH"]):  # (PATH twice: a duplicate)
            report, reason = self.checks(Fs(environ=clean_environ(extra)))
            self.assertEqual(reason, "env-not-clean", extra)
            self.assertFalse(report["ok"])
            self.assertEqual(report["checks"][0], {"name": "env", "ok": False})
            self.fs.close()
            self.fs = None

    def test_env_missing_fixed_name(self):
        environ = b"".join(("%s=x\0" % n).encode() for n in eradication.ENV_FIXED[1:])
        self.assertEqual(self.checks(Fs(environ=environ))[1], "env-not-clean")

    def test_env_unreadable_fails_closed(self):
        fs = Fs()
        os.unlink(fs.proc + "/1/environ")
        self.assertEqual(self.checks(fs)[1], "env-not-clean")

    def test_other_process(self):
        self.assertEqual(self.checks(Fs(pids=(1, 57)))[1], "extra-process")

    def test_not_pid1_in_container_mode(self):
        fs = Fs(pids=(7,))
        self.assertEqual(self.checks(fs, pid=7)[1], "extra-process")

    def test_not_pid1_allowed_in_vm_mode(self):
        self.assertIsNone(self.checks(Fs(pids=(7,)), pid=7, container=False)[1])

    def test_forbidden_file(self):
        fs = Fs()
        fs.write("/etc/rp_environment", b"")
        self.assertEqual(self.checks(fs)[1], "key-file")

    def test_key_name_in_scanned_files(self):
        for path in eradication.SCANNED_FILES + ("/etc/profile.d/runpod.sh",):
            fs = Fs()
            fs.write(path, b"export RUNPOD_API_KEY=rpa_x\n")
            self.assertEqual(self.checks(fs)[1], "key-file", path)
            fs.close()
            self.fs = None

    def test_scanned_files_without_the_key_pass(self):
        fs = Fs()
        fs.write("/etc/environment", b'PATH="/usr/bin"\n')
        fs.write("/etc/profile.d/x.sh", b"export A=1\n")
        self.assertIsNone(self.checks(fs)[1])

    def test_huge_scanned_file_fails_closed(self):
        fs = Fs()
        fs.write("/root/.bashrc", b"#" * (eradication.SCAN_MAX + 1))
        self.assertEqual(self.checks(fs)[1], "key-file")

    def test_first_failure_names_the_reason(self):
        fs = Fs(environ=clean_environ(["RUNPOD_API_KEY"]), pids=(1, 2))
        fs.write("/etc/rp_environment", b"")
        report, reason = self.checks(fs)
        self.assertEqual(reason, "env-not-clean")
        self.assertEqual([c["ok"] for c in report["checks"]], [False, False, False])


class FakeControl:
    """A transport recording calls and answering from a script of responses per path."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        path = url.split("https://control.example.com", 1)[1]
        self.calls.append((path, headers, json.loads(body)))
        queue = self.answers.get(path)
        if not queue:
            return 500, b'{"error":{"code":"internal"}}'
        status, payload = queue.pop(0) if len(queue) > 1 else queue[0]
        return status, json.dumps(payload).encode() if not isinstance(payload, bytes) else payload


ENROLLED = {"machineId": "mch_1", "agentToken": "agent-tok-1", "agentTokenExpiresAt": "2026-11-25T00:00:00Z",
            "incarnation": 1, "relayUrl": "wss://relay.example.com", "heartbeatSeconds": 30,
            "idle": {"minutes": 30, "gpuUtilThresholdPct": 5}, "maxSessionEndsAt": "2026-11-25T08:00:00Z",
            "setupScript": None, "workspace": {"restore": True}}


def no_gpu(*a, **k):
    raise FileNotFoundError("nvidia-smi")


class StartTest(unittest.TestCase):
    def setUp(self):
        self.fs = Fs()
        self.sleeps = []

    def tearDown(self):
        self.fs.close()

    def start(self, control, **kw):
        return main.start(self.fs.root, transport=control, proc=self.fs.proc, pid=1, run_gpu=no_gpu,
                          sleep=self.sleeps.append, **kw)

    def test_enroll_then_heartbeats(self):
        self.fs.boot()
        control = FakeControl({"/v1/agent/enroll": [(200, ENROLLED)],
                               "/v1/agent/heartbeat": [(200, {"commands": []}), (200, {"agentToken": "agent-tok-2", "commands": []}), (200, {"commands": []})]})
        self.assertEqual(self.start(control, max_beats=3), 0)
        paths = [c[0] for c in control.calls]
        self.assertEqual(paths, ["/v1/agent/enroll"] + ["/v1/agent/heartbeat"] * 3)
        enroll = control.calls[0]
        self.assertNotIn("authorization", enroll[1])
        self.assertEqual(enroll[2]["bootToken"], TOKEN)
        self.assertEqual(enroll[2]["providerMachineId"], "pod-1")
        self.assertEqual(enroll[2]["mode"], "container")
        self.assertTrue(enroll[2]["eradication"]["ok"])
        self.assertIsNone(enroll[2]["gpu"])
        self.assertEqual(control.calls[1][1]["authorization"], "Bearer agent-tok-1")
        self.assertEqual(control.calls[3][1]["authorization"], "Bearer agent-tok-2")  # the refreshed token
        self.assertEqual(control.calls[1][2]["incarnation"], 1)
        self.assertEqual(self.sleeps, [30, 30, 30])
        self.assertFalse(os.path.exists(self.fs.root + "/run/sbgpu/boot.json"), "boot.json is removed")

    def test_failed_check_aborts_and_never_enrolls(self):
        self.fs.boot()
        self.fs.write("/etc/rp_environment", b"")
        control = FakeControl({"/v1/agent/abort": [(200, {})]})
        self.assertEqual(self.start(control), 3)
        self.assertEqual(control.calls, [("/v1/agent/abort", control.calls[0][1], {"bootToken": TOKEN, "reason": "key-file"})])

    def test_abort_failure_still_stops(self):
        self.fs.boot()
        self.fs.write("/etc/rp_environment", b"")
        self.assertEqual(self.start(FakeControl({})), 3)

    def test_refused_enroll_stops(self):
        self.fs.boot()
        control = FakeControl({"/v1/agent/enroll": [(403, {"error": {"code": "tokenReused"}})]})
        self.assertEqual(self.start(control), 3)
        self.assertEqual(len(control.calls), 1)

    def test_enroll_without_incarnation_stops(self):
        self.fs.boot()
        bad = dict(ENROLLED)
        del bad["incarnation"]
        self.assertEqual(self.start(FakeControl({"/v1/agent/enroll": [(200, bad)]})), 3)

    def test_bad_or_missing_boot_json(self):
        self.assertEqual(self.start(FakeControl({})), 3)
        self.fs.boot(mode="pod")
        with self.assertRaises(main.BootError):
            main.read_boot(self.fs.root)
        # A complete boot.json, padded past the cap, is refused for its size alone.
        self.fs.boot()
        path = self.fs.root + "/run/sbgpu/boot.json"
        with open(path, "rb") as f:
            good = f.read()
        self.fs.write("/run/sbgpu/boot.json", good + b" " * (main.BOOT_JSON_MAX - len(good)))
        self.assertEqual(main.read_boot(self.fs.root)["mode"], "container")
        self.fs.write("/run/sbgpu/boot.json", good + b" " * (main.BOOT_JSON_MAX + 1 - len(good)))
        with self.assertRaises(main.BootError):
            main.read_boot(self.fs.root)
        self.assertFalse(os.path.exists(path))

    def test_empty_provider_machine_id_is_sent_as_null(self):
        self.fs.boot(providerMachineId="")
        control = FakeControl({"/v1/agent/enroll": [(403, {})]})
        self.start(control)
        self.assertIsNone(control.calls[0][2]["providerMachineId"])

    def test_heartbeat_refused_stops(self):
        self.fs.boot()
        control = FakeControl({"/v1/agent/enroll": [(200, ENROLLED)], "/v1/agent/heartbeat": [(401, {"error": {"code": "unauthorized"}})]})
        self.assertEqual(self.start(control, max_beats=5), 3)

    def test_heartbeat_errors_back_off_then_recover(self):
        self.fs.boot()
        control = FakeControl({"/v1/agent/enroll": [(200, ENROLLED)],
                               "/v1/agent/heartbeat": [(503, b"busy"), (500, {}), (500, {}), (200, {"commands": []})]})
        self.assertEqual(self.start(control, max_beats=4), 0)
        self.assertEqual(self.sleeps, [1, 2, 4, 30])

    def test_commands(self):
        self.fs.boot()
        control = FakeControl({"/v1/agent/enroll": [(200, ENROLLED)],
                               "/v1/agent/heartbeat": [(200, {"commands": [{"id": "cmd_1", "op": "save"}, {"id": "cmd_1", "op": "save"}, {"id": "cmd_x", "op": "dance"}]}),
                                                       (200, {"commands": [{"id": "cmd_2", "op": "stop"}]})],
                               "/v1/agent/save-status": [(200, {"ok": True})]})
        self.assertEqual(self.start(control, max_beats=10), 0)
        self.assertEqual([c[0] for c in control.calls].count("/v1/agent/heartbeat"), 2, "a stop ends the loop")
        status = [c[2] for c in control.calls if c[0] == "/v1/agent/save-status"]
        self.assertEqual([s["commandId"] for s in status], ["cmd_1", "cmd_2"])
        self.assertEqual(status[0]["save"]["state"], "failed")

    def test_revoke(self):
        self.fs.boot()
        control = FakeControl({"/v1/agent/enroll": [(200, ENROLLED)], "/v1/agent/heartbeat": [(200, {"commands": [{"id": "c", "op": "revoke"}]})]})
        self.assertEqual(self.start(control, max_beats=10), 3)

    def test_heartbeat_interval_is_clamped(self):
        for given, used in ((1, 5), (10_000, 300), ("30", 30), (45, 45)):
            agent = main.Agent(Control("https://control.example.com", FakeControl({})), dict(ENROLLED, heartbeatSeconds=given))
            self.assertEqual(agent.heartbeat_s, used, given)


class ControlTest(unittest.TestCase):
    def test_https_only(self):
        with self.assertRaises(ControlError) as e:
            Control("http://127.0.0.1:9").enroll({})
        self.assertIn("must be https", str(e.exception))

    def test_oversized_and_non_json_answers(self):
        cap = 1024 * 1024
        fits = b'{"agentToken":"t","pad":"' + b"x" * (cap - 27) + b'"}'
        self.assertEqual(len(fits), cap)
        self.assertEqual(Control("https://control.example.com", lambda *a: (200, fits)).enroll({})["agentToken"], "t")
        for status, body in ((200, fits[:-2] + b'x"}'), (200, b"not json"), (200, b"[1]")):
            c = Control("https://control.example.com", lambda *a, s=status, b=body: (s, b))
            with self.assertRaises(ControlError):
                c.enroll({})

    def test_error_status_is_kept(self):
        c = Control("https://control.example.com", lambda *a: (403, b'{"error":{"code":"forbidden"}}'))
        with self.assertRaises(ControlError) as e:
            c.enroll({})
        self.assertTrue(e.exception.refused)

    def test_calls_need_a_token(self):
        with self.assertRaises(ControlError):
            Control("https://control.example.com", lambda *a: (200, b"{}")).heartbeat({})

    def test_malformed_commands_are_dropped(self):
        c = Control("https://control.example.com", lambda *a: (200, json.dumps({"commands": [{"id": 1, "op": "stop"}, {"id": "a"}, "x", {"id": "b", "op": "save"}]}).encode()))
        c.token = "t"
        self.assertEqual(c.heartbeat({}), [{"id": "b", "op": "save"}])


class GpuInfoTest(unittest.TestCase):
    def run_with(self, stdout, rc=0):
        class R:
            returncode = rc
        R.stdout = stdout
        return main.gpu_info(lambda *a, **k: R)

    def test_parse(self):
        self.assertEqual(self.run_with("NVIDIA L4, 23034\nNVIDIA L4, 23034\n"), {"name": "NVIDIA L4", "count": 2, "memoryMiB": 23034})
        self.assertIsNone(self.run_with(""))
        self.assertIsNone(self.run_with("NVIDIA L4, n/a\n"))
        self.assertIsNone(self.run_with("NVIDIA L4, 1\n", rc=9))
        self.assertIsNone(main.gpu_info(no_gpu))


if __name__ == "__main__":
    unittest.main()
