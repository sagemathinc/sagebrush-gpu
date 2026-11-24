"""Terminals in the agent (sbgpu_agent/terminal.py), with real PTYs.

Ported from Sagebrush's runner tests (engine/py/test_remote_terminal.py; SageMath, Inc.), over the harness in
termharness.py.  The relay authenticates pages there, so the proof tests are replaced by the open's own checks:

- the open: every malformed open refused (the page closed) before any effect: no PTY spawned; a second open on a
  page closes it; a message before an open is answered not_open;
- sessions: the shell in its own session with the PTY as its controlling terminal, TERM, the size, resize
  (SIGWINCH), the exit code and signal, kill (only its own session), the 5th session refused, the ring and its replay
  rule, ended sessions kept and pruned, idle stop (a logical clock), and every process group in the PTY's session
  gone after a kill, an exit and the agent's stop;
- grants: a takeover ends the older page's grant ("elsewhere", close); a late message from an ended grant changes
  nothing; a page-close detaches (the shell goes on); a lost leg ends every grant, and a new leg reattaches.
"""
import asyncio
import base64
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from termharness import (read_file, Run, tpaired, recv, shell, script, until, TMP, FLOOD, aio, as_unittest,  # noqa: E402
                         session_groups_alive, ring_text)
from sbgpu_agent import terminal as T  # noqa: E402

# (no job control: the shell stays in the terminal's foreground group, so it gets SIGWINCH; the background job makes
# its own process group in the same session, as an interactive shell's jobs do)
LOOP = shell("loop.sh", """echo "hello $TERM"
stty size
trap 'echo winch; stty size' WINCH
%s -I -S -c "import os,time; os.setpgid(0,0); time.sleep(600)" &
while :; do sleep 0.05; done
""" % sys.executable)
EXIT7 = shell("exit7.sh", "echo bye\nexit 7\n")


def script(name, body):
    path = os.path.join(TMP, name)
    with open(path, "w") as f:
        f.write(body)
    return path


# (a job in its own group that, on SIGHUP, makes a NEW group in the same
# session 0.3 s later (after the first census), records its pid, and ignores SIGTERM: only a census that repeats
# catches it)
TRAPPER = script("trapper.py", """import os, signal, subprocess, sys, time
os.setpgid(0, 0)
def late(*a):
    time.sleep(0.3)
    p = subprocess.Popen([sys.executable, "-I", "-S", "-c", "import os,time; os.setpgid(0,0); time.sleep(600)"])
    with open(sys.argv[1], "w") as f:
        f.write(str(p.pid))
signal.signal(signal.SIGHUP, late)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
    time.sleep(0.05)
""")
LATE_PID = os.path.join(TMP, "late.pid")
LATE = shell("late.sh", "%s -I -S %s %s &\nwhile :; do sleep 0.05; done\n" % (sys.executable, TRAPPER, LATE_PID))
# (a producer in its own group that floods the PTY and ignores HUP and TERM (only SIGKILL,
# or the PTY's close, ends it); the shell exits at once)


# ================= the open: checked before any effect

@aio
async def test_open_refusals_before_any_effect():
    t = await Run().start(sh=LOOP)
    try:
        leg = await t.relay.leg()
        gen = 0

        async def refused(msg, why):
            nonlocal gen
            gen += 1
            p = await tpaired(t, leg, gen)
            p.send(msg)
            assert await until(lambda: {"relay": "close", "gen": gen} in leg.controls), why
            assert t.runner.pages[gen].close_code == 1008, why
            assert t.terms.stats["spawned"] == 0, why

        good = {"t": "open", "rows": 24, "cols": 80}
        for why, msg in (
            ("no rows", {"t": "open", "cols": 80}),
            ("another key", dict(good, x=1)),
            ("rows 0", dict(good, rows=0)),
            ("cols 1001", dict(good, cols=1001)),
            ("rows a string", dict(good, rows="24")),
            ("rows a float", dict(good, rows=24.0)),
            ("rows a bool", dict(good, rows=True)),
            ("a short session id", dict(good, session="A" * 21)),
            ("a long session id", dict(good, session="A" * 23)),
            ("a session id with a bad character", dict(good, session="A" * 21 + "=")),
            ("a session id not a string", dict(good, session=7)),
        ):
            await refused(msg, why)
        assert t.terms.stats["refused"] == 11
        # (a message before an open: not_open, the page stays open)
        gen += 1
        p = await tpaired(t, leg, gen)
        p.send({"t": "resize", "rows": 30, "cols": 100})
        assert await recv(leg) == (gen, {"t": "error", "error": "not_open"})
        assert not t.runner.pages[gen].closed
        p.send({"t": "dance"})  # (any message but open, before one: the same)
        assert await recv(leg) == (gen, {"t": "error", "error": "not_open"})
        # (the control: a good open on its own page opens a session)
        gen += 1
        pa = await tpaired(t, leg, gen)
        m = await pa.open()
        assert m["t"] == "opened" and len(m["session"]) == 22 and set(m) == {"t", "session"}, m
        assert t.terms.stats["spawned"] == 1
        # (the same open again on that page: this page already has a terminal -> closed, nothing spawned)
        pa.send(good)
        assert await until(lambda: {"relay": "close", "gen": pa.gen} in leg.controls)
        assert t.runner.pages[pa.gen].close_code == 1008 and t.terms.stats["spawned"] == 1
        # (the size bounds themselves are good: 1 and 1000)
        gen += 1
        pc = await tpaired(t, leg, gen)
        assert (await pc.open(rows=1, cols=1000))["t"] == "opened"
        sc = t.runner.pages[pc.gen].grant.session
        assert (sc.rows, sc.cols) == (1, 1000)
        pc.send({"t": "resize", "rows": 1000, "cols": 1})
        await asyncio.sleep(0.1)
        assert (sc.rows, sc.cols) == (1000, 1) and not t.runner.pages[pc.gen].closed
        sc.stop()
        assert await until(lambda: sc.exit is not None, 5)
        # (after an open, a message that isn't a terminal message closes the page: 1002)
        gen += 1
        pb = await tpaired(t, leg, gen)
        assert (await pb.open())["t"] == "opened"
        pb.send({"t": "dance"})
        assert await until(lambda: t.runner.pages[pb.gen].close_code == 1002)
    finally:
        await t.end()


# ================= sessions: the shell, size, resize, kill, exit

@aio
async def test_session_lifecycle():
    t = await Run().start(sh=LOOP)
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, 1)
        m = await p.open(rows=24, cols=80)
        assert m["t"] == "opened", m
        s = t.terms.running[m["session"]]
        assert await until(lambda: "24 80" in ring_text(s)), ring_text(s)
        assert "hello xterm-256color" in ring_text(s)
        # (the shell leads its own session, with the PTY as its controlling terminal)
        with open("/proc/%d/stat" % s.leader, "rb") as f:
            st = f.read()
        fields = st[st.rfind(b")") + 2:].split()
        assert int(fields[3]) == s.leader and int(fields[4]) != 0, fields[:6]  # (session, tty_nr)
        assert os.getsid(s.leader) == s.leader and os.getpgid(s.leader) == s.leader
        # (resize: the size applied, SIGWINCH delivered)
        p.send({"t": "resize", "rows": 30, "cols": 100})
        assert await until(lambda: "30 100" in ring_text(s)), ring_text(s)
        # (malformed resizes close the page; they change nothing)
        # (kill names its own session only: another id closes the page, nothing stopped)
        p2 = await tpaired(t, leg, 2)
        m2 = await p2.open()
        s2 = t.terms.running[m2["session"]]
        p2.send({"t": "kill", "session": s.id})
        assert await until(lambda: {"relay": "close", "gen": 2} in leg.controls)
        assert s.exit is None and s2.exit is None
        # (its own: the tree rule over every group in its session, the background job too; exit by SIGHUP)
        groups = session_groups_alive(s)
        assert len(groups) >= 2, groups  # (the shell's, and the background subshell's under sh's job control or not)
        p.send({"t": "kill", "session": s.id})
        g, m = await recv(leg)
        assert g == 1 and m["t"] == "exit" and m["code"] is None and m["signal"] in ("SIGHUP", "SIGTERM", "SIGKILL"), m
        assert await until(lambda: not session_groups_alive(s), 5), session_groups_alive(s)
        assert await until(lambda: s.master is None and s.pidfd is None and s.leader not in T.STOPPING, 5)
        assert s.id not in t.terms.running and s in t.terms.ended_
    finally:
        await t.end()


@aio
async def test_exit_code_and_ended_sessions():
    t = await Run().start(sh=EXIT7)
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, 1)
        m = await p.open()
        sid = m["session"]
        g, m = await recv(leg)
        assert m == {"t": "exit", "code": 7, "signal": None}, m
        s = t.terms.ended_[-1]
        assert s.id == sid and await until(lambda: b"bye" in bytes(s.ring.buf)), bytes(s.ring.buf)
        # (an ended session's ring stays for a reattach: opened, then its exit; still one page per session, so the
        # page that held it is told "elsewhere")
        p2 = await tpaired(t, leg, 2)
        p2.send(p2.open_msg(session=sid))
        got = [await recv(leg) for _ in range(3)]
        assert got == [(1, {"t": "error", "error": "elsewhere"}), (2, {"t": "opened", "session": sid}),
                       (2, {"t": "exit", "code": 7, "signal": None})], got
        # (kept: the last 8, for 10 minutes)
        for i in range(9):
            t.terms.ended_.append(T.Session(t.terms, "x%021d" % i, 24, 80))
            t.terms.ended_[-1].ended_at = t.terms.timers.now()
        t.terms._prune_ended()
        assert len(t.terms.ended_) == 8 and s not in t.terms.ended_
        # (pruned by count while page 2 holds it: that page is told, its grant released)
        assert await recv(leg) == (2, {"t": "error", "error": "expired"}) and t.runner.pages[2].grant is None
        t.terms.ended_[0].ended_at -= T.TERMINAL_LIMITS["endedMs"]
        t.terms._prune_ended()
        assert len(t.terms.ended_) == 7
        p3 = await tpaired(t, leg, 3)
        m = await p3.open(session=sid)
        assert m == {"t": "error", "error": "unknown_session"}, m
    finally:
        await t.end()


# ================= grants: takeover, late messages, detach, leg loss

@aio
async def test_grants():
    t = await Run().start(sh=LOOP)
    try:
        leg = await t.relay.leg()
        pa = await tpaired(t, leg, 1)
        sid = (await pa.open())["session"]
        s = t.terms.running[sid]
        page_a = t.runner.pages[1]
        ga = page_a.grant
        # (a takeover: B opens the session; A is told "elsewhere" and closed; A's grant is over)
        pb = await tpaired(t, leg, 2)
        pb.leg.send(pb.open_msg(session=sid, rows=40, cols=120), gen=2)
        seen = {}
        for _ in range(2):
            g, m = await recv(leg)
            seen[g] = m
        assert seen[1] == {"t": "error", "error": "elsewhere"} and seen[2]["t"] == "opened", seen
        assert await until(lambda: {"relay": "close", "gen": 1} in leg.controls)
        assert not ga.live and s.grant is t.runner.pages[2].grant and t.terms.stats["takeovers"] == 1
        assert await until(lambda: "40 120" in ring_text(s)), ring_text(s)
        # (a late message from A's ended grant changes nothing: not the size, not the session)
        late = t.terms.stats["lateIgnored"]
        t.terms.page_message(page_a, {"t": "resize", "rows": 5, "cols": 5})
        t.terms.page_message(page_a, {"t": "kill", "session": sid})
        assert t.terms.stats["lateIgnored"] == late + 2 and (s.rows, s.cols) == (40, 120) and s.exit is None
        # (a grant is no authority on another page, leg or generation)
        gb = t.runner.pages[2].grant
        assert gb.holds(t.runner.pages[2], t.runner.incarnation, t.runner.leg)
        assert not gb.holds(page_a, t.runner.incarnation, t.runner.leg)
        assert not gb.holds(t.runner.pages[2], "another", t.runner.leg)
        assert not gb.holds(t.runner.pages[2], t.runner.incarnation, object())
        # (page-close detaches: the grant ends, the shell goes on)
        leg.control(relay="page-close", conn="c2", gen=2)
        assert await until(lambda: s.grant is None)
        assert not gb.live and s.exit is None and sid in t.terms.running
        # (the leg lost: every grant ends; a page on a new leg reattaches)
        pc = await tpaired(t, leg, 3)
        assert (await pc.open(session=sid))["t"] == "opened"
        gc = t.runner.pages[3].grant
        leg.drop()
        leg2 = await t.relay.leg()
        assert await until(lambda: not gc.live)
        assert s.exit is None and s.grant is None
        pd = await tpaired(t, leg2, 1)
        m = await pd.open(session=sid)
        assert m["t"] == "opened" and s.grant.leg is t.runner.leg, m
    finally:
        await t.end()


# ================= limits, idle, the agent's stop

@aio
async def test_limits_idle_and_stop():
    t = await Run().start(sh=LOOP)
    try:
        leg = await t.relay.leg()
        sessions = []
        for gen in range(1, 5):
            p = await tpaired(t, leg, gen)
            sid = (await p.open())["session"]
            sessions.append(t.terms.running[sid])
        p5 = await tpaired(t, leg, 5)
        assert await p5.open() == {"t": "error", "error": "sessions", "limit": 4}
        assert t.terms.stats["spawned"] == 4
        # (idle: detached, no output, no attach for 24 h -> stopped; attached ones are kept)
        leg.control(relay="page-close", conn="c1", gen=1)
        assert await until(lambda: sessions[0].grant is None)
        await asyncio.sleep(0.2)
        for s in sessions:
            s.last_activity -= T.TERMINAL_LIMITS["idleMs"]
        t.terms._idle_check()
        assert t.terms.stats["idleStopped"] == 1
        assert await until(lambda: sessions[0].exit is not None, 5)
        assert all(s.exit is None for s in sessions[1:])
        # (the agent's stop: every session's groups gone)
        alive = [s for s in sessions[1:]]
        t.terms.stop_all()
        assert await until(lambda: all(s.exit is not None for s in alive), 5)
        assert await until(lambda: not any(session_groups_alive(s) for s in sessions), 5)
    finally:
        await t.end()


# ================= r2: ended expiry when nothing else happens; a late group; a flooding producer

def proc_gone(pid):
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            st = f.read()
    except OSError:
        return True
    return st[st.rfind(b")") + 2:].split()[0] == b"Z"


@aio
async def test_ended_expiry_quiet_and_on_lookup():
    """The last session's ring expires with nothing running and no other activity
    (its own timer), releasing its ring and the attached page's grant; and a reattach checks the age itself."""
    saved = T.TERMINAL_LIMITS["endedMs"]
    T.TERMINAL_LIMITS["endedMs"] = 400
    t = await Run().start(sh=EXIT7)
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, 1)
        sid = (await p.open())["session"]
        g, m = await recv(leg)
        assert m["t"] == "exit", m
        s = t.terms.ended_[-1]
        page = t.runner.pages[1]
        assert not t.terms.running and page.grant is not None and t.terms.idle_timer is not None
        # (quiet: nothing running, nothing sent; its expiry runs anyway)
        g, m = await recv(leg, 3)
        assert (g, m) == (1, {"t": "error", "error": "expired"}), (g, m)
        assert t.terms.ended_ == [] and t.terms.stats["expired"] == 1 and page.grant is None and s.grant is None
        assert s.ring is None and t.terms.prune_timer is None
        # (on lookup: an ended session past its age, its timer not yet run, can't be reattached)
        p2 = await tpaired(t, leg, 2)
        sid2 = (await p2.open())["session"]
        await recv(leg)  # (its exit)
        t.terms.timers.clear_timeout(t.terms.prune_timer)
        t.terms.prune_timer = None
        await asyncio.sleep(0.5)
        assert [e.id for e in t.terms.ended_] == [sid2]
        leg.control(relay="page-close", conn="c2", gen=2)
        await asyncio.sleep(0.1)
        p3 = await tpaired(t, leg, 3)
        assert await p3.open(session=sid2) == {"t": "error", "error": "unknown_session"}
        assert t.terms.ended_ == [] and sid != sid2
    finally:
        T.TERMINAL_LIMITS["endedMs"] = saved
        await t.end()


@aio
async def test_late_group_caught():
    """A job that makes a new group in the session after the first census is still
    stopped (the census repeats until the session is empty); and at the agent's exit drain_sessions does the same."""
    for how in ("kill", "exit"):
        if os.path.exists(LATE_PID):
            os.unlink(LATE_PID)
        t = await Run().start(sh=LATE)
        try:
            leg = await t.relay.leg()
            p = await tpaired(t, leg, 1)
            sid = (await p.open())["session"]
            s = t.terms.running[sid]
            assert await until(lambda: len(session_groups_alive(s)) >= 2, 5), session_groups_alive(s)
            if how == "kill":
                p.send({"t": "kill", "session": sid})
            else:
                t.terms.stop_all()
                left = await T.drain_sessions(6.0)
                assert left == [], left
            assert await until(lambda: os.path.exists(LATE_PID) and read_file(LATE_PID).strip(), 5)
            late = int(read_file(LATE_PID))
            assert await until(lambda: not session_groups_alive(s), 8), (how, session_groups_alive(s))
            assert await until(lambda: proc_gone(late), 3), (how, late)
            assert late in s.signalled, (how, late, s.signalled)  # (its own group, made late, was signalled)
            assert await until(lambda: s.master is None and s.leader not in T.STOPPING, 5), how
        finally:
            await t.end()


@aio
async def test_flooding_producer_bounded():
    """The shell exits leaving a producer that floods the PTY and ignores HUP and TERM.  The groups
    are stopped first, the PTY is read only at the rate ceiling meanwhile, then drained (bounded) and closed once
    the session is empty; and with a short cap the PTY is closed even while the producer still writes."""
    saved = T.TERMINAL_LIMITS["sweepCapMs"]
    try:
        for cap in (30_000, 300):
            T.TERMINAL_LIMITS["sweepCapMs"] = cap
            t = await Run().start(sh=FLOOD)
            try:
                leg = await t.relay.leg()
                p = await tpaired(t, leg, 1)
                t0 = time.monotonic()
                sid = (await p.open())["session"]
                g, m = await recv(leg, 10)
                assert m == {"t": "exit", "code": 3, "signal": None}, m
                s = t.terms.ended_[-1]
                assert s.id == sid
                if cap == 300:
                    # (closed at the cap, the producer not yet stopped (it ignores HUP and TERM; SIGKILL is at 2 s))
                    assert await until(lambda: s.master is None, 2), "the PTY not closed at the cap"
                    assert t.terms.stats["sweepCapped"] == 1 and time.monotonic() - t0 < 2.0
                assert await until(lambda: not session_groups_alive(s), 6), session_groups_alive(s)
                assert await until(lambda: s.master is None and s.leader not in T.STOPPING, 3)
                elapsed = time.monotonic() - t0
                # (work bounded: at most the rate per second, plus the final drain of one ring)
                assert t.terms.stats["outBytes"] <= T.TERMINAL_LIMITS["rate"] * (elapsed + 1) + T.TERMINAL_LIMITS["ring"], \
                    (t.terms.stats["outBytes"], elapsed)
                # (the page never acks: its credit, not the rate ceiling, may be what held the reads back)
                assert len(s.ring.buf) <= T.TERMINAL_LIMITS["ring"]
            finally:
                await t.end()
    finally:
        T.TERMINAL_LIMITS["sweepCapMs"] = saved


def test_drain_is_bounded_whatever_writes():
    """The final drain against a PTY that never runs dry (a fake read that always has more)
    stops after one ring's worth, in at most ring/read reads."""
    from sbgpu_agent.proctree import LoopTimers as RealTimers

    class Host:
        stats = {"outBytes": 0}
        timers = RealTimers()
    s = T.Session(Host(), "s" * 22, 24, 80)
    s.master = 12345  # (never a real fd: the read below is replaced)
    calls = []
    real = T.os.read

    def endless(fd, n):
        assert fd == 12345
        calls.append(n)
        if len(calls) > 1000:
            raise RuntimeError("an unbounded drain")
        return b"y" * n
    T.os.read = endless
    try:
        s._drain()
    finally:
        T.os.read = real
    cap, rd = T.TERMINAL_LIMITS["ring"], T.TERMINAL_LIMITS["read"]
    assert len(calls) <= -(-cap // rd) and sum(calls) <= cap and len(s.ring.buf) == sum(calls) == cap, (len(calls), sum(calls))


def test_rate_ceiling_holds_the_reads():
    """At most TERMINAL_LIMITS["rate"] bytes are read from a PTY in one second (no page attached, a PTY that always
    has more): then the reads pause until the second is over."""
    import types

    class Timers:
        def __init__(self):
            self.t, self.q = 10_000, []

        def now(self):
            return self.t

        def set_timeout(self, f, ms):
            self.q.append((self.t + ms, f))
            return len(self.q)

        def clear_timeout(self, h):
            pass

    class Loop:
        def add_reader(self, fd, f):
            pass

        def remove_reader(self, fd):
            pass

    host = types.SimpleNamespace(stats={"outBytes": 0, "ratePauses": 0}, timers=Timers(), loop=Loop())
    s = T.Session(host, "s" * 22, 24, 80)
    s.master = 12345  # (never a real fd: the read is replaced)
    real = T.os.read
    T.os.read = lambda fd, n: b"z" * n if fd == 12345 else real(fd, n)
    try:
        for _ in range(200):
            s._readable()
    finally:
        T.os.read = real
    assert host.stats["outBytes"] == T.TERMINAL_LIMITS["rate"], host.stats
    assert host.stats["ratePauses"] >= 1 and s.rate_timer is not None


@aio
async def test_input_after_the_exit_goes_nowhere():
    """Input to a session whose shell has exited is dropped, whatever its size: the page isn't closed for it (no
    input credit is used)."""
    t = await Run().start(sh=EXIT7)
    try:
        leg = await t.relay.leg()
        p = await tpaired(t, leg, 1)
        sid = (await p.open())["session"]
        g, m = await recv(leg)
        assert m["t"] == "exit", m
        chunk = base64.b64encode(b"z" * 16_384).decode()
        for _ in range(8):  # (128 KiB: twice the input credit)
            p.send({"t": "in", "b": chunk})
        await asyncio.sleep(0.3)
        assert not t.runner.pages[1].closed and sid not in t.terms.running
    finally:
        await t.end()


def test_ring_and_replay():
    r = T.Ring(cap=10_000)
    r.append(b"abc\ndef")
    assert r.replay() == b"abc\ndef"  # (not wrapped: whole)
    r = T.Ring(cap=8192)
    r.append(b"x" * 100 + b"\nline2\n" + b"y" * 9000)
    out = r.replay()
    assert len(r.buf) == 8192 and out == bytes(r.buf)  # (wrapped, no \n in its oldest 4 KiB: whole)
    r = T.Ring(cap=8192)
    r.append(b"z" * 2000 + b"partial\nnext line\n" + b"w" * 7000)  # (wrapped: its oldest kept bytes are z's, then a \n)
    out = r.replay()
    assert out.startswith(b"next line\n") and len(r.buf) == 8192 and r.total == 9018, out[:20]
    r = T.Ring(cap=8192)
    r.append(b"z" * 5000 + b"partial\nnext\n" + b"w" * 3500)  # (wrapped, but its first \n is past the oldest 4 KiB)
    assert r.replay() == bytes(r.buf)
    assert len(T.new_session_id()) == 22 and T.new_session_id() != T.new_session_id()


Tests = as_unittest(globals())
