"""The VM gate (sbgpu_agent/vmgate.py) against fake root and /proc trees: a locked-down VM passes, and each way a VM
can fail does, with its fixed word only."""

import hashlib
import io
import json
import os
import shutil
import socket
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sbgpu_agent import vmgate as G  # noqa: E402

NET_HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
SYSTEMD, RESOLVED, PY = "/usr/lib/systemd/systemd", "/usr/lib/systemd/systemd-resolved", "/usr/bin/python3.12"
ALLOW = {"v": 1, "processes": [SYSTEMD, RESOLVED, PY], "mounts": [],
         "loopback": [{"process": RESOLVED, "proto": "udp", "address": "127.0.0.53", "port": 53},
                      {"process": RESOLVED, "proto": "tcp", "address": "127.0.0.53", "port": 53}]}


def hex4(ip):
    return socket.inet_aton(ip)[::-1].hex().upper()


def hex6(ip):
    raw = socket.inet_pton(socket.AF_INET6, ip)
    return "".join(raw[i:i + 4][::-1].hex().upper() for i in range(0, 16, 4))


def row(n, local, port, state, inode, remote="00000000", rport=0):
    return "%4d: %s:%04X %s:%04X %s 00000000:00000000 00:00000000 00000000     0        0 %d 2 0000000000000000 0\n" % (
        n, local, port, remote, rport, state, inode)


class VM:
    """A fake VM: root/ (with etc, lib, home, opt, dev) and root/proc, locked down as the launcher leaves it."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="sbgpu-vmgate-")
        self.proc = os.path.join(self.root, "proc")
        os.makedirs(self.proc)
        self.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\nubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n"
                                 "nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin\n")
        for home in ("root", "home/ubuntu"):
            self.write(home + "/.ssh/authorized_keys", "")
        for unit in ("ssh.service", "ssh.socket"):
            self.write("lib/systemd/system/" + unit, "[Unit]\n")
            self.link("etc/systemd/system/" + unit, "/dev/null")
        self.link("etc/systemd/system/sshd.service", "/lib/systemd/system/ssh.service")  # (the alias Ubuntu ships)
        self.mountinfo("/")
        self.process(1, "systemd", SYSTEMD)
        self.process(300, "systemd-resolve", RESOLVED, sockets=(7001, 7002))
        self.tables(tcp=[row(0, hex4("127.0.0.53"), 53, "0A", 7002)], udp=[row(0, hex4("127.0.0.53"), 53, "07", 7001)])

    def path(self, p):
        return os.path.join(self.root, p)

    def write(self, p, data, mode=None):
        p = self.path(p)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data.encode() if isinstance(data, str) else data)
        return p

    def link(self, p, target):
        p = self.path(p)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if os.path.lexists(p):
            os.unlink(p)
        os.symlink(target, p)

    def process(self, pid, comm, exe, env=b"PATH=/usr/bin\0", cmd=None, sockets=(), kthread=False):
        base = "proc/%d/" % pid
        flags = G.PF_KTHREAD if kthread else 0x400100
        self.write(base + "stat", "%d (%s) S 0 %d %d 0 -1 %d 0 0 0 0\n" % (pid, comm, pid, pid, flags))
        self.write(base + "comm", comm + "\n")
        if not kthread:
            self.link(base + "exe", exe)  # (a kernel thread has none)
        self.write(base + "environ", env)
        self.write(base + "cmdline", cmd if cmd is not None else exe.encode() + b"\0")
        os.makedirs(self.path(base + "fd"), exist_ok=True)
        for i, inode in enumerate(sockets):
            self.link(base + "fd/%d" % (i + 3), "socket:[%d]" % inode)

    def mountinfo(self, *points):
        self.write("proc/self/mountinfo", "".join(
            "%d 1 8:%d / %s rw,relatime shared:1 - ext4 /dev/sda%d rw\n" % (20 + i, i, p, i) for i, p in enumerate(points)))

    def tables(self, tcp=(), tcp6=(), udp=(), udp6=()):
        for name, rows in (("tcp", tcp), ("tcp6", tcp6), ("udp", udp), ("udp6", udp6)):
            self.write("proc/net/" + name, NET_HEAD + "".join(rows))

    def run(self, allow=ALLOW, known=(), imds=False):
        def connect():
            if imds:
                class S:
                    def close(self):
                        pass
                return S()
            raise ConnectionRefusedError()
        return G.run(allow, known, root=self.root, proc=self.proc, connect=connect, self_pid=999999)

    def close(self):
        shutil.rmtree(self.root)


class Base(unittest.TestCase):
    def vm(self):
        v = VM()
        self.addCleanup(v.close)
        return v


class CleanTest(Base):
    def test_a_locked_down_vm_passes(self):
        self.assertEqual(self.vm().run(), (True, []))

    def test_the_line_has_fixed_words_only(self):
        self.assertEqual(G.line(False, ["listener-22", "process"]), 'SBGPU-GATE {"v":1,"pass":false,"fail":["listener-22","process"]}')
        v = self.vm()
        v.write("home/ubuntu/.ssh/authorized_keys", "ssh-ed25519 AAAA secret@host\n")
        v.process(400, "evil", "/tmp/evil-binary-name")
        ok, words = v.run()
        self.assertFalse(ok)
        self.assertTrue(set(words) <= set(G.WORDS), words)
        self.assertNotIn("evil", json.dumps(words))


class SshTest(Base):
    def test_units_resolve_through_the_search_path_and_aliases(self):
        self.assertEqual(G.unit_state(self.vm().root, "sshd.service"), "masked")  # (the alias, to a masked unit)
        v = self.vm()
        os.unlink(v.path("etc/systemd/system/ssh.service"))
        self.assertEqual(v.run(), (False, ["ssh-unit"]))  # (the alias now resolves to a live unit too)
        # (a mask in /etc is overridden by a live unit higher up the path)
        v = self.vm()
        v.write("run/systemd/transient/ssh.service", "[Unit]\n")
        self.assertEqual(v.run(), (False, ["ssh-unit"]))
        # (sshd.service as a unit of its own, unmasked)
        v = self.vm()
        os.unlink(v.path("etc/systemd/system/sshd.service"))
        v.write("usr/lib/systemd/system/sshd.service", "[Unit]\n")
        self.assertEqual(v.run(), (False, ["ssh-unit"]))
        # (the socket unit live)
        v = self.vm()
        os.unlink(v.path("etc/systemd/system/ssh.socket"))
        self.assertEqual(v.run(), (False, ["ssh-unit"]))
        # (no ssh installed at all: fine)
        v = self.vm()
        for p in ("lib/systemd/system/ssh.service", "lib/systemd/system/ssh.socket", "etc/systemd/system/ssh.service",
                  "etc/systemd/system/ssh.socket", "etc/systemd/system/sshd.service"):
            os.unlink(v.path(p))
        self.assertEqual(v.run(), (True, []))

    def test_a_running_sshd_fails(self):
        v = self.vm()
        v.process(500, "sshd", "/usr/sbin/sshd")
        self.assertIn("ssh-running", v.run(dict(ALLOW, processes=ALLOW["processes"] + ["/usr/sbin/sshd"]))[1])

    def test_authorized_keys_absent_or_empty_reached_without_links(self):
        v = self.vm()
        v.write("home/ubuntu/.ssh/authorized_keys2", "ssh-rsa AAAA\n")
        self.assertEqual(v.run(), (False, ["authorized-keys"]))
        v = self.vm()
        os.unlink(v.path("root/.ssh/authorized_keys"))  # (absent: fine)
        self.assertEqual(v.run(), (True, []))
        for how in ("file link", "dir link", "home link", "fifo", "dir"):
            v = self.vm()
            v.write("elsewhere/keys", "ssh-rsa AAAA\n")
            os.makedirs(v.path("elsewhere/.ssh"), exist_ok=True)
            if how == "file link":
                v.link("home/ubuntu/.ssh/authorized_keys", v.path("elsewhere/keys"))
            elif how == "dir link":
                shutil.rmtree(v.path("home/ubuntu/.ssh"))
                v.link("home/ubuntu/.ssh", v.path("elsewhere/.ssh"))
            elif how == "home link":
                shutil.rmtree(v.path("home/ubuntu"))
                v.link("home/ubuntu", v.path("elsewhere"))
            elif how == "fifo":
                os.unlink(v.path("home/ubuntu/.ssh/authorized_keys"))
                os.mkfifo(v.path("home/ubuntu/.ssh/authorized_keys"))  # (never opened, so never blocks)
            else:
                os.unlink(v.path("home/ubuntu/.ssh/authorized_keys"))
                os.makedirs(v.path("home/ubuntu/.ssh/authorized_keys"))
            self.assertEqual(v.run(), (False, ["authorized-keys"]), how)

    def test_passwd_bounded_regular_and_homes_absolute(self):
        for how in ("link", "big", "relative home", "dotted home"):
            v = self.vm()
            if how == "link":
                v.write("etc/passwd.real", "root:x:0:0::/root:/bin/sh\n")
                v.link("etc/passwd", v.path("etc/passwd.real"))
            elif how == "big":
                v.write("etc/passwd", "root:x:0:0::/root:/bin/sh\n" * (G.PASSWD_MAX // 20))
            elif how == "relative home":
                v.write("etc/passwd", "root:x:0:0::/root:/bin/sh\nx:x:1:1::home/x:/bin/sh\n")
            else:
                v.write("etc/passwd", "root:x:0:0::/root:/bin/sh\nx:x:1:1::/home/../root:/bin/sh\n")
            self.assertIn("unreadable", v.run()[1], how)
        # (homes under a virtual tree are never walked)
        v = self.vm()
        v.write("etc/passwd", "root:x:0:0::/root:/bin/sh\nx:x:1:1::/proc/1:/bin/sh\n")
        v.write("proc/1/.ssh/authorized_keys", "ssh-rsa AAAA\n")  # (keys there would fail it, if it were walked)
        self.assertEqual(v.run(), (True, []))


class ListenerTest(Base):
    def test_port_22_anywhere_and_public_listeners_fail(self):
        for tables, word in (
                ({"tcp": [row(0, hex4("0.0.0.0"), 22, "0A", 1)]}, "listener-22"),
                ({"tcp": [row(0, hex4("127.0.0.1"), 22, "0A", 1)]}, "listener-22"),
                ({"tcp6": [row(0, hex6("::"), 22, "0A", 1)]}, "listener-22"),
                ({"udp": [row(0, hex4("0.0.0.0"), 22, "07", 1)]}, "listener-22"),
                ({"tcp": [row(0, hex4("0.0.0.0"), 8080, "0A", 1)]}, "listener-public"),
                ({"tcp": [row(0, hex4("10.0.0.5"), 8080, "0A", 1)]}, "listener-public"),
                ({"tcp6": [row(0, hex6("::"), 8888, "0A", 1)]}, "listener-public"),
                ({"udp6": [row(0, hex6("fe80::1"), 546, "07", 1)]}, "listener-public"),
                ({"udp": [row(0, hex4("0.0.0.0"), 68, "07", 1)]}, "listener-public")):
            v = self.vm()
            base = {"tcp": [row(9, hex4("127.0.0.53"), 53, "0A", 7002)], "udp": [row(9, hex4("127.0.0.53"), 53, "07", 7001)]}
            for k, rows in tables.items():
                base[k] = base.get(k, []) + rows
            v.tables(**base)
            self.assertEqual(v.run(), (False, [word]), tables)

    def test_loopback_only_by_the_exact_allowlist(self):
        def with_rows(**t):
            v = self.vm()
            base = {"tcp": [row(9, hex4("127.0.0.53"), 53, "0A", 7002)], "udp": [row(9, hex4("127.0.0.53"), 53, "07", 7001)]}
            for k, rows in t.items():
                base[k] = base.get(k, []) + rows
            v.tables(**base)
            return v
        v = with_rows(tcp=[row(1, hex4("127.0.0.1"), 8888, "0A", 7003)])  # (an unlisted port, its owner unknown)
        self.assertEqual(v.run(), (False, ["listener-loopback"]))
        v = with_rows(tcp6=[row(1, hex6("::1"), 53, "0A", 7004)])  # (the right port, another address)
        v.process(301, "systemd-resolve", RESOLVED, sockets=(7004,))
        self.assertEqual(v.run(), (False, ["listener-loopback"]))
        v = with_rows()
        v.process(302, "python3", PY, sockets=(7001,))  # (the right socket claimed by another process too: last wins)
        os.unlink(v.path("proc/300/fd/3"))
        self.assertEqual(v.run(), (False, ["listener-loopback"]))
        # (clients aren't listeners: an established TCP, a connected UDP)
        v = with_rows(tcp=[row(1, hex4("10.0.0.5"), 40000, "01", 7005, remote=hex4("1.2.3.4"), rport=443)],
                      udp=[row(1, hex4("10.0.0.5"), 40001, "01", 7006, remote=hex4("1.1.1.1"), rport=53)],
                      tcp6=[row(1, hex6("2001:db8::5"), 40002, "01", 7007, remote=hex6("2001:db8::9"), rport=443)],
                      udp6=[row(1, hex6("2001:db8::5"), 40003, "01", 7008, remote=hex6("2001:db8::9"), rport=53)])
        self.assertEqual(v.run(), (True, []))  # (clients on other local ports, IPv4 and IPv6: exempt)

    def test_tables_missing_or_malformed_fail_closed(self):
        for how in ("missing", "header", "row"):
            v = self.vm()
            if how == "missing":
                os.unlink(v.path("proc/net/udp6"))
            elif how == "header":
                v.write("proc/net/tcp", "garbage\n")
            else:
                v.write("proc/net/tcp6", NET_HEAD + "   0: zz\n")
            self.assertEqual(v.run(), (False, ["unreadable"]), how)

    def test_the_real_tables_parse(self):
        if not os.path.exists("/proc/net/udp6"):
            self.skipTest("no /proc/net here")
        for proto, ip, port, inode in G.sockets("/proc"):
            self.assertIn(proto, ("tcp", "udp"))
            socket.inet_pton(socket.AF_INET6 if ":" in ip else socket.AF_INET, ip)


class ProcessTest(Base):
    def test_only_allowlisted_executables_and_kernel_threads_aside(self):
        v = self.vm()
        v.process(2, "kthreadd", "", kthread=True)
        self.assertEqual(v.run(), (True, []))
        v.process(400, "bash", "/usr/bin/bash")
        self.assertEqual(v.run(), (False, ["process"]))
        v = self.vm()
        v.process(401, "x", "/usr/bin/python3.12 (deleted)")
        self.assertEqual(v.run(), (False, ["process"]))

    def test_unreadable_fails_but_an_exited_process_is_skipped(self):
        v = self.vm()
        v.process(402, "x", PY)
        os.unlink(v.path("proc/402/environ"))
        self.assertEqual(v.run(), (False, ["process", "unreadable"]))
        v = self.vm()
        v.write("proc/403/stat", "")  # (half a process directory that then vanished)
        real = G._one

        def one(proc, pid, *rest):
            if pid == 403:
                shutil.rmtree(v.path("proc/403"))
            return real(proc, pid, *rest)
        G._one = one
        try:
            self.assertEqual(v.run(), (True, []))
        finally:
            G._one = real
        v = self.vm()
        v.write("proc/404/environ", b"x" * (G.ARGS_MAX + 1))
        v.process(404, "x", PY, env=b"x" * (G.ARGS_MAX + 1))
        self.assertIn("unreadable", v.run()[1])

    def test_processes_born_during_the_scan_are_scanned_and_endless_churn_fails(self):
        v = self.vm()
        real = G._pids
        state = {"n": 0}

        def pids(proc):
            state["n"] += 1
            if state["n"] == 2:
                v.process(600, "bash", "/usr/bin/bash")  # (born after the first listing)
            return real(proc)
        G._pids = pids
        try:
            self.assertEqual(v.run(), (False, ["process"]))
        finally:
            G._pids = real
        v = self.vm()

        def churn(proc):
            state["n"] += 1
            v.process(1000 + state["n"], "systemd", SYSTEMD)
            return real(proc)
        G._pids = churn
        try:
            self.assertEqual(v.run(), (False, ["process", "process-churn"]))
        finally:
            G._pids = real


class SecretsTest(Base):
    def test_credential_shapes_in_any_environ_or_cmdline(self):
        for env, cmd in ((b"K=-----BEGIN OPENSSH PRIVATE KEY-----\0", None),
                         (b"PATH=/usr/bin\0", PY.encode() + b"\0--token\0eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl\0"),
                         (b"AUTH=Authorization: Bearer abcdefghijklmnopqrstu\0", None),
                         (b"AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\0", None),
                         (b"K=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGvalidlookingkeymaterialhere12345\0", None)):
            v = self.vm()
            v.process(700, "python3", PY, env=env, cmd=cmd)
            self.assertEqual(v.run(), (False, ["credential-shape"]), env)

    def test_known_values_by_digest_embedded_or_alone(self):
        nonce = b"Zx9_Yw8-Vu7tSr6qPo5nMl"
        known = [{"sha256": hashlib.sha256(nonce).hexdigest(), "bytes": len(nonce)}]
        for env in (b"N=" + nonce + b"\0", b"X=abc" + nonce + b"def\0"):
            v = self.vm()
            v.process(701, "python3", PY, env=env)
            self.assertEqual(v.run(known=known), (False, ["known-value"]), env)
        v = self.vm()
        v.process(702, "python3", PY, env=b"N=" + nonce[:-1] + b"A\0")
        self.assertEqual(v.run(known=known), (True, []))

    def test_known_values_input_is_strict(self):
        good = {"sha256": "a" * 64, "bytes": 22}
        self.assertEqual(G.load_known(b""), [])
        self.assertEqual(G.load_known(json.dumps({"known": [good]}).encode()), [good])
        for bad in ({"known": [dict(good, bytes=8)]}, {"known": [dict(good, sha256="A" * 64)]}, {"known": [good], "x": 1},
                    {"known": [dict(good, value="secret")]}, {"known": [good] * (G.KNOWN_MAX + 1)},
                    {"known": [dict(good, bytes=G.KNOWN_BYTES_MAX + 1)]}):
            with self.assertRaises(ValueError, msg=bad):
                G.load_known(json.dumps(bad).encode())


class BudgetTest(Base):
    """The gate's work is bounded in all, not only per file: processes scanned, directory entries, fds, bytes hashed.
    Running out fails the gate ("gate-budget"); it never skips the rest and passes."""

    def limits(self, **kw):
        saved = {k: getattr(G, k) for k in kw}
        for k, val in kw.items():
            setattr(G, k, val)
        self.addCleanup(lambda: [setattr(G, k, val) for k, val in saved.items()])

    def test_processes_exact_and_over(self):
        v = self.vm()  # (2 processes: systemd and resolved)
        self.limits(MAX_PROCS=2)
        self.assertEqual(v.run(), (True, []))
        self.limits(MAX_PROCS=1)
        self.assertEqual(v.run(), (False, ["gate-budget", "process"]))

    def test_a_stable_large_process_table_fails_rather_than_passing(self):
        v = self.vm()
        for pid in range(1000, 1010):
            v.process(pid, "systemd", SYSTEMD)
        self.limits(MAX_PROCS=11)
        self.assertEqual(v.run(), (False, ["gate-budget", "process"]))
        self.limits(MAX_PROCS=12)
        self.assertEqual(v.run(), (True, []))

    def test_a_listing_is_enumerated_with_a_cap(self):
        v = self.vm()
        self.limits(MAX_PROCS=2)
        for i in range(G.MAX_PROCS + 520):
            os.makedirs(v.path("proc/x%d" % i))
        self.assertEqual(v.run(), (False, ["gate-budget", "process"]))

    def test_fds_per_process_and_in_all(self):
        v = self.vm()  # (resolved holds 2 fds)
        self.limits(MAX_FDS=2)
        self.assertEqual(v.run(), (True, []))
        v.link("proc/300/fd/9", "/dev/null")
        self.assertEqual(v.run(), (False, ["gate-budget", "process"]))
        v = self.vm()
        self.limits(MAX_FDS=4096, MAX_FDS_TOTAL=2)
        self.assertEqual(v.run(), (True, []))
        v.process(301, "systemd", SYSTEMD, sockets=(9001,))
        self.assertEqual(v.run(), (False, ["gate-budget", "process"]))

    def test_hashing_each_window_once_within_the_budget(self):
        # (an adversarial base64url run at the maximum count of known values, lengths 16..31; the budget is charged
        # (windows x length) per distinct length, once however many digests share it)
        run = b"A" * 1000
        known = [{"sha256": hashlib.sha256(bytes([66 + i]) * (16 + i)).hexdigest(), "bytes": 16 + i} for i in range(G.KNOWN_MAX)]
        known[1] = dict(known[1], bytes=16)  # (two digests of one length: hashed once)
        v = self.vm()
        base = G.Budget()
        G.processes(v.proc, 999999, known, base)  # (what the rest of the VM costs: "systemd-resolved" is a 16-byte run)
        need = base.hashed + sum((len(run) - n + 1) * n for n in {k["bytes"] for k in known})
        v.process(900, "python3", PY, env=b"X=" + run + b"\0")
        self.limits(MAX_HASH_BYTES=need)
        self.assertEqual(v.run(known=known), (True, []))
        self.limits(MAX_HASH_BYTES=need - 1)
        self.assertEqual(v.run(known=known), (False, ["gate-budget", "process"]))

    def test_unit_and_label_directories_exact_and_over(self):
        v = self.vm()
        for i in range(20):
            v.write("etc/systemd/system/benign-%d.service" % i, "[Unit]\n")
        n = max(len(os.listdir(v.path(d))) for d in G.UNIT_PATH if os.path.isdir(v.path(d)))
        self.limits(UNIT_DIR_MAX=n)
        self.assertEqual(v.run(), (True, []))
        self.limits(UNIT_DIR_MAX=n - 1)
        self.assertEqual(v.run(), (False, ["gate-budget"]))
        v = self.vm()
        for label in ("cloudimg-rootfs", "UEFI", "BOOT"):
            v.link("dev/disk/by-label/" + label, "../../vda1")
        self.limits(UNIT_DIR_MAX=4096, LABELS_MAX=3)
        self.assertEqual(v.run(), (True, []))
        self.limits(LABELS_MAX=2)
        self.assertEqual(v.run(), (False, ["gate-budget"]))

    def test_huge_directories_are_streamed_and_refused_at_the_cap(self):
        # (each unit directory and the labels directory yield names without end: the gate stops one past each cap)
        v = self.vm()
        real, real_listdir, taken = os.scandir, os.listdir, {}

        class Endless:
            def __init__(self, path):
                self.path = path

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def __iter__(self):
                i = 0
                while True:
                    taken[self.path] = i = i + 1
                    yield type("E", (), {"name": "benign-%d" % i})()

        watched = [os.path.join(v.root, d) for d in G.UNIT_PATH] + [v.path("dev/disk/by-label")]
        G.os.scandir = lambda p: Endless(p) if p in watched else real(p)
        G.os.listdir = None  # (no whole listing anywhere)
        try:
            self.assertEqual(v.run(), (False, ["gate-budget"]))
        finally:
            G.os.scandir, G.os.listdir = real, real_listdir
        self.assertEqual(max(taken.values()), max(G.UNIT_DIR_MAX, G.LABELS_MAX) + 1)
        self.assertEqual(taken[v.path("dev/disk/by-label")], G.LABELS_MAX + 1)

    def test_running_out_in_any_check_is_the_one_fixed_word(self):
        def over(*a, **k):
            raise G.OverBudget("forced")
        for name in ("check_ssh", "check_processes", "check_secrets", "check_listeners", "check_provider",
                     "check_imds", "check_config_drive", "sockets"):
            real = getattr(G, name)
            setattr(G, name, over)
            try:
                self.assertEqual(self.vm().run(), (False, ["gate-budget"]), name)
            finally:
                setattr(G, name, real)
        self.assertEqual(self.vm().run(), (True, []))  # (the control)

    def test_only_words_are_kept_never_the_bytes(self):
        v = self.vm()
        v.process(901, "python3", PY, env=b"K=-----BEGIN RSA PRIVATE KEY-----\0")
        procs = G.processes(v.proc, self_pid=999999)
        for p in procs.values():
            self.assertEqual(set(p) - {"kthread", "comm", "exe", "secrets", "sockets"}, set())
        self.assertEqual(procs[901]["secrets"], {"credential-shape"})


class RepairTest(Base):
    """The repairs after review: short reads, strict passwd rows, OpenSSH 9.8's sshd names, linked unit files,
    mount crossings, and port 22 in any state."""

    def test_short_reads_are_read_to_the_end(self):
        real = os.read
        G.os.read = lambda fd, n: real(fd, min(n, 7))  # (every read returns at most 7 bytes)
        try:
            self.assertEqual(self.vm().run(), (True, []))  # (the control: a clean VM still passes)
            v = self.vm()
            v.process(950, "python3", PY, env=b"PATH=/usr/bin\0K=-----BEGIN OPENSSH PRIVATE KEY-----\0")
            self.assertEqual(v.run(), (False, ["credential-shape"]))  # (a shape split across many reads)
            v = self.vm()
            v.write("proc/net/tcp6", NET_HEAD + row(0, hex6("::1"), 9999, "0A", 1) * 3 + "   9: zz\n")
            self.assertEqual(v.run(), (False, ["unreadable"]))  # (a malformed suffix after many short reads)
        finally:
            G.os.read = real

    def test_passwd_rows_strict(self):
        for passwd in (b"root:x:0:0::/root:/bin/sh\nx:x:1:1::/home/\xff:/bin/sh\n",   # (not UTF-8)
                       b"root:x:0:0::/root:/bin/sh\nx:x:1:1::/home/x\n",              # (6 fields)
                       b"root:x:0:0::/root:/bin/sh\nx:x:1:1::/home/x:/bin/sh:extra\n"):  # (8 fields)
            v = self.vm()
            v.write("etc/passwd", passwd)
            self.assertEqual(v.run(), (False, ["unreadable"]), passwd)
        v = self.vm()
        v.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\n\nubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n")
        self.assertEqual(v.run(), (True, []))  # (an empty line is fine)

    def test_every_sshd_name_whatever_the_allowlist(self):
        for name in ("sshd", "sshd-session", "sshd-auth"):
            v = self.vm()
            v.process(960, name, "/usr/lib/openssh/" + name)
            allow = dict(ALLOW, processes=ALLOW["processes"] + ["/usr/lib/openssh/" + name])
            self.assertEqual(v.run(allow), (False, ["ssh-running"]), name)

    def test_linked_unit_files_are_present_aliases_are_followed(self):
        for target in ("/opt/units/ssh.service", "../../../opt/units/ssh.service", "/lib/systemd/system/ssh.service.d/x"):
            v = self.vm()
            v.write("opt/units/ssh.service", "[Unit]\n")
            v.link("etc/systemd/system/sshd.service", target)  # (a linked unit file, not an alias)
            self.assertEqual(v.run(), (False, ["ssh-unit"]), target)
        # (the controls: aliases, absolute in the search path or bare in the same directory, to the masked unit)
        for target in ("/lib/systemd/system/ssh.service", "/usr/lib/systemd/system/ssh.service", "ssh.service"):
            v = self.vm()
            v.link("etc/systemd/system/sshd.service", target)
            self.assertEqual(v.run(), (True, []), target)

    def test_mount_crossings_below_a_home_are_refused_unless_pinned(self):
        for point in ("/home/ubuntu", "/home/ubuntu/.ssh", "/root"):
            v = self.vm()
            v.mountinfo("/", point)
            self.assertEqual(v.run(), (False, ["mount-crossing"]), point)
            self.assertEqual(v.run(dict(ALLOW, mounts=[point])), (True, []), point)  # (pinned by the image)
        for name in ("authorized_keys", "authorized_keys2"):  # (a key file itself bind-mounted, empty and regular)
            key = "/home/ubuntu/.ssh/" + name
            v = self.vm()
            v.write(key[1:], "")
            self.assertEqual(v.run(), (True, []), name)  # (the control: not a mount point)
            v.mountinfo("/", key)
            self.assertEqual(v.run(), (False, ["mount-crossing"]), name)
            self.assertEqual(v.run(dict(ALLOW, mounts=["/home/ubuntu/.ssh"])), (False, ["mount-crossing"]), name)
            self.assertEqual(v.run(dict(ALLOW, mounts=[key])), (True, []), name)  # (pinned: that exact path only)
            v.write(key[1:], "ssh-ed25519 AAAA\n")
            self.assertEqual(v.run(dict(ALLOW, mounts=[key])), (False, ["authorized-keys"]), name)
        v = self.vm()
        v.mountinfo("/", "/home/my\\040dir")  # (an escaped mount point elsewhere: read, and not crossed)
        self.assertIn("/home/my dir", G.mount_points(v.proc))
        self.assertEqual(v.run(), (True, []))
        for bad in ("garbage\n", "20 1 8:1 / relative rw shared:1 - ext4 /dev/sda rw\n", "20 1 8:1 / / rw shared:1 ext4 x y z\n"):
            v = self.vm()
            v.write("proc/self/mountinfo", bad)
            self.assertEqual(v.run(), (False, ["unreadable"]), bad)

    def test_port_22_in_any_state(self):
        for tables in ({"udp": [row(9, hex4("127.0.0.53"), 53, "07", 7001), row(1, hex4("10.0.0.5"), 22, "01", 7010, remote=hex4("1.2.3.4"), rport=40000)]},
                       {"tcp": [row(9, hex4("127.0.0.53"), 53, "0A", 7002), row(1, hex4("10.0.0.5"), 22, "01", 7011, remote=hex4("1.2.3.4"), rport=40001)]},
                       {"udp6": [row(1, hex6("2001:db8::5"), 22, "01", 7012, remote=hex6("2001:db8::9"), rport=40002)]},
                       {"tcp6": [row(1, hex6("2001:db8::5"), 22, "01", 7013, remote=hex6("2001:db8::9"), rport=40003)]}):
            v = self.vm()
            base = {"tcp": [row(9, hex4("127.0.0.53"), 53, "0A", 7002)], "udp": [row(9, hex4("127.0.0.53"), 53, "07", 7001)]}
            base.update(tables)
            v.tables(**base)
            self.assertEqual(v.run(), (False, ["listener-22"]), tables)


class ProviderTest(Base):
    def test_no_hyperstack_agent_of_any_kind(self):
        for how in ("unit", "unit@", "user", "process", "dir"):
            v = self.vm()
            if how == "unit":
                v.write("lib/systemd/system/hyperstack-agent.service", "[Unit]\n")
            elif how == "unit@":
                v.write("etc/systemd/system/hyperstack-agent@1.service", "[Unit]\n")
            elif how == "user":
                v.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\nhyperstack-agent:x:999:999::/var/empty:/usr/sbin/nologin\n")
            elif how == "process":
                v.process(800, "hyperstack-agen", "/usr/bin/hyperstack-agent")
            else:
                os.makedirs(v.path("opt/hyperstack-agent"))
            words = v.run()[1]
            self.assertIn("provider-agent", words, how)


class ImdsTest(Base):
    def test_metadata_and_config_drive_fail_closed(self):
        self.assertEqual(self.vm().run(imds=True), (False, ["imds"]))
        v = self.vm()
        v.link("dev/disk/by-label/config-2", "../../vdb")
        self.assertEqual(v.run(), (False, ["config-drive"]))
        v = self.vm()
        v.link("dev/disk/by-label/cloudimg-rootfs", "../../vda1")
        self.assertEqual(v.run(), (True, []))


class InputTest(Base):
    def test_the_allowlist_is_strict(self):
        v = self.vm()
        p = v.write("allow.json", json.dumps(ALLOW))
        self.assertEqual(G.load_allowlist(p), ALLOW)
        for bad in (dict(ALLOW, v=2), dict(ALLOW, processes=["bash"]),
                    dict(ALLOW, loopback=[{"process": RESOLVED, "proto": "tcp", "address": "0.0.0.0", "port": 53}]),
                    dict(ALLOW, loopback=[{"process": RESOLVED, "proto": "tcp", "address": "127.0.0.1", "port": 22}]),
                    dict(ALLOW, loopback=[{"process": RESOLVED, "proto": "sctp", "address": "127.0.0.1", "port": 53}]),
                    dict(ALLOW, mounts=["/"]), dict(ALLOW, mounts=["home"]), dict(ALLOW, mounts=["/home/../root"])):
            with self.assertRaises(ValueError, msg=bad):
                G.load_allowlist(v.write("bad.json", json.dumps(bad)))

    def test_main_fails_closed_on_bad_input(self):
        out = io.StringIO()
        self.assertEqual(G.main(["/nonexistent/allow.json"], io.BytesIO(b""), out), 1)
        self.assertEqual(out.getvalue(), 'SBGPU-GATE {"v":1,"pass":false,"fail":["unreadable"]}\n')
        v = self.vm()
        p = v.write("allow.json", json.dumps(ALLOW))
        out = io.StringIO()
        self.assertEqual(G.main([p], io.BytesIO(b"{not json"), out), 1)
        self.assertIn('"fail":["unreadable"]', out.getvalue())


if __name__ == "__main__":
    unittest.main()
