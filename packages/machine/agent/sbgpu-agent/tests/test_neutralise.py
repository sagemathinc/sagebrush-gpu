"""The neutralise step (sbgpu_agent/neutralise.py) on a fake VM shaped like the one a reseller rents out (provider keys
and logins, a sudo user with a password, gettys, a monitoring agent, container runtimes, job services, no metadata
rules), with systemd, logind, nft and kill stood in for.  After it, the gate passes; without each action, the gate
fails with that action's word."""

import fnmatch
import hashlib
import io
import json
import os
import stat
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sbgpu_agent import neutralise as N  # noqa: E402
from sbgpu_agent import vmgate as G  # noqa: E402
from test_vmgate import ALLOW, PY, SUDOERS, VM, nft_json  # noqa: E402

GRAFANA, AGETTY, DOCKERD, CRON = "/usr/bin/grafana-agent", "/sbin/agetty", "/usr/bin/dockerd", "/usr/sbin/cron"
PROVIDER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIProviderKeyProviderKeyProviderKey provider\n"


class FakeOps:
    """systemd, logind, nft and kill, over a fake VM: stopping a unit ends what it owns."""

    def __init__(self, vm):
        self.vm = vm
        self.active = {}      # unit -> ActiveState
        self.owns = {}        # unit -> ([pids], [files])
        self.stuck = {}       # unit -> the state a stop leaves it in
        self.instances = set()
        self.fail = set()     # commands (as tuples) that fail
        self.unkillable = set()
        self.nft = None
        self.calls = []

    def run(self, argv, data=None):
        self.calls.append(tuple(argv))
        if tuple(argv) in self.fail:
            return 1, b""
        root = self.vm.root
        if argv[:2] == ["systemctl", "stop"]:
            u = argv[2]
            self.active[u] = self.stuck.get(u, "inactive")
            if u not in self.stuck:
                pids, files = self.owns.pop(u, ([], []))
                for pid in pids:
                    self.vm.remove_process(pid)
                for f in files:
                    os.unlink(self.vm.path(f))
                self.instances.discard(u)
            return 0, b""
        if argv[:2] == ["systemctl", "mask"]:
            p = self.vm.path("etc/systemd/system/" + argv[2])
            if os.path.lexists(p):
                return (0 if os.path.islink(p) and os.readlink(p) == "/dev/null" else 1), b""
            os.makedirs(os.path.dirname(p), exist_ok=True)
            os.symlink("/dev/null", p)
            return 0, b""
        if argv[:2] == ["systemctl", "show"]:
            prop, u = argv[2].split("=")[1], argv[4]
            if prop == "ActiveState":
                return 0, (self.active.get(u, "inactive") + "\n").encode()
            st = G.unit_state(root, u)
            return 0, ({"masked": "masked", "present": "loaded", "absent": "not-found"}[st] + "\n").encode()
        if argv[:2] == ["systemctl", "list-units"]:
            pats = [a for a in argv[2:] if not a.startswith("--")]
            names = sorted(n for n in self.instances if any(fnmatch.fnmatch(n, p) for p in pats))
            return 0, "".join("%s loaded active running x\n" % n for n in names).encode()
        if argv[:2] == ["loginctl", "terminate-user"]:
            uid = self.vm.uid_of(argv[2])
            for pid in self.vm.pids_with_uid(uid):
                if pid not in self.unkillable:
                    self.vm.remove_process(pid)
            return 0, b""
        if argv[:2] == ["loginctl", "disable-linger"]:
            return 0, b""
        if argv[:3] == ["nft", "-f", "-"]:
            self.nft = data
            return 0, b""
        if argv[:2] == ["nft", "-j"]:
            return (0, nft_json()) if self.nft == N.NFT_SCRIPT.encode() else (1, b"")
        raise AssertionError("unexpected command %r" % (argv,))

    def kill(self, pid, sig):
        self.calls.append(("kill", pid))
        if pid not in self.unkillable:
            self.vm.remove_process(pid)

    def sleep(self, s):
        pass

    def listing(self):
        rc, out = self.run(["nft", "-j", "list", "table", "inet", "sbgpu_meta"])
        if rc:
            raise G.Unreadable("nft")
        return out


class RentedVM(VM):
    """The gate's fake VM, as the provider hands it over (r7/r8 on Hyperstack via Shadeform)."""

    def __init__(self):
        super().__init__()
        self.users = {"root": 0, "ubuntu": 1000, "shadeform": 1001, "messagebus": 102, "_apt": 105, "nobody": 65534}
        self.write("etc/passwd", "root:x:0:0:root:/root:/bin/bash\n"
                                 "messagebus:x:102:106::/nonexistent:/usr/sbin/nologin\n"
                                 "_apt:x:105:65534::/nonexistent:/usr/sbin/nologin\n"
                                 "ubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n"
                                 "shadeform:x:1001:1001::/home/shadeform:/bin/bash\n"
                                 "nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin\n")
        self.write("etc/shadow", "root:*:19000:0:99999:7:::\nmessagebus:*:19000:0:99999:7:::\n_apt:*:19000:0:99999:7:::\n"
                                 "ubuntu:!:19000:0:99999:7:::\nshadeform:$6$salt$hash:19000:0:99999:7:::\n"
                                 "nobody:*:19000:0:99999:7:::\n")
        os.chmod(self.path("etc/shadow"), 0o640)
        self.write("etc/group", "root:x:0:\nsudo:x:27:ubuntu,shadeform\nubuntu:x:1000:\nshadeform:x:1001:\n")
        self.write("etc/sudoers.d/90-cloud-init-users", "ubuntu ALL=(ALL) NOPASSWD:ALL\nshadeform ALL=(ALL) NOPASSWD:ALL\n")
        self.write("root/.ssh/authorized_keys", PROVIDER_KEY)
        self.write("home/shadeform/.ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaOurLaunchKeyOurLaunchKeyOurLaunchKey ours\n")
        self.ops = FakeOps(self)
        self.unit("getty@.service")
        self.unit("serial-getty@.service")
        for inst, pid in (("getty@tty1.service", 500), ("serial-getty@ttyS0.service", 501)):
            self.process(pid, "agetty", AGETTY)
            self.ops.instances.add(inst)
            self.ops.active[inst] = "active"
            self.ops.owns[inst] = ([pid], [])
        self.unit("grafana-agent.service", pids=[600], exe=GRAFANA)
        self.unit("docker.socket", files=["run/docker.sock"])
        self.unit("docker.service", pids=[610], exe=DOCKERD)
        self.unit("containerd.service", files=["run/containerd/containerd.sock"])
        self.unit("cron.service", pids=[620], exe=CRON)
        for u in ("snapd.service", "snapd.socket", "packagekit.service", "apt-daily.timer", "apport-forward.socket"):
            self.unit(u)
        self.process(700, "bash", PY, uid=1000)   # (the provider's session as ubuntu)
        self.process(701, "sd-pam", PY, uid=1001)
        self.nft = None

    def unit(self, name, pids=(), exe=None, files=()):
        self.write("lib/systemd/system/" + name, "[Unit]\n")
        for f in files:
            self.write(f, "")
        for pid in pids:
            self.process(pid, os.path.basename(exe)[:15], exe)
        self.ops.active[name] = "active"
        self.ops.owns[name] = (list(pids), list(files))

    def remove_process(self, pid):
        base = self.path("proc/%d" % pid)
        for dirpath, dirnames, filenames in os.walk(base, topdown=False):
            for f in filenames + dirnames:
                p = os.path.join(dirpath, f)
                os.unlink(p) if os.path.islink(p) or not os.path.isdir(p) else os.rmdir(p)
        if os.path.isdir(base):
            os.rmdir(base)

    def uid_of(self, name):
        return self.users[name]

    def pids_with_uid(self, uid):
        out = []
        for n in os.listdir(self.proc):
            if n.isdigit() and os.path.exists(self.path("proc/%s/status" % n)):
                if ("\t%d\t" % uid) in open(self.path("proc/%s/status" % n)).read():
                    out.append(int(n))
        return out

    def neutralise(self, allow=None):
        return N.run(allow or GATE_ALLOW, root=self.root, proc=self.proc, ops=self.ops)

    def gate(self, allow=None):
        self.nft = self.ops.listing() if self.ops.nft else b""
        return self.run(allow or GATE_ALLOW)


GATE_ALLOW = dict(ALLOW, sentinelHomes=["/nonexistent"])


class Base(unittest.TestCase):
    def vm(self):
        v = RentedVM()
        self.addCleanup(v.close)
        return v

    def lying(self, v, answers):
        real = v.ops.run

        def run(argv, data=None):
            for prefix, answer in answers:
                if tuple(argv[:len(prefix)]) == prefix:
                    v.ops.calls.append(tuple(argv))
                    return answer
            return real(argv, data)
        v.ops.run = run

    def patch(self, obj, name, value):
        old = getattr(obj, name)
        setattr(obj, name, value)
        self.addCleanup(setattr, obj, name, old)


class WholeStepTest(Base):
    def test_a_rented_vm_fails_the_gate_until_neutralised_then_passes(self):
        v = self.vm()
        ok, words = v.gate()
        self.assertFalse(ok)
        for w in ("authorized-keys", "password", "sudo", "console-login", "agent-active", "container-runtime",
                  "user-session", "imds", "process"):
            self.assertIn(w, words)
        self.assertEqual(v.neutralise(), (True, []))
        self.assertEqual(v.gate(), (True, []))

    def test_ssh_goes_first_then_sessions_and_the_metadata_last(self):
        v = self.vm()
        self.assertEqual(v.neutralise(), (True, []))
        calls = v.ops.calls
        first_login = next(i for i, c in enumerate(calls) if c[0] == "loginctl")
        ssh_stops = [i for i, c in enumerate(calls) if c[:2] == ("systemctl", "stop") and c[2] in N.SSH_UNITS]
        self.assertEqual(len(ssh_stops), 3)
        self.assertLess(max(ssh_stops), first_login)
        self.assertEqual(calls[-2][:3], ("nft", "-f", "-"))

    def test_running_it_twice_changes_nothing_the_second_time(self):
        v = self.vm()
        self.assertEqual(v.neutralise(), (True, []))
        before = {p: os.lstat(v.path(p)).st_ino for p in ("etc/shadow", "etc/group", "etc/passwd")}
        self.assertEqual(v.neutralise(), (True, []))
        self.assertEqual({p: os.lstat(v.path(p)).st_ino for p in before}, before)
        self.assertEqual(v.gate(), (True, []))

    def test_without_each_action_the_gate_fails_with_its_word(self):
        skips = [
            ("end_sessions", lambda *a: None, "user-session"),
            ("empty_keys", lambda *a: None, "authorized-keys"),
            ("lock_passwords", lambda *a: None, "password"),
            ("drop_sudo", lambda *a: None, "sudo"),
            ("console_units", lambda *a: [], "console-login"),
            ("agent_units", lambda *a: [], "agent-active"),
            ("CONTAINER_UNITS", (), "container-runtime"),
            ("JOB_UNITS", (), "process"),
            ("block_metadata", lambda *a: None, "imds"),
        ]
        for name, value, word in skips:
            v = self.vm()
            old = getattr(N, name)
            setattr(N, name, value)
            try:
                self.assertEqual(v.neutralise(), (True, []), name)
            finally:
                setattr(N, name, old)
            ok, words = v.gate()
            self.assertIn(word, words, name)


class UnitsTest(Base):
    def test_each_unit_is_proved_down_and_masked(self):
        for state in ("deactivating", "activating", "active", "reloading"):
            v = self.vm()
            v.ops.stuck["cron.service"] = state
            self.assertEqual(v.neutralise(), (False, ["units"]), state)
        v = self.vm()
        v.ops.stuck["cron.service"] = "failed"  # (failed is down)
        self.assertEqual(v.neutralise(), (True, []))
        v = self.vm()
        v.write("etc/systemd/system/cron.service", "[Unit]\n")  # (a file where the mask would go: mask fails)
        self.assertEqual(v.neutralise(), (False, ["units"]))
        v = self.vm()
        v.ops.fail.add(("systemctl", "show", "--property=ActiveState", "--value", "cron.service"))
        self.assertEqual(v.neutralise(), (False, ["units"]))
        v = self.vm()
        v.ops.fail.add(("systemctl", "mask", "packagekit.service"))
        self.assertEqual(v.neutralise(), (False, ["units"]))

    def test_disk_and_systemd_must_both_say_masked_and_down(self):
        v = self.vm()  # (systemctl says it masked, and systemd says masked, but nothing is on disk)
        self.lying(v, [(("systemctl", "mask", "cron.service"), (0, b"")),
                       (("systemctl", "show", "--property=LoadState", "--value", "cron.service"), (0, b"masked\n"))])
        self.assertEqual(v.neutralise(), (False, ["units"]))
        v = self.vm()  # (masked on disk, but systemd still has it loaded: not reloaded)
        self.lying(v, [(("systemctl", "show", "--property=LoadState", "--value", "cron.service"), (0, b"loaded\n"))])
        self.assertEqual(v.neutralise(), (False, ["units"]))
        v = self.vm()  # (a show that fails, whatever it printed)
        self.lying(v, [(("systemctl", "show", "--property=ActiveState", "--value", "cron.service"), (1, b"inactive\n"))])
        self.assertEqual(v.neutralise(), (False, ["units"]))

    def test_an_alias_to_a_masked_unit_isnt_masked_again(self):
        v = self.vm()
        self.assertEqual(v.neutralise(), (True, []))
        self.assertNotIn(("systemctl", "mask", "sshd.service"), v.ops.calls)  # (Ubuntu's alias to ssh.service)

    def test_console_instances_are_stopped_and_their_templates_masked(self):
        v = self.vm()
        v.write("lib/systemd/system/getty@tty2.service", "[Unit]\n")  # (an instance file of its own)
        self.assertEqual(v.neutralise(), (True, []))
        for u in ("getty@.service", "serial-getty@.service", "getty@tty2.service", "getty@tty1.service"):
            self.assertEqual(G.unit_state(v.root, u), "masked", u)
        self.assertIn(("systemctl", "stop", "serial-getty@ttyS0.service"), v.ops.calls)
        self.assertNotIn(("systemctl", "show", "--property=ActiveState", "--value", "getty@.service"), v.ops.calls)
        v = self.vm()
        v.ops.stuck["serial-getty@ttyS0.service"] = "deactivating"
        self.assertEqual(v.neutralise(), (False, ["units"]))
        v = self.vm()
        v.ops.fail.add(("systemctl", "list-units", "--all", "--plain", "--no-legend", "--full", "getty@*",
                        "serial-getty@*", "autovt@*", "container-getty@*", "console-getty.service"))
        self.assertEqual(v.neutralise(), (False, ["units"]))
        v = self.vm()
        self.patch(N, "UNITS_MAX", 1)
        self.assertEqual(v.neutralise(), (False, ["units"]))

    def test_every_unit_of_a_neutralised_agent(self):
        v = self.vm()
        for u in ("grafana-agent.socket", "grafana-agent.timer", "grafana-agent@x.service", "grafana-agent-other.service"):
            v.unit(u)
        self.assertEqual(v.neutralise(), (True, []))
        for u in ("grafana-agent.service", "grafana-agent.socket", "grafana-agent.timer", "grafana-agent@x.service"):
            self.assertEqual(G.unit_state(v.root, u), "masked", u)
        self.assertNotEqual(G.unit_state(v.root, "grafana-agent-other.service"), "masked")  # (not its unit)
        self.assertEqual(N.agent_units(v.root, dict(GATE_ALLOW, neutralisedAgents=[])), [])


class SessionsTest(Base):
    def test_sessions_ended_and_stragglers_killed(self):
        v = self.vm()
        v.process(702, "nohup", PY, uid=1000)  # (left behind by logind's terminate)
        real = v.ops.run

        def run(argv, data=None):
            if argv[:2] == ["loginctl", "terminate-user"]:
                return 0, b""  # (logind ends nothing: the kill must)
            return real(argv, data)
        v.ops.run = run
        self.assertEqual(v.neutralise(), (True, []))
        self.assertIn(("kill", 702), v.ops.calls)
        self.assertEqual(v.pids_with_uid(1000), [])
        self.assertIn(("loginctl", "disable-linger", "shadeform"), v.ops.calls)
        self.assertNotIn(("loginctl", "terminate-user", "messagebus"), v.ops.calls)  # (a system user)

    def test_every_uid_counts_and_uid_1000_is_a_user(self):
        v = self.vm()
        v.process(704, "setuid", PY)
        v.write("proc/704/status", "Uid:\t0\t1000\t0\t0\n")  # (only its effective uid)
        self.lying(v, [(("loginctl", "terminate-user"), (0, b""))])  # (logind ends nothing: the kill must find it)
        self.assertEqual(v.neutralise(), (True, []))
        self.assertIn(("kill", 704), v.ops.calls)
        self.assertIn(("loginctl", "terminate-user", "ubuntu"), v.ops.calls)  # (uid 1000 itself)

    def test_a_process_that_wont_die_stops_the_step(self):
        v = self.vm()
        v.ops.unkillable.add(700)
        self.assertEqual(v.neutralise(), (False, ["sessions"]))
        self.assertEqual(sum(1 for c in v.ops.calls if c == ("kill", 700)), N.KILL_ROUNDS)

    def test_a_process_whose_ids_cant_be_read_stops_the_step(self):
        v = self.vm()
        v.write("proc/620/status", "Name:\tcron\n")
        self.assertEqual(v.neutralise(), (False, ["sessions"]))
        v = self.vm()
        os.unlink(v.path("proc/620/status"))  # (no status, but still there)
        self.assertEqual(v.neutralise(), (False, ["sessions"]))
        v = self.vm()
        v.write("proc/703/stat", "703 (gone) S 0\n")  # (a process already gone: no status, no directory... almost)
        os.unlink(v.path("proc/703/stat"))
        os.rmdir(v.path("proc/703"))
        self.assertEqual(v.neutralise(), (True, []))
        v = self.vm()
        self.assertEqual(N._user_pids(v.proc), [700, 701])
        os.makedirs(v.path("proc/self"), exist_ok=True)
        self.assertEqual(N._user_pids(v.proc), [700, 701])  # (non-numeric entries are skipped)


class KeysTest(Base):
    def keyfile(self, v, rel):
        return open(v.path(rel), "rb").read()

    def test_keys_become_exactly_empty_in_place(self):
        v = self.vm()
        p = v.path("root/.ssh/authorized_keys")
        os.chmod(p, 0o600)
        st = os.lstat(p)
        fsyncs = []
        real = os.fsync
        self.patch(N.os, "fsync", lambda fd: fsyncs.append(fd) or real(fd))
        self.assertEqual(v.neutralise(), (True, []))
        self.assertEqual(self.keyfile(v, "root/.ssh/authorized_keys"), b"")
        self.assertEqual(self.keyfile(v, "home/shadeform/.ssh/authorized_keys"), b"")
        after = os.lstat(p)
        self.assertEqual((after.st_ino, stat.S_IMODE(after.st_mode), after.st_uid), (st.st_ino, 0o600, st.st_uid))
        self.assertGreaterEqual(len(fsyncs), 4)  # (each emptied file and its directory, at least)

    def test_fsync_of_the_file_and_its_directory(self):
        v = self.vm()
        fsyncs = []
        real = os.fsync

        def fsync(fd):
            fsyncs.append(stat.S_ISDIR(os.fstat(fd).st_mode))
            real(fd)
        self.patch(N.os, "fsync", fsync)
        root = v.root
        N.empty_keys(root, "/root", set(), set(), {})
        self.assertEqual(fsyncs, [False, True])  # (the file, then .ssh)
        fsyncs.clear()
        N.empty_keys(root, "/home/ubuntu", set(), set(), {})  # (already empty: still truncated and synced)
        self.assertEqual(fsyncs, [False, True])
        fsyncs.clear()
        N.empty_keys(root, "/home/nobody-here", set(), set(), {})
        self.assertEqual(fsyncs, [])

    def test_anything_but_a_regular_file_on_its_own_device_stops_untouched(self):
        v = self.vm()
        target = v.write("opt/elsewhere", "precious\n")
        os.unlink(v.path("root/.ssh/authorized_keys"))
        os.symlink(target, v.path("root/.ssh/authorized_keys"))
        self.assertEqual(v.neutralise(), (False, ["keys"]))
        self.assertEqual(open(target).read(), "precious\n")  # (never followed)
        v = self.vm()
        os.unlink(v.path("root/.ssh/authorized_keys"))
        os.mkfifo(v.path("root/.ssh/authorized_keys"))
        self.assertEqual(v.neutralise(), (False, ["keys"]))
        v = self.vm()
        os.unlink(v.path("root/.ssh/authorized_keys"))
        os.makedirs(v.path("root/.ssh/authorized_keys"))
        self.assertEqual(v.neutralise(), (False, ["keys"]))
        v = self.vm()
        os.makedirs(v.path("opt/realhome/.ssh"))
        v.write("opt/realhome/.ssh/authorized_keys", PROVIDER_KEY)
        os.rename(v.path("home/shadeform"), v.path("opt/shadeform-old"))
        os.symlink(v.path("opt/realhome"), v.path("home/shadeform"))  # (a linked home)
        self.assertEqual(v.neutralise(), (False, ["keys"]))
        self.assertEqual(open(v.path("opt/realhome/.ssh/authorized_keys")).read(), PROVIDER_KEY)

    def test_mount_points_need_a_pin(self):
        for point in ("/root/.ssh/authorized_keys", "/root/.ssh", "/home/shadeform"):
            v = self.vm()
            v.mountinfo("/", point)
            self.assertEqual(v.neutralise(), (False, ["keys"]), point)
            v = self.vm()
            v.mountinfo("/", point)
            self.assertEqual(v.neutralise(dict(GATE_ALLOW, mounts=[point])), (True, []), point)
            self.assertEqual(self.keyfile(v, "root/.ssh/authorized_keys"), b"")

    def test_a_truncate_that_didnt_take_stops_the_step(self):
        v = self.vm()
        self.patch(N.os, "ftruncate", lambda fd, n: None)
        self.assertEqual(v.neutralise(), (False, ["keys"]))

    def test_a_device_change_needs_a_pin(self):
        v = self.vm()
        real = os.fstat
        key_ino = os.lstat(v.path("root/.ssh/authorized_keys")).st_ino

        def fstat(fd):
            st = real(fd)
            if st.st_ino == key_ino:
                return os.stat_result((st.st_mode, st.st_ino, st.st_dev + 1) + tuple(st)[3:])
            return st
        self.patch(N.os, "fstat", fstat)
        self.assertEqual(v.neutralise(), (False, ["keys"]))
        self.assertEqual(self.keyfile(v, "root/.ssh/authorized_keys").decode(), PROVIDER_KEY)  # (before truncating)

    def test_homes_shared_once_and_aliases_refused_unless_pinned(self):
        v = self.vm()
        v.write("etc/passwd", open(v.path("etc/passwd")).read() + "second:x:1002:1002::/home/shadeform:/bin/bash\n")
        v.write("etc/shadow", open(v.path("etc/shadow")).read() + "second:!:19000:0:99999:7:::\n")
        v.users["second"] = 1002
        self.assertEqual(v.neutralise(), (True, []))
        v = self.vm()
        os.makedirs(v.path("home/alias"))
        v.write("etc/passwd", open(v.path("etc/passwd")).read() + "al:x:1003:1003::/home/alias:/bin/bash\n")
        v.write("etc/shadow", open(v.path("etc/shadow")).read() + "al:!:19000:0:99999:7:::\n")
        v.users["al"] = 1003
        target = os.lstat(v.path("home/shadeform"))
        real = os.fstat

        def fstat(fd):
            st = real(fd)
            if st.st_ino == os.lstat(v.path("home/alias")).st_ino:
                return os.stat_result((st.st_mode, target.st_ino, target.st_dev) + tuple(st)[3:])
            return st
        self.patch(N.os, "fstat", fstat)
        self.assertEqual(v.neutralise(), (False, ["keys"]))
        for pin in ("/home/alias", "/home/shadeform"):  # (either of the two paths, whichever is walked first)
            self.assertEqual(v.neutralise(dict(GATE_ALLOW, mounts=[pin])), (True, []), pin)

    def test_sentinel_homes_skipped_only_when_absent_locked_and_nologin(self):
        def with_home(home, shell="/usr/sbin/nologin", pw="*", sentinel=True):
            v = self.vm()
            os.makedirs(v.path("run"), exist_ok=True)
            os.makedirs(v.path("var"), exist_ok=True)
            os.symlink("../run", v.path("var/run"))  # (a link on the way: never walked through)
            v.write("etc/passwd", open(v.path("etc/passwd")).read() + "svc:x:120:120::%s:%s\n" % (home, shell))
            v.write("etc/shadow", open(v.path("etc/shadow")).read() + "svc:%s:19000:0:99999:7:::\n" % pw)
            allow = dict(GATE_ALLOW, sentinelHomes=["/nonexistent", home] if sentinel else ["/nonexistent"])
            return v, allow
        v, allow = with_home("/var/run/svc")
        self.assertEqual(v.neutralise(allow), (True, []))
        self.assertEqual(v.gate(allow), (True, []))
        for kw in ({"shell": "/bin/bash"}, {"pw": "$6$salt$hash"}, {"sentinel": False}):
            v, allow = with_home("/var/run/svc", **kw)
            self.assertEqual(v.neutralise(allow), (False, ["keys"]), kw)
        v, allow = with_home("/var/run/svc")
        os.makedirs(v.path("run/svc"))  # (it exists: a home like any other, through a link: refused)
        self.assertEqual(v.neutralise(allow), (False, ["keys"]))


class FilesTest(Base):
    def test_passwords_locked_with_owner_and_mode_kept(self):
        v = self.vm()
        v.write("etc/passwd", open(v.path("etc/passwd")).read().replace("root:x:0", "root:$6$inpasswd:0"))
        self.assertEqual(v.neutralise(), (True, []))
        rows = [ln.split(":") for ln in open(v.path("etc/shadow")).read().splitlines()]
        self.assertTrue(rows and all(r[1] == "!*" for r in rows))
        self.assertEqual(stat.S_IMODE(os.lstat(v.path("etc/shadow")).st_mode), 0o640)
        self.assertTrue(open(v.path("etc/passwd")).read().startswith("root:*:0:0:"))
        self.assertEqual(sorted(n for n in os.listdir(v.path("etc")) if n.endswith(".sbgpu")), [])
        v = self.vm()
        v.write("etc/shadow", "root:*:19000:0:99999:7::\n")
        self.assertEqual(v.neutralise(), (False, ["unreadable"]))
        v = self.vm()
        target = v.write("opt/shadow-elsewhere", "x:*:1:0:99999:7:::\n")
        os.unlink(v.path("etc/shadow"))
        os.symlink(target, v.path("etc/shadow"))
        self.assertEqual(v.neutralise(), (False, ["unreadable"]))

    def test_a_linked_file_is_never_replaced(self):
        v = self.vm()
        target = v.write("opt/real-group", "x:x:1:\n")
        os.unlink(v.path("etc/group"))
        os.symlink(target, v.path("etc/group"))
        with self.assertRaises(G.Unreadable):
            N.replace_file(v.root, "etc/group", b"y:x:2:\n")
        self.assertTrue(os.path.islink(v.path("etc/group")))
        self.assertEqual(open(target).read(), "x:x:1:\n")

    def test_a_leftover_temporary_file_is_replaced(self):
        v = self.vm()
        v.write("etc/.shadow.sbgpu", "stale")
        self.assertEqual(v.neutralise(), (True, []))
        self.assertFalse(os.path.lexists(v.path("etc/.shadow.sbgpu")))

    def test_sudo_dropped(self):
        v = self.vm()
        readme = "# README\n"
        v.write("etc/sudoers.d/README", readme)
        target = v.write("opt/keep", "precious\n")
        os.symlink(target, v.path("etc/sudoers.d/link"))
        allow = dict(GATE_ALLOW, sudoers=dict(GATE_ALLOW["sudoers"], **{"/etc/sudoers.d/README": hashlib.sha256(readme.encode()).hexdigest()}))
        self.assertEqual(v.neutralise(allow), (True, []))
        self.assertEqual(sorted(os.listdir(v.path("etc/sudoers.d"))), ["README"])
        self.assertEqual(open(target).read(), "precious\n")
        self.assertIn("sudo:x:27:\n", open(v.path("etc/group")).read())
        self.assertEqual(v.gate(allow), (True, []))
        v = self.vm()
        v.write("etc/sudoers.d/README", "# changed\n")
        self.assertEqual(v.neutralise(allow), (True, []))
        self.assertEqual(os.listdir(v.path("etc/sudoers.d")), [])  # (not the allowlist's bytes: removed)
        v = self.vm()
        v.write("etc/passwd", open(v.path("etc/passwd")).read().replace("shadeform:x:1001:1001:", "shadeform:x:1001:027:"))
        self.assertEqual(v.neutralise(), (False, ["sudo"]))
        v = self.vm()
        v.write("etc/sudoers", SUDOERS + "shadeform ALL=(ALL) NOPASSWD:ALL\n")
        self.assertEqual(v.neutralise(), (False, ["sudo"]))
        v = self.vm()
        os.unlink(v.path("etc/sudoers"))
        self.assertEqual(v.neutralise(), (True, []))


class MetadataTest(Base):
    def test_the_rules_applied_and_proved(self):
        v = self.vm()
        self.assertEqual(v.neutralise(), (True, []))
        self.assertEqual(v.ops.nft, N.NFT_SCRIPT.encode())
        v = self.vm()
        v.ops.fail.add(("nft", "-f", "-"))
        self.assertEqual(v.neutralise(), (False, ["metadata"]))
        v = self.vm()
        v.ops.nft = N.NFT_SCRIPT.encode()  # (a table already there from before: a failed apply still fails)
        v.ops.fail.add(("nft", "-f", "-"))
        self.assertEqual(v.neutralise(), (False, ["metadata"]))
        v = self.vm()
        real = v.ops.run

        def run(argv, data=None):
            if argv[:2] == ["nft", "-j"]:
                return 0, nft_json(json.loads(nft_json())["nftables"][:-1])  # (one rule short)
            return real(argv, data)
        v.ops.run = run
        self.assertEqual(v.neutralise(), (False, ["metadata"]))
        v = self.vm()
        v.ops.fail.add(("nft", "-j", "list", "table", "inet", "sbgpu_meta"))
        self.assertEqual(v.neutralise(), (False, ["metadata"]))
        v = self.vm()
        self.patch(G, "NFT_MAX", 10)
        self.assertEqual(v.neutralise(), (False, ["metadata"]))

    def test_the_script_is_the_gate_rules(self):
        self.assertIn("ip daddr 169.254.0.0/16 reject", N.NFT_SCRIPT)
        self.assertIn("type filter hook output priority -300; policy accept;", N.NFT_SCRIPT)
        for fam, addr, n in G.META_RULES:
            self.assertIn("%s daddr %s%s reject" % (fam, addr, "" if n in (32, 128) else "/%d" % n), N.NFT_SCRIPT)


class MainTest(Base):
    def test_the_line_and_bad_input(self):
        self.assertEqual(N.line(False, ["keys"]), 'SBGPU-NEUTRALISE {"v":1,"ok":false,"fail":["keys"]}')
        out = io.StringIO()
        self.assertEqual(N.main(["/nonexistent/allow.json"], out), 1)
        self.assertEqual(out.getvalue(), 'SBGPU-NEUTRALISE {"v":1,"ok":false,"fail":["unreadable"]}\n')
        out = io.StringIO()
        self.assertEqual(N.main([], out), 1)
        self.assertTrue(set(N.WORDS) >= {"units", "sessions", "keys", "passwords", "sudo", "metadata", "unreadable"})


if __name__ == "__main__":
    unittest.main()
