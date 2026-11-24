"""Terminals in the agent (DESIGN.md section 4.1): the sessions, their PTYs and lifecycle, and each page's attachment.

Ported from Sagebrush's runner (engine/py/python/sagebrush/remote/terminal.py; SageMath, Inc.).  What differs: the
relay authenticates every page before it reaches the agent (a single-use page token, bound to the member and this
machine), so an open carries no proof of its own, and its body is the message itself.  Everything else (sessions,
the ring and replay, credit, the grant rules, the tree rule at a stop) is the runner's, unchanged.

On a terminal page:

  page -> agent    {"t":"open","rows":r,"cols":c}                  a new session
                   {"t":"open","session":id,"rows":r,"cols":c}     reattach (id: 22 base64url characters)
                   {"t":"resize","rows":r,"cols":c}    {"t":"kill","session":id}
                   {"t":"in","b":"<base64>"}    {"t":"ack","upto":n}
  agent -> page    {"t":"opened","session":id}
                   {"t":"replay"}  {"t":"out","b":"<base64>"}...  {"t":"live"}
                   {"t":"out","b":"<base64>"}   {"t":"inack","upto":n}
                   {"t":"exit","code":n|null,"signal":s|null}   {"t":"error","error":e}

Errors (the page stays open): not_open, sessions (with "limit"), unknown_session, elsewhere (then close 4009),
expired, spawn (with "detail").  A malformed message closes the page: 1002 (not a terminal message, a malformed
resize, a kill for another session), 1008 (a second open, a malformed open, a bad ack, a malformed or oversized input
frame, input past its credit).

An open makes one attachment grant: (the leg, the page, the session).  It is the only authority for the page's
terminal: resize and kill are taken only from the page holding the live grant, for its own session.  A takeover
(another page opening the session), the page's close, a revoke and the leg's loss end it before any later effect; a
late message from an ended grant does nothing.

Sessions: at most 4 running; a PTY with $SHELL (else /bin/sh) as a login shell, in a new session, TERM=xterm-256color;
output read into a 1 MiB ring at most 1 MiB/s, and while a page is attached only within its credit
(terminal_output.py); ended sessions' rings kept 10 minutes, the last 8; a detached session with no output and no
attach for 24 h stopped.  Stopping (kill, exit's leftovers, the detached-idle stop, stop_all) is the tree rule over
every process group in the PTY's POSIX session: SIGHUP, SIGTERM, then SIGKILL 2 s later, with the session counted
again every 50 ms until it is empty, so a group made after one census is caught by the next.  Only then is the PTY
drained (bounded: one ring's worth) and closed; at 30 s it is closed whatever still writes.

What a terminal stop covers, exactly (kill, the detached-idle stop, stop_all): the terminal's original POSIX session
(its shell, its jobs, and every process group still in that session).  A process the member moves out of it (setsid,
a daemon) is the member's own process on their own machine: no terminal stop reaches it, by design (product ruling,
Nov 24).  The machine's stop reaches it: in container mode the agent, PID 1, ends every other process in the container
(proctree.stop_everything), and the provider's termination of the machine (at a stop, the budget's hard stop, or the
watchdog) is the outer boundary.  Idle detection counts GPU and process activity as well as terminals, so such a
process keeps the machine from looking idle.
"""

import asyncio
import base64
import fcntl
import os
import pty
import secrets
import signal
import struct
import subprocess
import sys
import termios

from sbgpu_agent.proctree import exit_status, kill_tree, session_groups
from sbgpu_agent.terminal_output import Attachment, IN_MAX, OUT_MAX, canonical_b64

TERMINAL_LIMITS = {
    "sessions": 4,              # running sessions in this agent
    "ring": 1024 * 1024,        # scrollback bytes per session
    "replayCut": 4096,          # the replay starts after the first \n in the ring's oldest this many bytes
    "ended": 8,                 # ended sessions whose rings are kept
    "endedMs": 10 * 60_000,     # ... for this long
    "idleMs": 24 * 3600_000,    # a detached session with no output and no attach this long is stopped
    "rate": 1024 * 1024,        # output bytes read per second, at most
    "read": OUT_MAX,            # one PTY read, at most (the decoded bytes one output frame holds)
    "size": (1, 1000),          # rows and cols
    "killMs": 2000,             # the tree rule's SIGTERM -> SIGKILL (proctree.kill_tree)
    "sweepMs": 50,              # a stopping session's census, again, until its PTY session is empty
    "sweepCapMs": 30_000,       # ... the PTY closed by then regardless; the census goes on every second
    "message": 8 * 1024,        # any message to the agent but `in`, bytes
    "in": IN_MAX,               # one input frame's decoded bytes
}
_SID_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
# (the PTY's slave becomes the shell's controlling terminal: start_new_session gives the child its own session,
# then this sets the terminal and execs the shell, so no preexec_fn runs.  It first gives every signal its default
# disposition and unblocks them all: exec keeps ignored signals and the mask, so an agent started with SIGINT ignored
# (nohup, a background job, some supervisors) would otherwise leave Ctrl-C dead in every terminal)
_CTTY = """import fcntl, os, signal, sys, termios
for n in signal.valid_signals():
    if n not in (signal.SIGKILL, signal.SIGSTOP):
        try:
            signal.signal(n, signal.SIG_DFL)
        except (OSError, ValueError):
            pass
signal.pthread_sigmask(signal.SIG_SETMASK, ())
fcntl.ioctl(0, termios.TIOCSCTTY, 0)
os.execvp(sys.argv[1], sys.argv[1:])
"""


def new_session_id():
    return base64.urlsafe_b64encode(secrets.token_bytes(16)).rstrip(b"=").decode("ascii")  # (22 characters)


def _size_ok(v):
    lo, hi = TERMINAL_LIMITS["size"]
    return type(v) is int and lo <= v <= hi


class Ring:
    """A session's last TERMINAL_LIMITS["ring"] output bytes, as bytes."""

    def __init__(self, cap=None):
        self.cap = cap or TERMINAL_LIMITS["ring"]
        self.buf = bytearray()
        self.total = 0  # (every byte ever appended)

    def append(self, b):
        self.total += len(b)
        self.buf += b
        if len(self.buf) > self.cap:
            del self.buf[:len(self.buf) - self.cap]

    def replay(self):
        """What a reattach replays: the ring, from after the first \\n in its oldest replayCut bytes if the ring has
        wrapped (so a line cut in two isn't shown half), else all of it."""
        b = bytes(self.buf)
        if self.total > len(b):
            i = b.find(b"\n", 0, TERMINAL_LIMITS["replayCut"])
            if i >= 0:
                return b[i + 1:]
        return b


class Grant:
    """One attachment's authority: its leg, page and session."""

    __slots__ = ("incarnation", "leg", "session", "page", "live", "att")

    def __init__(self, incarnation, page, session):
        self.incarnation, self.session = incarnation, session
        self.leg = page.leg  # (the leg it was made on: meaningless on any other)
        self.page, self.live = page, True
        self.att = None  # (its output and input paths: terminal_output.Attachment)

    def holds(self, page, incarnation, leg):
        return (self.live and self.page is page and self.incarnation == incarnation and self.leg is leg
                and page.leg is leg and not page.closed)


class Session:
    """A PTY and its shell, from open to its exit (or stop), and its ring for a while after."""

    def __init__(self, host, sid, rows, cols):
        self.host, self.id = host, sid
        self.ring = Ring()
        self.grant = None
        self.proc = self.master = None
        self.leader = None          # (the shell's pid: its session id and its first group)
        self.exit = None            # ({"code", "signal"} once it has exited)
        self.ended_at = None
        self.last_activity = host.timers.now()
        self.reading = False
        self.writing = False
        self.rate_at, self.rate_bytes, self.rate_timer = 0, 0, None
        self.pidfd = None
        self.poll_timer = None
        self.stopping = False
        self.sweep_started = None   # (when the stop's census began)
        self.sweep_timer = None
        self.signalled = {}         # (process group -> when it was sent SIGHUP and the tree rule)
        self.rows, self.cols = rows, cols

    # ---- start
    def spawn(self, cwd, env):
        master, slave = pty.openpty()
        try:
            self._winsize(master, self.rows, self.cols)
            shell = env.get("SHELL") or "/bin/sh"
            if not (os.path.isabs(shell) and os.access(shell, os.X_OK)):
                shell = "/bin/sh"
            env = dict(env, TERM="xterm-256color")
            self.proc = subprocess.Popen([sys.executable, "-I", "-S", "-c", _CTTY, shell, "-l"], stdin=slave,
                                         stdout=slave, stderr=slave, cwd=cwd, env=env, start_new_session=True,
                                         close_fds=True)
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        self.master, self.leader = master, self.proc.pid
        os.set_blocking(master, False)
        self.host.stats["spawned"] += 1
        self._read_on()
        self._watch_exit()

    @staticmethod
    def _winsize(fd, rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def resize(self, rows, cols):
        self.rows, self.cols = rows, cols
        if self.master is not None and self.exit is None:
            self._winsize(self.master, rows, cols)  # (the kernel signals SIGWINCH to the foreground group)

    # ---- output into the ring, at most TERMINAL_LIMITS["rate"] bytes a second, and to an attached page within its
    # credit: no credit, no read, so the PTY fills and the program blocks in write()
    def _att(self):
        """The attached page's output path, if it still takes output (not after its exit message)."""
        g = self.grant
        a = g.att if g is not None and g.live else None
        return a if a is not None and not a.exited else None

    def reading_changed(self):
        """Read again if nothing holds the reads back: the rate ceiling's pause, or an attached page's credit."""
        if self.master is None or self.rate_timer is not None:
            return
        a = self._att()
        if a is None or a.room() > 0:
            self._read_on()
        else:
            self._read_off()

    def writing_changed(self):
        a = self._att()
        want = a is not None and bool(a.inq) and self.master is not None
        if want and not self.writing:
            self.host.loop.add_writer(self.master, self._writable)
            self.writing = True
        elif not want and self.writing:
            self._write_off()

    def _write_off(self):
        if self.writing:
            self.host.loop.remove_writer(self.master)
            self.writing = False

    def _writable(self):
        a = self._att()
        if a is None or not a.writable():
            self._write_off()

    def write_pty(self, b):
        """Input to the PTY master, non-blocking: how many bytes it took, or None for none now.  After the shell's end
        (EIO) the bytes are dropped, as a terminal's would be."""
        try:
            return os.write(self.master, b)
        except BlockingIOError:
            return None
        except OSError:
            return len(b)

    def _read_on(self):
        if not self.reading and self.master is not None:
            self.host.loop.add_reader(self.master, self._readable)
            self.reading = True

    def _read_off(self):
        if self.reading:
            self.host.loop.remove_reader(self.master)
            self.reading = False

    def _readable(self):
        now = self.host.timers.now()
        if now - self.rate_at >= 1000:
            self.rate_at, self.rate_bytes = now, 0
        room = TERMINAL_LIMITS["rate"] - self.rate_bytes
        if room <= 0:
            return self._pause_until(self.rate_at + 1000 - now)
        a = self._att()
        if a is not None:
            room = min(room, a.room())  # (credit reserved before the read)
            if room <= 0:
                return self._read_off()  # (an ack or a flush reads again: reading_changed)
        try:
            b = os.read(self.master, min(TERMINAL_LIMITS["read"], room))
        except BlockingIOError:
            return
        except OSError:
            b = b""  # (EIO: every slave side closed, the shell's session is gone)
        if not b:
            return self._read_off()
        self.rate_bytes += len(b)
        if self.ring is not None:  # (released: an ended session pruned while its stop's sweep still runs)
            self.ring.append(b)
        self.last_activity = now
        self.host.stats["outBytes"] += len(b)
        if a is not None:
            a.feed(b)

    def _pause_until(self, ms):
        self._read_off()
        self.host.stats["ratePauses"] += 1

        def resume():
            self.rate_timer = None
            self.reading_changed()
        self.rate_timer = self.host.timers.set_timeout(resume, max(ms, 1))

    # ---- exit
    def _watch_exit(self):
        try:
            self.pidfd = os.pidfd_open(self.leader)
        except (AttributeError, OSError):
            self.pidfd = None
        if self.pidfd is not None:
            self.host.loop.add_reader(self.pidfd, self._reap)
        else:
            self._poll_exit()

    def _poll_exit(self):
        self.poll_timer = None
        if not self._reap():
            self.poll_timer = self.host.timers.set_timeout(self._poll_exit, 200)

    def _reap(self):
        if self.exit is not None:
            return True
        try:
            pid, status = os.waitpid(self.leader, os.WNOHANG)
        except ChildProcessError:
            pid, status = self.leader, None
        if pid == 0:
            return False
        self.proc.returncode = 0  # (reaped here: Popen mustn't wait for it again)
        code, sig = exit_status(status) if status is not None else (None, None)
        self.exit = {"code": code, "signal": sig}
        if self.pidfd is not None:
            self.host.loop.remove_reader(self.pidfd)
            os.close(self.pidfd)
            self.pidfd = None
        self.host.timers.clear_timeout(self.poll_timer)
        self.poll_timer = None
        # (what the shell left in its session, background jobs included: the tree rule, as at a kill; the PTY is
        # drained and closed once the session is empty, or at the sweep's bound, whichever is first)
        self._start_sweep()
        self.host.ended(self)
        return True

    def _drain(self):
        """The PTY's last output into the ring, once the session is empty: bounded work, never "until it stops"
        (at most one ring's worth, in at most that many reads), whatever is still writing."""
        left = TERMINAL_LIMITS["ring"]
        for _ in range(-(-left // TERMINAL_LIMITS["read"])):
            if self.master is None or left <= 0:
                return
            try:
                b = os.read(self.master, min(TERMINAL_LIMITS["read"], left))
            except OSError:
                return
            if not b:
                return
            left -= len(b)
            if self.ring is not None:
                self.ring.append(b)
            a = self._att()
            if a is not None:
                a.push_final(b)  # (within credit; the rest is in the ring only)

    def _release(self):
        self._read_off()
        self._write_off()
        self.host.timers.clear_timeout(self.rate_timer)
        self.rate_timer = None
        if self.master is not None:
            os.close(self.master)
            self.master = None
            if self.exit is not None:
                self.host.closed(self)  # (the PTY can yield nothing more: now the page's exit, after its last output)

    # ---- stop: the tree rule over every group in the PTY's session, again and again until it is empty
    def stop(self):
        self.stopping = True
        self._start_sweep()

    def _start_sweep(self):
        if self.leader is None or self.sweep_started is not None:
            return
        self.sweep_started = self.host.timers.now()
        STOPPING[self.leader] = self
        self._sweep()

    def _sweep(self):
        """One census of the PTY's session: a group not seen before gets SIGHUP and the tree rule (SIGTERM, SIGKILL
        2 s later); one seen and still there past that gets SIGKILL again.  So a job that makes a new group after
        an earlier census (trapping HUP or TERM) is caught by a later one.  Repeated every sweepMs until the session
        is empty and the shell reaped; then the bounded drain and the PTY closed.  At sweepCapMs the PTY is closed
        anyway (cleanup never waits on a producer), and the census goes on every second."""
        self.sweep_timer = None
        now = self.host.timers.now()
        groups = self.census()
        for g in groups:
            if g not in self.signalled:
                self.signalled[g] = now
                try:
                    os.killpg(g, signal.SIGHUP)
                except (ProcessLookupError, PermissionError):
                    continue
                kill_tree(g)
                self.host.stats["groupsStopped"] += 1
            elif now - self.signalled[g] > TERMINAL_LIMITS["killMs"] + TERMINAL_LIMITS["sweepMs"]:
                try:
                    os.killpg(g, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        if not groups and self.exit is not None:
            self._drain()
            self._release()
            STOPPING.pop(self.leader, None)
            return
        late = now - self.sweep_started >= TERMINAL_LIMITS["sweepCapMs"]
        if late and self.master is not None:
            self.host.stats["sweepCapped"] += 1
            self._drain()
            self._release()
        self.sweep_timer = self.host.timers.set_timeout(self._sweep, 1000 if late else TERMINAL_LIMITS["sweepMs"])

    def census(self):
        groups = session_groups(self.leader)
        if self.exit is None:
            groups.add(self.leader)
        return groups


STOPPING = {}  # (leader pid -> a Session being stopped whose census goes on: drain_sessions waits for them at exit)


async def drain_sessions(timeout=3.0):
    """At the agent's exit, before drain_groups: census every stopping session's PTY session until each is empty,
    giving any group made late its tree rule, then SIGKILL to every group still there at the deadline.  Returns the
    leaders whose sessions still had members then."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while True:
        alive = []
        for leader, s in list(STOPPING.items()):
            groups = s.census()
            if not groups and s.exit is not None:
                STOPPING.pop(leader, None)
                continue
            alive.append(leader)
            for g in groups:
                if g not in s.signalled:
                    s.signalled[g] = s.host.timers.now()
                    try:
                        os.killpg(g, signal.SIGHUP)
                    except (ProcessLookupError, PermissionError):
                        continue
                    kill_tree(g)
                elif loop.time() >= end:
                    try:
                        os.killpg(g, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
        if not alive or loop.time() >= end + 0.5:
            return alive
        await asyncio.sleep(0.05)


class Terminals:
    """The agent's terminal sessions and the grants of the pages attached to them.

    `host` gives: timers (now, set_timeout, clear_timeout), incarnation and leg (the current relay leg).  A page gives:
    leg, closed, grant (None until an open), send(obj), send_text(text, kind) and close(code, reason)."""

    def __init__(self, host, loop, cwd, env):
        self.host, self.loop = host, loop
        self.timers = host.timers
        self.cwd, self.env = cwd, dict(env)
        self.running = {}   # (session id -> Session)
        self.ended_ = []    # (ended Sessions, oldest first: at most TERMINAL_LIMITS["ended"], for endedMs)
        self.idle_timer = None
        self.prune_timer = None
        self.stats = {"spawned": 0, "opens": 0, "refused": 0, "takeovers": 0, "lateIgnored": 0, "outBytes": 0,
                      "ratePauses": 0, "groupsStopped": 0, "idleStopped": 0, "sweepCapped": 0, "expired": 0}

    # ---- pages
    def page_message(self, p, msg):
        # (a page that has closed, or is on a leg other than the current one, is gone: nothing it sends has any
        # effect, an open included, so a late open can't spawn, attach, resize or take a session over)
        if p.closed or p.leg is not self.host.leg:
            self.stats["lateIgnored"] += 1
            return None
        if not isinstance(msg, dict) or not isinstance(msg.get("t"), str):
            return p.close(1002, "not a terminal message")
        t = msg["t"]
        if t == "open":
            return self.open(p, msg)
        g = p.grant
        if g is None or not g.holds(p, self.host.incarnation, self.host.leg):
            # (a message with no live grant: nothing happens; a page that never opened is told so)
            self.stats["lateIgnored"] += 1
            if g is None:
                return self._error(p, "not_open")
            return None
        s = g.session
        if t == "resize":
            if set(msg) != {"t", "rows", "cols"} or not (_size_ok(msg["rows"]) and _size_ok(msg["cols"])):
                return p.close(1002, "a malformed resize")
            if s.exit is None:
                s.resize(msg["rows"], msg["cols"])
            return None
        if t == "kill":
            if set(msg) != {"t", "session"} or msg["session"] != s.id:
                return p.close(1002, "a kill for another session")
            if s.exit is None:
                s.stop()
            return None
        if t == "ack":
            if set(msg) != {"t", "upto"} or g.att is None or not g.att.ack(msg["upto"]):
                return p.close(1008, "a bad ack")  # (going back, past what was sent, or malformed: no credit change)
            return None
        if t == "in":
            b = canonical_b64(msg.get("b"), TERMINAL_LIMITS["in"]) if set(msg) == {"t", "b"} else None
            if b is None:
                return p.close(1008, "a malformed or oversized input frame")
            if s.exit is not None:
                return None  # (the shell has ended: input goes nowhere, as on a terminal)
            if not g.att.input(b):
                return p.close(1008, "input past its credit")
            return None
        return p.close(1002, "not a terminal message")

    def open(self, p, msg):
        """Everything checked before any effect, then the grant."""
        if p.grant is not None:
            return p.close(1008, "this page already has a terminal")
        if not (set(msg) in ({"t", "rows", "cols"}, {"t", "session", "rows", "cols"})
                and _size_ok(msg["rows"]) and _size_ok(msg["cols"])):
            return self._refuse(p, "shape")
        sid = msg.get("session")
        if sid is not None and not (isinstance(sid, str) and len(sid) == 22 and set(sid) <= _SID_CHARS):
            return self._refuse(p, "session")
        if sid is None:
            if len(self.running) >= TERMINAL_LIMITS["sessions"]:
                return self._error(p, "sessions", limit=TERMINAL_LIMITS["sessions"])
            s = Session(self, new_session_id(), msg["rows"], msg["cols"])
            try:
                s.spawn(self.cwd, self.env)
            except OSError as e:
                return self._error(p, "spawn", detail=type(e).__name__)
            self.running[s.id] = s
        else:
            self._prune_ended()  # (an ended session past its time is gone, whether or not its timer has run yet)
            s = self.running.get(sid) or next((e for e in self.ended_ if e.id == sid), None)
            if s is None:
                return self._error(p, "unknown_session")
            if s.grant is not None and s.grant.live:
                self.stats["takeovers"] += 1
                old = s.grant.page
                self._end_grant(s.grant)
                self._error(old, "elsewhere")
                old.close(4009, "the session was opened elsewhere")
            s.resize(msg["rows"], msg["cols"])
        g = s.grant = p.grant = Grant(self.host.incarnation, p, s)
        g.att = Attachment(s, p, s.write_pty)
        s.last_activity = self.timers.now()
        self.stats["opens"] += 1
        p.send({"t": "opened", "session": s.id})
        # (every attach replays: a reset, the ring, then live output; an ended session's exit comes after its replay)
        g.att.exit_after_replay = s.exit is not None and s.master is None  # (closed: else closed() sends it)
        g.att.start_replay(s.ring.replay() if s.ring is not None else b"")
        s.reading_changed()
        self._arm_idle()
        return None

    def page_gone(self, p):
        """The page closed, was closed, or its leg went: its grant ends; its session goes on, detached."""
        g = getattr(p, "grant", None)
        if g is not None:
            self._end_grant(g)

    def _end_grant(self, g):
        g.live = False
        g.page.grant = None
        if g.att is not None:
            g.att.end()  # (its buffered and replay bytes dropped: they are in the ring for the next attach)
        if g.session.grant is g:
            g.session.grant = None
            g.session.last_activity = self.timers.now()
            g.session.writing_changed()
            g.session.reading_changed()  # (detached: read into the ring at the rate ceiling only)

    def _refuse(self, p, reason):
        self.stats["refused"] += 1
        p.close(1008, "terminal open refused (%s)" % reason)

    def _error(self, p, error, **more):
        p.send(dict({"t": "error", "error": error}, **more))

    # ---- sessions' ends
    def ended(self, s):
        self.running.pop(s.id, None)
        s.ended_at = self.timers.now()
        self.ended_.append(s)
        self._prune_ended()
        # (the page's exit waits for the PTY's close (closed()): the shell's groups are stopped, the PTY drained to the
        # page within credit, and only then the exit, so no output can follow it)

    def closed(self, s):
        """An exited session's PTY is closed: its attached page gets what was buffered, then the exit, last."""
        g = s.grant
        if g is not None and g.live and not g.page.closed and g.att is not None and not g.att.exited:
            if g.att.replaying:
                g.att.exit_after_replay = True
            else:
                g.att.flush_now()
                g.att.send_exit()

    def _prune_ended(self):
        """Ended sessions past endedMs, or beyond the last `ended`, are gone: out of the list, their grant ended (so
        no page keeps one through it) and their ring released.  Then the next expiry is scheduled."""
        now = self.timers.now()
        keep = [e for e in self.ended_ if now - e.ended_at < TERMINAL_LIMITS["endedMs"]][-TERMINAL_LIMITS["ended"]:]
        for e in self.ended_:
            if e not in keep:
                self.stats["expired"] += 1
                if e.grant is not None:
                    page = e.grant.page
                    self._end_grant(e.grant)
                    self._error(page, "expired")
                e.ring = None
        self.ended_ = keep
        self.timers.clear_timeout(self.prune_timer)
        self.prune_timer = None
        if keep:
            due = keep[0].ended_at + TERMINAL_LIMITS["endedMs"] - now
            self.prune_timer = self.timers.set_timeout(self._prune_ended, max(due, 1))

    def _arm_idle(self):
        if self.idle_timer is None and self.running:
            self.idle_timer = self.timers.set_timeout(self._idle_check, 60_000)

    def _idle_check(self):
        """Every minute while sessions run: a detached one with no output and no attach for idleMs is stopped."""
        self.idle_timer = None
        now = self.timers.now()
        for s in list(self.running.values()):
            if s.grant is None and not s.stopping and now - s.last_activity >= TERMINAL_LIMITS["idleMs"]:
                self.stats["idleStopped"] += 1
                s.stop()
        self._prune_ended()
        self._arm_idle()

    def stop_all(self):
        """The agent ending (a stop, a revoke, SIGTERM): every session stopped by the tree rule."""
        self.timers.clear_timeout(self.idle_timer)
        self.timers.clear_timeout(self.prune_timer)
        self.idle_timer = self.prune_timer = None
        for s in list(self.running.values()):
            if s.grant is not None:
                self._end_grant(s.grant)
            s.stop()
