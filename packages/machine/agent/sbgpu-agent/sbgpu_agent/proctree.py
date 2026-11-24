"""Stopping process trees (the tree rule) and the agent's timers.

Ported from Sagebrush's runner (engine/py/python/sagebrush/remote/gateway.py: _group_members, _kill_tree,
_forget_when_empty, drain_groups; pair.py: RealTimers; SageMath, Inc.), unchanged in behaviour."""

import asyncio
import os
import signal
import subprocess
import time


class LoopTimers:
    """Millisecond timers on the running asyncio loop (now() is monotonic)."""

    def now(self):
        return int(time.monotonic() * 1000)

    def set_timeout(self, fn, ms):
        return asyncio.get_running_loop().call_later(ms / 1000, fn)

    def clear_timeout(self, h):
        if h is not None:
            h.cancel()


def _stat_fields(pid):
    """The fields of /proc/<pid>/stat after the command name: (state, ppid, pgrp, session, ...), or None."""
    try:
        with open("/proc/%s/stat" % pid, "rb") as f:
            st = f.read()
    except OSError:
        return None
    return st[st.rfind(b")") + 2:].split()


def group_members(pgid):
    """The pids in process group pgid (Linux: /proc; elsewhere: ps), zombies not counted."""
    out = []
    if os.path.isdir("/proc/self"):
        for d in os.listdir("/proc"):
            if not d.isdigit():
                continue
            fields = _stat_fields(d)
            if fields and len(fields) > 2 and fields[0] != b"Z" and int(fields[2]) == pgid:
                out.append(int(d))
        return out
    try:
        r = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat="], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return out
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1] == str(pgid) and not parts[2].startswith("Z"):
            out.append(int(parts[0]))
    return out


def session_groups(sid):
    """The process groups with a member in session sid, zombies not counted."""
    groups = set()
    if os.path.isdir("/proc/self"):
        for d in os.listdir("/proc"):
            if not d.isdigit():
                continue
            fields = _stat_fields(d)
            if fields and len(fields) > 3 and fields[0] != b"Z" and int(fields[3]) == sid:
                groups.add(int(fields[2]))
        return groups
    try:
        r = subprocess.run(["ps", "-A", "-o", "pgid=,sess=,stat="], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return groups
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1].isdigit() and int(parts[1]) == sid and not parts[2].startswith("Z"):
            groups.add(int(parts[0]))
    return groups


ENDING_GROUPS = set()  # (process groups sent SIGTERM whose SIGKILL is still due: drain_groups waits for them)
KILL_AFTER_S = 2.0


def kill_tree(pgid):
    """The tree rule: SIGTERM to the process group, SIGKILL to it 2 s later (whatever is left).  Once per group: a
    group already ending gets no second SIGTERM or timer."""
    if pgid in ENDING_GROUPS:
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    ENDING_GROUPS.add(pgid)
    loop = asyncio.get_running_loop()

    def kill():
        # (only a group still ending: one already SIGKILLed and taken out, or seen empty, may since be a reused pgid
        # of an unrelated group, and is never signalled)
        if pgid not in ENDING_GROUPS:
            return
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        _forget_when_empty(pgid, loop)
    loop.call_later(KILL_AFTER_S, kill)


def _forget_when_empty(pgid, loop, tries=100):
    """Take pgid out of ENDING_GROUPS once it has no members: now, then every 50 ms, at most `tries` times."""
    if pgid not in ENDING_GROUPS:
        return
    if not group_members(pgid):
        ENDING_GROUPS.discard(pgid)
    elif tries > 0:
        loop.call_later(0.05, _forget_when_empty, pgid, loop, tries - 1)


async def drain_groups(timeout=3.0):
    """At the agent's exit: wait until every process group it ended is empty, at most `timeout` seconds, then SIGKILL
    what is left.  Returns the pgids that still had members at the deadline."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while True:
        alive = [g for g in list(ENDING_GROUPS) if group_members(g)]
        for g in list(ENDING_GROUPS):
            if g not in alive:
                ENDING_GROUPS.discard(g)
        if not alive:
            return []
        if loop.time() >= end:
            for g in alive:
                try:
                    os.killpg(g, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                ENDING_GROUPS.discard(g)
            return alive
        await asyncio.sleep(0.05)


def exit_status(status):
    """(code, signal name) from a wait status: os.waitstatus_to_exitcode's rule, which Python 3.8 lacks."""
    if os.WIFSIGNALED(status):
        sig = os.WTERMSIG(status)
        return None, (signal.Signals(sig).name if sig in signal.valid_signals() else str(sig))
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status), None
    return None, None
