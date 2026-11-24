"""The probe agent's run: count this boot, run every check in order, print one line per check, then wait.

It is installed and started exactly as the machine agent is (the unchanged launcher fetches its pinned tarball, checks
its hash, and execs it as PID 1 with the allowlisted environment), and never contacts the control plane.  Its only
output is the result lines on stdout:

  SBGPU-PROBE {"v":1,"boot":n,"check":"pid1|environ|files|metadata|history|done","pass":bool,"paths":[...],"detail":"..."}

After "done" it stays up as PID 1 (reaping orphans) until SIGTERM, so the driver decides when the container stops.
"""

import json
import os
import signal
import sys
import time

from sbgpu_probe import checks

PREFIX = "SBGPU-PROBE "
CHECK_ORDER = ("pid1", "environ", "files", "metadata", "history", "done")
FILES_LIMIT_S = 600
BOOTS_FILE = "/opt/sbgpu/probe-boots"


def line(boot, check, ok, paths, detail):
    return PREFIX + json.dumps({"v": 1, "boot": boot, "check": check, "pass": bool(ok), "paths": list(paths),
                                "detail": detail}, separators=(",", ":"))


def next_boot(path):
    """This boot's number: the stored count plus one, written back durably.  (The launcher wipes /run at each start;
    /opt is the container's writable layer, which a restart keeps.)"""
    try:
        with open(path) as f:
            n = int(f.read().strip() or "0")
    except (OSError, ValueError):
        n = 0
    n += 1
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(str(n))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    return n


def run(out=sys.stdout, root="/", proc="/proc", pid=None, boots_file=BOOTS_FILE, get=checks.http_get,
        clock=time.monotonic):
    """Every check, in order; a check that raises fails with 'error'.  Returns the boot number."""
    boot = next_boot(boots_file)
    plan = (
        ("pid1", lambda: checks.check_pid1(proc=proc, pid=pid)),
        ("environ", lambda: checks.check_environ(proc=proc)),
        ("files", lambda: checks.check_files(root=root, proc=proc, deadline=clock() + FILES_LIMIT_S, clock=clock)),
        ("metadata", lambda: checks.check_metadata(get=get)),
        ("history", lambda: checks.check_history(root=root)),
    )
    for name, fn in plan:
        try:
            ok, paths, detail = fn()
        except Exception:
            ok, paths, detail = False, [], "error"
        out.write(line(boot, name, ok, paths, detail) + "\n")
        out.flush()
    out.write(line(boot, "done", True, [], "ok") + "\n")
    out.flush()
    return boot


def wait_for_term():
    """PID 1 until SIGTERM: orphans reaped every second."""
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
    while not stop:
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
        time.sleep(1)


def main():
    run()
    wait_for_term()
    raise SystemExit(0)
