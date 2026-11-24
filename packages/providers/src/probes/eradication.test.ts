import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../errors.ts";
import type { LaunchSpec, ProviderAdapter, ProviderMachineStatus } from "../types.ts";
import { parseArgs, planFor } from "./cli.ts";
import {
  checkPlan,
  judgeStage,
  outcomeOf,
  parseLogSse,
  parseProbeLine,
  ProbeFormatError,
  runEradicationProbe,
  type ProbePlan,
  type ProbeProviderApi,
} from "./eradication.ts";

const line = (check: string, pass = true, extra: Record<string, unknown> = {}) =>
  `SBGPU-PROBE ${JSON.stringify({ v: 1, boot: 1, check, pass, paths: [], detail: pass ? "" : "found-name", ...extra })}`;
const RUN = ["pid1", "environ", "files", "metadata", "history", "done"].map((c) => line(c));

// ---------------------------------------------------------------- lines and stages

test("parseProbeLine reads probe lines and ignores others", () => {
  assert.deepEqual(parseProbeLine(line("files", false, { paths: ["/etc/rp_environment"] })), {
    boot: 1, check: "files", pass: false, paths: ["/etc/rp_environment"], detail: "found-name",
  });
  assert.equal(parseProbeLine("starting"), null);
  assert.equal(parseProbeLine(" SBGPU-PROBE {}"), null);
});

const malformed = [
  "SBGPU-PROBE not json",
  "SBGPU-PROBE []",
  "SBGPU-PROBE null",
  line("pid1", true, { v: 2 }),
  line("pid1", true, { boot: 0 }),
  line("pid1", true, { boot: 1.5 }),
  line("pid1", true, { boot: "1" }),
  line("shell"),
  line("pid1", true, { pass: "true" }),
  line("pid1", true, { paths: "/x" }),
  line("pid1", true, { paths: [1] }),
  line("pid1", true, { paths: Array(21).fill("/x") }),
  line("pid1", true, { paths: ["/" + "x".repeat(256)] }),
  line("pid1", true, { detail: "Found The Key: rpa_..." }),
  line("pid1", true, { detail: "x".repeat(33) }),
  line("pid1", true, { extra: 1 }),
  `SBGPU-PROBE ${JSON.stringify({ v: 1, boot: 1, check: "pid1", pass: true, paths: [] })}`,
];

for (const l of malformed) {
  test(`parseProbeLine rejects ${l.slice(12, 80)}`, () => {
    assert.throws(() => parseProbeLine(l), ProbeFormatError);
  });
}

test("parseProbeLine accepts the edges of paths", () => {
  assert.equal(parseProbeLine(line("pid1", true, { paths: Array(20).fill("/" + "x".repeat(255)) }))!.paths.length, 20);
  assert.equal(parseProbeLine(line("pid1", true, { detail: "x".repeat(32) }))!.detail, "x".repeat(32));
});

test("judgeStage passes a complete, clean, passing run among other log lines", () => {
  const r = judgeStage(["launcher: verified", ...RUN, "agent: idle"]);
  assert.deepEqual(r, { pass: true, failures: [], failedChecks: [], complete: true });
});

const stageFailures: Array<[string, string[], string]> = [
  ["no output", ["hello"], "no-probe-output"],
  ["a missing check", RUN.filter((l) => !l.includes('"metadata"')), "checks-incomplete-or-out-of-order"],
  ["checks out of order", [RUN[1]!, RUN[0]!, ...RUN.slice(2)], "checks-incomplete-or-out-of-order"],
  ["a repeated run", [...RUN, ...RUN], "checks-incomplete-or-out-of-order"],
  ["no done", RUN.slice(0, 5), "checks-incomplete-or-out-of-order"],
  ["two boots", [...RUN.slice(0, 3), ...RUN.slice(3).map((l) => l.replace('"boot":1', '"boot":2'))], "several-boots-in-one-stage"],
  ["a failed check", RUN.map((l) => (l.includes('"environ"') ? line("environ", false, { paths: ["/proc/7/environ"] }) : l)), "check-failed"],
  ["a malformed probe line", [...RUN, "SBGPU-PROBE {"], "malformed-probe-line"],
  ["the key name in a log line", [...RUN, "export RUNPOD_API_KEY"], "key-name-in-log"],
  ["a key assignment in a log line", [...RUN, "env: RUNPOD_API_KEY=x"], "key-shaped-string-in-log"],
  ["a key-shaped string in a log line", [...RUN, "token rpa_ABCDEFGHIJKLMNOPQRSTUV"], "key-shaped-string-in-log"],
  ["a key-shaped string inside a probe line", [...RUN.slice(0, 5), line("done", true, { paths: ["/tmp/rpa_ABCDEFGHIJKLMNOPQRSTUV"] })], "key-shaped-string-in-log"],
];

for (const [what, lines, failure] of stageFailures) {
  test(`judgeStage fails on ${what}`, () => {
    const r = judgeStage(lines);
    assert.equal(r.pass, false);
    assert.ok(r.failures.includes(failure), JSON.stringify(r.failures));
  });
}

test("judgeStage reports failed checks with their paths; the key name inside a probe line is fine", () => {
  const r = judgeStage(RUN.map((l) => (l.includes('"files"') ? line("files", false, { paths: ["/etc/RUNPOD_API_KEY.txt"] }) : l)));
  assert.deepEqual(r.failures, ["check-failed"]);
  assert.deepEqual(r.failedChecks, [{ check: "files", detail: "found-name", paths: ["/etc/RUNPOD_API_KEY.txt"] }]);
  assert.equal(r.complete, true);
  assert.equal(judgeStage(["token rpa_short"]).failures.includes("key-shaped-string-in-log"), false);
});

test("parseLogSse reads RunPod's log events", () => {
  const body = 'id: 1\ndata: {"source":"container","line":"a","ts":"t"}\n\n: comment\n\ndata: {"source":"system",\ndata: "line":"b","ts":"t"}\n\n';
  assert.deepEqual(parseLogSse(body), ["a", "b"]);
  assert.deepEqual(parseLogSse(""), []);
  assert.throws(() => parseLogSse("data: {nope}\n\n"), ProbeFormatError);
  assert.throws(() => parseLogSse('data: {"source":"x"}\n\n'), ProbeFormatError);
  assert.deepEqual(parseLogSse('data: {"line":"c"}\r\n\r\n'), ["c"]);
});

// ---------------------------------------------------------------- plan

const TOKEN = "A".repeat(43);
const spec: LaunchSpec = {
  machineId: "mch_pr0bepr0bepr0bepr0be", gpuType: "RTX-A4000", gpuCount: 1, dataCenter: "EU-SE-1",
  image: "img", diskGb: 40, bootToken: TOKEN, launcher: ["/bin/sh", "-c", "x"], maxProviderCostPerHour: 3_000_000,
};
const plan: ProbePlan = { approval: "William, msg 123", spec, maxSpendMicros: 3_000_000, maxMinutes: 60, stageMinutes: 15, pollSeconds: 30 };

test("checkPlan accepts the default plan and refuses unsafe ones", () => {
  checkPlan(plan);
  const bad: Array<Partial<ProbePlan>> = [
    { approval: "" }, { approval: "  short " },
    { maxSpendMicros: 0 }, { maxSpendMicros: 10_000_001 }, { maxSpendMicros: 1.5 },
    { maxMinutes: 4 }, { maxMinutes: 121 }, { stageMinutes: 0 }, { stageMinutes: 31 },
    { pollSeconds: 9 }, { pollSeconds: 121 }, { stageMinutes: 21 },
    { spec: { ...spec, bootToken: "short" } }, { spec: { ...spec, bootToken: "A".repeat(42) + "=" } },
    { spec: { ...spec, maxProviderCostPerHour: 12_000_001 } },
  ];
  for (const b of bad) assert.throws(() => checkPlan({ ...plan, ...b }), RangeError, JSON.stringify(b));
  checkPlan({ ...plan, maxSpendMicros: 10_000_000, maxMinutes: 120, stageMinutes: 30, pollSeconds: 10 });
  checkPlan({ ...plan, maxMinutes: 45, spec: { ...spec, maxProviderCostPerHour: 16_000_000 } });
});

test("outcomeOf", () => {
  const ok = { pass: true, failures: [], failedChecks: [], complete: true };
  const failed = { pass: false, failures: ["check-failed"], failedChecks: [], complete: true };
  const keyLeak = { pass: false, failures: ["key-name-in-log", "checks-incomplete-or-out-of-order"], failedChecks: [], complete: false };
  const partial = { pass: false, failures: ["checks-incomplete-or-out-of-order"], failedChecks: [], complete: false };
  const all = (r: typeof ok | null) => [{ stage: "first-boot" as const, result: r }, { stage: "after-restart" as const, result: r }, { stage: "after-stop-start" as const, result: r }];
  assert.equal(outcomeOf({ stages: all(ok), aborts: [], terminatedConfirmed: true }), "pass");
  assert.equal(outcomeOf({ stages: all(ok), aborts: ["x"], terminatedConfirmed: true }), "aborted");
  assert.equal(outcomeOf({ stages: all(ok), aborts: [], terminatedConfirmed: false }), "aborted");
  assert.equal(outcomeOf({ stages: all(null), aborts: [], terminatedConfirmed: true }), "aborted");
  assert.equal(outcomeOf({ stages: [{ stage: "first-boot", result: ok }, ...all(null).slice(1)], aborts: [], terminatedConfirmed: true }), "aborted");
  const twoBoots = { pass: false, failures: ["several-boots-in-one-stage"], failedChecks: [], complete: true };
  assert.equal(outcomeOf({ stages: [{ stage: "first-boot", result: twoBoots }, ...all(null).slice(1)], aborts: [], terminatedConfirmed: true }), "fail");
  assert.equal(outcomeOf({ stages: [...all(ok).slice(0, 2), { stage: "after-stop-start", result: failed }], aborts: ["x"], terminatedConfirmed: false }), "fail");
  assert.equal(outcomeOf({ stages: [{ stage: "first-boot", result: keyLeak }, ...all(null).slice(1)], aborts: ["stage-timeout"], terminatedConfirmed: true }), "fail");
  assert.equal(outcomeOf({ stages: [{ stage: "first-boot", result: partial }, ...all(null).slice(1)], aborts: ["stage-timeout"], terminatedConfirmed: true }), "aborted");
});

// ---------------------------------------------------------------- driver

function status(over: Partial<ProviderMachineStatus> = {}): ProviderMachineStatus {
  return {
    provider: "runpod", providerMachineId: "pod1", machineId: spec.machineId, state: "running", rawStatus: "RUNNING",
    gpuType: "RTX-A4000", gpuCount: 1, dataCenter: "EU-SE-1", image: "img", diskGb: 40, volumeGb: 0,
    envNames: ["SBGPU_BOOT_TOKEN"], exposedPorts: [], unexpectedSettings: [], command: ["/bin/sh", "-c", "x"],
    providerCostPerHour: 250_000, observedAt: "", ...over,
  };
}

interface World {
  log: string[];
  stages: string[][];
  statusOver?: (n: number) => Partial<ProviderMachineStatus> | Error;
  launchError?: ProviderError;
  terminateFails?: boolean;
  actionFails?: string;
  /** Each stage's log lines appear only this long after the stage starts. */
  logDelayMs?: number;
  /** A stop takes this long to reach EXITED; start before then is refused. */
  stopDelayMs?: number;
}

function harness(w: World) {
  let t = 1_800_000_000_000;
  let stage = 0;
  let statusCalls = 0;
  let gone = false;
  let stopped = false;
  let stoppedAt = 0;
  let stageAt = t;
  const adapter: ProviderAdapter = {
    info: { provider: "runpod", selfIdentity: { env: "RUNPOD_POD_ID" }, bootTokenEnv: "SBGPU_BOOT_TOKEN" },
    listOffers: async () => [],
    listMachines: async () => [],
    launch: async () => {
      w.log.push("launch");
      if (w.launchError) throw w.launchError;
      return { providerMachineId: "pod1", status: status({ state: "provisioning" }) };
    },
    status: async (id) => {
      statusCalls++;
      if (gone) return status({ providerMachineId: id, state: "terminated" });
      const over = w.statusOver?.(statusCalls);
      if (over instanceof Error) throw over;
      if (stopped && t >= stoppedAt + (w.stopDelayMs ?? 0)) return status({ state: "failed", rawStatus: "EXITED", ...over });
      if (stopped) return status({ state: "stopping", rawStatus: "RUNNING", ...over });
      return status(over);
    },
    terminate: async () => {
      w.log.push("terminate");
      if (w.terminateFails) throw new Error("503");
      gone = true;
    },
  };
  const api: ProbeProviderApi = {
    action: async (_id, action) => {
      w.log.push(action);
      if (w.actionFails === action) throw new Error("409");
      if (action === "start" && t < stoppedAt + (w.stopDelayMs ?? 0)) throw new Error("409 not stopped");
      if (action === "restart" || action === "start") {
        stage++;
        stageAt = t;
      }
      if (action === "stop") stoppedAt = t;
      stopped = action === "stop";
    },
    logs: async () => (t >= stageAt + (w.logDelayMs ?? 0) ? (w.stages[stage] ?? []) : []),
  };
  const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
  return { adapter, api, clock, elapsed: () => t - 1_800_000_000_000 };
}

test("a clean pod passes all three stages, then is terminated", async () => {
  const w: World = { log: [], stages: [RUN, RUN, RUN] };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.equal(r.outcome, "pass");
  assert.deepEqual(w.log, ["launch", "restart", "stop", "start", "terminate"]);
  assert.deepEqual(r.stages.map((s) => s.result?.pass), [true, true, true]);
  assert.equal(r.terminatedConfirmed, true);
  assert.equal(r.providerMachineId, "pod1");
  assert.deepEqual(r.aborts, []);
});

test("the driver waits for the stop to finish before starting again", async () => {
  const w: World = { log: [], stages: [RUN, RUN, RUN], stopDelayMs: 5 * 60_000 };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.equal(r.outcome, "pass", JSON.stringify(r.aborts));
  assert.deepEqual(w.log, ["launch", "restart", "stop", "start", "terminate"]);
});

test("the lifetime cap stops slow stages", async () => {
  // Each stage takes 14 minutes, the stop another 14: past 45 minutes during the last stage.
  const w: World = { log: [], stages: [RUN, RUN, RUN], logDelayMs: 14 * 60_000, stopDelayMs: 14 * 60_000 };
  const h = harness(w);
  const r = await runEradicationProbe({ ...plan, maxMinutes: 45 }, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["lifetime"]);
  assert.equal(r.outcome, "aborted");
  assert.ok(h.elapsed() <= 46 * 60_000, String(h.elapsed()));
});

test("a finding in a later stage fails the probe and still terminates", async () => {
  const leaky = [...RUN, "x RUNPOD_API_KEY=y"];
  const w: World = { log: [], stages: [RUN, leaky, RUN] };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.equal(r.outcome, "fail");
  assert.deepEqual(w.log, ["launch", "restart", "terminate"]);
  assert.equal(r.stages[1]!.result!.pass, false);
  assert.equal(r.stages[2]!.result, null);
});

test("a stage that never finishes times out: aborted, terminated", async () => {
  const w: World = { log: [], stages: [RUN.slice(0, 3)] };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.equal(r.outcome, "aborted");
  assert.deepEqual(r.aborts, ["stage-timeout"]);
  assert.deepEqual(w.log, ["launch", "terminate"]);
  assert.ok(h.elapsed() >= 15 * 60_000 && h.elapsed() < 17 * 60_000);
});

test("drift aborts at once and terminates", async () => {
  const w: World = { log: [], stages: [RUN.slice(0, 2)], statusOver: (n) => (n >= 3 ? { exposedPorts: ["22/tcp"] } : {}) };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["drift:exposedPorts"]);
  assert.equal(r.outcome, "aborted");
  assert.deepEqual(w.log, ["launch", "terminate"]);
});

test("the spend cap stops the probe before it is exceeded", async () => {
  // $1/h against a $0.20 cap: 12 minutes of budget.
  const p = { ...plan, maxSpendMicros: 200_000, maxMinutes: 45, stageMinutes: 15, spec: { ...spec, maxProviderCostPerHour: 1_000_000 } };
  const w: World = { log: [], stages: [RUN.slice(0, 1)], statusOver: () => ({ providerCostPerHour: 1_000_000 }) };
  const h = harness(w);
  const r = await runEradicationProbe(p, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["spend-cap"]);
  assert.ok(r.estimatedSpendMicros <= 200_000, String(r.estimatedSpendMicros));
  assert.deepEqual(w.log, ["launch", "terminate"]);
});

test("the spend estimate uses the rate cap (an upper bound) over the whole lifetime", async () => {
  const w: World = { log: [], stages: [RUN.slice(0, 1)], statusOver: () => ({ providerCostPerHour: 250_000 }) };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["stage-timeout"]);
  assert.equal(r.estimatedSpendMicros, Math.ceil((3_000_000 * h.elapsed()) / 3_600_000));
});

test("an unreadable status aborts", async () => {
  const w: World = { log: [], stages: [RUN], statusOver: () => new Error("500") };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["status-unreadable"]);
  assert.equal(r.outcome, "aborted");
});

test("an unconfirmed termination is reported, never a pass", async () => {
  const w: World = { log: [], stages: [RUN, RUN, RUN], terminateFails: true };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.equal(r.terminatedConfirmed, false);
  assert.equal(r.outcome, "aborted");
});

test("a failed action is a driver error; the pod is still terminated", async () => {
  const w: World = { log: [], stages: [RUN, RUN, RUN], actionFails: "stop" };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["driver-error"]);
  assert.equal(r.outcome, "aborted");
  assert.equal(w.log.at(-1), "terminate");
});

test("a launch that leaves a pod behind is cleaned up; one that doesn't isn't", async () => {
  const left: World = { log: [], stages: [], launchError: new ProviderError("runpod", "spec_mismatch", "x", null, null, "podX") };
  const h = harness(left);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["launch-failed"]);
  assert.equal(r.providerMachineId, "podX");
  assert.deepEqual(left.log, ["launch", "terminate"]);
  const none: World = { log: [], stages: [], launchError: new ProviderError("runpod", "no_capacity", "x") };
  const h2 = harness(none);
  const r2 = await runEradicationProbe(plan, h2.adapter, h2.api, h2.clock);
  assert.deepEqual(none.log, ["launch"]);
  assert.equal(r2.outcome, "aborted");
  assert.equal(r2.providerMachineId, null);
});

test("an invalid plan never launches", async () => {
  const w: World = { log: [], stages: [] };
  const h = harness(w);
  await assert.rejects(runEradicationProbe({ ...plan, approval: "" }, h.adapter, h.api, h.clock), RangeError);
  assert.deepEqual(w.log, []);
});

// ---------------------------------------------------------------- CLI arguments

test("parseArgs: dry run by default; execute needs an approval", () => {
  const o = parseArgs(["--launcher", "l.json"]);
  assert.equal(o.execute, false);
  assert.equal(o.gpu, "RTX-A4000");
  assert.equal(o.maxUsd, 3);
  assert.equal(parseArgs(["--launcher", "l.json", "--execute", "--approval", "William 2026-12-01"]).execute, true);
  for (const bad of [
    [], ["--launcher"], ["--launcher", "l.json", "--execute"], ["--launcher", "l.json", "--execute", "--approval", "ok"],
    ["--launcher", "l.json", "--gpu", "TPU"], ["--launcher", "l.json", "--max-usd", "-1"], ["--launcher", "l.json", "--max-usd", "x"],
    ["--launcher", "l.json", "--bogus"], ["--launcher", "--execute"],
  ]) {
    assert.throws(() => parseArgs(bad), RangeError, JSON.stringify(bad));
  }
});

test("planFor builds a checked plan whose rate cap fits the spend cap", () => {
  const p = planFor(parseArgs(["--launcher", "l.json"]), ["/bin/sh", "-c", "x"], TOKEN);
  assert.equal(p.maxSpendMicros, 3_000_000);
  assert.equal(p.spec.maxProviderCostPerHour, 3_000_000);
  assert.equal(p.spec.machineId, "mch_pr0bepr0bepr0bepr0be");
  assert.throws(() => planFor(parseArgs(["--launcher", "l.json"]), [], TOKEN), RangeError);
  assert.throws(() => planFor(parseArgs(["--launcher", "l.json", "--max-usd", "11"]), ["x"], TOKEN), RangeError);
  assert.throws(() => planFor(parseArgs(["--launcher", "l.json"]), ["x"], "short"), RangeError);
});
