// Enroll: a machine's boot token, exchanged once for its first agent token. VM mode (design r3,
// SEC clear): the token was issued at the announce. Container mode (the container-launch design
// r2.1, step 5, SEC clear): the token was made at the intent, and its window opens when control
// first sees the pod running. Every request ends one of three ways:
// - refused: one fixed 403, and nothing changes (the token stays usable while it's valid);
// - a definitive failure: one batch first uses the token and marks the launch to terminate
//   (a second use of a real token, a failing gate report, provider facts that disagree, a
//   signing failure after the commit), and only then is the provider called. Still the 403;
// - enrolled: one guarded batch commits (all or nothing), then the token is signed.
// The checks, in order: the signer ready (before anything else); the shape; a used token
// (a second use); the window and the launch's state; the request's claims and the gate
// report; a fresh provider read. Eligibility is bound again at the commit. Container mode has
// the eradication report in place of the gate's, and its fresh read comes before the window: a
// token still pending (no window yet) gets it from that read, when the pod is seen running.

import { AGENT_ERADICATION_CHECKS, DEFAULT_POLICY, isBootTokenShape, mergePolicy, parseGateReport, signToken, toIso, type AgentClaims, type AgentEnrollResponse, type ProjectPolicy, type VmGateReport } from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import type { Stmt } from "./db.ts";
import { HEARTBEAT_LOST_MS } from "./heartbeat.ts";
import { HttpError, base64url, json, sha256Hex } from "./http.ts";
import { terminateAttempt, withDeadline, type InstanceFacts, type JobEnv } from "./vm.ts";
import { containerRow, observeContainer, stopMachineStmt, terminateContainerAttempt, type ContainerEnv } from "./container.ts";

export const ENROLL_MAX_BODY_BYTES = 4096;
export const HEARTBEAT_SECONDS = 30;
/** Below this GPU use (percent) a machine counts as idle. */
export const IDLE_GPU_UTIL_PCT = 5;
const AGENT_TOKEN_TTL_S = 3600;

type EnrollFailure = "second-enroll" | "gate-failed" | "provider-facts" | "sign-failed" | "eradication-failed";

const REFUSED = () => new HttpError("forbidden", "refused");

const PRINTABLE = /^[\x21-\x7e]{1,64}$/;
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/;

/** Equal strings, compared without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function isInt(x: unknown, lo: number, hi: number): x is number {
  return Number.isSafeInteger(x) && (x as number) >= lo && (x as number) <= hi;
}

/** The fields both modes share, in their exact shapes: the agent's hash, version, hostname and GPU line. */
function commonShape(b: Record<string, unknown>): true | null {
  // (the hash is compared with the launch's own, so its form needs no check here)
  if (typeof b.agentSha256 !== "string") return null;
  if (typeof b.agentVersion !== "string" || !PRINTABLE.test(b.agentVersion)) return null;
  if (typeof b.hostname !== "string" || !HOSTNAME.test(b.hostname)) return null;
  if (b.gpu !== null) {
    const g = b.gpu as Record<string, unknown>;
    if (typeof g !== "object" || Array.isArray(g) || Object.keys(g).sort().join(",") !== "count,memoryMiB,name") return null;
    if (typeof g.name !== "string" || !/^[\x20-\x7e]{1,64}$/.test(g.name) || !isInt(g.count, 1, 64) || !isInt(g.memoryMiB, 0, 4 * 1024 * 1024)) return null;
  }
  return true;
}

interface VmEnroll {
  bootToken: string;
  agentSha256: string;
  gate: VmGateReport;
}

/** A VM enroll request in its exact shape, else null (the fixed refusal). */
function parseVmEnroll(b: Record<string, unknown>): VmEnroll | null {
  const keys = Object.keys(b).sort();
  // (no providerMachineId: a VM can't know it, and the token's launch has it)
  const base = ["agentSha256", "agentVersion", "bootToken", "gate", "gpu", "hostname", "mode"];
  const withEradication = [...base, "eradication"].sort();
  if (keys.join(",") !== base.join(",") && keys.join(",") !== withEradication.join(",")) return null;
  if (b.mode !== "vm" || !isBootTokenShape(b.bootToken)) return null;
  if (!commonShape(b)) return null;
  // (eradication is container mode's; in VM mode it may only be the empty, passing report)
  if ("eradication" in b) {
    const e = b.eradication as Record<string, unknown>;
    if (typeof e !== "object" || e === null || Object.keys(e).sort().join(",") !== "checks,ok" || e.ok !== true || !Array.isArray(e.checks) || e.checks.length !== 0) return null;
  }
  const gate = parseGateReport(b.gate);
  if (!gate) return null;
  return { bootToken: b.bootToken, agentSha256: b.agentSha256 as string, gate };
}

interface TokenRow {
  token_sha256: string;
  machine_id: string;
  incarnation: number;
  issued_ms: number;
  expires_ms: number;
  used_ms: number | null;
  provider: string;
  provider_machine_id: string | null;
  agent_sha256: string;
  ipv4: string | null;
  outcome: string;
  watchdog_version: number;
  machine_state: string;
  machine_incarnation: number;
  policy_json: string;
  final_save_reserve_minutes: number;
}

const TOKEN_SELECT = `SELECT b.token_sha256, b.machine_id, b.incarnation, b.issued_ms, b.expires_ms, b.used_ms,
       v.provider, v.provider_machine_id, v.agent_sha256, v.ipv4, v.outcome, v.watchdog_version,
       m.state AS machine_state, m.incarnation AS machine_incarnation, p.policy_json, p.final_save_reserve_minutes
     FROM boot_tokens b
     JOIN launches v ON v.machine_id = b.machine_id AND v.incarnation = b.incarnation
     JOIN machines m ON m.id = b.machine_id
     JOIN projects p ON p.id = m.project_id
     WHERE b.token_sha256 = ? AND v.mode = 'vm'`;

/** The statement that uses the token: only this token, only unused. */
function useToken(r: TokenRow, nowMs: number, inWindow: boolean): Stmt {
  return {
    sql: `UPDATE boot_tokens SET used_ms = ? WHERE token_sha256 = ? AND machine_id = ? AND incarnation = ? AND used_ms IS NULL${inWindow ? " AND issued_ms <= ? AND ? < expires_ms" : ""}`,
    params: inWindow ? [nowMs, r.token_sha256, r.machine_id, r.incarnation, nowMs, nowMs] : [nowMs, r.token_sha256, r.machine_id, r.incarnation],
  };
}

/**
 * A definitive failure: one batch uses the token (unless it already was), marks the launch to
 * terminate with `reason` (a launch holding a token is issued, enrolled or already ending), and
 * records a failing gate report; only then the provider, in the background (the watchdog retries a failure).
 * If the batch can't be written, nothing changes, and the token's expiry ends the launch.
 */
async function definitiveFailure(ctx: Ctx, r: TokenRow, reason: EnrollFailure, gate: VmGateReport | null): Promise<never> {
  const { deps } = ctx;
  const now = deps.now();
  const stmts: Stmt[] = [];
  if (reason !== "second-enroll") stmts.push(useToken(r, now, false));
  stmts.push({
    sql: `UPDATE launches SET outcome = 'terminate', terminate_reason = COALESCE(terminate_reason, ?), next_ms = ?, watchdog_version = watchdog_version + 1
          WHERE machine_id = ? AND incarnation = ? AND outcome IN ('issued', 'enrolled')`,
    params: [reason, now, r.machine_id, r.incarnation],
  });
  if (reason === "gate-failed" && gate) {
    // (a report may already be there: another holder of this token enrolled meanwhile. The mark
    // must hold all the same, so an existing report is kept rather than failing the batch.)
    stmts.push({
      sql: `INSERT INTO gate_reports (machine_id, incarnation, words, at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (machine_id, incarnation) DO NOTHING`,
      params: [r.machine_id, r.incarnation, JSON.stringify(gate.fail), now],
    });
  }
  try {
    await deps.db.batch(stmts);
  } catch {
    deps.alert(`vm-enroll: ${reason} (not recorded)`);
    throw REFUSED();
  }
  deps.alert(`vm-enroll: ${reason}`);
  const cur = await deps.db.all<{ watchdog_version: number; provider_machine_id: string | null; outcome: string }>(
    `SELECT watchdog_version, provider_machine_id, outcome FROM launches WHERE machine_id = ? AND incarnation = ?`,
    [r.machine_id, r.incarnation],
  );
  const c = cur[0];
  if (c && c.outcome === "terminate") {
    const env: JobEnv = { db: deps.db, now, vm: deps.vm, elapsedMs: () => 0 };
    deps.waitUntil(terminateAttempt(env, { machine_id: r.machine_id, incarnation: r.incarnation, provider_machine_id: c.provider_machine_id, watchdog_version: c.watchdog_version }, reason));
  }
  throw REFUSED();
}

export const ENROLL_HANDLERS: Handlers = {
  async agentEnroll(ctx: Ctx) {
    const { deps } = ctx;
    // 0. the signer ready, before anything else: else refused, the token untouched
    const signer = await deps.agentSigner();
    if (!signer) {
      deps.alert("vm-enroll: the agent signer isn't ready");
      throw REFUSED();
    }
    if (ctx.body.mode === "container") return containerEnroll(ctx, signer);
    // 1. the exact shape; the token's row (an unknown token is only refused)
    const req = parseVmEnroll(ctx.body);
    if (!req) throw REFUSED();
    const hash = await sha256Hex(req.bootToken);
    const r = (await deps.db.all<TokenRow>(TOKEN_SELECT, [hash]))[0];
    if (!r) throw REFUSED();
    // 2. a used token is a second use: definitive
    if (r.used_ms !== null) return definitiveFailure(ctx, r, "second-enroll", null);
    // 3. the window and the launch's state
    const now = deps.now();
    const live =
      r.issued_ms <= now && now < r.expires_ms && r.outcome === "issued" && r.machine_state === "starting" && r.machine_incarnation === r.incarnation &&
      r.provider_machine_id !== null && r.ipv4 !== null; // (the token's provider id is its launch's: the database's key)
    if (!live) throw REFUSED();
    const providerMachineId = r.provider_machine_id as string;
    // 4. the request's claims, then the gate's report (a failing one is definitive)
    if (!sameText(req.agentSha256, r.agent_sha256)) throw REFUSED();
    if (!req.gate.pass) return definitiveFailure(ctx, r, "gate-failed", req.gate);
    // 5. a fresh provider read: unavailable is retryable (token untouched); a disagreeing answer is definitive
    const vm = deps.vm;
    const facts = vm ? await withDeadline<InstanceFacts>(() => vm.instanceFacts(providerMachineId), "unavailable") : "unavailable";
    if (facts === "unavailable") throw REFUSED();
    if (facts.state !== "active" || !facts.exclusive || facts.ipv4 !== r.ipv4) return definitiveFailure(ctx, r, "provider-facts", null);
    // 6. the enroll batch, eligibility bound again at a fresh time; all or nothing
    const at = deps.now();
    try {
      // (each conditional write is followed by a guard that fails the batch unless that write
      // changed exactly one row: changes() is the statement just before; D1 runs a batch in order,
      // on one connection, as one transaction)
      const took = { sql: `INSERT INTO enroll_guard (ok) SELECT 0 WHERE changes() <> 1`, params: [] };
      await deps.db.batch([
        useToken(r, at, true),
        took,
        {
          sql: `UPDATE launches SET outcome = 'enrolled', next_ms = NULL, heartbeat_due_ms = ?, watchdog_version = watchdog_version + 1
                WHERE machine_id = ? AND incarnation = ? AND provider = ? AND provider_machine_id = ? AND outcome = 'issued' AND watchdog_version = ?`,
          params: [at + HEARTBEAT_LOST_MS, r.machine_id, r.incarnation, r.provider, providerMachineId, r.watchdog_version],
        },
        took,
        { sql: `UPDATE machines SET state = 'running' WHERE id = ? AND incarnation = ? AND state = 'starting'`, params: [r.machine_id, r.incarnation] },
        took,
        { sql: `INSERT INTO gate_reports (machine_id, incarnation, words, at_ms) VALUES (?, ?, '[]', ?)`, params: [r.machine_id, r.incarnation, at] },
      ]);
    } catch {
      // the loser, classified by what's there now: used by someone else is a second use; anything else refused
      const again = (await deps.db.all<TokenRow>(TOKEN_SELECT, [hash]))[0];
      if (again && again.used_ms !== null) return definitiveFailure(ctx, again, "second-enroll", null);
      throw REFUSED();
    }
    // after the commit: sign. A failure now is definitive (sign-failed), never a wait for heartbeats
    const iat = Math.floor(at / 1000);
    const claims: AgentClaims = { v: 1, kind: "agent", jti: base64url(deps.randomBytes(16)), iat, exp: iat + AGENT_TOKEN_TTL_S, mch: r.machine_id, inc: r.incarnation };
    let agentToken: string;
    try {
      agentToken = await signToken(claims, signer.privateKey, signer.kid);
    } catch {
      const enrolled = (await deps.db.all<TokenRow>(TOKEN_SELECT, [hash]))[0] ?? r;
      return definitiveFailure(ctx, enrolled, "sign-failed", null);
    }
    return json(200, enrolledBody(ctx, r, agentToken, claims, at));
  },
};

/** The project's policy for a token row. */
function policyOf(r: { policy_json: string; final_save_reserve_minutes: number }): ProjectPolicy {
  return { ...mergePolicy(DEFAULT_POLICY, JSON.parse(r.policy_json) as Partial<ProjectPolicy>), finalSaveReserveMinutes: r.final_save_reserve_minutes };
}

/** The enroll response, both modes. */
function enrolledBody(ctx: Ctx, r: { machine_id: string; incarnation: number; policy_json: string; final_save_reserve_minutes: number }, agentToken: string, claims: AgentClaims, at: number): AgentEnrollResponse {
  const policy = policyOf(r);
  return {
    machineId: r.machine_id,
    agentToken,
    agentTokenExpiresAt: toIso(claims.exp * 1000),
    incarnation: r.incarnation,
    relayUrl: `wss://${new URL(ctx.deps.config.appOrigin).host}/api/relay/v1/peer?machine=${r.machine_id}`,
    heartbeatSeconds: HEARTBEAT_SECONDS,
    idle: { minutes: policy.idleStopMinutes, gpuUtilThresholdPct: IDLE_GPU_UTIL_PCT },
    maxSessionEndsAt: toIso(at + policy.maxSessionMinutes * 60_000),
    setupScript: policy.setupScript,
    workspace: { restore: true },
  };
}

// ---------------------------------------------------------------- container mode

/** The agent's eradication checks, by name, in its order: the contract's list. */
export const ERADICATION_CHECKS = AGENT_ERADICATION_CHECKS;

interface ContainerEnroll {
  bootToken: string;
  agentSha256: string;
  providerMachineId: string;
  /** Every check, and the report itself, said ok. */
  eradicated: boolean;
}

/**
 * A container enroll request in its exact shape, else null (the fixed refusal): the pod id it
 * read for itself, and the eradication report with exactly the agent's checks, in order. A
 * well-formed report that doesn't pass parses (its failure is definitive, not a refusal).
 */
function parseContainerEnroll(b: Record<string, unknown>): ContainerEnroll | null {
  const keys = ["agentSha256", "agentVersion", "bootToken", "eradication", "gpu", "hostname", "mode", "providerMachineId"];
  if (Object.keys(b).sort().join(",") !== keys.join(",")) return null;
  if (b.mode !== "container" || !isBootTokenShape(b.bootToken)) return null;
  if (!commonShape(b)) return null;
  if (typeof b.providerMachineId !== "string" || !PRINTABLE.test(b.providerMachineId)) return null;
  const e = b.eradication as Record<string, unknown>;
  if (typeof e !== "object" || e === null || Array.isArray(e) || Object.keys(e).sort().join(",") !== "checks,ok" || typeof e.ok !== "boolean") return null;
  const checks = e.checks;
  if (!Array.isArray(checks) || checks.length !== ERADICATION_CHECKS.length) return null;
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i] as Record<string, unknown>;
    if (typeof c !== "object" || c === null || Array.isArray(c) || Object.keys(c).sort().join(",") !== "name,ok") return null;
    if (c.name !== ERADICATION_CHECKS[i] || typeof c.ok !== "boolean") return null;
  }
  const eradicated = e.ok === true && checks.every((c) => (c as { ok: boolean }).ok === true);
  return { bootToken: b.bootToken, agentSha256: b.agentSha256 as string, providerMachineId: b.providerMachineId, eradicated };
}

interface ContainerTokenRow {
  token_sha256: string;
  machine_id: string;
  incarnation: number;
  issued_ms: number | null;
  expires_ms: number | null;
  used_ms: number | null;
  provider: string;
  provider_machine_id: string | null;
  agent_sha256: string;
  outcome: string;
  watchdog_version: number;
  machine_state: string;
  machine_incarnation: number;
  policy_json: string;
  final_save_reserve_minutes: number;
}

const CONTAINER_TOKEN_SELECT = `SELECT b.token_sha256, b.machine_id, b.incarnation, b.issued_ms, b.expires_ms, b.used_ms,
       v.provider, v.provider_machine_id, v.agent_sha256, v.outcome, v.watchdog_version,
       m.state AS machine_state, m.incarnation AS machine_incarnation, p.policy_json, p.final_save_reserve_minutes
     FROM boot_tokens b
     JOIN launches v ON v.machine_id = b.machine_id AND v.incarnation = b.incarnation
     JOIN machines m ON m.id = b.machine_id
     JOIN projects p ON p.id = m.project_id
     WHERE b.token_sha256 = ? AND b.mode = 'container' AND v.mode = 'container'`;

function containerEnv(ctx: Ctx): ContainerEnv | null {
  const c = ctx.deps.container;
  if (!c) return null;
  const { deps } = ctx;
  return { db: deps.db, installation: deps.config.installation, clock: deps.now, provider: c.provider, expect: c.expect, randomBytes: deps.randomBytes, elapsedMs: () => 0 };
}

/**
 * A definitive container failure: one batch uses the token (unless it already was) and marks the
 * launch to terminate with `reason`; only then is the pod ended, in the background, by the
 * container termination (which claims the row again and confirms the pod gone). If the batch
 * can't be written, nothing changes, and the token's window or the create deadline ends the launch.
 */
async function containerFailure(ctx: Ctx, env: ContainerEnv, r: ContainerTokenRow, reason: EnrollFailure): Promise<never> {
  const { deps } = ctx;
  const now = deps.now();
  const stmts: Stmt[] = [];
  if (reason !== "second-enroll") {
    stmts.push({
      sql: `UPDATE boot_tokens SET used_ms = ? WHERE token_sha256 = ? AND machine_id = ? AND incarnation = ? AND used_ms IS NULL`,
      params: [now, r.token_sha256, r.machine_id, r.incarnation],
    });
  }
  stmts.push({
    sql: `UPDATE launches SET outcome = 'terminate', terminate_reason = COALESCE(terminate_reason, ?), next_ms = ?, watchdog_version = watchdog_version + 1
          WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND outcome IN ('creating', 'issued', 'enrolled')`,
    params: [reason, now, r.machine_id, r.incarnation],
  });
  stmts.push(stopMachineStmt(r.machine_id, r.incarnation));
  try {
    await deps.db.batch(stmts);
  } catch {
    deps.alert(`container-enroll: ${reason} (not recorded)`);
    throw REFUSED();
  }
  deps.alert(`container-enroll: ${reason}`);
  const cur = await containerRow(deps.db, r.machine_id, r.incarnation);
  if (cur && cur.outcome === "terminate") deps.waitUntil(terminateContainerAttempt(env, cur, reason));
  throw REFUSED();
}

/** Container mode's enroll (see the header): the same three endings as VM mode's. */
async function containerEnroll(ctx: Ctx, signer: { privateKey: Parameters<typeof signToken>[1]; kid: string }): Promise<Response> {
  const { deps } = ctx;
  // 0. an adapter wired (none in production yet): else refused, the token untouched
  const env = containerEnv(ctx);
  if (!env) throw REFUSED();
  // 1. the exact shape; the token's row (an unknown token is only refused)
  const req = parseContainerEnroll(ctx.body);
  if (!req) throw REFUSED();
  const hash = await sha256Hex(req.bootToken);
  const read = async () => (await deps.db.all<ContainerTokenRow>(CONTAINER_TOKEN_SELECT, [hash]))[0];
  const r = await read();
  if (!r) throw REFUSED();
  // 2. a used token is a second use: definitive
  if (r.used_ms !== null) return containerFailure(ctx, env, r, "second-enroll");
  // 3. the launch's state, and the request's claims: the pod it names is the launch's own, and
  // the agent is the pinned one (a mismatch is only refused, as in VM mode)
  const state = (x: ContainerTokenRow) =>
    (x.outcome === "creating" || x.outcome === "issued") && x.machine_state === "starting" && x.machine_incarnation === x.incarnation && x.provider_machine_id !== null;
  if (!state(r)) throw REFUSED();
  if (!sameText(req.providerMachineId, r.provider_machine_id as string)) throw REFUSED();
  if (!sameText(req.agentSha256, r.agent_sha256)) throw REFUSED();
  // 4. the eradication report: one that doesn't pass is definitive
  if (!req.eradicated) return containerFailure(ctx, env, r, "eradication-failed");
  // 5. a fresh provider read, verified (the pod, its image, launcher, env names and settings),
  // which records first running (the token's window) if it is the earliest seen. Not running
  // yet, or unavailable, is retryable (the token untouched); a pod that disagrees or exited was
  // ended by the read (its token revoked first)
  const seen = await observeContainer(env, r.machine_id, r.incarnation);
  if (seen !== "running") throw REFUSED();
  // 6. the window and the state again, as the read left them (the token used meanwhile is a second use)
  const t = await read();
  if (!t) throw REFUSED();
  if (t.used_ms !== null) return containerFailure(ctx, env, t, "second-enroll");
  const now = deps.now();
  if (!state(t) || t.outcome !== "issued" || t.provider_machine_id !== r.provider_machine_id) throw REFUSED();
  if (t.issued_ms === null || t.expires_ms === null || !(t.issued_ms <= now && now < t.expires_ms)) throw REFUSED();
  const providerMachineId = t.provider_machine_id as string;
  // 7. the enroll batch, eligibility bound again at a fresh time; all or nothing
  const at = deps.now();
  const policy = policyOf(t);
  try {
    const took = { sql: `INSERT INTO enroll_guard (ok) SELECT 0 WHERE changes() <> 1`, params: [] };
    await deps.db.batch([
      {
        sql: `UPDATE boot_tokens SET used_ms = ? WHERE token_sha256 = ? AND machine_id = ? AND incarnation = ? AND mode = 'container' AND provider_machine_id = ?
                AND used_ms IS NULL AND issued_ms <= ? AND ? < expires_ms`,
        params: [at, t.token_sha256, t.machine_id, t.incarnation, providerMachineId, at, at],
      },
      took,
      {
        sql: `UPDATE launches SET outcome = 'enrolled', next_ms = NULL, heartbeat_due_ms = ?, max_end_ms = ?, watchdog_version = watchdog_version + 1
              WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND provider = ? AND provider_machine_id = ? AND outcome = 'issued' AND watchdog_version = ?`,
        params: [at + HEARTBEAT_LOST_MS, at + policy.maxSessionMinutes * 60_000, t.machine_id, t.incarnation, t.provider, providerMachineId, t.watchdog_version],
      },
      took,
      { sql: `UPDATE machines SET state = 'running' WHERE id = ? AND incarnation = ? AND state = 'starting'`, params: [t.machine_id, t.incarnation] },
      took,
    ]);
  } catch {
    // the loser, classified by what's there now: used by someone else is a second use; anything else refused
    const again = await read();
    if (again && again.used_ms !== null) return containerFailure(ctx, env, again, "second-enroll");
    throw REFUSED();
  }
  // after the commit: sign. A failure now is definitive (sign-failed)
  const iat = Math.floor(at / 1000);
  const claims: AgentClaims = { v: 1, kind: "agent", jti: base64url(deps.randomBytes(16)), iat, exp: iat + AGENT_TOKEN_TTL_S, mch: t.machine_id, inc: t.incarnation };
  let agentToken: string;
  try {
    agentToken = await signToken(claims, signer.privateKey, signer.kid);
  } catch {
    return containerFailure(ctx, env, (await read()) ?? t, "sign-failed");
  }
  return json(200, enrolledBody(ctx, t, agentToken, claims, at));
}
