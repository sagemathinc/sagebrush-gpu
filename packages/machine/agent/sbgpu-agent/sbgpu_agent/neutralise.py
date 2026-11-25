"""The boot script's neutralise step (DESIGN.md section 1.6; the SEC-cleared design, Nov 25): before the first gate, as
root, it closes the provider's access paths that a VM rented through a reseller carries (seen on Hyperstack via
Shadeform: the provider's own keys and logins, a sudo user with a password, console gettys, a monitoring agent and a
guest agent, container runtimes, update and job services, and the metadata service).  The gate then checks each
result itself; this step reporting success is never evidence on its own.

  N1  sessions   ssh is stopped and masked first; every user session (uid >= 1000) is ended and lingering turned off,
                 and any process still at uid >= 1000 is killed; none may remain
  N2  keys       every authorized_keys and authorized_keys2 under every passwd home is emptied: reached through
                 no-follow directory handles (never a link, never another mount unless pinned), opened without O_TRUNC,
                 proved a regular file on its directory's device, ftruncate(0), proved empty, fsynced with its directory
  N3  passwords  every shadow password becomes "!*" (and a hash in passwd itself, "*"); the files are replaced
                 atomically with their owner and mode
  N4  sudo       the sudo, admin and wheel groups lose their members; a sudoers.d file the image allowlist doesn't have
                 is removed; a user whose primary group is a sudo group, or a changed /etc/sudoers, stops the step
  N5-N8 units    the console logins, the neutralised agents, the container runtimes and the job and update services
                 are stopped and masked, and each is proved down (ActiveState inactive or failed, LoadState masked)
  N9  metadata   our nftables table rejects every metadata address in both families, and the gate's own check of the
                 listing must pass

It changes nothing it can't prove.  It prints one line, `SBGPU-NEUTRALISE {"v":1,"ok":bool,"fail":[...]}`, a fixed word
for the first step that failed (it stops there: the boot stops, and the watchdog ends the machine).
"""

import hashlib
import json
import os
import signal
import stat
import subprocess
import sys
import time

from . import vmgate as G

WORDS = ("units", "sessions", "keys", "passwords", "sudo", "metadata", "unreadable")

SSH_UNITS = ("ssh.socket", "ssh.service", "sshd.service")
CONTAINER_UNITS = ("docker.socket", "docker.service", "containerd.service")
JOB_UNITS = (  # (N8: exactly these, from the Hyperstack image's unit list)
    "cron.service",
    "snapd.service", "snapd.socket", "snapd.seeded.service", "snapd.autoimport.service", "snapd.core-fixup.service",
    "snapd.recovery-chooser-trigger.service", "snapd.snap-repair.timer", "snapd.snap-repair.service",
    "packagekit.service",
    "apt-daily.timer", "apt-daily-upgrade.timer", "apt-daily.service", "apt-daily-upgrade.service",
    "unattended-upgrades.service",
    "apport-forward.socket", "apport-autoreport.path", "apport-autoreport.timer", "apport-autoreport.service",
)
DOWN = ("inactive", "failed")      # (activating, deactivating, reloading or active is not down)
LOCKED = "!*"
KILL_ROUNDS = 5
UNITS_MAX = 4096                   # (instances listed by systemd)
NFT_SCRIPT = """table inet sbgpu_meta
delete table inet sbgpu_meta
table inet sbgpu_meta {
\tchain out {
\t\ttype filter hook output priority -300; policy accept;
\t\tip daddr 169.254.0.0/16 reject
\t\tip6 daddr fe80::a9fe:a9fe reject
\t\tip6 daddr fd00:ec2::254 reject
\t}
}
"""


class Failed(Exception):
    """A step that couldn't be done, or done and proved: its fixed word."""

    def __init__(self, word):
        super().__init__(word)
        self.word = word


class Ops:
    """The commands and signals the step uses, so tests can stand in for systemd, logind, nft and kill."""

    def run(self, argv, data=None):
        r = subprocess.run(argv, input=data, capture_output=True, timeout=60, check=False,
                           stdin=None if data is not None else subprocess.DEVNULL)
        return r.returncode, r.stdout

    def kill(self, pid, sig):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass

    def sleep(self, s):
        time.sleep(s)


# ---- units (N1's ssh, N5-N8)
def _show(ops, unit, prop):
    rc, out = ops.run(["systemctl", "show", "--property=" + prop, "--value", unit])
    if rc != 0:
        raise Failed("units")
    return out.decode("ascii", "replace").strip()


def unit_down(ops, root, unit):
    """Stop and mask one unit, and prove it: masked on disk (as the gate resolves it) and, unless a template, down."""
    ops.run(["systemctl", "stop", unit])  # (a unit the image hasn't got: nothing to stop)
    if G.unit_state(root, unit) != "masked":  # (an alias to a masked unit is masked already, and can't be masked)
        if ops.run(["systemctl", "mask", unit])[0] != 0 or G.unit_state(root, unit) != "masked":
            raise Failed("units")
    if unit.endswith("@.service"):
        return  # (systemd shows nothing for a template: its instances are proved one by one)
    if _show(ops, unit, "ActiveState") not in DOWN or _show(ops, unit, "LoadState") != "masked":
        raise Failed("units")


def _instances(ops, patterns):
    """Every loaded unit matching the patterns, as systemd lists them (capped)."""
    rc, out = ops.run(["systemctl", "list-units", "--all", "--plain", "--no-legend", "--full"] + list(patterns))
    if rc != 0:
        raise Failed("units")
    names = [ln.split()[0].decode("ascii", "replace") for ln in out.splitlines() if ln.strip()]
    if len(names) > UNITS_MAX:
        raise Failed("units")
    return names


def console_units(ops, root):
    templates = tuple(u.split("@")[0] + "@" for u in G.CONSOLE_UNITS if "@" in u)
    names = set(G.CONSOLE_UNITS) | {n for n in G.unit_names(root) if n.startswith(templates)}
    names |= set(_instances(ops, [t + "*" for t in templates] + ["console-getty.service"]))
    return sorted(names, key=lambda n: (n.endswith("@.service"), n))  # (instances first, then the templates)


def agent_units(root, allow):
    names = G.unit_names(root)
    out = []
    for a in allow["neutralisedAgents"]:
        u = a["unit"]
        out += sorted({u + ".service"} | {n for n in names if n in (u + ".socket", u + ".timer", u + ".path")
                                          or n.startswith(u + "@")})
    return out


# ---- N1 sessions
def _user_pids(proc):
    out = []
    for n in G._entries(proc, G.MAX_PROCS + 512):
        if not n.isdigit():
            continue
        try:
            status = G._read_bounded(os.path.join(proc, n, "status"), G.STATUS_MAX, regular=False)
        except (FileNotFoundError, G.Unreadable):
            if os.path.exists(os.path.join(proc, n)):
                raise Failed("sessions")
            continue  # (exited)
        uids = [int(x) for ln in status.split(b"\n") if ln.startswith(b"Uid:") for x in ln.split()[1:]]
        if len(uids) != 4:
            raise Failed("sessions")
        if max(uids) >= G.USER_UID_MIN:
            out.append(int(n))
    return out


def end_sessions(ops, root, proc):
    users = [r[0] for r in G._rows(os.path.join(root, "etc/passwd"), G.PASSWD_MAX, 7)
             if G._gid(r[2]) >= G.USER_UID_MIN]  # (a uid parses like a gid: decimal digits only)
    for u in users:
        ops.run(["loginctl", "terminate-user", u])   # (a user with no session: nothing to end)
        ops.run(["loginctl", "disable-linger", u])
    for _ in range(KILL_ROUNDS):
        pids = _user_pids(proc)
        if not pids:
            return
        for pid in pids:
            ops.kill(pid, signal.SIGKILL)
        ops.sleep(0.2)
    raise Failed("sessions")


# ---- N2 keys
def _empty_key(dfd, name, path, dev, mounts, pinned):
    try:
        fd = os.open(name, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dfd)
    except FileNotFoundError:
        return False
    except OSError:
        raise Failed("keys")  # (a link, a directory, anything not openable for writing as itself)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or (path not in pinned and (path in mounts or st.st_dev != dev)):
            raise Failed("keys")
        os.ftruncate(fd, 0)
        if os.fstat(fd).st_size != 0:
            raise Failed("keys")
        os.fsync(fd)
    finally:
        os.close(fd)
    return True


def empty_keys(root, home, mounts, pinned, seen):
    """Empty home/.ssh's key files, reached the way the gate reaches them (G._keys_state)."""
    fds = []
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        fds.append(fd)
        dev = os.fstat(fd).st_dev
        path = ""
        for part in [p for p in home.split("/") if p] + [".ssh"]:
            path += "/" + part
            try:
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            except FileNotFoundError:
                return
            except OSError:
                raise Failed("keys")  # (a link or a non-directory on the way: never followed)
            fds.append(fd)
            st = os.fstat(fd)
            if path not in pinned and (path in mounts or st.st_dev != dev):
                raise Failed("keys")
            dev = st.st_dev
            if path == home:
                key = (st.st_dev, st.st_ino)
                if key in seen:
                    if seen[key] == home or home in pinned or seen[key] in pinned:
                        return  # (the same directory: emptied once)
                    raise Failed("keys")  # (a second path to it, not pinned)
                seen[key] = home
        changed = False
        for name in ("authorized_keys", "authorized_keys2"):
            changed |= _empty_key(fd, name, path + "/" + name, dev, mounts, pinned)
        if changed:
            os.fsync(fd)
    finally:
        for f in fds:
            os.close(f)


# ---- N3, N4: files replaced atomically
def replace_file(root, rel, data):
    """Replace root/rel with `data`: same owner and mode, written to a new file beside it, fsynced, renamed over it,
    and the directory fsynced.  The file and its directory are reached without following links."""
    parent, name = os.path.split(rel)
    dfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in [p for p in parent.split("/") if p]:
            nfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dfd)
            os.close(dfd)
            dfd = nfd
        st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
        if not stat.S_ISREG(st.st_mode):
            raise G.Unreadable(rel)
        tmp = "." + name + ".sbgpu"
        try:
            os.unlink(tmp, dir_fd=dfd)
        except FileNotFoundError:
            pass
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        try:
            os.fchown(fd, st.st_uid, st.st_gid)
            os.fchmod(fd, stat.S_IMODE(st.st_mode))
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
        os.fsync(dfd)
    finally:
        os.close(dfd)


def _join(rows):
    return ("".join(":".join(r) + "\n" for r in rows)).encode("utf-8")


def lock_passwords(root):
    shadow = G._rows(os.path.join(root, "etc/shadow"), G.SHADOW_MAX, 9)
    if any(r[1] != LOCKED for r in shadow):
        replace_file(root, "etc/shadow", _join([[r[0], LOCKED] + r[2:] for r in shadow]))
    passwd = G._rows(os.path.join(root, "etc/passwd"), G.PASSWD_MAX, 7)
    if any(r[1] != "x" and not G._locked(r[1]) for r in passwd):
        replace_file(root, "etc/passwd", _join([r if r[1] == "x" or G._locked(r[1]) else [r[0], "*"] + r[2:]
                                                for r in passwd]))


def drop_sudo(root, allow):
    groups = G._rows(os.path.join(root, "etc/group"), G.GROUP_MAX, 4)
    gids = {G._gid(g[2]) for g in groups if g[0] in G.SUDO_GROUPS}
    if any(G._gid(r[3]) in gids for r in G._rows(os.path.join(root, "etc/passwd"), G.PASSWD_MAX, 7)):
        raise Failed("sudo")  # (a primary group can't be taken away safely here: stop)
    if any(g[0] in G.SUDO_GROUPS and g[3] for g in groups):
        replace_file(root, "etc/group", _join([g[:3] + [""] if g[0] in G.SUDO_GROUPS else g for g in groups]))
    try:
        data = G._read_bounded(os.path.join(root, "etc/sudoers"), G.SUDOERS_MAX)
        if allow["sudoers"].get("/etc/sudoers") != hashlib.sha256(data).hexdigest():
            raise Failed("sudo")  # (we never edit sudoers itself)
    except FileNotFoundError:
        pass
    try:
        names = G._entries(os.path.join(root, "etc/sudoers.d"), G.SUDOERS_D_MAX)
    except FileNotFoundError:
        return
    dfd = os.open(os.path.join(root, "etc/sudoers.d"), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for n in names:
            want = allow["sudoers"].get("/etc/sudoers.d/" + n)
            if want is not None:
                try:
                    if hashlib.sha256(G._read_bounded(n, G.SUDOERS_MAX, dir_fd=dfd)).hexdigest() == want:
                        continue
                except G.Unreadable:
                    pass
            os.unlink(n, dir_fd=dfd)  # (a link is removed as itself, never followed)
        os.fsync(dfd)
    finally:
        os.close(dfd)


# ---- N9 metadata
def block_metadata(ops):
    if ops.run(["nft", "-f", "-"], NFT_SCRIPT.encode())[0] != 0:
        raise Failed("metadata")
    rc, listing = ops.run(["nft", "-j", "list", "table", "inet", G.META_TABLE])
    if rc != 0 or len(listing) > G.NFT_MAX or not G.meta_rules_exact(listing):
        raise Failed("metadata")


# ---- the step
def run(allow, root="/", proc="/proc", ops=None):
    """(ok, [word]): N1-N9 in order, stopping at the first that fails."""
    ops = ops or Ops()
    try:
        for u in SSH_UNITS:
            unit_down(ops, root, u)
        end_sessions(ops, root, proc)
        mounts, pinned, seen = G.mount_points(proc), set(allow["mounts"]), {}
        for home in G._homes(root, allow["sentinelHomes"]):
            empty_keys(root, home, mounts, pinned, seen)
        lock_passwords(root)
        drop_sudo(root, allow)
        for u in console_units(ops, root) + agent_units(root, allow) + list(CONTAINER_UNITS) + list(JOB_UNITS):
            unit_down(ops, root, u)
        block_metadata(ops)
    except Failed as f:
        return False, [f.word]
    except (G.Unreadable, G.OverBudget, OSError, ValueError):
        return False, ["unreadable"]
    return True, []


def line(ok, words):
    return "SBGPU-NEUTRALISE " + json.dumps({"v": 1, "ok": bool(ok), "fail": list(words)}, separators=(",", ":"))


def main(argv=None, stdout=None):
    argv = sys.argv[1:] if argv is None else argv
    stdout = sys.stdout if stdout is None else stdout
    try:
        allow = G.load_allowlist(argv[0])
    except (IndexError, OSError, ValueError, G.Unreadable):
        stdout.write(line(False, ["unreadable"]) + "\n")
        return 1
    ok, words = run(allow)
    stdout.write(line(ok, words) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
