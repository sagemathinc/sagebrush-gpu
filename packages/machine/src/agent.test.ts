// The agent is Python (stdlib only, since every GPU image has python3 but not Node), so it can't import @sbgpu/api.
// These tests run its unit tests, and check that what it sends has exactly the contract's fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { AgentAbortRequest, AgentEnrollRequest, AgentHeartbeatRequest, AgentSaveStatusRequest, SaveStatus } from "@sbgpu/api";
import { AGENT_ABORT_REASONS } from "@sbgpu/api";
import { ENV_COPY_ALLOWLIST, ENV_FIXED } from "./boot/boot.ts";

const AGENT_DIR = fileURLToPath(new URL("../agent/sbgpu-agent/", import.meta.url));

function py(code: string): unknown {
  const out = execFileSync("python3", ["-c", code], { cwd: AGENT_DIR, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
  return JSON.parse(out);
}

test("the agent's Python unit tests pass", () => {
  const out = execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests"], {
    cwd: AGENT_DIR,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(out, ""); // (unittest reports on stderr; a failure makes execFileSync throw with it)
});

// Each Record below must name every field of its contract type, and only those (the compiler checks).
const ENROLL_FIELDS: Record<keyof AgentEnrollRequest, true> = {
  bootToken: true, agentVersion: true, agentSha256: true, providerMachineId: true, mode: true,
  eradication: true, gpu: true, hostname: true,
};
const HEARTBEAT_FIELDS: Record<keyof AgentHeartbeatRequest, true> = {
  incarnation: true, uptimeS: true, activity: true, idleSince: true, save: true,
};
const ACTIVITY_FIELDS: Record<keyof AgentHeartbeatRequest["activity"], true> = {
  lastTerminalInputAt: true, lastJupyterActivityAt: true, gpuUtilPct: true, gpuMemUsedMiB: true,
};
const SAVE_FIELDS: Record<keyof SaveStatus, true> = { state: true, lastSavedAt: true, progress: true, error: true, snapshotId: true };
const SAVE_STATUS_FIELDS: Record<keyof AgentSaveStatusRequest, true> = { incarnation: true, commandId: true, save: true };
const ABORT_FIELDS: Record<keyof AgentAbortRequest, true> = { bootToken: true, reason: true };
const keys = (r: object) => Object.keys(r).sort();

test("the agent's requests have the contract's fields", () => {
  const got = py(`
import json
from sbgpu_agent import main, eradication
boot = {"controlUrl": "https://c", "mode": "container", "bootToken": "t", "providerMachineId": "", "agentSha256": "a" * 64}
report, _ = eradication.run_checks(proc="/nonexistent", root="/nonexistent", pid=1)
enroll = main.enroll_request(boot, report, None, "host")
from sbgpu_agent.control import Control
sent = []
control = Control("https://c", lambda m, u, h, b, t: (sent.append(json.loads(b)), (200, b"{}"))[1])
control.abort("t", "other")
control.token = "x"
agent = main.Agent(control, {"incarnation": 1, "heartbeatSeconds": 30})
agent.handle({"id": "cmd_1", "op": "save"})
print(json.dumps({"enroll": enroll, "heartbeat": agent.heartbeat_request(), "abort": sent[0], "saveStatus": sent[1],
                  "reasons": list(eradication.REASONS)}))
`) as { enroll: object; heartbeat: { activity: object; save: object }; abort: object; saveStatus: { save: object }; reasons: string[] };
  assert.deepEqual(keys(got.enroll), keys(ENROLL_FIELDS));
  assert.deepEqual(keys(got.heartbeat), keys(HEARTBEAT_FIELDS));
  assert.deepEqual(keys(got.heartbeat.activity), keys(ACTIVITY_FIELDS));
  assert.deepEqual(keys(got.heartbeat.save), [...keys(SAVE_FIELDS), "dirtyBytes"].sort());
  assert.deepEqual(keys(got.saveStatus), keys(SAVE_STATUS_FIELDS));
  assert.deepEqual(keys(got.saveStatus.save), keys(SAVE_FIELDS));
  assert.deepEqual(keys(got.abort), keys(ABORT_FIELDS));
  assert.deepEqual(got.reasons, [...AGENT_ABORT_REASONS]);
});

test("the agent checks the same environment lists as the launcher", () => {
  const got = py(`
import json
from sbgpu_agent import eradication
print(json.dumps([list(eradication.ENV_FIXED), list(eradication.ENV_COPY_ALLOWLIST)]))
`) as [string[], string[]];
  assert.deepEqual(got, [[...ENV_FIXED], [...ENV_COPY_ALLOWLIST]]);
});
