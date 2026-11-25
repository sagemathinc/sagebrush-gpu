// VM enroll (design r3, SEC clear): a VM's boot token, issued at its announce, exchanged once
// for the machine's first agent token. Every request ends one of three ways:
// - refused: one fixed 403, and nothing changes (the token stays usable while it's valid);
// - a definitive failure: one batch first uses the token and marks the launch to terminate
//   (a second use of a real token, a failing gate report, provider facts that disagree, a
//   signing failure after the commit), and only then is the provider called. Still the 403;
// - enrolled: one guarded batch commits (all or nothing), then the token is signed.
// The checks, in order: the signer ready (before anything else); the shape; a used token
// (a second use); the window and the launch's state; the request's claims and the gate
// report; a fresh provider read. Eligibility is bound again at the commit.

import { DEFAULT_POLICY, isBootTokenShape, mergePolicy, parseGateReport, signToken, toIso, type AgentClaims, type AgentEnrollResponse, type ProjectPolicy, type VmGateReport } from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import type { Stmt } from "./db.ts";
import { HttpError, base64url, json, sha256Hex } from "./http.ts";
import { terminateAttempt, withDeadline, type InstanceFacts, type JobEnv } from "./vm.ts";

export const ENROLL_MAX_BODY_BYTES = 4096;
export const HEARTBEAT_SECONDS = 30;
/** Below this GPU use (percent) a machine counts as idle. */
export const IDLE_GPU_UTIL_PCT = 5;
const AGENT_TOKEN_TTL_S = 3600;

type EnrollFailure = "second-enroll" | "gate-failed" | "provider-facts" | "sign-failed";

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

interface VmEnroll {
  bootToken: string;
  agentSha256: string;
  providerMachineId: string;
  gate: VmGateReport;
}

/** A VM enroll request in its exact shape, else null (the fixed refusal). */
function parseVmEnroll(b: Record<string, unknown>): VmEnroll | null {
  const keys = Object.keys(b).sort();
  const base = ["agentSha256", "agentVersion", "bootToken", "gate", "gpu", "hostname", "mode", "providerMachineId"];
  const withEradication = [...base, "eradication"].sort();
  if (keys.join(",") !== base.join(",") && keys.join(",") !== withEradication.join(",")) return null;
  if (b.mode !== "vm" || !isBootTokenShape(b.bootToken)) return null;
  // (the hash and the provider id are compared with the launch's own, so their forms need no check here)
  if (typeof b.agentSha256 !== "string") return null;
  if (typeof b.agentVersion !== "string" || !PRINTABLE.test(b.agentVersion)) return null;
  if (typeof b.providerMachineId !== "string") return null;
  if (typeof b.hostname !== "string" || !HOSTNAME.test(b.hostname)) return null;
  if (b.gpu !== null) {
    const g = b.gpu as Record<string, unknown>;
    if (typeof g !== "object" || Array.isArray(g) || Object.keys(g).sort().join(",") !== "count,memoryMiB,name") return null;
    if (typeof g.name !== "string" || !/^[\x20-\x7e]{1,64}$/.test(g.name) || !isInt(g.count, 1, 64) || !isInt(g.memoryMiB, 0, 4 * 1024 * 1024)) return null;
  }
  // (eradication is container mode's; in VM mode it may only be the empty, passing report)
  if ("eradication" in b) {
    const e = b.eradication as Record<string, unknown>;
    if (typeof e !== "object" || e === null || Object.keys(e).sort().join(",") !== "checks,ok" || e.ok !== true || !Array.isArray(e.checks) || e.checks.length !== 0) return null;
  }
  const gate = parseGateReport(b.gate);
  if (!gate) return null;
  return { bootToken: b.bootToken, agentSha256: b.agentSha256, providerMachineId: b.providerMachineId, gate };
}

interface TokenRow {
  token_sha256: string;
  machine_id: string;
  incarnation: number;
  token_provider_machine_id: string;
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

const TOKEN_SELECT = `SELECT b.token_sha256, b.machine_id, b.incarnation, b.provider_machine_id AS token_provider_machine_id, b.issued_ms, b.expires_ms, b.used_ms,
       v.provider, v.provider_machine_id, v.agent_sha256, v.ipv4, v.outcome, v.watchdog_version,
       m.state AS machine_state, m.incarnation AS machine_incarnation, p.policy_json, p.final_save_reserve_minutes
     FROM boot_tokens b
     JOIN vm_launches v ON v.machine_id = b.machine_id AND v.incarnation = b.incarnation
     JOIN machines m ON m.id = b.machine_id
     JOIN projects p ON p.id = m.project_id
     WHERE b.token_sha256 = ?`;

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
    sql: `UPDATE vm_launches SET outcome = 'terminate', terminate_reason = COALESCE(terminate_reason, ?), next_ms = ?, watchdog_version = watchdog_version + 1
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
    `SELECT watchdog_version, provider_machine_id, outcome FROM vm_launches WHERE machine_id = ? AND incarnation = ?`,
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
      r.provider_machine_id !== null && r.ipv4 !== null && sameText(r.token_provider_machine_id, r.provider_machine_id);
    if (!live) throw REFUSED();
    const providerMachineId = r.provider_machine_id as string;
    // 4. the request's claims, then the gate's report (a failing one is definitive)
    if (!sameText(req.providerMachineId, providerMachineId) || !sameText(req.agentSha256, r.agent_sha256)) throw REFUSED();
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
          sql: `UPDATE vm_launches SET outcome = 'enrolled', next_ms = NULL, watchdog_version = watchdog_version + 1
                WHERE machine_id = ? AND incarnation = ? AND provider = ? AND provider_machine_id = ? AND outcome = 'issued' AND watchdog_version = ?`,
          params: [r.machine_id, r.incarnation, r.provider, providerMachineId, r.watchdog_version],
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
    const policy: ProjectPolicy = { ...mergePolicy(DEFAULT_POLICY, JSON.parse(r.policy_json) as Partial<ProjectPolicy>), finalSaveReserveMinutes: r.final_save_reserve_minutes };
    const body: AgentEnrollResponse = {
      machineId: r.machine_id,
      agentToken,
      agentTokenExpiresAt: toIso(claims.exp * 1000),
      incarnation: r.incarnation,
      relayUrl: `wss://${new URL(deps.config.appOrigin).host}/api/relay/v1/peer?machine=${r.machine_id}`,
      heartbeatSeconds: HEARTBEAT_SECONDS,
      idle: { minutes: policy.idleStopMinutes, gpuUtilThresholdPct: IDLE_GPU_UTIL_PCT },
      maxSessionEndsAt: toIso(at + policy.maxSessionMinutes * 60_000),
      setupScript: policy.setupScript,
      workspace: { restore: true },
    };
    return json(200, body);
  },
};
