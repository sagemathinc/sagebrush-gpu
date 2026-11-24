"""The agent's life cycle (DESIGN.md section 3.1), so far: boot.json, the eradication checks, abort or enroll, then
heartbeats and their commands.  The relay, terminals, workspace sync, idle detection and the setup script come next.

Exit codes: 0 stopped as asked; 3 refused or aborted (the launcher's respawn loop, in VM mode, doesn't retry it)."""

import json
import os
import signal
import socket
import subprocess
import time

from sbgpu_agent import eradication
from sbgpu_agent.control import Control, ControlError

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


def start(prefix, transport=None, proc="/proc", pid=None, run_gpu=subprocess.run, max_beats=None, sleep=time.sleep):
    """Everything from boot.json to the heartbeat loop.  Returns the exit code."""
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
    if not isinstance(enrolled.get("incarnation"), int):
        return EXIT_REFUSED
    agent = Agent(control, enrolled, sleep=sleep)
    signal.signal(signal.SIGTERM, lambda *_: setattr(agent, "stop_requested", True))
    return agent.run(max_beats=max_beats)


def main():
    raise SystemExit(start(os.environ.get("SBGPU_PREFIX", "")))
