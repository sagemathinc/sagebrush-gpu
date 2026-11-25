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

# (joined at run time, never folded into a constant, so this file and its bytecode can't match a scan of the tree)
NAME = "_".join(("RUNPOD", "API", "KEY"))
SHAPE = "_".join(("rpa", "A1b2C3d4E5f6G7h8I9j0"))
LINE = re.compile(r'^SBGPU-PROBE \{"v":1,"boot":[1-9][0-9]*,"check":"(listen22-start|pid1|environ|files|metadata|history|'
                  r'listen22-end|done)",'
                  r'"pass":(true|false),"paths":\[.*\],"detail":"[a-z0-9-]{0,32}"\}$')
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (the kernel's socket tables, as /proc/net/tcp and tcp6 print them)
NET_HEAD = ("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n")
NET6_HEAD = ("  sl  local_address                         remote_address                        st tx_queue rx_queue tr "
             "tm->when retrnsmt   uid  timeout inode\n")


def row4(n, local, port, state, rport="0000"):
    return "%4d: %s:%s 00000000:%s %s 00000000:00000000 00:00000000 00000000     0        0 %d 1 0000000000000000 100 0 0 10 0\n" % (
        n, local, port, rport, state, 1000 + n)


def row6(n, local, port, state, rport="0000"):
    return "%4d: %s:%s %s:%s %s 00000000:00000000 00:00000000 00000000     0        0 %d 1 0000000000000000 100 0 0 10 0\n" % (
        n, local, port, "0" * 32, rport, state, 2000 + n)


def write_net(proc, rows4=(), rows6=()):
    """A /proc/net with these tcp and tcp6 rows (none: nothing listens on 22)."""
    os.makedirs(proc + "/net", exist_ok=True)
    with open(proc + "/net/tcp", "w") as f:
        f.write(NET_HEAD + "".join(rows4))
    with open(proc + "/net/tcp6", "w") as f:
        f.write(NET6_HEAD + "".join(rows6))


class Tree:
    """A temporary root (with root/proc as its /proc)."""

    def __init__(self, mounts="none / overlay rw 0 0\nproc /proc proc rw 0 0\nsysfs /sys sysfs ro 0 0\n"):
        self.dir = tempfile.mkdtemp(prefix="sbgpu-probe-")
        self.proc = self.dir + "/proc"
        os.makedirs(self.proc)
        self.write("/proc/mounts", mounts)
        write_net(self.proc, [row4(0, "0100007F", "1F90", "0A")], [row6(0, "0" * 32, "1F90", "0A")])

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

    def test_the_packaged_probe_with_its_bytecode_passes_its_own_file_scan(self):
        """As production runs it: the tarball built and unpacked, then imported and compiled by python -I -S with
        bytecode enabled (the launcher doesn't disable it), and the whole unpacked tree, .pyc files included,
        scanned."""
        import subprocess
        import sys
        import tarfile
        work = tempfile.mkdtemp(prefix="sbgpu-probe-pkg-")
        self.addCleanup(shutil.rmtree, work)
        build = os.path.join(os.path.dirname(os.path.dirname(HERE)), "scripts", "build-tarball.py")
        tgz = os.path.join(work, "probe.tar.gz")
        subprocess.run([sys.executable, "-I", build, HERE, tgz], check=True, capture_output=True)
        root = os.path.join(work, "root")
        with tarfile.open(tgz) as t:
            t.extractall(root, filter="data")
        env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
        agent = os.path.join(root, "sbgpu-agent")
        subprocess.run([sys.executable, "-I", "-S", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import sbgpu_probe.checks, sbgpu_probe.main", agent],
                       check=True, env=env, capture_output=True)
        subprocess.run([sys.executable, "-I", "-S", "-m", "compileall", "-q", agent], check=True, env=env, capture_output=True)
        pycs = [n for _, _, fs in os.walk(agent) for n in fs if n.endswith(".pyc")]
        self.assertGreaterEqual(len(pycs), 3, pycs)
        os.makedirs(os.path.join(root, "proc"))
        with open(os.path.join(root, "proc", "mounts"), "w") as f:
            f.write("none / overlay rw 0 0\nproc /proc proc rw 0 0\n")
        self.assertEqual(checks.check_files(root=root, proc=os.path.join(root, "proc")), (True, [], "ok"))

    def test_the_probe_writes_no_bytecode_when_run_as_production_runs_it(self):
        """The real entry, python -I -S <dir>, bytecode enabled (no PYTHON* settings): nothing of the probe's package
        is compiled to bytecode."""
        import subprocess
        import sys
        import tarfile
        work = tempfile.mkdtemp(prefix="sbgpu-probe-run-")
        self.addCleanup(shutil.rmtree, work)
        build = os.path.join(os.path.dirname(os.path.dirname(HERE)), "scripts", "build-tarball.py")
        tgz = os.path.join(work, "probe.tar.gz")
        subprocess.run([sys.executable, "-I", build, HERE, tgz], check=True, capture_output=True)
        with tarfile.open(tgz) as t:
            t.extractall(work, filter="data")
        agent = os.path.join(work, "sbgpu-agent")
        env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
        env["HOME"] = work  # (its boot counter's parent may not be writable here: the run is stopped before files)
        proc = subprocess.Popen([sys.executable, "-I", "-S", agent], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
        try:
            first = proc.stdout.readline().decode()
        finally:
            proc.kill()
            proc.wait()
            proc.stdout.close()
        pycs = [os.path.join(d, n) for d, _, fs in os.walk(agent) for n in fs if n.endswith(".pyc")]
        # (Python's runner compiles the entry, __main__.py, before any of its code runs: that one file only, which
        # holds nothing the probe looks for; nothing of sbgpu_probe is compiled, since bytecode is off before import)
        self.assertTrue(all(os.path.basename(p).startswith("__main__.") for p in pycs), pycs)
        for p in pycs:
            self.assertIsNone(checks.scan_file(p), p)
        # (it ran: the pid1 line, or nothing if it couldn't count its boot here)
        self.assertTrue(first == "" or first.startswith("SBGPU-PROBE "), first)

    def test_show(self):
        self.assertEqual(checks.show("/etc/a b\x01\\"), "/etc/a b\\x01\\x5c")
        self.assertEqual(checks.show("/x/" + NAME + ".txt"), "/x/<name>.txt")
        # (an assignment's whole value, up to the next separator, and every key shape: redacted before the name)
        self.assertEqual(checks.show("/d/" + NAME + "=legacySecretValue/f"), "/d/<name>=<redacted>/f")
        self.assertEqual(checks.show("/d/" + NAME + " : legacy.Secret-Value"), "/d/<name>=<redacted>")
        self.assertEqual(checks.show("/d/x" + SHAPE + "y/z"), "/d/x<redacted>/z")
        for p in ("/d/" + NAME + "=legacySecretValue", "/d/" + SHAPE, "/" + NAME + "/" + SHAPE + "/" + NAME + ":v"):
            out = checks.show(p)
            self.assertIsNone(checks.found(out.encode()), out)
            self.assertNotIn("legacySecretValue", out)
            self.assertNotIn(SHAPE[4:], out)
        self.assertEqual(len(checks.show("/" + "a" * 1000)), checks.PATH_BYTES)
        self.assertEqual(checks.show(b"/\xff"), "/\\xff")


class Listen22Test(Base):
    """Nothing may listen on TCP port 22: any LISTEN row on local port 0016, IPv4 or IPv6, fails; so do tables that are
    missing, too big or that don't parse.  Nothing about the sockets is reported."""

    def check(self, rows4=(), rows6=()):
        t = self.tree()
        write_net(t.proc, rows4, rows6)
        return checks.check_listen22(t.proc + "/net")

    def test_listeners_on_22_fail_others_dont(self):
        other = [row4(0, "0100007F", "1F90", "0A"), row4(1, "0A000002", "0016", "01", rport="D431"),  # (22, established)
                 row4(2, "00000000", "0017", "0A"), row4(3, "00000000", "1F90", "0A", rport="0016")]  # (23; 22 remote)
        self.assertEqual(self.check(other, [row6(0, "0" * 32, "0050", "0A")]), (True, [], "no-listener"))
        self.assertEqual(self.check(), (True, [], "no-listener"))
        for rows4, rows6 in (([row4(0, "00000000", "0016", "0A")], []),                    # (0.0.0.0:22)
                             ([row4(0, "0100007F", "0016", "0A")], []),                    # (127.0.0.1:22 too)
                             ([], [row6(0, "0" * 32, "0016", "0A")]),                      # (IPv6 [::]:22)
                             (other + [row4(9, "00000000", "0016", "0A")], [])):           # (after other rows)
            self.assertEqual(self.check(rows4, rows6), (False, [], "listener"), (rows4, rows6))

    def test_unreadable_or_malformed_tables_fail_closed(self):
        t = self.tree()
        os.unlink(t.proc + "/net/tcp6")
        self.assertEqual(checks.check_listen22(t.proc + "/net"), (False, [], "unreadable"))
        t = self.tree()
        os.unlink(t.proc + "/net/tcp")
        self.assertEqual(checks.check_listen22(t.proc + "/net"), (False, [], "unreadable"))
        for tcp in ("", "nonsense\n", NET_HEAD + "   0: 00000000:16 00000000:0000 0A x\n",
                    NET_HEAD + "   0: 0000000:0016 00000000:0000 0A x\n", NET_HEAD + "garbage\n",
                    NET_HEAD + row4(0, "00000000", "0016", "0a").replace(" 0a ", " 0a\t")):
            t = self.tree()
            t.write("/proc/net/tcp", tcp)
            self.assertEqual(checks.check_listen22(t.proc + "/net"), (False, [], "unreadable"), tcp)
        # (over the bound, cut exactly after a whole row: only the size check, not a torn row, can refuse it)
        t = self.tree()
        row = row4(0, "00000000", "1F90", "0A")
        t.write("/proc/net/tcp", NET_HEAD + row * 3)
        t.write("/proc/net/tcp6", NET_HEAD)  # (within the bound: tcp alone is over it)
        saved = checks.NET_MAX
        checks.NET_MAX = len(NET_HEAD) + len(row)
        try:
            self.assertEqual(checks.check_listen22(t.proc + "/net"), (False, [], "unreadable"))
        finally:
            checks.NET_MAX = saved

    def test_the_real_tables_parse(self):
        # (this host's own tables: whatever listens here, they are read and parsed, never "unreadable")
        if not (os.path.exists("/proc/net/tcp") and os.path.exists("/proc/net/tcp6")):
            self.skipTest("no /proc/net here")
        ok, paths, detail = checks.check_listen22("/proc/net")
        self.assertIn(detail, ("listener", "no-listener"))
        self.assertEqual((ok, paths), (detail == "no-listener", []))


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

    def test_names_and_link_targets_are_scanned_and_reported_without_leaking(self):
        cases = [
            ("a file name", lambda t: t.write("/opt/" + SHAPE, "clean")),
            ("an assignment as a file name", lambda t: t.write("/opt/" + NAME + "=legacySecretValue", "clean")),
            ("a directory name", lambda t: t.write("/opt/" + NAME + "/f", "clean")),
            ("a symlink's name", lambda t: os.symlink("/nowhere", t.dir + "/" + SHAPE)),
            ("a symlink's target text", lambda t: os.symlink("/x/" + NAME + "=legacySecretValue", t.dir + "/link")),
            ("a directory symlink's target text", lambda t: os.symlink("/x/" + SHAPE, t.dir + "/linkdir")),
        ]
        for why, make in cases:
            t = Tree()
            try:
                make(t)
                ok, paths, detail = checks.check_files(root=t.dir, proc=t.proc)
                self.assertFalse(ok, why)
                self.assertIn(detail, ("found-name", "found-shape"), why)
                self.assertTrue(paths, why)
                for p in paths:
                    self.assertIsNone(checks.found(p.encode()), (why, p))
                    self.assertNotIn("legacySecretValue", p, why)
                out = main.line(1, "files", ok, paths, detail)
                self.assertIsNone(checks.found(out.encode()), (why, out))
                self.assertNotIn("legacySecretValue", out, why)
            finally:
                t.close()

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

    def test_a_traversal_error_fails(self):
        t = self.tree()
        t.write("/a", "clean")
        real = checks.os.walk

        def walk(top, **kw):
            kw["onerror"](PermissionError(13, "denied", t.dir + "/hidden"))
            return real(top, **kw)
        checks.os.walk = walk
        try:
            self.assertEqual(checks.check_files(root=t.dir, proc=t.proc), (False, [], "unreadable"))
        finally:
            checks.os.walk = real

    def test_unreadable_directory_fails(self):
        if os.geteuid() == 0:
            self.skipTest("root reads everything")
        t = self.tree()
        t.write("/locked/inside", NAME)
        os.chmod(t.dir + "/locked", 0)
        self.assertEqual(checks.check_files(root=t.dir, proc=t.proc), (False, [], "unreadable"))

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

    def test_bodies_at_and_past_the_cap(self):
        cap = checks.METADATA_BODY_MAX
        one = checks.METADATA_ENDPOINTS[0][0]

        def serve(body):
            return lambda url, headers, timeout: (200, body) if url == one else None
        self.assertEqual(checks.check_metadata(get=serve(b"a" * cap)), (True, [one], "ok"))
        self.assertEqual(checks.check_metadata(get=serve(b"a" * (cap + 1))), (False, [one], "oversized"))
        # (the key just past the cap: what get() returns is cap + 1 bytes, so it's oversized, not clean)
        self.assertEqual(checks.check_metadata(get=serve((b"a" * cap + SHAPE.encode())[:cap + 1])), (False, [one], "oversized"))

    def test_http_get_reads_one_byte_past_the_cap(self):
        import http.server
        import threading
        cap = checks.METADATA_BODY_MAX
        body = b"a" * cap + SHAPE.encode()

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            status, got = checks.http_get("http://127.0.0.1:%d/" % srv.server_address[1], {}, 5)
            self.assertEqual((status, len(got)), (200, cap + 1))
            url = "http://127.0.0.1:%d/" % srv.server_address[1]
            self.assertEqual(checks.check_metadata(endpoints=((url, {}),))[2], "oversized")
        finally:
            srv.shutdown()
            srv.server_close()

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
        # (a real capture, made by the probe-only prologue, as on a probe pod)
        from test_capture import random_key, run_prologue
        cap = t.dir + "/opt/sbgpu/probe-capture"
        if not os.path.exists(cap):
            r, _ = run_prologue(t.dir + "/opt/sbgpu", random_key("rpa"))
            self.assertEqual(r.returncode, 0, r.stderr)
        out = io.StringIO()
        boot = main.run(out=out, root=t.dir, proc=t.proc, pid=1, boots_file=boots, get=lambda *a: None, capture_file=cap, **kw)
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

    def test_a_listener_fails_both_listen22_lines_and_every_check_still_runs(self):
        t = self.tree()
        t.process(1)
        write_net(t.proc, [], [row6(0, "0" * 32, "0016", "0A")])
        boot, lines = self.run_once(t, t.dir + "/opt/sbgpu/probe-boots")
        got = [json.loads(x[len("SBGPU-PROBE "):]) for x in lines]
        self.assertEqual([o["check"] for o in got], list(main.CHECK_ORDER))
        for o in got:
            if o["check"].startswith("listen22"):
                self.assertEqual((o["pass"], o["paths"], o["detail"]), (False, [], "listener"))
            else:
                self.assertTrue(o["pass"], o)

    def test_listen22_end_looks_again_rather_than_reusing_the_start(self):
        # (the tables change while the checks run: a listener appearing, one going away, the tables becoming unreadable;
        # listen22-end must see the tables as they are then, not the start's answer)
        listener = [row4(0, "00000000", "0016", "0A")]
        for before, during, want in (
                ([], lambda proc: write_net(proc, listener), [(True, "no-listener"), (False, "listener")]),
                (listener, lambda proc: write_net(proc), [(False, "listener"), (True, "no-listener")]),
                ([], lambda proc: os.unlink(proc + "/net/tcp6"), [(True, "no-listener"), (False, "unreadable")])):
            t = self.tree()
            t.process(1)
            write_net(t.proc, before)
            real = checks.check_history

            def history(*a, **kw):
                during(t.proc)
                return real(*a, **kw)
            checks.check_history = history
            try:
                boot, lines = self.run_once(t, t.dir + "/opt/sbgpu/probe-boots")
            finally:
                checks.check_history = real
            got = {o["check"]: o for o in (json.loads(x[len("SBGPU-PROBE "):]) for x in lines)}
            self.assertEqual([(got[c]["pass"], got[c]["detail"]) for c in ("listen22-start", "listen22-end")], want)

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
