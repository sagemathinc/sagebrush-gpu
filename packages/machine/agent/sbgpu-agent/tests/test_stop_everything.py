"""The machine's stop (sbgpu_agent/proctree.stop_everything): every other process in the container ended, as PID 1.

Unit rows drive it with an injected kill against a fake /proc.  The real row runs it as PID 1 of a child PID namespace
(unshare), where kill(-1) can only reach that namespace; it is skipped where namespaces aren't allowed, and never runs
kill(-1) outside one.
"""
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sbgpu_agent import proctree as P  # noqa: E402


class FakeProc:
    """A fake /proc whose processes react to signals: `term` die on SIGTERM, the others need SIGKILL; `late` appears
    after the first SIGKILL (a fork that raced the census); `zombie` stays as a zombie and doesn't count."""

    def __init__(self, term=(), stubborn=(), late=(), zombie=(), unkillable=()):
        self.dir = tempfile.mkdtemp(prefix="sbgpu-fakeproc-")
        self.term, self.stubborn, self.late, self.unkillable = set(term), set(stubborn), set(late), set(unkillable)
        self.signals = []
        self.t = 0.0
        for pid in (1, *term, *stubborn, *unkillable):
            self.add(pid)
        for pid in zombie:
            self.add(pid, "Z")
        self.kills = 0

    def add(self, pid, state="S"):
        os.makedirs("%s/%d" % (self.dir, pid), exist_ok=True)
        with open("%s/%d/stat" % (self.dir, pid), "w") as f:
            f.write("%d (x) %s 1 %d %d 0" % (pid, state, pid, pid))

    def remove(self, pid):
        shutil.rmtree("%s/%d" % (self.dir, pid), ignore_errors=True)

    def kill(self, pid, sig):
        assert pid == -1, pid
        self.signals.append(sig)
        if sig == signal.SIGTERM:
            for p in self.term:
                self.remove(p)
        if sig == signal.SIGKILL:
            for p in self.stubborn | self.term:
                self.remove(p)
            self.kills += 1
            if self.kills == 1:
                for p in self.late:
                    self.add(p)
            elif self.kills == 2:
                for p in self.late:
                    self.remove(p)

    def clock(self):
        return self.t

    def sleep(self, s):
        self.t += s

    def run(self, pid=1):
        return P.stop_everything(pid=pid, proc=self.dir, kill=self.kill, sleep=self.sleep, clock=self.clock, reap=lambda: None)

    def close(self):
        shutil.rmtree(self.dir)


class UnitTest(unittest.TestCase):
    def fake(self, **kw):
        f = FakeProc(**kw)
        self.addCleanup(f.close)
        return f

    def test_term_is_enough(self):
        f = self.fake(term=(10, 11), zombie=(12,))
        self.assertEqual(f.run(), [])
        self.assertEqual(f.signals, [signal.SIGTERM])

    def test_kill_after_the_term_wait(self):
        f = self.fake(term=(10,), stubborn=(20,))
        self.assertEqual(f.run(), [])
        self.assertEqual(f.signals, [signal.SIGTERM, signal.SIGKILL])
        self.assertGreaterEqual(f.t, P.STOP_LIMITS["termWaitS"])

    def test_a_late_process_is_caught_by_the_next_census(self):
        f = self.fake(stubborn=(20,), late=(30,))
        self.assertEqual(f.run(), [])
        self.assertEqual(f.signals, [signal.SIGTERM, signal.SIGKILL, signal.SIGKILL])

    def test_bounded_when_something_never_ends(self):
        f = self.fake(unkillable=(40,))
        self.assertEqual(f.run(), [40])
        self.assertLessEqual(f.t, P.STOP_LIMITS["termWaitS"] + P.STOP_LIMITS["capS"] + 2 * P.STOP_LIMITS["everyS"])

    def test_only_as_pid_1(self):
        f = self.fake(term=(10,))
        with self.assertRaises(RuntimeError):
            f.run(pid=7)
        self.assertEqual(f.signals, [])

    def test_zombies_and_self_dont_count(self):
        f = self.fake(zombie=(12, 13))
        self.assertEqual(P.other_processes(f.dir, 1), [])
        f.add(14)
        self.assertEqual(P.other_processes(f.dir, 1), [14])


INNER = r"""
import os, subprocess, sys, time
sys.path.insert(0, sys.argv[1])
from sbgpu_agent import proctree as P
assert os.getpid() == 1
# (a terminal-like session with a job, and a process that escaped it with setsid)
subprocess.Popen(["sh", "-c", "sleep 600 & sleep 600"], start_new_session=True)
subprocess.Popen([sys.executable, "-c", "import os, time; os.setsid(); time.sleep(600)"])
time.sleep(0.5)
assert len(P.other_processes()) >= 3, P.other_processes()
print("LEFT", P.stop_everything())
"""


def namespace_runner():
    """The command prefix that runs a child as PID 1 of a new PID namespace, or None."""
    for prefix in (["unshare", "--user", "--map-root-user", "--pid", "--fork", "--mount-proc"],
                   ["sudo", "-n", "unshare", "--pid", "--fork", "--mount-proc"]):
        try:
            r = subprocess.run(prefix + ["true"], capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            continue
        if r.returncode == 0:
            return prefix
    return None


class NamespaceTest(unittest.TestCase):
    def test_everything_ends_setsid_included(self):
        prefix = namespace_runner()
        if prefix is None:
            self.skipTest("no PID namespaces here (unshare not permitted)")
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        r = subprocess.run(prefix + [sys.executable, "-I", "-c", INNER, here], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("LEFT []", r.stdout)


if __name__ == "__main__":
    unittest.main()
