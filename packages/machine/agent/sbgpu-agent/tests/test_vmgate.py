"""The VM gate (sbgpu_agent/vmgate.py) against fake root and /proc trees: a locked-down VM passes, and each way a VM
can fail does, with its fixed word only."""

import errno
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
SUDOERS = "Defaults env_reset\nroot ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n"
ALLOW = {"v": 1, "processes": [SYSTEMD, RESOLVED, PY], "mounts": [], "sentinelHomes": ["/nonexistent"],
         "loopback": [{"process": RESOLVED, "proto": "udp", "address": "127.0.0.53", "port": 53},
                      {"process": RESOLVED, "proto": "tcp", "address": "127.0.0.53", "port": 53}],
         "providerReader2": [], "neutralisedAgents": [{"unit": "grafana-agent", "process": "grafana-agent"}],
         "sudoers": {"/etc/sudoers": hashlib.sha256(SUDOERS.encode()).hexdigest()}}


def nft_rule(proto, addr, n):
    right = addr if n == (32 if proto == "ip" else 128) else {"prefix": {"addr": addr, "len": n}}
    return {"rule": {"family": "inet", "table": "sbgpu_meta", "chain": "out", "handle": 3, "expr": [
        {"match": {"op": "==", "left": {"payload": {"protocol": proto, "field": "daddr"}}, "right": right}},
        {"reject": None}]}}


NFT_CHAIN = {"chain": {"family": "inet", "table": "sbgpu_meta", "name": "out", "handle": 1, "type": "filter",
                       "hook": "output", "prio": -300, "policy": "accept"}}
NFT_OBJS = [{"metainfo": {"version": "1.0.9", "json_schema_version": 1}},
            {"table": {"family": "inet", "name": "sbgpu_meta", "handle": 7}}, NFT_CHAIN,
            nft_rule("ip", "169.254.0.0", 16), nft_rule("ip6", "fe80::a9fe:a9fe", 128), nft_rule("ip6", "fd00:ec2::254", 128)]


def nft_json(objs=None):
    return json.dumps({"nftables": NFT_OBJS if objs is None else objs}).encode()


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
        self.write("etc/shadow", "root:*:19000:0:99999:7:::\nubuntu:!:19000:0:99999:7:::\nnobody:*:19000:0:99999:7:::\n")
        self.write("etc/group", "root:x:0:\nsudo:x:27:\nubuntu:x:1000:\nnogroup:x:65534:\n")
        self.write("etc/sudoers", SUDOERS)
        os.makedirs(self.path("etc/sudoers.d"))
        for i, name in enumerate(("lo", "eth0")):
            self.write("sys/class/net/%s/ifindex" % name, "%d\n" % (i + 1))
        self.write("proc/net/route", "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
                                     "eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0\n")
        self.write("proc/net/ipv6_route", "")
        self.write("proc/net/fib_trie", "Main:\n  +-- 0.0.0.0/0 3 0 5\n     |-- 10.0.0.5\n        /32 host LOCAL\n")
        self.nft = nft_json()
        self.loaded = b""  # (systemd's list of loaded units matching a neutralised agent: none)
        self.probe = {}  # (address -> what a connection to it does; default: refused at once)
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

    def process(self, pid, comm, exe, env=b"PATH=/usr/bin\0", cmd=None, sockets=(), kthread=False, uid=0):
        base = "proc/%d/" % pid
        flags = G.PF_KTHREAD if kthread else 0x400100
        self.write(base + "stat", "%d (%s) S 0 %d %d 0 -1 %d 0 0 0 0\n" % (pid, comm, pid, pid, flags))
        self.write(base + "status", "Name:\t%s\nUid:\t%d\t%d\t%d\t%d\nGid:\t0\t0\t0\t0\n" % (comm, uid, uid, uid, uid))
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
        def connect(family, address):
            what = "accept" if imds else self.probe.get(address, errno.ECONNREFUSED)
            if what == "accept":
                class S:
                    def close(self):
                        pass
                return S()
            if what == "timeout":
                raise socket.timeout("timed out")
            raise OSError(what, os.strerror(what))
        return G.run(allow, known, root=self.root, proc=self.proc, connect=connect, self_pid=999999,
                     nft=lambda: self.nft, units=lambda patterns: self.loaded)

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
                     "check_imds", "check_config_drive", "sockets", "check_passwords", "check_sudo", "check_consoles",
                     "check_neutralised", "check_sessions", "check_containers", "unit_names"):
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
            self.assertEqual(set(p) - {"kthread", "comm", "exe", "uids", "secrets", "sockets"}, set())
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

    def test_passwd_parsing_itself_is_strict(self):
        # (on the parser directly: the gate's verdict for these rows is "unreadable" by other paths too)
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "etc"))

            def homes(data):
                with open(os.path.join(root, "etc", "passwd"), "wb") as f:
                    f.write(data)
                return G._homes(root)

            self.assertEqual(homes(b"root:x:0:0::/root:/bin/sh\nx:x:1:1::/home/x:/bin/sh\n"), ["/home/x", "/root"])  # (the control)
            for data in (b"x:x:1:1::/home/x\n",                   # (6 fields)
                         b"x:x:1:1::/home/x:/bin/sh:extra\n",     # (8 fields)
                         b"x:x:1:1::/home/\xff:/bin/sh\n",         # (a home that isn't UTF-8: refused, never replaced)
                         b"\xffx:x:1:1::/home/x:/bin/sh\n",        # (a name that isn't UTF-8)
                         b"x:x:1:1::/home/x:/bin/\xff\n"):         # (a shell that isn't UTF-8)
                with self.assertRaises(G.Unreadable, msg=data):
                    homes(b"root:x:0:0::/root:/bin/sh\n" + data)

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


class NeutralisedTest(Base):
    """What the boot script's neutralise step leaves, checked independently (SEC-cleared design, revision 3): locked
    passwords, no sudo grant, no console login, neutralised agents, no user session, no container runtime, and the
    metadata reject rules in place in both families."""

    def limits(self, **kw):
        saved = {k: getattr(G, k) for k in kw}
        for k, val in kw.items():
            setattr(G, k, val)
        self.addCleanup(lambda: [setattr(G, k, val) for k, val in saved.items()])

    def test_every_password_locked(self):
        for field in ("!", "*", "!*", "!$6$salt$hash"):
            v = self.vm()
            v.write("etc/shadow", "root:%s:19000:0:99999:7:::\n" % field)
            self.assertEqual(v.run(), (True, []), field)
        for field in ("", "$6$salt$hash", "x"):
            v = self.vm()
            v.write("etc/shadow", "root:*:19000:0:99999:7:::\nshadeform:%s:19000:0:99999:7:::\n" % field)
            self.assertEqual(v.run(), (False, ["password"]), field)
        v = self.vm()
        v.write("etc/passwd", "root:$6$salt$hash:0:0:root:/root:/bin/bash\n")  # (a hash in passwd itself)
        self.assertEqual(v.run(), (False, ["password"]))
        v = self.vm()
        v.write("etc/passwd", "root:*:0:0:root:/root:/bin/bash\n")
        self.assertEqual(v.run(), (True, []))
        for bad in ("root:*:19000:0:99999:7::\n", "root:*:19000:0:99999:7::::\n", "root:\xff:19000:0:99999:7:::\n"):  # (8, 10 fields; not UTF-8)
            v = self.vm()
            v.write("etc/shadow", bad.encode("latin-1"))
            self.assertEqual(v.run(), (False, ["unreadable"]), bad)
        v = self.vm()
        os.unlink(v.path("etc/shadow"))
        self.assertEqual(v.run(), (False, ["unreadable"]))
        v = self.vm()
        self.limits(SHADOW_MAX=len(open(v.path("etc/shadow"), "rb").read()))
        self.assertEqual(v.run(), (True, []))
        self.limits(SHADOW_MAX=G.SHADOW_MAX - 1)
        self.assertEqual(v.run(), (False, ["unreadable"]))

    def test_no_sudo_grant(self):
        for group in ("sudo:x:27:shadeform\n", "admin:x:115:ubuntu\n", "wheel:x:10:ubuntu,shadeform\n"):
            v = self.vm()
            v.write("etc/group", "root:x:0:\n" + group)
            self.assertEqual(v.run(), (False, ["sudo"]), group)
        v = self.vm()
        v.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\nshadeform:x:1001:27::/home/shadeform:/bin/bash\n")
        self.assertEqual(v.run(), (False, ["sudo"]))  # (sudo as a primary group)
        for group_gid, user_gid in (("27", "27"), ("027", "27"), ("27", "027"), ("027", "0027")):
            v = self.vm()  # (group ids compare as numbers, as libc reads them)
            v.write("etc/group", "root:x:0:\nsudo:x:%s:\n" % group_gid)
            v.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\nshadeform:x:1001:%s::/home/shadeform:/bin/bash\n" % user_gid)
            self.assertEqual(v.run(), (False, ["sudo"]), (group_gid, user_gid))
        v = self.vm()
        v.write("etc/group", "root:x:0:\nsudo:x:27:\n")
        v.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\nshadeform:x:1001:270::/home/shadeform:/bin/bash\n")
        self.assertEqual(v.run(), (True, []))  # (270 isn't 27)
        for group_gid, user_gid in (("+27", "27"), ("27", " 27"), ("2a", "27"), ("27", ""), ("", "27"), ("27", "12345678901")):
            v = self.vm()  # (anything but plain decimal digits is unreadable, never compared as text)
            v.write("etc/group", "root:x:0:\nsudo:x:%s:\n" % group_gid)
            v.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\nshadeform:x:1001:%s::/home/shadeform:/bin/bash\n" % user_gid)
            self.assertEqual(v.run(), (False, ["unreadable"]), (group_gid, user_gid))
        v = self.vm()
        v.write("etc/group", "root:x:0:\nusers:x:100:ubuntu\n")  # (a member of an ordinary group: fine)
        self.assertEqual(v.run(), (True, []))
        v = self.vm()
        v.write("etc/sudoers.d/90-cloud-init-users", "ubuntu ALL=(ALL) NOPASSWD:ALL\n")
        self.assertEqual(v.run(), (False, ["sudo"]))
        readme = "# a README\n"
        allow = dict(ALLOW, sudoers=dict(ALLOW["sudoers"], **{"/etc/sudoers.d/README": hashlib.sha256(readme.encode()).hexdigest()}))
        v.write("etc/sudoers.d/90-cloud-init-users", readme)
        self.assertEqual(v.run(allow), (False, ["sudo"]))  # (the right bytes under another name)
        os.unlink(v.path("etc/sudoers.d/90-cloud-init-users"))
        v.write("etc/sudoers.d/README", readme)
        self.assertEqual(v.run(allow), (True, []))
        v.write("etc/sudoers", SUDOERS + "shadeform ALL=(ALL) NOPASSWD:ALL\n")
        self.assertEqual(v.run(allow), (False, ["sudo"]))
        v = self.vm()
        v.link("etc/sudoers.d/README", "/tmp/elsewhere")  # (a link: not read through)
        self.assertEqual(v.run(allow), (False, ["sudo"]))
        v = self.vm()
        os.unlink(v.path("etc/sudoers"))
        self.assertEqual(v.run(), (True, []))  # (no sudoers at all grants nothing)
        v = self.vm()
        for i in range(3):
            v.write("etc/sudoers.d/f%d" % i, readme)
        many = dict(ALLOW, sudoers=dict(ALLOW["sudoers"], **{"/etc/sudoers.d/f%d" % i: hashlib.sha256(readme.encode()).hexdigest() for i in range(3)}))
        self.limits(SUDOERS_D_MAX=3)
        self.assertEqual(v.run(many), (True, []))
        self.limits(SUDOERS_D_MAX=2)
        self.assertEqual(v.run(many), (False, ["gate-budget"]))
        self.limits(SUDOERS_D_MAX=64, SUDOERS_MAX=len(SUDOERS) - 1)
        self.assertEqual(v.run(many), (False, ["sudo"]))  # (an over-long sudoers file)

    def test_no_console_login(self):
        for unit in G.CONSOLE_UNITS:
            v = self.vm()
            v.write("lib/systemd/system/" + unit, "[Unit]\n")
            self.assertEqual(v.run(), (False, ["console-login"]), unit)
            v.link("etc/systemd/system/" + unit, "/dev/null")
            self.assertEqual(v.run(), (True, []), unit)  # (masked)
        v = self.vm()
        v.write("lib/systemd/system/getty@.service", "[Unit]\n")
        v.link("etc/systemd/system/getty@.service", "/dev/null")
        v.write("etc/systemd/system/getty@tty1.service", "[Unit]\n")  # (an instance of its own)
        self.assertEqual(v.run(), (False, ["console-login"]))
        v.link("etc/systemd/system/getty@tty1.service", "/dev/null")
        self.assertEqual(v.run(), (True, []))
        v.write("run/systemd/system/serial-getty@ttyS0.service", "[Unit]\n")
        self.assertEqual(v.run(), (False, ["console-login"]))
        for name in G.CONSOLE_PROCS:
            v = self.vm()
            v.process(700, name, "/sbin/" + name)
            self.assertEqual(v.run(dict(ALLOW, processes=ALLOW["processes"] + ["/sbin/" + name])), (False, ["console-login"]), name)

    def test_neutralised_agents_masked_and_not_running(self):
        v = self.vm()
        v.write("usr/bin/grafana-agent", "binary")  # (inert files may stay: binary, config, its user)
        v.write("etc/grafana-agent.yaml", "server: {}\n")
        v.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\ngrafana-agent:x:998:998::/var/lib/grafana-agent:/usr/sbin/nologin\n")
        v.write("lib/systemd/system/grafana-agent.service", "[Unit]\n")
        self.assertEqual(v.run(), (False, ["agent-active"]))
        v.link("etc/systemd/system/grafana-agent.service", "/dev/null")
        self.assertEqual(v.run(), (True, []))
        for other in ("grafana-agent.socket", "grafana-agent.timer", "grafana-agent.path", "grafana-agent@x.service", "grafana-agent@.service"):
            v.write("lib/systemd/system/" + other, "[Unit]\n")
            self.assertEqual(v.run(), (False, ["agent-active"]), other)
            v.link("etc/systemd/system/" + other, "/dev/null")
            self.assertEqual(v.run(), (True, []), other)
        v.link("etc/systemd/system/grafana-agent.timer", "grafana-agent-gone.timer")  # (a dangling alias: not a mask)
        self.assertEqual(v.run(), (False, ["agent-active"]))
        v.link("etc/systemd/system/grafana-agent.timer", "/dev/null")
        v.write("lib/systemd/system/grafana-agent-helper.service", "[Unit]\n")  # (another unit's name: not its own)
        self.assertEqual(v.run(), (True, []))
        v.process(710, "grafana-agent", "/usr/bin/grafana-agent")
        self.assertEqual(v.run(dict(ALLOW, processes=ALLOW["processes"] + ["/usr/bin/grafana-agent"])), (False, ["agent-active"]))
        v = self.vm()
        v.process(711, "agent", "/opt/x/grafana-agent")  # (by its executable's name too)
        self.assertEqual(v.run(dict(ALLOW, processes=ALLOW["processes"] + ["/opt/x/grafana-agent"])), (False, ["agent-active"]))
        self.assertEqual(self.vm().run(), (True, []))  # (not installed at all: nothing to neutralise)

    def test_loaded_units_of_a_neutralised_agent_must_be_down(self):
        for line, ok in (("grafana-agent.socket loaded active running x\n", False),
                         ("grafana-agent.socket masked active running x\n", False),
                         ("grafana-agent.socket loaded inactive dead x\n", False),   # (down, but it could start)
                         ("grafana-agent.socket masked inactive dead x\n", True),
                         ("grafana-agent@3.service not-found inactive dead x\n", True),
                         ("grafana-agent.timer masked failed failed x\n", True),
                         ("grafana-agent.timer not-found activating start x\n", False)):
            v = self.vm()
            v.loaded = line.encode()
            self.assertEqual(v.run(), (True, []) if ok else (False, ["agent-active"]), line)
        for bad in (b"garbage\n", b"bad/name loaded active running x\n", b"\xff loaded active running x\n"):
            v = self.vm()
            v.loaded = bad
            self.assertEqual(v.run(), (False, ["unreadable"]), bad)
        self.assertEqual(G.agent_patterns(ALLOW), ["grafana-agent.service", "grafana-agent.socket", "grafana-agent.timer",
                                                   "grafana-agent.path", "grafana-agent@*"])

    def test_only_the_agents_own_loaded_units_are_judged(self):
        unrelated = b"cron.service loaded active running x\nmy-agent-other.service loaded active running x\n"
        v = self.vm()
        asked = []
        v.loaded = unrelated
        none = dict(ALLOW, neutralisedAgents=[])
        res = G.run(none, (), root=v.root, proc=v.proc, self_pid=999999, nft=lambda: v.nft,
                    units=lambda patterns: asked.append(patterns) or unrelated,
                    connect=lambda f, a: (_ for _ in ()).throw(ConnectionRefusedError(errno.ECONNREFUSED, "x")))
        self.assertEqual(res, (True, []))
        self.assertEqual(asked, [])  # (no agents: systemd isn't asked, an empty pattern list would list everything)
        v = self.vm()  # (an unrelated unit in the list, even an active one, isn't the agent's)
        v.loaded = b"grafana-agent-other.service loaded active running x\ncron.service loaded active running x\n"
        self.assertEqual(v.run(), (True, []))
        v.loaded = b"grafana-agent.socket loaded active running x\n"
        self.assertEqual(v.run(), (False, ["agent-active"]))  # (the control: its own unit still fails)

    def test_the_gate_lists_loaded_units_through_the_bounded_runner(self):
        calls = []

        def runner(argv, limit, timeout, data=None):
            calls.append((argv, limit, timeout))
            return runner.answer
        self.patch_attr(G, "run_bounded", runner)
        runner.answer = (0, b"grafana-agent.socket masked inactive dead x\n")
        self.assertEqual(G.loaded_units(G._list_units(["a@*"])), [("grafana-agent.socket", "masked", "inactive")])
        self.assertEqual(calls[-1], (["systemctl", "list-units", "--all", "--plain", "--no-legend", "--full", "a@*"],
                                     G.LIST_MAX, G.LIST_TIMEOUT_S))
        runner.answer = (1, b"")
        with self.assertRaises(G.Unreadable):
            G._list_units(["a@*"])

        def failing(argv, limit, timeout, data=None):
            raise G.CommandFailed("overflow")
        self.patch_attr(G, "run_bounded", failing)
        with self.assertRaises(G.Unreadable):
            G._list_units(["a@*"])
        with self.assertRaises(G.Unreadable):
            G._nft_listing()
        self.patch_attr(G, "run_bounded", lambda argv, limit, timeout, data=None: (1, b"{}"))
        with self.assertRaises(G.Unreadable):
            G._nft_listing()
        self.patch_attr(G, "run_bounded", lambda argv, limit, timeout, data=None: (0, b"{}") if limit == G.NFT_MAX else None)
        self.assertEqual(G._nft_listing(), b"{}")

    def test_lingering_users_fail(self):
        v = self.vm()
        v.write(G.LINGER_DIR + "/shadeform", "")
        self.assertEqual(v.run(), (False, ["user-session"]))
        os.unlink(v.path(G.LINGER_DIR + "/shadeform"))
        self.assertEqual(v.run(), (True, []))  # (the directory there, and empty)

    def patch_attr(self, obj, name, value):
        old = getattr(obj, name)
        setattr(obj, name, value)
        self.addCleanup(setattr, obj, name, old)

    def test_a_provider_channel_kept_on_purpose_is_exact_and_labelled(self):
        qga = "/usr/sbin/qemu-ga"
        v = self.vm()
        v.process(720, "qemu-ga", qga)
        self.assertEqual(v.run(), (False, ["process"]))
        self.assertEqual(v.run(dict(ALLOW, providerReader2=[qga])), (True, []))  # (reader (2), until r8)
        neutral = dict(ALLOW, neutralisedAgents=ALLOW["neutralisedAgents"] + [{"unit": "qemu-guest-agent", "process": "qemu-ga"}],
                       processes=ALLOW["processes"] + [qga])
        self.assertEqual(v.run(neutral), (False, ["agent-active"]))  # (after r8: masked, and no process)
        v = self.vm()
        v.write("lib/systemd/system/hyperstack-agent.service", "[Unit]\n")
        v.link("etc/systemd/system/hyperstack-agent.service", "/dev/null")
        self.assertEqual(v.run(), (False, ["provider-agent"]))  # (masked or not, a provider agent fails)

    def test_no_user_session_and_no_container_runtime(self):
        for uid in (1000, 1001, 65534):
            v = self.vm()
            v.process(730, "bash", PY, uid=uid)
            self.assertEqual(v.run(), (False, ["user-session"]), uid)
        v = self.vm()
        v.process(730, "bash", PY, uid=999)
        self.assertEqual(v.run(), (True, []))
        v.write("proc/730/status", "Uid:\t0\t1000\t0\t0\n")  # (any one of the four)
        self.assertEqual(v.run(), (False, ["user-session"]))
        v.write("proc/730/status", "Name:\tbash\n")  # (no Uid line: unreadable, not skipped)
        self.assertEqual(v.run(), (False, ["process", "unreadable"]))
        for sock in G.CONTAINER_SOCKETS:
            v = self.vm()
            v.write(sock, "")
            self.assertEqual(v.run(), (False, ["container-runtime"]), sock)

    def test_metadata_rules_exactly_ours(self):
        changed = [
            NFT_OBJS[:-1],                                                     # (a rule missing)
            NFT_OBJS + [nft_rule("ip", "10.0.0.1", 32)],                       # (one more)
            NFT_OBJS[:3] + [nft_rule("ip", "169.254.169.0", 24)] + NFT_OBJS[4:],  # (a narrower prefix)
            NFT_OBJS + [NFT_CHAIN],                                            # (a second chain)
            NFT_OBJS + [{"set": {"name": "x"}}],                               # (anything else in the table)
            NFT_OBJS + [NFT_OBJS[3]],                                          # (a rule twice)
        ]
        drop = json.loads(json.dumps(NFT_OBJS))
        drop[3]["rule"]["expr"][1] = {"drop": None}
        changed.append(drop)
        for key, val in (("prio", -200), ("hook", "input"), ("policy", "drop"), ("type", "nat")):
            c = json.loads(json.dumps(NFT_OBJS))
            c[2]["chain"][key] = val
            changed.append(c)
        # (the rules must sit in our one output chain of inet sbgpu_meta: a reject anywhere else does nothing)
        def moved(**ident):
            c = json.loads(json.dumps(NFT_OBJS))
            for r in c[3:]:
                r["rule"].update(ident)
            return c
        dead = {"chain": {"family": "inet", "table": "sbgpu_meta", "name": "dead", "handle": 2}}
        changed += [
            NFT_OBJS[:2] + [NFT_CHAIN] + moved(chain="dead")[3:],               # (the rules in a chain not listed)
            NFT_OBJS[:3] + [dead] + moved(chain="dead")[3:],                    # (an inert second chain: two chains)
            moved(table="other"), moved(family="ip"),
            [o if "rule" not in o else {"rule": {k: x for k, x in o["rule"].items() if k != "chain"}} for o in NFT_OBJS],
            [o if "table" not in o else {"table": dict(o["table"], name="other")} for o in NFT_OBJS],
            [o if "table" not in o else {"table": dict(o["table"], family="ip")} for o in NFT_OBJS],
            [o for o in NFT_OBJS if "table" not in o],                          # (no table object)
            NFT_OBJS + [{"table": {"family": "inet", "name": "sbgpu_meta", "handle": 8}}],  # (two)
            [o if "chain" not in o else {"chain": dict(o["chain"], table="other")} for o in NFT_OBJS],
            [o if "chain" not in o else {"chain": dict(o["chain"], family="ip")} for o in NFT_OBJS],
        ]
        for objs in changed:
            v = self.vm()
            v.nft = nft_json(objs)
            self.assertEqual(v.run(), (False, ["imds"]), objs)
        renamed = [o if "chain" not in o else {"chain": dict(o["chain"], name="meta")} for o in moved(chain="meta")]
        v = self.vm()
        v.nft = nft_json(renamed)
        self.assertEqual(v.run(), (True, []))  # (the control: any name, as long as rules and chain agree)
        for raw in (b"", b"{", b'{"other": []}'):
            v = self.vm()
            v.nft = raw
            self.assertEqual(v.run(), (False, ["imds"]), raw)
        v = self.vm()

        def missing():
            raise G.Unreadable("nft")
        v.nft = None
        self.assertEqual(G.run(ALLOW, (), root=v.root, proc=v.proc, self_pid=999999, nft=missing, units=lambda p: b"",
                               connect=lambda f, a: (_ for _ in ()).throw(ConnectionRefusedError(errno.ECONNREFUSED, "x"))),
                         (False, ["imds"]))
        self.assertTrue(G.meta_rules_exact(nft_json()))

    def test_every_metadata_address_refused_at_once(self):
        v4 = G.META_V4
        v6alias = (G.META_V6[1], 80, 0, 0)
        ll = (G.META_V6[0], 80, 0, 2)  # (eth0's index)
        for addr in (v4, v6alias, ll):
            for what in ("accept", "timeout", errno.EHOSTUNREACH, errno.ETIMEDOUT):
                v = self.vm()
                v.probe[addr] = what
                self.assertEqual(v.run(), (False, ["imds"]), (addr, what))
            for what in (errno.ECONNREFUSED, errno.EACCES, errno.EPERM, errno.ENETUNREACH):
                v = self.vm()
                v.probe[addr] = what
                self.assertEqual(v.run(), (True, []), (addr, what))
        v = self.vm()
        v.probe[(G.META_V6[0], 80, 0, 1)] = "accept"  # (loopback isn't an interface to the metadata service)
        self.assertEqual(v.run(), (True, []))
        v = self.vm()
        v.write("sys/class/net/eth1/ifindex", "3\n")  # (each interface is probed)
        v.probe[(G.META_V6[0], 80, 0, 3)] = "accept"
        self.assertEqual(v.run(), (False, ["imds"]))
        v.write("sys/class/net/eth1/ifindex", "three\n")
        self.assertEqual(v.run(), (False, ["unreadable"]))
        v = self.vm()
        self.limits(NET_IF_MAX=2)
        self.assertEqual(v.run(), (True, []))
        self.limits(NET_IF_MAX=1)
        self.assertEqual(v.run(), (False, ["gate-budget"]))

    def test_nothing_reaches_metadata_outside_the_rules(self):
        route = "eth0\t%s\t0100000A\t0007\t0\t0\t100\tFFFFFFFF\t0\t0\t0\n"
        v = self.vm()
        v.write("proc/net/route", open(v.path("proc/net/route")).read() + route % hex4("169.254.169.254"))
        self.assertEqual(v.run(), (True, []))  # (OpenStack's DHCP host route to the metadata address: covered)
        # (narrower rules, as a later rule set might have: a route, address or IPv6 route outside them fails)
        narrow = frozenset({("ip", "169.254.169.254", 32), ("ip6", "fe80::a9fe:a9fe", 128)})
        objs = NFT_OBJS[:3] + [nft_rule("ip", "169.254.169.254", 32), nft_rule("ip6", "fe80::a9fe:a9fe", 128)]
        self.limits(META_RULES=narrow)
        v.nft = nft_json(objs)
        self.assertEqual(v.run(), (True, []))
        v.write("proc/net/route", open(v.path("proc/net/route")).read() + route % hex4("169.254.170.2"))
        self.assertEqual(v.run(), (False, ["imds"]))
        v = self.vm()
        v.nft = nft_json(objs)
        v.write("proc/net/fib_trie", open(v.path("proc/net/fib_trie")).read() + "     |-- 169.254.3.4\n        /32 host LOCAL\n")
        self.assertEqual(v.run(), (False, ["imds"]))
        v = self.vm()
        v.nft = nft_json(objs)
        r6 = socket.inet_pton(socket.AF_INET6, "fd00:ec2::254").hex()
        v.write("proc/net/ipv6_route", "%s 80 %s 00 %s 00000400 00000001 00000000 00000001     eth0\n" % (r6, "0" * 32, "0" * 32))
        self.assertEqual(v.run(), (False, ["imds"]))
        self.limits(META_RULES=G.META_RULES | {("ip6", "fd00:ec2::254", 128)})
        v.nft = nft_json(objs + [nft_rule("ip6", "fd00:ec2::254", 128)])
        self.assertEqual(v.run(), (True, []))
        v.write("proc/net/ipv6_route", "garbage\n")
        self.assertEqual(v.run(), (False, ["unreadable"]))
        v = self.vm()
        v.write("proc/net/route", "Iface\tDestination\neth0\t00000000\n")
        self.assertEqual(v.run(), (False, ["unreadable"]))

    def test_one_real_home_scanned_once_and_aliases_refused_unless_pinned(self):
        v = self.vm()
        v.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\na:x:1000:1000::/home/a:/bin/bash\nb:x:1001:1001::/home/a:/bin/bash\n")
        v.write("home/a/.ssh/authorized_keys", "")
        calls = []
        real = G._keys_state
        G._keys_state = lambda *a, **k: calls.append(a[1]) or real(*a, **k)
        try:
            self.assertEqual(v.run(), (True, []))
        finally:
            G._keys_state = real
        self.assertEqual(sorted(calls), ["/home/a", "/root"])  # (two users, one home: scanned once)
        # (two paths to one real directory, as a bind mount gives; the walk sees the same (st_dev, st_ino) twice)
        v = self.vm()
        v.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\na:x:1000:1000::/home/a:/bin/bash\nb:x:1001:1001::/home/b:/bin/bash\n")
        for h in ("home/a", "home/b"):
            os.makedirs(v.path(h))
        a_ino = os.stat(v.path("home/a"))
        real_fstat = os.fstat

        def fstat(fd):
            st = real_fstat(fd)
            if st.st_ino == os.stat(v.path("home/b")).st_ino:
                return os.stat_result((st.st_mode, a_ino.st_ino, a_ino.st_dev) + tuple(st)[3:])
            return st
        G.os.fstat = fstat
        try:
            self.assertEqual(v.run(), (False, ["mount-crossing"]))
            self.assertEqual(v.run(dict(ALLOW, mounts=["/home/b"])), (True, []))  # (the alias pinned by the image)
            self.assertEqual(v.run(dict(ALLOW, mounts=["/home/a"])), (True, []))  # (or the path it aliases)
        finally:
            G.os.fstat = real_fstat
        self.assertEqual(v.run(), (True, []))  # (the control: two different directories)


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


class ConfigDriveTest(Base):
    def test_a_config_drive_label_in_any_case(self):
        for label in ("config-2", "CONFIG-2", "Config-2", "cidata", "CIDATA", "CiData"):
            v = self.vm()
            v.link("dev/disk/by-label/" + label, "../../vdb")
            self.assertEqual(v.run(), (False, ["config-drive"]), label)
        for label in ("config-22", "my-cidata", "cloudimg-rootfs"):
            v = self.vm()
            v.link("dev/disk/by-label/" + label, "../../vdb")
            self.assertEqual(v.run(), (True, []), label)


class InputTest(Base):
    def test_the_allowlist_is_strict(self):
        v = self.vm()
        p = v.write("allow.json", json.dumps(ALLOW))
        self.assertEqual(G.load_allowlist(p), ALLOW)
        for bad in (dict(ALLOW, v=2), dict(ALLOW, processes=["bash"]),
                    dict(ALLOW, loopback=[{"process": RESOLVED, "proto": "tcp", "address": "0.0.0.0", "port": 53}]),
                    dict(ALLOW, loopback=[{"process": RESOLVED, "proto": "tcp", "address": "127.0.0.1", "port": 22}]),
                    dict(ALLOW, loopback=[{"process": RESOLVED, "proto": "sctp", "address": "127.0.0.1", "port": 53}]),
                    dict(ALLOW, mounts=["/"]), dict(ALLOW, mounts=["home"]), dict(ALLOW, mounts=["/home/../root"]),
                    dict(ALLOW, providerReader2=["qemu-ga"]),                      # (not an absolute path)
                    dict(ALLOW, providerReader2=[PY]),                             # (also an ordinary process: no label)
                    dict(ALLOW, providerReader2=["/usr/sbin/grafana-agent"]),      # (both kept and neutralised)
                    dict(ALLOW, neutralisedAgents=[{"unit": "hyperstack-agent", "process": "x"}]),  # (a provider agent)
                    dict(ALLOW, neutralisedAgents=[{"unit": "x", "process": "hyperstack-agent"}]),
                    dict(ALLOW, neutralisedAgents=[{"unit": "Bad Name", "process": "x"}]),
                    dict(ALLOW, neutralisedAgents=[{"unit": "x"}]),
                    dict(ALLOW, sudoers={"/etc/passwd": "0" * 64}), dict(ALLOW, sudoers={"/etc/sudoers": "zz"}),
                    dict(ALLOW, sudoers={"/etc/sudoers.d/../shadow": "0" * 64}),
                    {k: x for k, x in ALLOW.items() if k != "sudoers"}):
            with self.assertRaises(ValueError, msg=bad):
                G.load_allowlist(v.write("bad.json", json.dumps(bad)))
        ok = dict(ALLOW, providerReader2=["/usr/sbin/qemu-ga"], sudoers=dict(ALLOW["sudoers"], **{"/etc/sudoers.d/README": "0" * 64}))
        self.assertEqual(G.load_allowlist(v.write("ok.json", json.dumps(ok))), ok)

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
