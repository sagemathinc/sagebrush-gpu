"""A test harness for the agent's terminals (sbgpu_agent/terminal.py): a stand-in for the relay leg and its pages,
with the same helper names as Sagebrush's runner terminal tests (Run, tpaired, recv, until, ...), so those tests
port with few changes.  Pages are already authenticated (the relay's job), so a page here is simply open.

The leg:
- leg.send(obj, gen=g): a page's message to the agent (closed 1009 over 65,536 bytes, as the relay leg would);
- leg.control(relay="page-open", gen=g, ...) / leg.control(relay="page-close", gen=g, ...);
- leg.controls: the agent's controls toward the relay, e.g. {"relay": "close", "gen": g} when it closes a page;
- leg.drop(): the leg is lost; every page on it goes; t.relay.leg() then gives the new one.
"""

import asyncio
import json
import os
import stat
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from sbgpu_agent import terminal as T  # noqa: E402
from sbgpu_agent.proctree import LoopTimers, drain_groups  # noqa: E402

TMP = tempfile.mkdtemp(prefix="sbgpu-term-")
FRAME_MAX = 65_536


def read_file(path):
    with open(path) as f:
        return f.read()


def shell(name, body):
    """A test 'shell': a sh script the session runs as $SHELL (its -l argument ignored)."""
    path = os.path.join(TMP, name)
    with open(path, "w") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(path, stat.S_IRWXU)
    return path


def script(name, body):
    path = os.path.join(TMP, name)
    with open(path, "w") as f:
        f.write(body)
    return path


# (a flood: a producer in its own group that floods the PTY and ignores HUP and TERM; the shell exits)
FLOODER = script("flood.py", """import os, signal
os.setpgid(0, 0)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
    os.write(1, b"x" * 65536)
""")
FLOOD = shell("flood.sh", "%s -I -S %s &\nsleep 0.3\nexit 3\n" % (sys.executable, FLOODER))


def aio(fn):
    """Run an async test function on a fresh loop."""
    def run():
        return asyncio.run(fn())
    run.__name__ = fn.__name__
    run.__doc__ = fn.__doc__
    return run


def as_unittest(namespace):
    """A unittest.TestCase with one method per test_* function of a module (so `unittest discover` runs them)."""
    class Tests(unittest.TestCase):
        pass
    for name, fn in list(namespace.items()):
        if name.startswith("test_") and callable(fn):
            setattr(Tests, name, (lambda f: lambda self: f())(fn))
    return Tests


class Page:
    """One page on a leg, as the agent sees it."""

    def __init__(self, leg, gen):
        self.leg, self.gen = leg, gen
        self.closed = False
        self.close_code = None
        self.grant = None

    def send(self, obj):
        self.send_text(json.dumps(obj, separators=(",", ":")), "control")

    def send_text(self, text, kind):
        if not self.closed and not self.leg.lost:
            self.leg.q.put_nowait(("text", (self.gen, text)))

    def close(self, code, reason):
        if self.closed:
            return
        self.closed, self.close_code = True, code
        self.leg.controls.append({"relay": "close", "gen": self.gen})
        self.leg.runner.terms.page_gone(self)


class Leg:
    def __init__(self, runner):
        self.runner = runner
        self.q = asyncio.Queue()
        self.controls = []
        self.lost = False
        self.closed = False

    def send(self, obj, gen):
        p = self.runner.pages.get(gen)
        if p is None or p.closed or p.leg is not self or self.lost:
            return
        text = json.dumps(obj, separators=(",", ":"))
        if len(text.encode("utf-8")) > FRAME_MAX:
            return p.close(1009, "a message over the frame cap")
        self.runner.terms.page_message(p, json.loads(text))

    def control(self, relay, gen, **_):
        if relay == "page-open":
            self.runner.pages[gen] = Page(self, gen)
        elif relay == "page-close":
            p = self.runner.pages.get(gen)
            if p is not None and not p.closed:
                p.closed = True
                self.runner.terms.page_gone(p)

    def drop(self):
        self.lost = True
        for p in list(self.runner.pages.values()):
            if p.leg is self and not p.closed:
                p.closed = True
                self.runner.terms.page_gone(p)
        self.runner.leg = Leg(self.runner)

    async def next(self, timeout):
        return await asyncio.wait_for(self.q.get(), timeout)


class Runner:
    """The host Terminals needs: timers, incarnation, the current leg; plus the pages by generation."""

    def __init__(self):
        self.timers = LoopTimers()
        self.incarnation = 1
        self.pages = {}
        self.terms = None
        self.leg = Leg(self)


class Relay:
    def __init__(self, runner):
        self.runner = runner

    async def leg(self):
        return self.runner.leg


class Run:
    """The agent's terminals with a fake relay leg."""

    async def start(self, sh=None):
        self.runner = Runner()
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": TMP, "LANG": "C.UTF-8"}
        if sh:
            env["SHELL"] = sh
        self.runner.terms = T.Terminals(self.runner, asyncio.get_running_loop(), TMP, env)
        self.relay = Relay(self.runner)
        return self

    @property
    def terms(self):
        return self.runner.terms

    async def end(self):
        self.terms.stop_all()
        await T.drain_sessions(3.0)
        await drain_groups(3.0)


STREAM = ("replay", "out", "live", "inack")


async def recv(leg, timeout=10, stream=False):
    """The next message the agent sent to a page on this leg: (gen, obj).  Unless `stream`, the output stream's
    messages (replay, out, live, inack) are set aside in leg.streams[gen]."""
    while True:
        kind, (g, text) = await leg.next(timeout)
        m = json.loads(text)
        if not stream and isinstance(m, dict) and m.get("t") in STREAM:
            if not hasattr(leg, "streams"):
                leg.streams = {}
            leg.streams.setdefault(g, []).append(m)
            continue
        return g, m


async def until(f, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if f():
            return True
        await asyncio.sleep(0.02)
    return False


class TPage:
    """The browser side of one page."""

    def __init__(self, t, leg, gen):
        self.t, self.leg, self.gen = t, leg, gen

    def open_msg(self, rows=24, cols=80, session=None):
        m = {"t": "open", "rows": rows, "cols": cols}
        if session is not None:
            m["session"] = session
        return m

    async def open(self, **kw):
        self.leg.send(self.open_msg(**kw), gen=self.gen)
        g, m = await recv(self.leg)
        assert g == self.gen, (g, m)
        return m

    def send(self, obj):
        self.leg.send(obj, gen=self.gen)


async def tpaired(t, leg, gen):
    leg.control(relay="page-open", conn="c%d" % gen, kind="agent", chan="terminal", gen=gen)
    return TPage(t, leg, gen)


def session_groups_alive(s):
    from sbgpu_agent.proctree import session_groups
    return session_groups(s.leader)


def ring_text(s):
    return bytes(s.ring.buf).decode("utf-8", "replace")
