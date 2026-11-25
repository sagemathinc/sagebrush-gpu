import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../errors.ts";
import type { LaunchSpec, ProviderAdapter, ProviderMachineStatus } from "../types.ts";
import {
  accountSpendPerHr,
  AUTHORIZED_KEY_FILE,
  completeEventsLength,
  finishRun,
  MAX_KEY_FILE_BYTES,
  parseArgs,
  planFor,
  readKeyFile,
  readLogs,
  RUNPOD_GRAPHQL,
  settleSpend,
} from "./cli.ts";
import type { ProbeReport } from "./eradication.ts";
import {
  checkPlan,
  judgeStage,
  judgeStageWithDigest,
  validShape,
  launcherSha256,
  maskSalt,
  outcomeOf,
  parseLogSse,
  parseProbeLine,
  CALL_TIMEOUT_MS,
  ProbeFormatError,
  probeLauncher,
  RESERVE_MS,
  runEradicationProbe,
  type ProbePlan,
  type ProbeProviderApi,
} from "./eradication.ts";

const line = (check: string, pass = true, extra: Record<string, unknown> = {}) =>
  `SBGPU-PROBE ${JSON.stringify({ v: 1, boot: 1, check, pass, paths: [], detail: pass ? "" : "found-name", ...extra })}`;
const DIG = "d".repeat(64);
const SHAPE_DETAIL = "v44-rpa-dlsu";
const pid1 = (digest = DIG, shape = SHAPE_DETAIL) => line("pid1", true, { detail: shape, paths: [`digest:${digest}`] });
const RUN = [pid1(), ...["environ", "files", "metadata", "history", "done"].map((c) => line(c))];

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
  assert.deepEqual(r, { pass: true, failures: [], failedChecks: [], complete: true, shape: SHAPE_DETAIL });
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

test("judgeStage reports failed checks with their paths", () => {
  const r = judgeStage(RUN.map((l) => (l.includes('"files"') ? line("files", false, { paths: ["/etc/rp_environment"] }) : l)));
  assert.deepEqual(r.failures, ["check-failed"]);
  assert.deepEqual(r.failedChecks, [{ check: "files", detail: "found-name", paths: ["/etc/rp_environment"] }]);
  assert.equal(r.complete, true);
  assert.equal(judgeStage(["token rpa_short"]).failures.includes("key-shaped-string-in-log"), false);
});

// SEC H2: the raw line is scanned before parsing, so no field of a passing probe line can carry
// the key's name or a key-shaped string.
const NAME = "RUNPOD_API_KEY";
const SHAPE = "rpa_ABCDEFGHIJKLMNOPQRSTUV";
const fieldRows: Array<[string, string, string]> = [
  ["the name in paths of a passing line", line("files", true, { paths: [`/etc/${NAME}`] }), "key-name-in-log"],
  ["the name as a whole path", line("files", true, { paths: [NAME] }), "key-name-in-log"],
  ["a key shape in paths of a passing line", line("files", true, { paths: [`/tmp/${SHAPE}`] }), "key-shaped-string-in-log"],
  ["an assignment in paths", line("files", true, { paths: [`${NAME}=x`] }), "key-shaped-string-in-log"],
  ["the name in a malformed probe line", `SBGPU-PROBE {"${NAME}":1}`, "key-name-in-log"],
  ["a key shape in a malformed probe line", `SBGPU-PROBE ${SHAPE}`, "key-shaped-string-in-log"],
  ["the name in a non-probe line", `echo ${NAME}`, "key-name-in-log"],
  // TESTS T1 (r2): JSON escapes decode to the name or a key shape after the raw scan.
  ["an escaped name in paths", line("files", true, { paths: ["/tmp/RUNPOD_API_KEY"] }).replace("RUNPOD", "\\u0052UNPOD"), "key-name-in-log"],
  ["an escaped key shape in paths", line("files", true, { paths: [`/tmp/${SHAPE}`] }).replace("rpa_", "\\u0072pa_"), "key-shaped-string-in-log"],
  ["an escaped assignment in paths", line("files", true, { paths: ["RUNPOD_API_KEY=x"] }).replace("=", "\\u003d").replace("RUNPOD", "\\u0052UNPOD"), "key-shaped-string-in-log"],
];

test("the escaped rows really hide from the raw scan", () => {
  const escaped = line("files", true, { paths: ["/tmp/RUNPOD_API_KEY"] }).replace("RUNPOD", "\\u0052UNPOD");
  assert.ok(!escaped.includes(NAME));
  assert.deepEqual(parseProbeLine(escaped)!.paths, ["/tmp/RUNPOD_API_KEY"]);
});

for (const [what, l, failure] of fieldRows) {
  test(`judgeStage fails on ${what}`, () => {
    const files = RUN.findIndex((x) => x.includes('"files"'));
    const lines = l.startsWith("SBGPU-PROBE") && !l.includes('"v":1') ? [...RUN, l] : l.startsWith("SBGPU-PROBE") ? [...RUN.slice(0, files), l, ...RUN.slice(files + 1)] : [...RUN, l];
    const r = judgeStage(lines);
    assert.equal(r.pass, false);
    assert.ok(r.failures.includes(failure), JSON.stringify(r.failures));
  });
}

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
const HASH = "a".repeat(64);
const agent = { agentUrl: "https://cdn.example.test/probe-agent.tar.gz", agentSha256: HASH, controlUrl: "https://control.example.test" };
const SALT = "5".repeat(64);
const LAUNCHER = probeLauncher(agent, SALT);
const spec: LaunchSpec = {
  machineId: "mch_pr0bepr0bepr0bepr0be", gpuType: "RTX-A4000", gpuCount: 1, dataCenter: "EU-SE-1",
  image: "img", diskGb: 40, bootToken: TOKEN, launcher: LAUNCHER, maxProviderCostPerHour: 3_000_000,
};
const plan: ProbePlan = { approval: "William, msg 123", agent, saltHex: SALT, spec, maxSpendMicros: 3_000_000, maxMinutes: 60, stageMinutes: 15, pollSeconds: 30 };

// SEC H1: the launcher can only be the production one for the probe agent.
test("probeLauncher is renderBootCommand's container argv, with the agent's values in it", () => {
  assert.equal(LAUNCHER.length, 3);
  assert.deepEqual(LAUNCHER.slice(0, 2), ["/bin/sh", "-c"]);
  assert.ok(LAUNCHER[2]!.includes(agent.agentUrl));
  assert.ok(LAUNCHER[2]!.includes(HASH));
  for (const bad of [
    { ...agent, agentUrl: "http://cdn.example.test/a.tgz" },
    { ...agent, agentUrl: "https://cdn.example.test/a b.tgz" },
    { ...agent, agentSha256: "A".repeat(64) },
    { ...agent, agentSha256: "a".repeat(63) },
    { ...agent, controlUrl: "ftp://control.example.test" },
  ]) {
    assert.throws(() => probeLauncher(bad, SALT), JSON.stringify(bad));
  }
});

const hostile: Array<[string, string[]]> = [
  ["a fake script", ["/bin/sh", "-c", "echo SBGPU-PROBE ..."]],
  ["an extra argument", [...LAUNCHER, "--fake"]],
  ["a missing argument", LAUNCHER.slice(0, 2)],
  ["an altered script", ["/bin/sh", "-c", LAUNCHER[2]!.replace(HASH, "b".repeat(64))]],
  ["another shell", ["/bin/bash", "-c", LAUNCHER[2]!]],
  ["the launcher for another agent", probeLauncher({ ...agent, agentUrl: "https://evil.example.test/a.tgz" }, SALT)],
  ["the launcher with another salt", probeLauncher(agent, "6".repeat(64))],
  ["the production launcher without the prologue", ["/bin/sh", "-c", LAUNCHER[2]!.slice(LAUNCHER[2]!.indexOf("SBGPU_AGENT_URL="))]],
];

for (const [what, launcher] of hostile) {
  test(`a plan with ${what} as its launcher never launches`, async () => {
    assert.throws(() => checkPlan({ ...plan, spec: { ...plan.spec, launcher } }), RangeError);
    const w: World = { log: [], stages: [RUN, RUN, RUN] };
    const h = harness(w);
    await assert.rejects(runEradicationProbe({ ...plan, spec: { ...plan.spec, launcher } }, h.adapter, h.api, h.clock), RangeError);
    assert.deepEqual(w.log, []);
  });
}

test("the report records the probe agent and the launcher's hash", async () => {
  const w: World = { log: [], stages: [RUN, RUN, RUN] };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.equal(r.agentUrl, agent.agentUrl);
  assert.equal(r.agentSha256, HASH);
  assert.equal(r.launcherSha256, await launcherSha256(LAUNCHER));
  assert.match(r.launcherSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(await launcherSha256([...LAUNCHER, "x"]), r.launcherSha256);
  // Argument boundaries count: ["ab", "c"] and ["a", "bc"] are different launchers.
  assert.notEqual(await launcherSha256(["ab", "c"]), await launcherSha256(["a", "bc"]));
  assert.equal(await launcherSha256([]), "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
});

test("an adapter whose boot token variable isn't the launcher's is refused", async () => {
  const w: World = { log: [], stages: [RUN, RUN, RUN] };
  const h = harness(w);
  const a = { ...h.adapter, info: { ...h.adapter.info, bootTokenEnv: "OTHER" } };
  await assert.rejects(runEradicationProbe(plan, a, h.api, h.clock), RangeError);
  assert.deepEqual(w.log, []);
});

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
  checkPlan({ ...plan, maxMinutes: 60, spec: { ...spec, maxProviderCostPerHour: 12_000_000 } });
  // LIMITS H2: the stages plus the cleanup reserve must fit the lifetime ...
  assert.equal(RESERVE_MS, 387_000);
  checkPlan({ ...plan, maxMinutes: 52 }); // 45 min of stages + 6.45 min reserve
  assert.throws(() => checkPlan({ ...plan, maxMinutes: 51 }), RangeError);
  // ... and the spend cap must cover the launch and cleanup reserve (plus a poll) at the rate cap.
  const need = Math.ceil((3_000_000 * (RESERVE_MS + 30_000)) / 3_600_000);
  const short = { ...plan, maxMinutes: 10, stageMinutes: 1 }; // where the reserve rule is the binding one
  checkPlan({ ...short, maxSpendMicros: need });
  assert.throws(() => checkPlan({ ...short, maxSpendMicros: need - 1 }), /cleanup reserve/);
});

test("outcomeOf", () => {
  const ok = { pass: true, failures: [], failedChecks: [], complete: true, shape: SHAPE_DETAIL };
  const failed = { pass: false, failures: ["check-failed"], failedChecks: [], complete: true, shape: null };
  const keyLeak = { pass: false, failures: ["key-name-in-log", "checks-incomplete-or-out-of-order"], failedChecks: [], complete: false, shape: null };
  const partial = { pass: false, failures: ["checks-incomplete-or-out-of-order"], failedChecks: [], complete: false, shape: null };
  const all = (r: typeof ok | null) => [{ stage: "first-boot" as const, result: r }, { stage: "after-restart" as const, result: r }, { stage: "after-stop-start" as const, result: r }];
  assert.equal(outcomeOf({ stages: all(ok), aborts: [], terminatedConfirmed: true }), "pass");
  assert.equal(outcomeOf({ stages: all(ok), aborts: ["x"], terminatedConfirmed: true }), "aborted");
  assert.equal(outcomeOf({ stages: all(ok), aborts: [], terminatedConfirmed: false }), "aborted");
  assert.equal(outcomeOf({ stages: all(null), aborts: [], terminatedConfirmed: true }), "aborted");
  assert.equal(outcomeOf({ stages: [{ stage: "first-boot", result: ok }, ...all(null).slice(1)], aborts: [], terminatedConfirmed: true }), "aborted");
  const twoBoots = { pass: false, failures: ["several-boots-in-one-stage"], failedChecks: [], complete: true, shape: null };
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
    envNames: ["SBGPU_BOOT_TOKEN"], exposedPorts: [], unexpectedSettings: [], command: LAUNCHER,
    providerCostPerHour: 250_000, observedAt: "", ...over,
  };
}

interface World {
  log: string[];
  stages: string[][];
  statusOver?: (n: number) => Partial<ProviderMachineStatus> | Error;
  launchError?: Error;
  terminateFails?: boolean;
  /** Terminate takes this long. */
  terminateDelayMs?: number;
  /** Each status read takes this long. */
  statusDelayMs?: number;
  /** The raw status a stopped pod reports (default EXITED). */
  stoppedRaw?: string;
  /** How many log reads the driver made. */
  logCalls?: number;
  actionFails?: string;
  /** Each stage's log lines appear only this long after the stage starts. */
  logDelayMs?: number;
  /** A stop takes this long to reach EXITED; start before then is refused. */
  stopDelayMs?: number;
  /** The spec the adapter was asked to launch. */
  launched?: LaunchSpec;
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
    launch: async (s: LaunchSpec) => {
      w.log.push("launch");
      w.launched = s;
      if (w.launchError) throw w.launchError;
      return { providerMachineId: "pod1", status: status({ state: "provisioning" }) };
    },
    status: async (id) => {
      statusCalls++;
      t += w.statusDelayMs ?? 0;
      if (gone) return status({ providerMachineId: id, state: "terminated" });
      const over = w.statusOver?.(statusCalls);
      if (over instanceof Error) throw over;
      if (stopped && t >= stoppedAt + (w.stopDelayMs ?? 0)) return status({ state: "failed", rawStatus: w.stoppedRaw ?? "EXITED", ...over });
      if (stopped) return status({ state: "stopping", rawStatus: "RUNNING", ...over });
      return status(over);
    },
    terminate: async () => {
      w.log.push("terminate");
      t += w.terminateDelayMs ?? 0;
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
    logs: async () => {
      w.logCalls = (w.logCalls ?? 0) + 1;
      return t >= stageAt + (w.logDelayMs ?? 0) ? (w.stages[stage] ?? []) : [];
    },
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

test("the lifetime cap stops slow stages, leaving room for the cleanup", async () => {
  // Each stage takes 11 minutes, the stop another 11: the 45-minute lifetime, less the reserve,
  // runs out during the last stage.
  const w: World = { log: [], stages: [RUN, RUN, RUN], logDelayMs: 11 * 60_000, stopDelayMs: 11 * 60_000 };
  const h = harness(w);
  const r = await runEradicationProbe({ ...plan, maxMinutes: 45, stageMinutes: 12 }, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["lifetime"]);
  assert.equal(r.outcome, "aborted");
  assert.ok(h.elapsed() + RESERVE_MS <= 45 * 60_000, String(h.elapsed()));
  assert.deepEqual(w.log, ["launch", "restart", "stop", "start", "terminate"]);
});

test("LIMITS H1: a slow stop never leads to a start past the budget", async () => {
  // $1/h against a $0.20 cap; the first two stages finish at once; the stop takes 15 minutes.
  const p = { ...plan, maxSpendMicros: 200_000, maxMinutes: 45, stageMinutes: 10, spec: { ...spec, maxProviderCostPerHour: 1_000_000 } };
  const w: World = { log: [], stages: [RUN, RUN, RUN], stopDelayMs: 15 * 60_000, statusOver: () => ({ providerCostPerHour: 1_000_000 }) };
  const h = harness(w);
  const r = await runEradicationProbe(p, h.adapter, h.api, h.clock);
  assert.deepEqual(w.log, ["launch", "restart", "stop", "terminate"]);
  assert.deepEqual(r.aborts, ["spend-cap"]);
  assert.ok(r.estimatedSpendMicros <= 200_000, String(r.estimatedSpendMicros));
  assert.equal(r.withinCap, true);
});

test("LIMITS H1: no action is taken once the pod drifts", async () => {
  // Status read 1 is the first stage's guard; read 2 is the guard before the restart.
  const w: World = { log: [], stages: [RUN, RUN, RUN], statusOver: (n) => (n >= 2 ? { image: "other" } : {}) };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.deepEqual(w.log, ["launch", "terminate"]);
  assert.deepEqual(r.aborts, ["drift:image"]);
});

test("LIMITS H2: a slow terminate still fits the cap (the cleanup reserve)", async () => {
  const p = { ...plan, maxSpendMicros: 200_000, maxMinutes: 45, stageMinutes: 10, spec: { ...spec, maxProviderCostPerHour: 1_000_000 } };
  const w: World = { log: [], stages: [[]], terminateDelayMs: CALL_TIMEOUT_MS, statusOver: () => ({ providerCostPerHour: 1_000_000 }) };
  const h = harness(w);
  const r = await runEradicationProbe(p, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["spend-cap"]);
  assert.ok(r.estimatedSpendMicros <= 200_000, String(r.estimatedSpendMicros));
  assert.equal(r.withinCap, true);
  assert.equal(r.exposure, null);
});

// At 3.6M micro-USD per hour, one millisecond costs exactly one micro: costs equal times.
const exact = { ...plan, maxMinutes: 10, stageMinutes: 1, pollSeconds: 10, spec: { ...spec, maxProviderCostPerHour: 3_600_000 } };

test("LIMITS: the spend boundary is exact (equal to the cap is allowed, one past is not)", async () => {
  // A stage that never finishes; polls every 10 s; the reserve is 387 s. The pause at 30 s would
  // end at 30 + 10 + 387 = 427 s = 427000 micro: one past this cap.
  const w: World = { log: [], stages: [[]] };
  const h = harness(w);
  const r = await runEradicationProbe({ ...exact, maxSpendMicros: 426_999 }, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["spend-cap"]);
  assert.equal(h.elapsed(), 30_000);
  const w2: World = { log: [], stages: [[]] };
  const h2 = harness(w2);
  await runEradicationProbe({ ...exact, maxSpendMicros: 427_000 }, h2.adapter, h2.api, h2.clock);
  assert.equal(h2.elapsed(), 40_000);
});

test("LIMITS: the budget is checked again after a slow status read", async () => {
  // The guard passes at 0 s (387000 <= cap); the status read takes 20 s; 407000 > cap.
  const w: World = { log: [], stages: [RUN], statusDelayMs: 20_000 };
  const h = harness(w);
  const r = await runEradicationProbe({ ...exact, maxSpendMicros: 406_999 }, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["spend-cap"]);
  assert.equal(w.logCalls ?? 0, 0);
});

test("a pod that crashed (ERROR) is not taken for a stopped one", async () => {
  const w: World = { log: [], stages: [RUN, RUN, RUN], stoppedRaw: "ERROR" };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.deepEqual(r.aborts, ["state-timeout"]);
  assert.deepEqual(w.log, ["launch", "restart", "stop", "terminate"]);
});

test("withinCap is false when the cleanup overran the reserve", async () => {
  const p = { ...plan, maxSpendMicros: 200_000, maxMinutes: 45, stageMinutes: 10, spec: { ...spec, maxProviderCostPerHour: 1_000_000 } };
  const w: World = { log: [], stages: [[]], terminateDelayMs: 30 * 60_000 };
  const h = harness(w);
  const r = await runEradicationProbe(p, h.adapter, h.api, h.clock);
  assert.equal(r.withinCap, false);
  assert.ok(r.estimatedSpendMicros > 200_000);
});

test("LIMITS H2: an unconfirmed termination is reported as exposure", async () => {
  const w: World = { log: [], stages: [RUN.slice(0, 1)], terminateFails: true };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.equal(r.terminatedConfirmed, false);
  assert.deepEqual(r.exposure, { providerMachineId: "pod1", machineName: "sbg-mch_pr0bepr0bepr0bepr0be", ratePerHour: 3_000_000 });
  assert.equal(r.outcome, "aborted");
});

test("SEC H1: changing the plan while the driver runs changes nothing", async () => {
  const mutable: ProbePlan = structuredClone(plan);
  const w: World = { log: [], stages: [RUN, RUN, RUN] };
  const h = harness(w);
  const running = runEradicationProbe(mutable, h.adapter, h.api, h.clock);
  // The driver is now awaiting the launcher digest: swap in a fake launcher.
  mutable.spec.launcher = ["/bin/sh", "-c", "echo fake"];
  mutable.spec.image = "attacker/image";
  mutable.maxSpendMicros = 10_000_000;
  const r = await running;
  assert.deepEqual(w.launched!.launcher, LAUNCHER);
  assert.equal(w.launched!.image, "img");
  assert.equal(r.launcherSha256, await launcherSha256(LAUNCHER));
  assert.equal(r.outcome, "pass");
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
  // $1/h against a $0.20 cap: 12 minutes of budget, 6.45 of them held in reserve.
  const p = { ...plan, maxSpendMicros: 200_000, maxMinutes: 45, stageMinutes: 10, spec: { ...spec, maxProviderCostPerHour: 1_000_000 } };
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
  assert.deepEqual(r.launchError, { kind: "spec_mismatch", httpStatus: null });
  assert.deepEqual(r2.launchError, { kind: "no_capacity", httpStatus: null });
});

test("a refused launch reports its kind and HTTP status, never the error's text", async () => {
  const w: World = { log: [], stages: [], launchError: new ProviderError("runpod", "unplaceable", "RunPod HTTP 400 (unplaceable) MARKER", 400) };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.deepEqual(r.launchError, { kind: "unplaceable", httpStatus: 400 });
  assert.deepEqual([r.terminatedConfirmed, r.exposure, r.aborts], [true, null, ["launch-failed"]]);
  assert.ok(!JSON.stringify(r).includes("MARKER"));
  // Anything that isn't a ProviderError is a driver error, and may have left a pod.
  const odd: World = { log: [], stages: [], launchError: Object.assign(new Error("MARKER"), { name: "MARKER" }) };
  const h2 = harness(odd);
  const r2 = await runEradicationProbe(plan, h2.adapter, h2.api, h2.clock);
  assert.deepEqual(r2.launchError, { kind: "driver-error", httpStatus: null });
  assert.equal(r2.terminatedConfirmed, false);
  assert.ok(!JSON.stringify(r2).includes("MARKER"));
});

test("an invalid plan never launches", async () => {
  const w: World = { log: [], stages: [] };
  const h = harness(w);
  await assert.rejects(runEradicationProbe({ ...plan, approval: "" }, h.adapter, h.api, h.clock), RangeError);
  assert.deepEqual(w.log, []);
});

// ---------------------------------------------------------------- CLI arguments

const ARGS = ["--agent-url", agent.agentUrl, "--agent-sha256", HASH, "--control-url", agent.controlUrl];

test("parseArgs: dry run by default; execute needs an approval; no way to pass a launcher", () => {
  const o = parseArgs(ARGS);
  assert.equal(o.execute, false);
  assert.equal(o.gpu, "RTX-A4000");
  assert.equal(o.maxUsd, 3);
  assert.equal(parseArgs([...ARGS, "--execute", "--approval", "William 2026-12-01", "--key-file", AUTHORIZED_KEY_FILE]).execute, true);
  for (const bad of [
    [...ARGS, "--execute", "--approval", "William 2026-12-01"],
    [...ARGS, "--execute", "--approval", "William 2026-12-01", "--key-file", "/tmp/key"],
    [...ARGS, "--execute", "--approval", "William 2026-12-01", "--key-file", AUTHORIZED_KEY_FILE + "/"],
    [...ARGS, "--key-file", AUTHORIZED_KEY_FILE],
    [...ARGS, "--execute", "--key-file", AUTHORIZED_KEY_FILE],
    [...ARGS, "--execute", "--approval", "ok", "--key-file", AUTHORIZED_KEY_FILE],
  ]) {
    assert.throws(() => parseArgs(bad), RangeError, JSON.stringify(bad));
  }
  for (const bad of [
    [], ARGS.slice(2), ARGS.slice(0, 4), [...ARGS.slice(0, 2), ...ARGS.slice(4)],
    [...ARGS, "--launcher", "l.json"], [...ARGS, "--execute"], [...ARGS, "--execute", "--approval", "ok"],
    [...ARGS, "--gpu", "TPU"], [...ARGS, "--max-usd", "-1"], [...ARGS, "--max-usd", "x"], [...ARGS, "--bogus"],
    ["--agent-url", "--execute"],
  ]) {
    assert.throws(() => parseArgs(bad), RangeError, JSON.stringify(bad));
  }
});

test("planFor builds the launcher itself and a checked plan whose rate cap fits the spend cap", () => {
  const p = planFor(parseArgs(ARGS), TOKEN, SALT);
  assert.equal(p.saltHex, SALT);
  assert.throws(() => planFor(parseArgs(ARGS), TOKEN, "5".repeat(63)), RangeError);
  assert.throws(() => planFor(parseArgs(ARGS), TOKEN, "G".repeat(64)), RangeError);
  assert.deepEqual(p.spec.launcher, LAUNCHER);
  assert.deepEqual(p.agent, agent);
  assert.equal(p.maxSpendMicros, 3_000_000);
  assert.equal(p.spec.maxProviderCostPerHour, 3_000_000);
  assert.equal(p.spec.machineId, "mch_pr0bepr0bepr0bepr0be");
  assert.throws(() => planFor(parseArgs([...ARGS, "--max-usd", "11"]), TOKEN, SALT), RangeError);
  assert.throws(() => planFor(parseArgs(ARGS), "short", SALT), RangeError);
  for (const [flag, value] of [["--agent-url", "http://x.test/a.tgz"], ["--agent-sha256", "XYZ"], ["--control-url", "file:///etc"]] as const) {
    const args = [...ARGS];
    args[args.indexOf(flag) + 1] = value;
    assert.throws(() => planFor(parseArgs(args), TOKEN, SALT), `${flag} ${value}`);
  }
});

// ---------------------------------------------------------------- TESTS T2: the SSE reader

const ev = (line: string, eol: string) => `data: ${JSON.stringify({ source: "container", line, ts: "t" })}${eol}${eol}`;

/** A fetch whose response body streams these chunks, then ends (or stays open). */
function streamFetch(chunks: string[], end = true): typeof fetch {
  return (async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        if (end) c.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

test("completeEventsLength finds the last blank line, LF or CRLF", () => {
  assert.equal(completeEventsLength("data: a\n\n"), 9);
  assert.equal(completeEventsLength("data: a\r\n\r\n"), 11);
  assert.equal(completeEventsLength("data: a\n\ndata: b"), 9);
  assert.equal(completeEventsLength("data: a\r\n\r\ndata: b\r\n"), 11);
  assert.equal(completeEventsLength("data: a\r\n"), 0);
  assert.equal(completeEventsLength(""), 0);
});

for (const [what, chunks, expected] of [
  ["LF events", [ev("hello", "\n"), ev("world", "\n")], ["hello", "world"]],
  ["CRLF events", [ev("hello", "\r\n"), ev("world", "\r\n")], ["hello", "world"]],
  ["a CRLF delimiter split across chunks", [ev("hello", "\r\n").slice(0, -2), "\r\n", ev("world", "\r\n")], ["hello", "world"]],
  ["an LF delimiter split across chunks", [ev("hello", "\n").slice(0, -1), "\n" + ev("world", "\n")], ["hello", "world"]],
  ["an incomplete tail", [ev("hello", "\r\n"), 'data: {"source":"container","line":"partial"'], ["hello"]],
  ["an event split mid-JSON", [ev("hello", "\n").slice(0, 20), ev("hello", "\n").slice(20)], ["hello"]],
] as const) {
  test(`readLogs keeps complete events: ${what}`, async () => {
    assert.deepEqual(await readLogs("k", "pod1", "t", { fetch: streamFetch([...chunks]) }), expected);
  });
}

test("readLogs stops on a quiet open stream and keeps what is complete", async () => {
  const lines = await readLogs("k", "pod1", "t", { fetch: streamFetch([ev("hello", "\r\n")], false), quietMs: 20 });
  assert.deepEqual(lines, ["hello"]);
});

// ---------------------------------------------------------------- the value capture (probe prologue)

test("judgeStageWithDigest: a passing pid1 carries the shape and one digest; the digest stays internal", () => {
  const { result, digest } = judgeStageWithDigest(RUN);
  assert.equal(result.pass, true);
  assert.equal(result.shape, SHAPE_DETAIL);
  assert.equal(digest, DIG);
  assert.ok(!JSON.stringify(result).includes(DIG));
});

const badCaptures: Array<[string, string]> = [
  ["no digest", line("pid1", true, { detail: SHAPE_DETAIL, paths: [] })],
  ["two paths", line("pid1", true, { detail: SHAPE_DETAIL, paths: [`digest:${DIG}`, "/x"] })],
  ["a short digest", line("pid1", true, { detail: SHAPE_DETAIL, paths: [`digest:${"d".repeat(63)}`] })],
  ["an uppercase digest", line("pid1", true, { detail: SHAPE_DETAIL, paths: [`digest:${"D".repeat(64)}`] })],
  ["no shape", line("pid1", true, { detail: "", paths: [`digest:${DIG}`] })],
  ["a malformed shape", line("pid1", true, { detail: "rpa-44", paths: [`digest:${DIG}`] })],
  // TESTS T1: shapes the prologue can't write.
  ...["v0-rpa-z", "v9999-none-zz", "v16-abcdefghijklmnop-uuu", "v0016-none-uld"].map(
    (s): [string, string] => [`the impossible shape ${s}`, line("pid1", true, { detail: s, paths: [`digest:${DIG}`] })],
  ),
];

test("validShape: exactly the prologue's grammar, with each field's edges", () => {
  const valid = [
    "v16-none-d", "v4096-none-u", "v44-none-dhlosu", "v44-rpa-dlsu", "v44-rpa-ls", "v44-rpa-lsu",
    "v25-abcdefgh-ls", "v18-a-ls", "v18-7-ds", "v18-p1-su", "v44-p3-su", "v25-p8-su", "v44-p3-dls", "v18-none-o",
    "v44-none-ls",
  ];
  const invalid = [
    // bytes: below 16, above 4096, leading zeros, none, too many digits
    "v15-none-d", "v4097-none-d", "v0016-none-d", "v016-none-d", "v-none-d", "v10000-none-d", "v0-rpa-z", "v9999-none-zz",
    // classes: empty, out of order, repeated, unknown
    "v44-none-", "v44-none-ld", "v44-none-dd", "v44-none-z", "v44-none-uld", "v44-none-x",
    // prefix: too long, uppercase, punctuation, empty
    "v44-abcdefghi-ls", "v16-abcdefghijklmnop-uuu", "v44-RPA-lsu", "v44-r_a-ls", "v44--ls",
    // prefix without "_", letters without "l", digits without "d", too long for the key
    "v44-rpa-lu", "v44-rpa-su", "v44-r7-ls", "v24-abcdefgh-ls", "v17-a-ls",
    // pN: needs "u" (or reads as a literal, which needs "l" and "d"), N in 1..8, room after it
    "v44-p3-s", "v44-p3-ls", "v44-p9-su", "v44-p0-su", "v20-p4-su",
    // anything around it
    " v44-rpa-ls", "v44-rpa-ls\n", "V44-rpa-ls", "v44_rpa_ls", "v44-rpa-ls-x",
  ];
  for (const s of valid) assert.equal(validShape(s), true, s);
  for (const s of invalid) assert.equal(validShape(s), false, JSON.stringify(s));
});

for (const [what, l] of badCaptures) {
  test(`a passing pid1 with ${what} fails the stage (bad-capture-report), with no digest`, () => {
    const { result, digest } = judgeStageWithDigest([l, ...RUN.slice(1)]);
    assert.equal(result.pass, false);
    assert.ok(result.failures.includes("bad-capture-report"), JSON.stringify(result.failures));
    assert.equal(digest, null);
    assert.equal(result.shape, null);
  });
}

test("a failed stage gives no digest, and digests never appear in reported paths", () => {
  const failingPid1 = line("pid1", false, { detail: "bad-capture", paths: [`digest:${DIG}`, "/opt/sbgpu/probe-capture"] });
  const { result, digest } = judgeStageWithDigest([failingPid1, ...RUN.slice(1)]);
  assert.equal(digest, null);
  assert.deepEqual(result.failedChecks, [{ check: "pid1", detail: "bad-capture", paths: ["/opt/sbgpu/probe-capture"] }]);
  const { digest: d2 } = judgeStageWithDigest([...RUN.slice(0, 2), line("files", false), ...RUN.slice(3)]);
  assert.equal(d2, null);
});

test("maskSalt replaces every occurrence of a valid salt, and nothing else", () => {
  assert.equal(maskSalt(`a${SALT}b${SALT}`, SALT), "a<salt>b<salt>");
  assert.equal(maskSalt("no salt here", SALT), "no salt here");
  assert.equal(maskSalt("abc", "abc"), "abc");
  assert.ok(!maskSalt(JSON.stringify(LAUNCHER), SALT).includes(SALT));
  assert.ok(JSON.stringify(LAUNCHER).includes(SALT));
});

test("a clean run with the same capture in every stage passes; the report has the shape, never the digest or salt", async () => {
  const w: World = { log: [], stages: [RUN, RUN, RUN] };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.equal(r.outcome, "pass");
  assert.equal(r.observedShape, SHAPE_DETAIL);
  assert.equal(r.captureConsistent, true);
  const text = JSON.stringify(r);
  assert.ok(!text.includes(DIG));
  assert.ok(!text.includes(SALT));
});

for (const [what, stage3] of [
  ["a different digest", [pid1("e".repeat(64)), ...RUN.slice(1)]],
  ["a different shape", [pid1(DIG, "v45-rpa-dlsu"), ...RUN.slice(1)]],
] as const) {
  test(`${what} after stop/start is inconsistent: aborted, never pass`, async () => {
    const w: World = { log: [], stages: [RUN, RUN, [...stage3]] };
    const h = harness(w);
    const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
    assert.equal(r.captureConsistent, false);
    assert.ok(r.aborts.includes("capture-inconsistent"));
    assert.equal(r.outcome, "aborted");
    assert.ok(!JSON.stringify(r).includes("e".repeat(64)));
  });
}

test("captureConsistent stays null unless all three stages passed; observedShape comes from the first boot", async () => {
  const w: World = { log: [], stages: [RUN, [...RUN, "x RUNPOD_API_KEY=y"]] };
  const h = harness(w);
  const r = await runEradicationProbe(plan, h.adapter, h.api, h.clock);
  assert.equal(r.captureConsistent, null);
  assert.equal(r.observedShape, SHAPE_DETAIL);
  assert.equal(outcomeOf({ ...r, captureConsistent: false, aborts: [] }), "fail");
  const okStages = r.stages.map((s) => ({ ...s, result: { pass: true, failures: [], failedChecks: [], complete: true, shape: SHAPE_DETAIL } }));
  assert.equal(outcomeOf({ stages: okStages, aborts: [], terminatedConfirmed: true, captureConsistent: true }), "pass");
  assert.equal(outcomeOf({ stages: okStages, aborts: [], terminatedConfirmed: true, captureConsistent: false }), "aborted");
  assert.equal(outcomeOf({ stages: okStages, aborts: [], terminatedConfirmed: true, captureConsistent: null }), "aborted");
});

// ---------------------------------------------------------------- the CLI: key file and spend check

test("readKeyFile: only the authorized path, one line, no whitespace, bounded; errors never carry content", () => {
  const read = (content: string) => (path: string) => {
    assert.equal(path, AUTHORIZED_KEY_FILE);
    return new TextEncoder().encode(content);
  };
  assert.equal(readKeyFile(AUTHORIZED_KEY_FILE, read("rpa_SECRETVALUE1234567890")), "rpa_SECRETVALUE1234567890");
  assert.equal(readKeyFile(AUTHORIZED_KEY_FILE, read("rpa_SECRETVALUE1234567890\n")), "rpa_SECRETVALUE1234567890");
  assert.equal(readKeyFile(AUTHORIZED_KEY_FILE, read("rpa_SECRETVALUE1234567890\r\n")), "rpa_SECRETVALUE1234567890");
  assert.equal(readKeyFile(AUTHORIZED_KEY_FILE, read("k".repeat(MAX_KEY_FILE_BYTES))).length, MAX_KEY_FILE_BYTES);
  for (const bad of ["", "\n", " ", "rpa_SECRET VALUE", "rpa_SECRET\nSECOND", "\trpa_SECRET", "rpa_SECRET\n\n", "k".repeat(MAX_KEY_FILE_BYTES + 1)]) {
    assert.throws(
      () => readKeyFile(AUTHORIZED_KEY_FILE, read(bad)),
      (e: unknown) => e instanceof RangeError && !e.message.includes("SECRET"),
      JSON.stringify(bad),
    );
  }
  assert.throws(() => readKeyFile(AUTHORIZED_KEY_FILE, () => new Uint8Array([0xff, 0xfe])), TypeError);
  assert.throws(() => readKeyFile("/tmp/other", read("k")), RangeError);
});

function spendFetch(status: number, body: string, seen: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

test("accountSpendPerHr reads myself.currentSpendPerHr, with the key only in the Authorization header", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  assert.equal(await accountSpendPerHr("KEYVALUE", spendFetch(200, JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } } }), seen)), 0);
  assert.equal(seen[0]!.url, RUNPOD_GRAPHQL);
  assert.equal((seen[0]!.init.headers as Record<string, string>)["Authorization"], "Bearer KEYVALUE");
  assert.ok(!String(seen[0]!.init.body).includes("KEYVALUE"));
  assert.equal(await accountSpendPerHr("k", spendFetch(200, JSON.stringify({ data: { myself: { currentSpendPerHr: 0.25 } } }))), 0.25);
  // The control for the errors rows: an empty errors array is no error.
  assert.equal(await accountSpendPerHr("k", spendFetch(200, JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } }, errors: [] }))), 0);
  for (const [status, body] of [
    [401, '{"errors":[{"message":"KEYVALUE is bad"}]}'],
    [500, ""],
    [500, JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } } })],
    [201, JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } } })],
    [200, "not json"],
    [200, "{}"],
    [200, JSON.stringify({ data: { myself: { currentSpendPerHr: -1 } } })],
    [200, JSON.stringify({ data: { myself: { currentSpendPerHr: "0" } } })],
    [200, JSON.stringify({ data: { myself: { currentSpendPerHr: null } } })],
    // GraphQL errors beside a 0 (LIMITS H1), and malformed error envelopes.
    [200, JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } }, errors: [{ message: "upstream billing failed KEYVALUE" }] })],
    [200, JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } }, errors: [null] })],
    [200, JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } }, errors: {} })],
    [200, JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } }, errors: "KEYVALUE" })],
    [200, JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } }, errors: null })],
    [200, JSON.stringify([{ data: { myself: { currentSpendPerHr: 0 } } }])],
    [200, "0"],
    [200, "null"],
  ] as const) {
    await assert.rejects(
      accountSpendPerHr("KEYVALUE", spendFetch(status, body)),
      (e: unknown) => e instanceof Error && !e.message.includes("KEYVALUE"),
      `${status} ${body}`,
    );
  }
});

test("settleSpend: settled only on a successful read of exactly 0, within the polls", async () => {
  const seq = (values: Array<number | Error>) => {
    let i = 0;
    return async () => {
      const v = values[Math.min(i++, values.length - 1)]!;
      if (v instanceof Error) throw v;
      return v;
    };
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  assert.deepEqual(await settleSpend(seq([0]), sleep), { settled: true, lastSpendPerHr: 0 });
  assert.deepEqual(sleeps, []);
  assert.deepEqual(await settleSpend(seq([0.25, new Error("x"), 0]), sleep, 6, 10), { settled: true, lastSpendPerHr: 0 });
  assert.deepEqual(sleeps, [10, 10]);
  assert.deepEqual(await settleSpend(seq([0.25]), async () => {}, 3, 1), { settled: false, lastSpendPerHr: 0.25 });
  assert.deepEqual(await settleSpend(seq([0.005]), async () => {}, 2, 1), { settled: false, lastSpendPerHr: 0.005 });
  assert.deepEqual(await settleSpend(seq([new Error("x")]), async () => {}, 3, 1), { settled: false, lastSpendPerHr: null });
  // LIMITS H1 end to end: a 0 that comes with GraphQL errors never settles; a later clean 0 does.
  const replies = [
    JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } }, errors: [{ message: "upstream billing failed" }] }),
    JSON.stringify({ data: { myself: { currentSpendPerHr: 0 } } }),
  ];
  let r = 0;
  const graphql = (async () => new Response(replies[Math.min(r++, replies.length - 1)]!, { status: 200 })) as unknown as typeof fetch;
  assert.deepEqual(await settleSpend(() => accountSpendPerHr("k", graphql), async () => {}, 1, 1), { settled: false, lastSpendPerHr: null });
  assert.deepEqual(await settleSpend(() => accountSpendPerHr("k", graphql), async () => {}, 1, 1), { settled: true, lastSpendPerHr: 0 });
  r = 0;
  assert.deepEqual(await settleSpend(() => accountSpendPerHr("k", graphql), async () => {}, 2, 1), { settled: true, lastSpendPerHr: 0 });
  assert.equal(r, 2);
  let calls = 0;
  await settleSpend(async () => { calls++; return 1; }, async () => {}, 4, 1);
  assert.equal(calls, 4);
});

// ---------------------------------------------------------------- the CLI's end of a paid run (mocks only)

function finishReport(outcome: ProbeReport["outcome"], terminatedConfirmed: boolean): ProbeReport {
  return {
    outcome,
    approval: "test",
    agentUrl: "https://example.invalid/a.tar.gz",
    agentSha256: "a".repeat(64),
    launcherSha256: "b".repeat(64),
    providerMachineId: "pod1",
    stages: [],
    observedShape: SHAPE_DETAIL,
    captureConsistent: outcome === "pass" ? true : null,
    aborts: [],
    estimatedSpendMicros: 1,
    withinCap: true,
    terminatedConfirmed,
    exposure: terminatedConfirmed ? null : { providerMachineId: "pod1", machineName: "m", ratePerHour: 1 },
    launchError: null,
  };
}

async function finish(report: ProbeReport, spend: Array<number | Error>) {
  const out: string[] = [];
  let reads = 0;
  const code = await finishRun({
    run: async () => report,
    readSpend: async () => {
      const v = spend[Math.min(reads++, spend.length - 1)]!;
      if (v instanceof Error) throw v;
      return v;
    },
    sleep: async () => {},
    write: (t) => out.push(t),
    apiKey: "KEYVALUE-never-printed",
    saltHex: SALT,
  });
  // The salt never reaches stdout, whatever the report carries.
  assert.ok(!out.join("").includes(SALT));
  return { code, reads, printed: JSON.parse(out.join("")) as Record<string, unknown> };
}

test("finishRun: a pass exits 0 only once the spend rate reads exactly 0", async () => {
  const ok = await finish(finishReport("pass", true), [0]);
  assert.deepEqual([ok.code, ok.reads, ok.printed["spendSettled"], ok.printed["accountSpendPerHrAfter"]], [0, 1, true, 0]);
  const later = await finish(finishReport("pass", true), [0.25, 0]);
  assert.deepEqual([later.code, later.reads, later.printed["spendSettled"]], [0, 2, true]);
});

test("finishRun: a pass with a nonzero or unreadable spend rate exits 1 (T2)", async () => {
  const nonzero = await finish(finishReport("pass", true), [0.25]);
  assert.deepEqual([nonzero.code, nonzero.reads, nonzero.printed["spendSettled"], nonzero.printed["accountSpendPerHrAfter"]], [1, 6, false, 0.25]);
  const failing = await finish(finishReport("pass", true), [new Error("spend read: GraphQL errors")]);
  assert.deepEqual([failing.code, failing.printed["spendSettled"], failing.printed["accountSpendPerHrAfter"]], [1, false, null]);
});

test("finishRun: unconfirmed termination never reads the spend rate and exits 3", async () => {
  for (const outcome of ["pass", "fail", "aborted"] as const) {
    const r = await finish(finishReport(outcome, false), [0]);
    assert.deepEqual([r.code, r.reads, r.printed["spendSettled"], r.printed["accountSpendPerHrAfter"]], [3, 0, false, null], outcome);
  }
});

test("finishRun: a confirmed fail exits 1 even with the spend settled; the output masks the salt and refuses the key", async () => {
  const r = await finish(finishReport("fail", true), [0]);
  assert.deepEqual([r.code, r.printed["spendSettled"]], [1, true]);
  const withSalt = { ...finishReport("pass", true), approval: `salt ${SALT}` };
  const masked = await finish(withSalt, [0]);
  assert.equal(masked.printed["approval"], "salt <salt>");
  // A fake key that reaches the output path: nothing is written, and the error doesn't carry it.
  const written: string[] = [];
  await assert.rejects(
    finishRun({
      run: async () => ({ ...finishReport("pass", true), aborts: ["x KEYVALUE-never-printed"] }),
      readSpend: async () => 0,
      sleep: async () => {},
      write: (t) => written.push(t),
      apiKey: "KEYVALUE-never-printed",
      saltHex: SALT,
    }),
    (e: unknown) => e instanceof Error && /contains the key/.test(e.message) && !e.message.includes("KEYVALUE"),
  );
  assert.deepEqual(written, []);
});
