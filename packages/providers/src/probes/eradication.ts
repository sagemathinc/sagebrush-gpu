// The RunPod key-eradication probe: the provider-side driver.
//
// SEC admits RunPod only if a paid adversarial probe shows that RunPod's injected pod API key
// (RUNPOD_API_KEY) is gone from everything root in the pod can reach, before any access, on every
// restart path. The in-pod part is a separate, pinned probe agent that the unchanged production
// launcher fetches, verifies and execs (packages/machine). This driver:
//   1. launches one pod exactly as production does (RunPodAdapter: our launcher as entrypoint, no
//      ports, no SSH or Jupyter, no template or volume, env = one random boot token);
//   2. reads the probe agent's results from the container log, and scans every log line for the
//      key's variable name and key-shaped strings;
//   3. drives the restart paths (restart; stop then start) and expects a full passing check run
//      after each;
//   4. on every poll checks the pod against its launch spec (drift) and the spend against a cap;
//   5. always ends by terminating the pod and confirming it's gone.
// It never uses RunPod's exec API: exec'd processes get the container's configured environment,
// key included, which would plant the key in /proc and spoil the probe.
//
// Running it costs money: it needs William's approval, recorded as an approval reference. The
// CLI (cli.ts) is a dry run unless given --execute and that reference.

import { BOOT_TOKEN_ENV, renderBootCommand } from "@sbgpu/machine";
import { specDrift, expectedSpec } from "../drift.ts";
import { terminateAndConfirm } from "../placement.ts";
import type { LaunchSpec, ProviderAdapter, ProviderMachineStatus } from "../types.ts";

// ---------------------------------------------------------------- the probe agent's report

export const PROBE_PREFIX = "SBGPU-PROBE ";
/** The checks of one boot, in the order the probe agent runs them. */
export const PROBE_CHECKS = ["pid1", "environ", "files", "metadata", "history", "done"] as const;
export type ProbeCheck = (typeof PROBE_CHECKS)[number];

export interface ProbeLine {
  boot: number;
  check: ProbeCheck;
  pass: boolean;
  paths: string[];
  detail: string;
}

/**
 * Strings that must never appear in any raw log line, probe lines included: the key's variable
 * name (anywhere, in any field), an assignment to it, or a string shaped like a RunPod API key
 * ("rpa_" and a long token). The key formats must be confirmed from RunPod's documentation before
 * a paid admission run; a probe report that names the variable in a path is a finding, not a pass.
 */
const KEY_SHAPES = [/rpa_[A-Za-z0-9_-]{16,}/, /RUNPOD_API_KEY\s*[=:]\s*\S/];
const KEY_NAME = "RUNPOD_API_KEY";

const DETAIL = /^[a-z0-9-]{0,32}$/;

/** Parse one probe line, or null if it isn't one. A malformed probe line throws. */
export function parseProbeLine(line: string): ProbeLine | null {
  if (!line.startsWith(PROBE_PREFIX)) return null;
  let j: unknown;
  try {
    j = JSON.parse(line.slice(PROBE_PREFIX.length));
  } catch {
    throw new ProbeFormatError("a probe line is not JSON");
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) throw new ProbeFormatError("a probe line is not an object");
  const o = j as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "boot,check,detail,pass,paths,v") throw new ProbeFormatError("a probe line has unexpected fields");
  if (o["v"] !== 1) throw new ProbeFormatError("a probe line has another version");
  if (!Number.isSafeInteger(o["boot"]) || (o["boot"] as number) < 1) throw new ProbeFormatError("a probe line has a bad boot");
  if (typeof o["check"] !== "string" || !(PROBE_CHECKS as readonly string[]).includes(o["check"])) {
    throw new ProbeFormatError("a probe line has an unknown check");
  }
  if (typeof o["pass"] !== "boolean") throw new ProbeFormatError("a probe line has no pass");
  const paths = o["paths"];
  if (
    !Array.isArray(paths) ||
    paths.length > 20 ||
    !paths.every((p) => typeof p === "string" && new TextEncoder().encode(p).length <= 256)
  ) {
    throw new ProbeFormatError("a probe line has bad paths");
  }
  if (typeof o["detail"] !== "string" || !DETAIL.test(o["detail"])) throw new ProbeFormatError("a probe line has a bad detail");
  return { boot: o["boot"] as number, check: o["check"] as ProbeCheck, pass: o["pass"], paths: paths as string[], detail: o["detail"] };
}

export class ProbeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeFormatError";
  }
}

export interface StageResult {
  /** Every check ran in order, ended with done, and passed. */
  pass: boolean;
  /** Why not, in fixed words (never text from the machine). */
  failures: string[];
  /** Checks that failed, with the paths the probe reported. */
  failedChecks: Array<{ check: ProbeCheck; detail: string; paths: string[] }>;
  complete: boolean;
}

/**
 * Judge the log lines of one stage (one boot of the probe agent): container and system lines
 * since the stage began. Passes only with exactly one run of every check, in order, all passing,
 * one boot number, no other probe output and nothing key-like in any line.
 */
export function judgeStage(lines: readonly string[]): StageResult {
  const failures: string[] = [];
  const failedChecks: StageResult["failedChecks"] = [];
  const probe: ProbeLine[] = [];
  for (const line of lines) {
    // The raw line, before any parsing: a field of a valid probe line is no hiding place.
    if (KEY_SHAPES.some((re) => re.test(line))) failures.push("key-shaped-string-in-log");
    if (line.includes(KEY_NAME)) failures.push("key-name-in-log");
    let p: ProbeLine | null;
    try {
      p = parseProbeLine(line);
    } catch {
      failures.push("malformed-probe-line");
      continue;
    }
    if (p === null) continue;
    probe.push(p);
    if (!p.pass) failedChecks.push({ check: p.check, detail: p.detail, paths: p.paths });
  }
  const order = probe.map((p) => p.check).join(",");
  const complete = order === PROBE_CHECKS.join(",");
  if (!complete) failures.push(probe.length === 0 ? "no-probe-output" : "checks-incomplete-or-out-of-order");
  if (new Set(probe.map((p) => p.boot)).size > 1) failures.push("several-boots-in-one-stage");
  if (failedChecks.length > 0) failures.push("check-failed");
  return { pass: failures.length === 0, failures: [...new Set(failures)], failedChecks, complete };
}

// ---------------------------------------------------------------- the plan

/** The probe agent the production launcher fetches, verifies and execs. */
export interface ProbeAgent {
  /** https URL of the probe agent tarball. */
  agentUrl: string;
  /** Its pinned sha256, 64 lowercase hex. */
  agentSha256: string;
  /** https URL of the control plane (checked by the launcher; unused by the probe). */
  controlUrl: string;
}

/**
 * The production launcher argv for a probe agent: exactly what renderBootCommand builds in
 * container mode. There is no other way to give the driver a launcher.
 */
export function probeLauncher(agent: ProbeAgent): string[] {
  const r = renderBootCommand({ agentUrl: agent.agentUrl, agentSha256: agent.agentSha256, controlUrl: agent.controlUrl, mode: "container" });
  if (!("argv" in r)) throw new RangeError("renderBootCommand gave no argv for container mode");
  return r.argv;
}

/** Lowercase hex SHA-256 of the launcher argv, as JSON: the report's record of what ran. */
export async function launcherSha256(argv: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(argv));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ProbePlan {
  /** Who approved the spend, and where (e.g. a message reference). Required to execute. */
  approval: string;
  /** The probe agent; the launch's launcher must be probeLauncher(agent), byte for byte. */
  agent: ProbeAgent;
  /** The production launch. */
  spec: LaunchSpec;
  /** Hard cap on the estimated spend, in micro-USD. At most $10. */
  maxSpendMicros: number;
  /** Hard cap on the pod's lifetime, in minutes. At most 120. */
  maxMinutes: number;
  /** How long to wait for one stage's "done", in minutes. At most 30. */
  stageMinutes: number;
  /** Between polls, in seconds: 10 to 120. */
  pollSeconds: number;
}

export const MAX_PROBE_SPEND_MICROS = 10_000_000;

function intIn(name: string, x: number, lo: number, hi: number): void {
  if (!Number.isSafeInteger(x) || x < lo || x > hi) throw new RangeError(`${name} must be an integer in [${lo}, ${hi}], got ${x}`);
}

export function checkPlan(plan: ProbePlan): void {
  if (typeof plan.approval !== "string" || plan.approval.trim().length < 8) {
    throw new RangeError("an approval reference is required");
  }
  intIn("maxSpendMicros", plan.maxSpendMicros, 1, MAX_PROBE_SPEND_MICROS);
  intIn("maxMinutes", plan.maxMinutes, 5, 120);
  intIn("stageMinutes", plan.stageMinutes, 1, 30);
  intIn("pollSeconds", plan.pollSeconds, 10, 120);
  if (plan.stageMinutes * STAGES.length > plan.maxMinutes) throw new RangeError("maxMinutes is shorter than the stages need");
  if (!/^[A-Za-z0-9_-]{43}$/.test(plan.spec.bootToken)) throw new RangeError("the boot token must be 43 base64url characters");
  // The launcher is the production one for this probe agent, or nothing runs.
  const expected = probeLauncher(plan.agent);
  if (plan.spec.launcher.length !== expected.length || plan.spec.launcher.some((a, i) => a !== expected[i])) {
    throw new RangeError("the launcher is not the production launcher for this probe agent");
  }
  if (plan.spec.maxProviderCostPerHour * (plan.maxMinutes / 60) > plan.maxSpendMicros * 4) {
    throw new RangeError("the rate cap is far above what the spend cap allows");
  }
}

// ---------------------------------------------------------------- the driver

/** What the driver needs from the provider, beyond the adapter. */
export interface ProbeProviderApi {
  /** POST /v2/pods/{id}/action. */
  action(providerMachineId: string, action: "restart" | "stop" | "start"): Promise<void>;
  /** Container and system log lines since `since` (ISO), oldest first. */
  logs(providerMachineId: string, since: string): Promise<string[]>;
}

export interface ProbeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const STAGES = ["first-boot", "after-restart", "after-stop-start"] as const;
export type Stage = (typeof STAGES)[number];

export type ProbeOutcome = "pass" | "fail" | "aborted";

export interface ProbeReport {
  outcome: ProbeOutcome;
  approval: string;
  /** What ran: the probe agent's URL and pin, and the hash of the complete launcher argv. */
  agentUrl: string;
  agentSha256: string;
  launcherSha256: string;
  providerMachineId: string | null;
  stages: Array<{ stage: Stage; result: StageResult | null }>;
  /** Fixed words, e.g. "spend-cap", "lifetime", "drift:image", "launch-failed". */
  aborts: string[];
  /** Upper bound: the pod's rate times its whole lifetime, stopped time included. */
  estimatedSpendMicros: number;
  terminatedConfirmed: boolean;
}

/**
 * Run the probe. Always terminates the pod and confirms it's gone before returning; if that
 * can't be confirmed, terminatedConfirmed is false and a human must act. Never throws once a pod
 * may exist: every failure becomes an abort in the report.
 */
export async function runEradicationProbe(
  plan: ProbePlan,
  adapter: ProviderAdapter,
  api: ProbeProviderApi,
  clock: ProbeClock,
): Promise<ProbeReport> {
  checkPlan(plan);
  if (adapter.info.bootTokenEnv !== BOOT_TOKEN_ENV) throw new RangeError("the adapter's boot token variable isn't the launcher's");
  const report: ProbeReport = {
    outcome: "aborted",
    approval: plan.approval,
    agentUrl: plan.agent.agentUrl,
    agentSha256: plan.agent.agentSha256,
    launcherSha256: await launcherSha256(plan.spec.launcher),
    providerMachineId: null,
    stages: STAGES.map((stage) => ({ stage, result: null })),
    aborts: [],
    estimatedSpendMicros: 0,
    terminatedConfirmed: true,
  };
  const t0 = clock.now();
  let rate = plan.spec.maxProviderCostPerHour;
  const spend = () => Math.ceil((rate * (clock.now() - t0)) / 3_600_000);

  let id: string;
  try {
    const launched = await adapter.launch(plan.spec);
    id = launched.providerMachineId;
    rate = Math.max(rate, launched.status.providerCostPerHour ?? rate);
  } catch (e) {
    // A failed launch may still have left a pod (the adapter reports its id): clean it up.
    const left = typeof e === "object" && e !== null && "providerMachineId" in e ? (e as { providerMachineId: unknown }).providerMachineId : null;
    report.aborts.push("launch-failed");
    if (typeof left === "string") {
      report.providerMachineId = left;
      report.terminatedConfirmed = await terminateAndConfirm(adapter, left, clock.sleep, 10, 3000);
    }
    report.estimatedSpendMicros = spend();
    return report;
  }
  report.providerMachineId = id;
  const expected = expectedSpec(plan.spec, adapter.info, id);

  /** One poll: drift, spend and lifetime. Returns an abort word, or null. */
  const guard = async (): Promise<string | null> => {
    if (clock.now() - t0 > plan.maxMinutes * 60_000) return "lifetime";
    // One more poll interval must still fit under the cap.
    if (Math.ceil((rate * (clock.now() - t0 + plan.pollSeconds * 1000)) / 3_600_000) > plan.maxSpendMicros) return "spend-cap";
    let s: ProviderMachineStatus;
    try {
      s = await adapter.status(id);
    } catch {
      return "status-unreadable";
    }
    if (s.providerCostPerHour !== null) rate = Math.max(rate, s.providerCostPerHour);
    const drift = specDrift(expected, s).filter((d) => !(d.field === "dataCenter" && s.dataCenter === null));
    if (drift.length > 0) return `drift:${drift[0]!.field}`;
    return null;
  };

  /** Wait for one stage's probe run to finish; judge it. */
  const stage = async (index: number, since: string): Promise<boolean> => {
    const deadline = clock.now() + plan.stageMinutes * 60_000;
    for (;;) {
      const abort = await guard();
      if (abort !== null) {
        report.aborts.push(abort);
        return false;
      }
      let lines: string[];
      try {
        lines = await api.logs(id, since);
      } catch {
        report.aborts.push("logs-unreadable");
        return false;
      }
      const result = judgeStage(lines);
      if (result.complete || result.failures.some((f) => f !== "checks-incomplete-or-out-of-order" && f !== "no-probe-output")) {
        report.stages[index]!.result = result;
        return result.pass;
      }
      if (clock.now() >= deadline) {
        report.stages[index]!.result = result;
        report.aborts.push("stage-timeout");
        return false;
      }
      await clock.sleep(plan.pollSeconds * 1000);
    }
  };

  /** Wait until the pod reports `state` (bounded by the stage time). */
  const waitState = async (state: ProviderMachineStatus["state"], rawStatus?: string): Promise<boolean> => {
    const deadline = clock.now() + plan.stageMinutes * 60_000;
    for (;;) {
      try {
        const s = await adapter.status(id);
        if (s.state === state && (rawStatus === undefined || s.rawStatus === rawStatus)) return true;
      } catch {
        report.aborts.push("status-unreadable");
        return false;
      }
      if (clock.now() >= deadline) {
        report.aborts.push("state-timeout");
        return false;
      }
      await clock.sleep(plan.pollSeconds * 1000);
    }
  };

  const iso = () => new Date(clock.now()).toISOString();
  try {
    let ok = await stage(0, new Date(t0).toISOString());
    if (ok) {
      const since = iso();
      await api.action(id, "restart");
      ok = await stage(1, since);
    }
    if (ok) {
      await api.action(id, "stop");
      ok = await waitState("failed", "EXITED");
      if (ok) {
        const since = iso();
        await api.action(id, "start");
        ok = await stage(2, since);
      }
    }
  } catch {
    report.aborts.push("driver-error");
    report.outcome = "aborted";
  } finally {
    report.terminatedConfirmed = await terminateAndConfirm(adapter, id, clock.sleep, 10, 3000);
    report.estimatedSpendMicros = spend();
  }
  report.outcome = outcomeOf(report);
  return report;
}

/**
 * "fail" if any stage's checks failed (the probe found something); "pass" only if every stage
 * passed, nothing aborted and the pod is confirmed gone; otherwise "aborted" (inconclusive).
 */
export function outcomeOf(r: Pick<ProbeReport, "stages" | "aborts" | "terminatedConfirmed">): ProbeOutcome {
  if (r.stages.some((s) => s.result !== null && !s.result.pass && s.result.complete)) return "fail";
  if (r.stages.some((s) => s.result !== null && s.result.failures.some((f) => f.startsWith("key-") || f === "check-failed"))) {
    return "fail";
  }
  if (r.stages.every((s) => s.result?.pass === true) && r.aborts.length === 0 && r.terminatedConfirmed) return "pass";
  return "aborted";
}

// ---------------------------------------------------------------- RunPod log reading

/** The `data` lines of an SSE body, as RunPod's log endpoint sends them: {source, line, ts}. */
export function parseLogSse(body: string): string[] {
  const out: string[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    let j: unknown;
    try {
      j = JSON.parse(data);
    } catch {
      throw new ProbeFormatError("a log event is not JSON");
    }
    if (typeof j !== "object" || j === null || typeof (j as { line?: unknown }).line !== "string") {
      throw new ProbeFormatError("a log event has no line");
    }
    out.push((j as { line: string }).line);
  }
  return out;
}
