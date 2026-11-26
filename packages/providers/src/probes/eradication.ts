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

import { BOOT_TOKEN_ENV, renderBootScript, renderProbePrologue } from "@sbgpu/machine";
import { isDriftMarker, specDrift, expectedSpec, type CommandShape, type FieldShape } from "../drift.ts";
import { ProviderError, type ProviderErrorKind } from "../errors.ts";
import { terminateAndConfirm } from "../placement.ts";
import type { LaunchSpec, ProviderAdapter, ProviderMachineStatus } from "../types.ts";

// ---------------------------------------------------------------- the probe agent's report

export const PROBE_PREFIX = "SBGPU-PROBE ";
/**
 * The checks of one boot, in the order the probe agent runs them. The two port-22 checks (SEC,
 * Nov 24) bracket the rest: no TCP listener on port 22, IPv4 or IPv6, at the start of every boot
 * and again just before done.
 */
export const PROBE_CHECKS = [
  "listen22-start", "pid1", "environ", "files", "metadata", "history", "listen22-end", "done",
] as const;
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
  /**
   * The injected key's shape, as the probe's pid1 check reports it (e.g. "v44-rpa-dlsu":
   * byte length, prefix or "none", character classes), or null if pid1 didn't pass.
   */
  shape: string | null;
}

/** pid1's paths carry the capture's salted digest as one "digest:<64 hex>" entry. */
const DIGEST_PATH = /^digest:([0-9a-f]{64})$/;
/**
 * A passing pid1's detail is the key's shape, v<bytes>-<prefix>-<classes>, exactly as the prologue and
 * the probe's capture.shape() can write it:
 * - bytes: 16..4096, in decimal without leading zeros;
 * - classes: a non-empty subset of d h l o s u, in that order;
 * - prefix: "none", or 1-8 ASCII alphanumerics that ended in "_" with at least 16 bytes after it,
 *   written as itself when lowercase alphanumeric and as p<length> otherwise (so it has an uppercase
 *   letter). A prefix needs "s" in the classes and fits in the length, and a literal prefix's letters
 *   and digits need "l" and "d"; "p3" is valid if either reading is.
 */
const SHAPE = /^v([1-9][0-9]{1,3})-([a-z0-9]{1,8})-(d?h?l?o?s?u?)$/;

export function validShape(detail: string): boolean {
  const m = SHAPE.exec(detail);
  if (m === null) return false;
  const bytes = Number(m[1]);
  const [prefix, classes] = [m[2]!, m[3]!];
  if (bytes < 16 || bytes > 4096 || classes === "") return false;
  if (prefix === "none") return true;
  const fits = (len: number) => classes.includes("s") && bytes >= len + 1 + 16;
  const literal =
    fits(prefix.length) && (!/[a-z]/.test(prefix) || classes.includes("l")) && (!/[0-9]/.test(prefix) || classes.includes("d"));
  const byLength = /^p[1-8]$/.test(prefix) && fits(Number(prefix.slice(1))) && classes.includes("u");
  return literal || byLength;
}

/**
 * Judge the log lines of one stage (one boot of the probe agent): container and system lines
 * since the stage began. Passes only with exactly one run of every check, in order, all passing,
 * one boot number, no other probe output and nothing key-like in any line.
 */
export function judgeStage(lines: readonly string[]): StageResult {
  return judgeStageWithDigest(lines).result;
}

/**
 * judgeStage, and the capture's salted digest from pid1 (null unless the stage passed). The
 * digest is for comparing stages inside the driver only: it never goes into the report, and it is
 * stripped from every reported path.
 */
export function judgeStageWithDigest(lines: readonly string[]): { result: StageResult; digest: string | null } {
  const failures: string[] = [];
  let digest: string | null = null;
  let shape: string | null = null;
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
    // ... and the decoded fields too: JSON escapes ("\u0052UNPOD...") hide from the raw scan.
    for (const field of [...p.paths, p.detail]) {
      if (KEY_SHAPES.some((re) => re.test(field))) failures.push("key-shaped-string-in-log");
      if (field.includes(KEY_NAME)) failures.push("key-name-in-log");
    }
    probe.push(p);
    if (p.check === "listen22-start" || p.check === "listen22-end") {
      // Only the three fixed outcomes, no paths, and a pass that agrees with its detail.
      const ok = p.paths.length === 0 && (p.pass ? p.detail === "no-listener" : p.detail === "listener" || p.detail === "unreadable");
      if (!ok) failures.push("bad-listen22-report");
    }
    if (p.check === "pid1" && p.pass) {
      // A passing pid1 must carry exactly the shape and one digest, nothing else.
      const m = p.paths.length === 1 ? DIGEST_PATH.exec(p.paths[0]!) : null;
      if (m === null || !validShape(p.detail)) failures.push("bad-capture-report");
      else {
        digest = m[1]!;
        shape = p.detail;
      }
    }
    if (!p.pass) failedChecks.push({ check: p.check, detail: p.detail, paths: p.paths.filter((x) => !x.startsWith("digest:")) });
  }
  const order = probe.map((p) => p.check).join(",");
  const complete = order === PROBE_CHECKS.join(",");
  if (!complete) failures.push(probe.length === 0 ? "no-probe-output" : "checks-incomplete-or-out-of-order");
  if (new Set(probe.map((p) => p.boot)).size > 1) failures.push("several-boots-in-one-stage");
  if (failedChecks.length > 0) failures.push("check-failed");
  const result = { pass: failures.length === 0, failures: [...new Set(failures)], failedChecks, complete, shape };
  return { result, digest: result.pass ? digest : null };
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

export const SALT_HEX = /^[0-9a-f]{64}$/;

/**
 * The probe's launcher argv: the probe-only prologue (it captures the injected key's salted
 * digest and shape) followed by the unchanged production launcher script for the probe agent,
 * run by /bin/sh as PID 1. Built only from these typed values; there is no other way to give the
 * driver a launcher.
 */
export function probeLauncher(agent: ProbeAgent, saltHex: string): string[] {
  if (!SALT_HEX.test(saltHex)) throw new RangeError("the salt must be 64 lowercase hex");
  const script = renderBootScript({ agentUrl: agent.agentUrl, agentSha256: agent.agentSha256, controlUrl: agent.controlUrl, mode: "container" });
  return ["/bin/sh", "-c", renderProbePrologue(saltHex) + script];
}

/** `text` with every occurrence of the salt replaced: for anything printed. */
export function maskSalt(text: string, saltHex: string): string {
  return SALT_HEX.test(saltHex) ? text.split(saltHex).join("<salt>") : text;
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
  /** The probe agent; the launch's launcher must be probeLauncher(agent, saltHex), byte for byte. */
  agent: ProbeAgent;
  /** This run's salt: 32 random bytes as 64 lowercase hex. Never printed or reported. */
  saltHex: string;
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

/**
 * Every provider call is bounded by a 30 s timeout (RunPodAdapter's default, and the CLI's log
 * and action calls). The driver keeps this much time in reserve at every step: one call in flight,
 * plus the whole cleanup (a terminate and CONFIRM_POLLS status reads, with sleeps between them).
 */
export const CALL_TIMEOUT_MS = 30_000;
export const CONFIRM_POLLS = 10;
export const CONFIRM_INTERVAL_MS = 3000;
export const CLEANUP_RESERVE_MS = CALL_TIMEOUT_MS * (1 + CONFIRM_POLLS) + CONFIRM_INTERVAL_MS * (CONFIRM_POLLS - 1);
export const RESERVE_MS = CALL_TIMEOUT_MS + CLEANUP_RESERVE_MS;

function intIn(name: string, x: number, lo: number, hi: number): void {
  if (!Number.isSafeInteger(x) || x < lo || x > hi) throw new RangeError(`${name} must be an integer in [${lo}, ${hi}], got ${x}`);
}

/** Micro-USD for `ms` at `rate` micro-USD per hour, rounded up. */
function costFor(rate: number, ms: number): number {
  return Math.ceil((rate * ms) / 3_600_000);
}

export function checkPlan(plan: ProbePlan): void {
  if (typeof plan.approval !== "string" || plan.approval.trim().length < 8) {
    throw new RangeError("an approval reference is required");
  }
  intIn("maxSpendMicros", plan.maxSpendMicros, 1, MAX_PROBE_SPEND_MICROS);
  intIn("maxMinutes", plan.maxMinutes, 5, 120);
  intIn("stageMinutes", plan.stageMinutes, 1, 30);
  intIn("pollSeconds", plan.pollSeconds, 10, 120);
  if (plan.stageMinutes * STAGES.length * 60_000 + RESERVE_MS > plan.maxMinutes * 60_000) {
    throw new RangeError("maxMinutes is shorter than the stages and the cleanup reserve need");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(plan.spec.bootToken)) throw new RangeError("the boot token must be 43 base64url characters");
  // The launcher is the production one for this probe agent, or nothing runs.
  const expected = probeLauncher(plan.agent, plan.saltHex);
  if (plan.spec.launcher.length !== expected.length || plan.spec.launcher.some((a, i) => a !== expected[i])) {
    throw new RangeError("the launcher is not the production launcher for this probe agent");
  }
  if (plan.spec.maxProviderCostPerHour * (plan.maxMinutes / 60) > plan.maxSpendMicros * 4) {
    throw new RangeError("the rate cap is far above what the spend cap allows");
  }
  // Launching at all must leave room for the launch call and a full cleanup.
  if (costFor(plan.spec.maxProviderCostPerHour, RESERVE_MS + plan.pollSeconds * 1000) > plan.maxSpendMicros) {
    throw new RangeError("the spend cap doesn't cover the launch and cleanup reserve at the rate cap");
  }
}

// ---------------------------------------------------------------- the driver

/** What the driver needs from the provider, beyond the adapter. Each call times out in 30 s. */
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
  /** The injected key's shape seen at the first boot (e.g. "v44-rpa-dlsu"), or null. */
  observedShape: string | null;
  /**
   * Every stage reported the same shape and the same salted digest (compared inside the driver;
   * the digest itself is never reported). null unless all three stages passed.
   */
  captureConsistent: boolean | null;
  /** Fixed words, e.g. "spend-cap", "lifetime", "drift:image", "launch-failed". */
  aborts: string[];
  /** Upper bound: the highest rate seen times the pod's whole lifetime, stopped time included. */
  estimatedSpendMicros: number;
  /** estimatedSpendMicros is at most the plan's cap. */
  withinCap: boolean;
  terminatedConfirmed: boolean;
  /**
   * null when no pod exists or it is confirmed gone. Otherwise the driver can't bound the spend:
   * a pod may keep billing at this rate (micro-USD per hour) until a human finds and terminates
   * it. providerMachineId is null when a launch's outcome is unknown: the pod, if any, carries
   * machineName.
   */
  exposure: { providerMachineId: string | null; machineName: string; ratePerHour: number } | null;
  /**
   * Why the launch failed, as our own fixed words: the ProviderError's kind and HTTP status, or
   * "driver-error" for anything else. Never the provider's text. null when the launch succeeded.
   */
  launchError: {
    kind: ProviderErrorKind | "driver-error";
    httpStatus: number | null;
    drift: string[] | null;
    commandShape: CommandShape | null;
  } | null;
}

/**
 * Drift markers fit for the report: of the first 32 entries (the cap comes before any check), only
 * markers driftMarkers can produce; everything else is dropped.
 */
export function reportableDrift(drift: readonly unknown[] | null): string[] | null {
  try {
    if (!Array.isArray(drift)) return null;
    // slice reads each of the first 32 entries once; the filter then sees only those values.
    return drift.slice(0, 32).filter((m): m is string => isDriftMarker(m));
  } catch {
    // A throwing getter or proxy: nothing to report.
    return null;
  }
}

const FIELD_KINDS: ReadonlySet<string> = new Set(["absent", "null", "string", "array", "object", "number", "boolean"]);
const SHAPE_NUMBER_MAX = 1_000_000;

/** A count fit for the report: a whole number from 0 to a million, else null. */
function count(x: unknown): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= SHAPE_NUMBER_MAX ? x : null;
}

// The boundary reads every property exactly once into a local and checks and uses only that
// local: a getter can't pass a check and then hand over something else.

function fieldShapeOf(x: unknown): FieldShape | null {
  if (typeof x !== "object" || x === null) return null;
  const r = x as Record<string, unknown>;
  const kind = r["kind"];
  const length = r["length"];
  if (typeof kind !== "string" || !FIELD_KINDS.has(kind)) return null;
  return { kind: kind as FieldShape["kind"], length: count(length) };
}

/**
 * A command shape fit for the report, rebuilt field by field from fixed kinds, counts and
 * booleans (at most 8 items); anything else, a throwing getter or proxy included, makes it null.
 * Never text.
 */
export function reportableCommandShape(shape: unknown): CommandShape | null {
  try {
    if (typeof shape !== "object" || shape === null) return null;
    const s = shape as Record<string, unknown>;
    const ep = s["entrypoint"];
    const c = s["cmd"];
    const items = s["entrypointItems"];
    const whole = s["entrypointMatches"];
    const entrypoint = fieldShapeOf(ep);
    const cmd = fieldShapeOf(c);
    if (entrypoint === null || cmd === null) return null;
    if (typeof whole !== "boolean" || !Array.isArray(items)) return null;
    const n: unknown = items.length;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 8) return null;
    const entrypointItems: CommandShape["entrypointItems"] = [];
    for (let i = 0; i < n; i++) {
      const it: unknown = items[i];
      if (typeof it !== "object" || it === null) return null;
      const r = it as Record<string, unknown>;
      const length = r["length"];
      const matches = r["matches"];
      const prefix = count(r["commonPrefix"]);
      if (typeof matches !== "boolean" || prefix === null) return null;
      entrypointItems.push({ length: count(length), matches, commonPrefix: prefix });
    }
    return { entrypoint, cmd, entrypointItems, entrypointMatches: whole };
  } catch {
    return null;
  }
}

const LAUNCH_ERROR_KINDS: ReadonlySet<string> = new Set([
  "no_capacity", "unplaceable", "forbidden", "price_above_cap", "spec_mismatch", "rate_limited", "transient",
  "invalid_request", "insufficient_funds", "auth", "not_found", "outcome_unknown", "unknown",
]);

/**
 * What a failed launch tells the driver: the pod it left behind (to clean up), whether a pod may
 * exist that nobody can name (outcome unknown), and the report's launchError. It never throws,
 * and it secures the pod id before touching anything else: the kind comes next, and the
 * diagnostics (status, drift, command shape) last, each read once in its own try, so an
 * unreadable diagnostic can only lose itself, never the cleanup. Anything that isn't a
 * ProviderError with a known kind is a driver error whose outcome is unknown (exposure).
 */
export function launchFailure(e: unknown): {
  left: string | null;
  outcomeUnknown: boolean;
  launchError: NonNullable<ProbeReport["launchError"]>;
} {
  const driverError = { kind: "driver-error" as const, httpStatus: null, drift: null, commandShape: null };
  let left: string | null = null;
  let err: ProviderError;
  try {
    if (!(e instanceof ProviderError)) return { left: null, outcomeUnknown: true, launchError: driverError };
    err = e;
    const id: unknown = err.providerMachineId;
    left = typeof id === "string" && id !== "" ? id : null;
  } catch {
    return { left: null, outcomeUnknown: true, launchError: driverError };
  }
  let kind: unknown;
  try {
    kind = err.kind;
  } catch {
    return { left, outcomeUnknown: true, launchError: driverError };
  }
  if (typeof kind !== "string" || !LAUNCH_ERROR_KINDS.has(kind)) return { left, outcomeUnknown: true, launchError: driverError };
  const read = (get: () => unknown): unknown => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  const status = read(() => err.httpStatus);
  const drift = read(() => err.drift);
  const shape = read(() => err.commandShape);
  return {
    left,
    outcomeUnknown: kind === "outcome_unknown",
    launchError: {
      kind: kind as ProviderErrorKind,
      httpStatus: typeof status === "number" && Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
      drift: reportableDrift(drift as unknown[] | null),
      commandShape: reportableCommandShape(shape),
    },
  };
}

/**
 * Run the probe. Always terminates the pod and confirms it's gone before returning; if that
 * can't be confirmed, the report says so (exposure) and a human must act. Never throws once a
 * pod may exist: every failure becomes an abort in the report.
 *
 * The plan is copied first; only the copy is checked and used, so changing the
 * caller's plan while the probe runs changes nothing.
 */
export async function runEradicationProbe(
  input: ProbePlan,
  adapter: ProviderAdapter,
  api: ProbeProviderApi,
  clock: ProbeClock,
): Promise<ProbeReport> {
  const plan: ProbePlan = structuredClone(input);
  checkPlan(plan);
  const delivery = adapter.info.bootDelivery;
  if (delivery.kind !== "env" || delivery.name !== BOOT_TOKEN_ENV) throw new RangeError("the adapter's boot token variable isn't the launcher's");
  const report: ProbeReport = {
    outcome: "aborted",
    approval: plan.approval,
    agentUrl: plan.agent.agentUrl,
    agentSha256: plan.agent.agentSha256,
    launcherSha256: await launcherSha256(plan.spec.launcher),
    providerMachineId: null,
    stages: STAGES.map((stage) => ({ stage, result: null })),
    observedShape: null,
    captureConsistent: null,
    aborts: [],
    estimatedSpendMicros: 0,
    withinCap: true,
    terminatedConfirmed: true,
    exposure: null,
    launchError: null,
  };
  // Each stage's capture digest, compared across stages here and never reported.
  const digests: Array<string | null> = STAGES.map(() => null);
  const t0 = clock.now();
  let rate = plan.spec.maxProviderCostPerHour;
  const spend = () => costFor(rate, clock.now() - t0);

  /**
   * Whether `extraMs` more (a sleep), one call in flight and a full cleanup still fit the
   * lifetime and the spend cap. Returns an abort word, or null.
   */
  const fits = (extraMs: number): string | null => {
    const after = clock.now() - t0 + extraMs + RESERVE_MS;
    if (after > plan.maxMinutes * 60_000) return "lifetime";
    if (costFor(rate, after) > plan.maxSpendMicros) return "spend-cap";
    return null;
  };

  const finish = async (id: string | null): Promise<ProbeReport> => {
    if (id !== null) {
      report.terminatedConfirmed = await terminateAndConfirm(adapter, id, clock.sleep, CONFIRM_POLLS, CONFIRM_INTERVAL_MS);
      if (!report.terminatedConfirmed) {
        report.exposure = { providerMachineId: id, machineName: plan.spec.name, ratePerHour: rate };
      }
    }
    report.estimatedSpendMicros = spend();
    report.withinCap = report.estimatedSpendMicros <= plan.maxSpendMicros;
    report.outcome = outcomeOf(report);
    return report;
  };

  let id: string;
  try {
    // The whole launch, recovery after a lost response included, stops when the budget can no
    // longer hold one more call and the cleanup.
    const launched = await adapter.launch(plan.spec, { shouldStop: () => fits(0) !== null });
    id = launched.providerMachineId;
    rate = Math.max(rate, launched.status.providerCostPerHour ?? rate);
  } catch (e) {
    report.aborts.push("launch-failed");
    const { left, outcomeUnknown, launchError } = launchFailure(e);
    report.launchError = launchError;
    // A failed launch may still have left a pod. With its id: clean it up.
    if (left !== null) {
      report.providerMachineId = left;
      return finish(left);
    }
    // Without one, if the create request may have gone through (a lost response, a search
    // that didn't finish, anything unexpected), a pod may exist that we can't name: say so.
    if (outcomeUnknown) {
      report.terminatedConfirmed = false;
      report.exposure = { providerMachineId: null, machineName: plan.spec.name, ratePerHour: rate };
    }
    return finish(null);
  }
  report.providerMachineId = id;
  const expected = expectedSpec(plan.spec, adapter.info, id);

  /** Before any call: the budget, then a status read with the drift check. */
  const guard = async (): Promise<{ abort: string | null; status: ProviderMachineStatus | null }> => {
    const over = fits(0);
    if (over !== null) return { abort: over, status: null };
    let s: ProviderMachineStatus;
    try {
      s = await adapter.status(id);
    } catch {
      return { abort: "status-unreadable", status: null };
    }
    if (s.providerCostPerHour !== null) rate = Math.max(rate, s.providerCostPerHour);
    const drift = specDrift(expected, s).filter((d) => !(d.field === "dataCenter" && s.dataCenter === null));
    if (drift.length > 0) return { abort: `drift:${drift[0]!.field}`, status: s };
    // The status call itself took time (up to a call timeout): check the budget again.
    return { abort: fits(0), status: s };
  };

  /** Sleep one poll interval, if the budget allows it. */
  const pause = async (): Promise<boolean> => {
    const over = fits(plan.pollSeconds * 1000);
    if (over !== null) {
      report.aborts.push(over);
      return false;
    }
    await clock.sleep(plan.pollSeconds * 1000);
    return true;
  };

  /** Run a provider action, only within budget and with no drift. */
  const act = async (action: "restart" | "stop" | "start"): Promise<boolean> => {
    const g = await guard();
    if (g.abort !== null) {
      report.aborts.push(g.abort);
      return false;
    }
    await api.action(id, action);
    return true;
  };

  /** Wait for one stage's probe run to finish; judge it. */
  const stage = async (index: number, since: string): Promise<boolean> => {
    const deadline = clock.now() + plan.stageMinutes * 60_000;
    for (;;) {
      const g = await guard();
      if (g.abort !== null) {
        report.aborts.push(g.abort);
        return false;
      }
      let lines: string[];
      try {
        lines = await api.logs(id, since);
      } catch {
        report.aborts.push("logs-unreadable");
        return false;
      }
      const { result, digest } = judgeStageWithDigest(lines);
      digests[index] = digest;
      if (result.complete || result.failures.some((f) => f !== "checks-incomplete-or-out-of-order" && f !== "no-probe-output")) {
        report.stages[index]!.result = result;
        return result.pass;
      }
      if (clock.now() >= deadline) {
        report.stages[index]!.result = result;
        report.aborts.push("stage-timeout");
        return false;
      }
      if (!(await pause())) {
        report.stages[index]!.result = result;
        return false;
      }
    }
  };

  /** Wait until the pod reports `state`, under the same guard (bounded by the stage time). */
  const waitState = async (state: ProviderMachineStatus["state"], rawStatus: string): Promise<boolean> => {
    const deadline = clock.now() + plan.stageMinutes * 60_000;
    for (;;) {
      const g = await guard();
      if (g.abort !== null) {
        report.aborts.push(g.abort);
        return false;
      }
      if (g.status !== null && g.status.state === state && g.status.rawStatus === rawStatus) return true;
      if (clock.now() >= deadline) {
        report.aborts.push("state-timeout");
        return false;
      }
      if (!(await pause())) return false;
    }
  };

  const iso = () => new Date(clock.now()).toISOString();
  try {
    let ok = await stage(0, new Date(t0).toISOString());
    if (ok) {
      const since = iso();
      ok = (await act("restart")) && (await stage(1, since));
    }
    if (ok) {
      ok = (await act("stop")) && (await waitState("failed", "EXITED"));
      if (ok) {
        const since = iso();
        ok = (await act("start")) && (await stage(2, since));
      }
    }
  } catch {
    report.aborts.push("driver-error");
  }
  report.observedShape = report.stages[0]!.result?.shape ?? null;
  if (report.stages.every((s) => s.result?.pass === true)) {
    const shapes = report.stages.map((s) => s.result!.shape);
    report.captureConsistent =
      digests.every((d) => d !== null && d === digests[0]) && shapes.every((x) => x !== null && x === shapes[0]);
    if (!report.captureConsistent) report.aborts.push("capture-inconsistent");
  }
  return finish(id);
}

/**
 * "fail" if any stage's checks failed (the probe found something); "pass" only if every stage
 * passed, nothing aborted and the pod is confirmed gone; otherwise "aborted" (inconclusive).
 */
export function outcomeOf(
  r: Pick<ProbeReport, "stages" | "aborts" | "terminatedConfirmed"> & { captureConsistent?: boolean | null },
): ProbeOutcome {
  if (r.stages.some((s) => s.result !== null && !s.result.pass && s.result.complete)) return "fail";
  if (r.stages.some((s) => s.result !== null && s.result.failures.some((f) => f.startsWith("key-") || f === "check-failed"))) {
    return "fail";
  }
  if (
    r.stages.every((s) => s.result?.pass === true) &&
    r.aborts.length === 0 &&
    r.terminatedConfirmed &&
    (r.captureConsistent === undefined || r.captureConsistent === true)
  ) {
    return "pass";
  }
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
