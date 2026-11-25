"""The agent's life cycle (DESIGN.md section 3.1), so far: boot.json, the eradication checks, abort or enroll, then
heartbeats and their commands (in a thread) and the relay leg with the terminals (on the event loop).  However that
ends (a stop or revoke command, the relay revoking or refusing the machine, a refused heartbeat, SIGTERM, an error),
the terminals are stopped, and in container mode, where the agent is PID 1, every other process in the container is
ended too (proctree.stop_everything; SEC ruling, Nov 24).  Workspace sync, idle detection and the setup script come
next.

Exit codes: 0 stopped as asked; 3 refused or aborted (the launcher's respawn loop, in VM mode, doesn't retry it)."""

import asyncio
import json
import os
import signal
import socket
import subprocess
import threading
import time

from sbgpu_agent import eradication, proctree
from sbgpu_agent.control import Control, ControlError
from sbgpu_agent.relayclient import Fatal, RelayClient
from sbgpu_agent.terminal import Terminals, drain_sessions

AGENT_VERSION = "0.0.1"
EXIT_STOPPED = 0
EXIT_REFUSED = 3
BOOT_JSON_MAX = 4096
HEARTBEAT_MIN_S = 5
HEARTBEAT_MAX_S = 300


class BootError(Exception):
    pass


def read_boot(prefix):
    """boot.json, read once and removed before anything else happens (the token is single use anyway)."""
    path = prefix + "/run/sbgpu/boot.json"
    try:
        with open(path, "rb") as f:
            data = f.read(BOOT_JSON_MAX + 1)
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    if len(data) > BOOT_JSON_MAX:
        raise BootError("boot.json too large")
    boot = json.loads(data.decode("utf-8"))
    for key in ("controlUrl", "mode", "bootToken", "providerMachineId", "agentSha256"):
        if not isinstance(boot.get(key), str):
            raise BootError("boot.json lacks " + key)
    if boot["mode"] not in ("container", "vm"):
        raise BootError("bad mode")
    return boot


def gpu_info(run=subprocess.run):
    """{name, count, memoryMiB} of the first GPU type, from nvidia-smi; None without one."""
    try:
        r = run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    rows = [line.rsplit(",", 1) for line in r.stdout.splitlines() if "," in line] if r.returncode == 0 else []
    if not rows:
        return None
    try:
        return {"name": rows[0][0].strip()[:128], "count": len(rows), "memoryMiB": int(rows[0][1].strip())}
    except ValueError:
        return None


def enroll_request(boot, report, gpu, hostname):
    return {
        "bootToken": boot["bootToken"],
        "agentVersion": AGENT_VERSION,
        "agentSha256": boot["agentSha256"],
        "providerMachineId": boot["providerMachineId"] or None,
        "mode": boot["mode"],
        "eradication": report,
        "gpu": gpu,
        "hostname": hostname[:255],
    }


def idle_save():
    return {"state": "idle", "lastSavedAt": None, "progress": None, "error": None, "snapshotId": None}


class Agent:
    def __init__(self, control, enrolled, clock=time.monotonic, sleep=time.sleep):
        self.control = control
        self.incarnation = enrolled["incarnation"]
        beat = enrolled.get("heartbeatSeconds")
        self.heartbeat_s = min(max(beat if isinstance(beat, int) else 30, HEARTBEAT_MIN_S), HEARTBEAT_MAX_S)
        self.clock = clock
        self.sleep = sleep
        self.started = clock()
        self.done_commands = set()
        self.stop_requested = False

    def heartbeat_request(self):
        save = idle_save()
        save["dirtyBytes"] = 0
        return {
            "incarnation": self.incarnation,
            "uptimeS": int(self.clock() - self.started),
            "activity": {"lastTerminalInputAt": None, "lastJupyterActivityAt": None, "gpuUtilPct": None, "gpuMemUsedMiB": None},
            "idleSince": None,
            "save": save,
        }

    def handle(self, command):
        """One command, once (by id).  Returns an exit code to stop with, or None to go on."""
        if command["id"] in self.done_commands:
            return None
        self.done_commands.add(command["id"])
        op = command["op"]
        if op == "revoke":
            return EXIT_REFUSED
        if op in ("stop", "stop-after-save", "save"):
            # (The workspace sync isn't built yet: report the save as failed, honestly, so control's deadline
            # and stopReason say so.)
            save = idle_save()
            save["state"] = "failed"
            save["error"] = "not-built"
            self.control.save_status({"incarnation": self.incarnation, "commandId": command["id"], "save": save})
            return EXIT_STOPPED if op != "save" else None
        return None  # an op this agent doesn't know: ignored, never guessed at

    def run(self, max_beats=None):
        beats = 0
        backoff = 1
        while max_beats is None or beats < max_beats:
            beats += 1
            if self.stop_requested:
                return EXIT_STOPPED
            try:
                commands = self.control.heartbeat(self.heartbeat_request())
                backoff = 1
            except ControlError as e:
                if e.refused:
                    return EXIT_REFUSED
                self.sleep(min(backoff, self.heartbeat_s))
                backoff = min(backoff * 2, 60)
                continue
            for c in commands:
                code = self.handle(c)
                if code is not None:
                    return code
            self.sleep(self.heartbeat_s)
            if os.getpid() == 1:
                reap()
        return EXIT_STOPPED


def reap():
    """PID 1's duty: collect orphans that ended (DESIGN.md section 1.3)."""
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def terminal_env(home="/root"):
    """The environment terminals run with: the agent's own (allowlisted by the launcher), plus HOME and TERM."""
    env = dict(os.environ)
    env.setdefault("HOME", home)
    env.pop("SBGPU_PREFIX", None)
    return env


async def serve(agent, relay_url, container, stop_everything=proctree.stop_everything, cwd="/root", err=None,
                relay_sleep=asyncio.sleep, heartbeat_wake=None):
    """Heartbeats (agent.run, in a thread) and the relay leg with its terminals, until either ends; then the stop:
    the terminals, and in container mode every other process.  Returns the exit code."""
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    wake = heartbeat_wake or threading.Event()
    err = err or (lambda s: None)
    client = RelayClient(relay_url, lambda: agent.control.token, lambda host: Terminals(host, loop, cwd, terminal_env(cwd)),
                         proctree.LoopTimers(), err=err, sleep=relay_sleep)
    code = EXIT_STOPPED

    def on_term():
        agent.stop_requested = True
        wake.set()
        stop.set()
    try:
        loop.add_signal_handler(signal.SIGTERM, on_term)
    except (NotImplementedError, RuntimeError, ValueError):
        pass
    beats = asyncio.ensure_future(asyncio.to_thread(agent.run))
    relay = asyncio.ensure_future(client.run(stop))
    try:
        await asyncio.wait([beats, relay], return_when=asyncio.FIRST_COMPLETED)
        if relay.done() and isinstance(relay.exception(), Fatal):
            code = EXIT_REFUSED  # (revoked, or refused by the relay: the machine is stopping)
        elif relay.done() and relay.exception() is not None:
            code = EXIT_REFUSED
        elif beats.done():
            code = beats.result() if beats.exception() is None else EXIT_REFUSED
    finally:
        # (whichever ended first, the other ends now)
        agent.stop_requested = True
        wake.set()
        stop.set()
        for t in (relay, beats):
            try:
                await t
            except BaseException:
                pass
        try:
            loop.remove_signal_handler(signal.SIGTERM)
        except (NotImplementedError, RuntimeError, ValueError):
            pass
        # (the machine's stop: the terminals' sessions by the tree rule, then, in container mode, everything else.  The
        # container-wide stop runs whatever happens before it, a cleanup error or a cancellation included, and is
        # called synchronously, so nothing can come between; only then does an earlier error go on)
        try:
            client.terms.stop_all()
            await drain_sessions(3.0)
            await proctree.drain_groups(3.0)
        finally:
            if container:
                try:
                    left = stop_everything()
                    if left:
                        err("Processes still there after the stop: %d.\n" % len(left))
                except Exception as e:
                    err("stop_everything: %s\n" % e)
    return code


def start(prefix, transport=None, proc="/proc", pid=None, run_gpu=subprocess.run, max_beats=None, sleep=None,
          stop_everything=proctree.stop_everything, cwd="/root", relay_sleep=asyncio.sleep):
    """Everything from boot.json to the end.  Returns the exit code."""
    try:
        boot = read_boot(prefix)
    except (OSError, ValueError, BootError):
        return EXIT_REFUSED
    control = Control(boot["controlUrl"], transport) if transport else Control(boot["controlUrl"])
    report, reason = eradication.run_checks(proc=proc, root=prefix, pid=pid, container=boot["mode"] == "container")
    if reason is not None:
        try:
            control.abort(boot["bootToken"], reason)
        except ControlError:
            pass  # control terminates an unenrolled machine within its TTL anyway
        return EXIT_REFUSED
    try:
        enrolled = control.enroll(enroll_request(boot, report, gpu_info(run_gpu), socket.gethostname()))
    except ControlError:
        return EXIT_REFUSED
    if not isinstance(enrolled.get("incarnation"), int) or not isinstance(enrolled.get("relayUrl"), str):
        return EXIT_REFUSED
    wake = threading.Event()
    agent = Agent(control, enrolled, sleep=sleep or (lambda s: wake.wait(s)))
    if max_beats is not None:
        run = agent.run
        agent.run = lambda: run(max_beats=max_beats)
    return asyncio.run(serve(agent, enrolled["relayUrl"], boot["mode"] == "container", stop_everything=stop_everything,
                             cwd=cwd, relay_sleep=relay_sleep, heartbeat_wake=wake))


def main():
    raise SystemExit(start(os.environ.get("SBGPU_PREFIX", "")))
