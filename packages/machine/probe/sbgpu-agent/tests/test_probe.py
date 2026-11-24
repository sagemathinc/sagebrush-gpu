"""The probe agent's checks and its output (sbgpu_probe), against fake /proc and filesystem trees.

    python3 -m unittest discover -s tests      (from packages/machine/probe/sbgpu-agent)
"""

import io
import json
import os
import re
import shutil
import tempfile
import unittest

from sbgpu_probe import checks, main

NAME = "RUN" + "POD_API_KEY"  # (split here too, so this file can't match a scan of the probe's own tree)
SHAPE = "rp" + "a_" + "A1b2C3d4E5f6G7h8I9j0"
LINE = re.compile(r'^SBGPU-PROBE \{"v":1,"boot":[1-9][0-9]*,"check":"(pid1|environ|files|metadata|history|done)",'
                  r'"pass":(true|false),"paths":\[.*\],"detail":"[a-z0-9-]{0,32}"\}$')
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Tree:
    """A temporary root (with root/proc as its /proc)."""

    def __init__(self, mounts="none / overlay rw 0 0\nproc /proc proc rw 0 0\nsysfs /sys sysfs ro 0 0\n"):
        self.dir = tempfile.mkdtemp(prefix="sbgpu-probe-")
        self.proc = self.dir + "/proc"
        os.makedirs(self.proc)
        self.write("/proc/mounts", mounts)

    def write(self, path, data, mode=None):
        p = self.dir + path
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data.encode() if isinstance(data, str) else data)
        if mode is not None:
            os.chmod(p, mode)
        return p

    def process(self, pid, environ=b"PATH=/usr/bin\0", cmdline=b"/usr/bin/python3\0-I\0-S\0/opt/sbgpu/agent/x/sbgpu-agent\0",
                tasks=None):
        self.write("/proc/%d/environ" % pid, environ)
        self.write("/proc/%d/cmdline" % pid, cmdline)
        for tid, env in (tasks or {}).items():
            self.write("/proc/%d/task/%d/environ" % (pid, tid), env)

    def close(self):
        for dirpath, dirnames, filenames in os.walk(self.dir):
            for n in dirnames + filenames:
                try:
                    os.chmod(os.path.join(dirpath, n), 0o700)
                except OSError:
                    pass
        shutil.rmtree(self.dir)


class Base(unittest.TestCase):
    def tree(self, **kw):
        t = Tree(**kw)
        self.addCleanup(t.close)
        return t


class FoundTest(Base):
    def test_name_and_shapes(self):
        self.assertEqual(checks.found(b"x " + NAME.encode() + b" y"), "found-name")
        self.assertEqual(checks.found(b"key " + SHAPE.encode()), "found-shape")
        self.assertEqual(checks.found(b"rp" + b"a_short"), None)  # (too short for a key)
        self.assertEqual(checks.found(b"RUNPOD_POD_ID=abc PATH=/x"), None)
        self.assertEqual(checks.found(NAME.encode() + b"=" + SHAPE.encode()), "found-name")

    def test_the_probe_never_contains_what_it_looks_for(self):
        for dirpath, _, filenames in os.walk(HERE):
            for n in filenames:
                if n.endswith(".py"):
                    self.assertIsNone(checks.scan_file(os.path.join(dirpath, n)), n)

    def test_show(self):
        self.assertEqual(checks.show("/etc/a b\x01\\"), "/etc/a b\\x01\\x5c")
        self.assertEqual(checks.show("/x/" + NAME + ".txt"), "/x/<name>.txt")
        self.assertEqual(len(checks.show("/" + "a" * 1000)), checks.PATH_BYTES)
        self.assertEqual(checks.show(b"/\xff"), "/\\xff")


class Pid1Test(Base):
    def test_pid1(self):
        t = self.tree()
        t.process(1)
        self.assertEqual(checks.check_pid1(proc=t.proc, pid=1), (True, [], "ok"))

    def test_not_pid1(self):
        t = self.tree()
        t.process(1)
        self.assertEqual(checks.check_pid1(proc=t.proc, pid=7)[2], "not-pid1")

    def test_another_process(self):
        t = self.tree()
        t.process(1)
        t.process(23)
        ok, paths, detail = checks.check_pid1(proc=t.proc, pid=1)
        self.assertEqual((ok, detail), (False, "extra-process"))
        self.assertEqual(paths, [checks.show(t.proc + "/23")])

    def test_unexpected_cmdline(self):
        for cmd in (b"/bin/sh\0-c\0x\0", b"/usr/bin/python3\0/tmp/other\0", b""):
            t = self.tree()
            t.process(1, cmdline=cmd)
            self.assertEqual(checks.check_pid1(proc=t.proc, pid=1)[2], "unexpected-cmdline", cmd)

    def test_unreadable_cmdline(self):
        t = self.tree()
        t.process(1)
        os.unlink(t.proc + "/1/cmdline")
        self.assertEqual(checks.check_pid1(proc=t.proc, pid=1)[2], "unreadable")


class EnvironTest(Base):
    def test_clean(self):
        t = self.tree()
        t.process(1, tasks={1: b"PATH=/usr/bin\0", 9: b"HOME=/root\0"})
        self.assertEqual(checks.check_environ(proc=t.proc), (True, [], "ok"))

    def test_name_in_a_process_or_a_thread(self):
        t = self.tree()
        t.process(1)
        t.process(40, environ=b"A=1\0" + NAME.encode() + b"=x\0")
        t.process(41, tasks={42: b"X=" + SHAPE.encode() + b"\0"})
        ok, paths, detail = checks.check_environ(proc=t.proc)
        self.assertFalse(ok)
        self.assertEqual(detail, "found-name")
        self.assertEqual(sorted(paths), sorted([checks.show(t.proc + "/40/environ"), checks.show(t.proc + "/41/task/42/environ")]))

    def test_unreadable_fails(self):
        if os.geteuid() == 0:
            self.skipTest("root reads everything")
        t = self.tree()
        t.process(1)
        os.chmod(t.proc + "/1/environ", 0)
        self.assertEqual(checks.check_environ(proc=t.proc)[2], "unreadable")


class FilesTest(Base):
    def test_clean_tree(self):
        t = self.tree()
        t.write("/etc/environment", 'PATH="/usr/bin"\n')
        t.write("/opt/app/model.bin", os.urandom(4096).replace(b"rpa", b"xxx"))
        self.assertEqual(checks.check_files(root=t.dir, proc=t.proc), (True, [], "ok"))

    def test_found_anywhere_with_its_path(self):
        t = self.tree()
        t.write("/etc/rp_environment", "export " + NAME + "=abc\n")
        t.write("/var/log/deep/x.log", "token " + SHAPE)
        ok, paths, detail = checks.check_files(root=t.dir, proc=t.proc)
        self.assertEqual((ok, detail), (False, "found-name"))
        self.assertEqual(paths, ["/etc/rp_environment", "/var/log/deep/x.log"])

    def test_across_a_chunk_boundary(self):
        t = self.tree()
        saved = checks.CHUNK
        checks.CHUNK = 1000
        try:
            t.write("/big", b"a" * 990 + NAME.encode() + b"b" * 2000)
            self.assertEqual(checks.check_files(root=t.dir, proc=t.proc)[2], "found-name")
        finally:
            checks.CHUNK = saved

    def test_virtual_mounts_proc_sys_dev_skipped_and_symlinks_not_followed(self):
        t = self.tree(mounts="none / overlay rw 0 0\nproc /proc proc rw 0 0\ncg /mnt/cg cgroup2 rw 0 0\n")
        t.process(1, environ=NAME.encode() + b"=x\0")  # (/proc: environ's job, not the walk's)
        t.write("/sys/x", NAME)
        t.write("/dev/x", NAME)
        t.write("/mnt/cg/x", NAME)
        outside = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, outside)
        with open(outside + "/secret", "w") as f:
            f.write(NAME)
        os.symlink(outside + "/secret", t.dir + "/link")
        os.symlink(outside, t.dir + "/linkdir")
        self.assertEqual(checks.check_files(root=t.dir, proc=t.proc), (True, [], "ok"))

    def test_paths_capped(self):
        t = self.tree()
        for i in range(30):
            t.write("/f/%02d" % i, SHAPE)
        ok, paths, detail = checks.check_files(root=t.dir, proc=t.proc)
        self.assertEqual((ok, detail, len(paths)), (False, "found-shape", checks.PATHS_MAX))

    def test_timeout(self):
        t = self.tree()
        t.write("/a", "x")
        t.write("/b", "y")
        clock = iter([0, 100, 200]).__next__
        self.assertEqual(checks.check_files(root=t.dir, proc=t.proc, deadline=50, clock=clock)[2], "timeout")

    def test_unreadable_file_fails(self):
        if os.geteuid() == 0:
            self.skipTest("root reads everything")
        t = self.tree()
        t.write("/locked", "x", mode=0)
        self.assertEqual(checks.check_files(root=t.dir, proc=t.proc), (False, [], "unreadable"))

    def test_no_mounts_fails(self):
        t = self.tree()
        os.unlink(t.proc + "/mounts")
        self.assertEqual(checks.check_files(root=t.dir, proc=t.proc), (False, [], "unreadable"))


class MetadataTest(Base):
    def test_nothing_reachable(self):
        self.assertEqual(checks.check_metadata(get=lambda *a: None), (True, [], "ok"))

    def test_reachable_but_clean_passes_and_says_where(self):
        got = []

        def get(url, headers, timeout):
            got.append((url, headers, timeout))
            return (200, b"instance-id: i-1") if url.startswith("http://169.254.169.254/latest") else None
        ok, paths, detail = checks.check_metadata(get=get)
        self.assertEqual((ok, detail), (True, "ok"))
        self.assertEqual(paths, ["http://169.254.169.254/latest/meta-data/", "http://169.254.169.254/latest/user-data"])
        self.assertEqual([u for u, _, _ in got], [u for u, _ in checks.METADATA_ENDPOINTS])
        self.assertTrue(all(t == checks.METADATA_TIMEOUT_S for _, _, t in got))

    def test_a_credential_in_a_body_fails(self):
        def get(url, headers, timeout):
            return (200, b'{"Token":"' + SHAPE.encode() + b'"}') if "170.2/v2/credentials" in url else (404, b"")
        ok, paths, detail = checks.check_metadata(get=get)
        self.assertEqual((ok, detail, paths), (False, "found-shape", ["http://169.254.170.2/v2/credentials"]))

    def test_the_list_is_fixed_and_link_local(self):
        for url, headers in checks.METADATA_ENDPOINTS:
            self.assertRegex(url, r"^http://169\.254\.(169\.254|170\.2)/")
            self.assertIsInstance(headers, dict)


class HistoryTest(Base):
    def test_clean_and_found(self):
        t = self.tree()
        t.write("/root/.bash_history", "ls\n")
        self.assertEqual(checks.check_history(root=t.dir), (True, [], "ok"))
        t.write("/home/u/.python_history", "k = '" + SHAPE + "'\n")
        t.write("/root/.zsh_history", "echo $" + NAME + "\n")
        ok, paths, detail = checks.check_history(root=t.dir)
        self.assertEqual((ok, detail), (False, "found-name"))
        self.assertEqual(sorted(paths), ["/home/u/.python_history", "/root/.zsh_history"])


class RunTest(Base):
    def run_once(self, t, boots, **kw):
        out = io.StringIO()
        boot = main.run(out=out, root=t.dir, proc=t.proc, pid=1, boots_file=boots, get=lambda *a: None, **kw)
        return boot, out.getvalue().splitlines()

    def test_lines_in_order_with_the_boot_count(self):
        t = self.tree()
        t.process(1)
        boots = t.dir + "/opt/sbgpu/probe-boots"
        boot, lines = self.run_once(t, boots)
        self.assertEqual(boot, 1)
        self.assertEqual([json.loads(x[len("SBGPU-PROBE "):])["check"] for x in lines], list(main.CHECK_ORDER))
        for x in lines:
            self.assertRegex(x, LINE)
            o = json.loads(x[len("SBGPU-PROBE "):])
            self.assertEqual(list(o), ["v", "boot", "check", "pass", "paths", "detail"])
            self.assertTrue(o["pass"], x)
            self.assertIsNone(checks.found(x.encode()), x)
        boot2, lines2 = self.run_once(t, boots)
        self.assertEqual(boot2, 2)
        self.assertTrue(all('"boot":2,' in x for x in lines2))

    def test_a_finding_and_an_error(self):
        t = self.tree()
        t.process(1, environ=NAME.encode() + b"=x\0")
        saved = checks.check_history
        checks.check_history = lambda **kw: 1 / 0
        try:
            _, lines = self.run_once(t, t.dir + "/boots")
        finally:
            checks.check_history = saved
        got = {json.loads(x[12:])["check"]: json.loads(x[12:]) for x in lines}
        self.assertEqual((got["environ"]["pass"], got["environ"]["detail"]), (False, "found-name"))
        self.assertEqual((got["history"]["pass"], got["history"]["detail"]), (False, "error"))
        self.assertTrue(got["done"]["pass"])
        for x in lines:
            self.assertIsNone(checks.found(x.encode()), x)  # (the name is never printed, even when found)


if __name__ == "__main__":
    unittest.main()
