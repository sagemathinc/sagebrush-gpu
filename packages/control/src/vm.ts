// VM mode's announce and watchdog (design draft 5; announce contract r3, SEC clear).
//
// The launcher announces once, after its local gate, from the VM's own IPv4. We
// authenticate it first (the launch nonce, the edge's client IPv4, the boot script's hash),
// with no state change if that fails; then read the provider's facts again; then claim the
// one announce (first wins) and issue a single-use boot token, 120 s, of which we keep only
// the hash. Anything else after authentication (a second announce, wrong facts, the provider
// unavailable, past the deadline, a failed issue) terminates the VM. Every refusal is one
// fixed 403, whatever the reason.
//
// The watchdog (a scheduled job) terminates launches that must end, bounded per run and
// fair: rows in order of their last attempt, each claimed with a conditional update of its
// version before any provider call, at most two provider calls per row with deadlines, and
// no new claim past the run's budget. Only the provider confirming the instance absent
// marks a launch terminated.

import { ANNOUNCE_NONCE_PATTERN, SHA256_HEX_PATTERN, isId, toIso } from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import type { Db } from "./db.ts";
import { HttpError, base64url, json, sha256Hex } from "./http.ts";
import { closeAccrual } from "./ledger.ts";

import type { InstanceFacts } from "@sbgpu/providers";

export type { InstanceFacts };

/** The two calls VM mode needs from a provider adapter (the Hyperstack adapter has them). */
export interface VmProvider {
  instanceFacts(providerMachineId: string): Promise<InstanceFacts>;
  /** Idempotent; throws when the provider can't confirm the request was taken. */
  terminate(providerMachineId: string): Promise<void>;
}

export const BOOT_TOKEN_TTL_MS = 120_000;
export const ANNOUNCE_DEADLINE_MS = 10 * 60_000;
export const PROVIDER_CALL_DEADLINE_MS = 5000;
export const WATCHDOG_BATCH = 20;
export const WATCHDOG_BUDGET_MS = 60_000;

type TerminateReason = "second-announce" | "provider-facts" | "provider-unavailable" | "deadline" | "issue-failed";

interface LaunchRow {
  machine_id: string;
  incarnation: number;
  provider_machine_id: string;
  nonce_sha256: string;
  boot_script_sha256: string;
  ipv4: string;
  first_active_ms: number;
  announce_ms: number | null;
  watchdog_version: number;
}

/** One dotted-decimal IPv4 in canonical form (no leading zeros, nothing else). */
const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
export function canonicalIpv4(x: string | null): string | null {
  return x !== null && IPV4.test(x) ? x : null;
}

/** Equal strings, compared without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The provider's answer, or "unavailable" past the deadline or on any throw. */
async function withDeadline<T>(p: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p().catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), PROVIDER_CALL_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const REFUSED = () => new HttpError("forbidden", "refused");

/** Mark a launch for termination (keeping an earlier reason), unless it's already terminated. */
async function markTerminate(db: Db, r: LaunchRow, reason: TerminateReason, nowMs: number, claimAnnounce: boolean): Promise<void> {
  await db.run(
    `UPDATE vm_launches SET outcome = 'terminate', terminate_reason = COALESCE(terminate_reason, ?)${claimAnnounce ? ", announce_ms = COALESCE(announce_ms, ?)" : ""}
     WHERE machine_id = ? AND incarnation = ? AND outcome <> 'terminated'`,
    claimAnnounce ? [reason, nowMs, r.machine_id, r.incarnation] : [reason, r.machine_id, r.incarnation],
  );
}

export interface JobEnv {
  db: Db;
  /** The run's time (stored times). */
  now: number;
  vm: VmProvider | null;
  /** Milliseconds since the run began (its budget). */
  elapsedMs(): number;
}

/**
 * One termination attempt for a launch, if this caller wins the row's claim (a
 * conditional update from the version it read, so concurrent callers never both work it):
 * terminate, then one facts read; confirmed absent marks it terminated and closes its accrual.
 * Returns whether the claim was won.
 */
export async function terminateAttempt(env: JobEnv, r: { machine_id: string; incarnation: number; provider_machine_id: string; watchdog_version: number }, reason: string): Promise<boolean> {
  const claimed = await env.db.run(
    `UPDATE vm_launches SET watchdog_version = watchdog_version + 1, watchdog_ms = ?,
       outcome = CASE WHEN outcome IN ('launched', 'issued') THEN 'terminate' ELSE outcome END,
       terminate_reason = COALESCE(terminate_reason, ?)
     WHERE machine_id = ? AND incarnation = ? AND watchdog_version = ? AND outcome <> 'terminated' AND outcome <> 'enrolled'`,
    [env.now, reason, r.machine_id, r.incarnation, r.watchdog_version],
  );
  if (claimed.changes !== 1) return false;
  const vm = env.vm;
  if (!vm) return true; // (no adapter: the row stays eligible)
  await withDeadline(() => vm.terminate(r.provider_machine_id), undefined);
  const facts = await withDeadline<InstanceFacts>(() => vm.instanceFacts(r.provider_machine_id), "unavailable");
  if (facts !== "unavailable" && facts.state === "absent") {
    await env.db.batch([
      {
        sql: `UPDATE vm_launches SET outcome = 'terminated', terminated_ms = ? WHERE machine_id = ? AND incarnation = ? AND outcome = 'terminate'`,
        params: [env.now, r.machine_id, r.incarnation],
      },
      ...closeAccrual(r.machine_id, r.incarnation, env.now),
    ]);
  }
  return true;
}

export const VM_HANDLERS: Handlers = {
  async agentAnnounce(ctx: Ctx) {
    const { deps } = ctx;
    const b = ctx.body;
    // the exact shape: these three keys, these forms
    const keys = Object.keys(b).sort().join(",");
    if (keys !== "bootScriptSha256,machineId,nonce") throw new HttpError("badRequest", "an announce is exactly machineId, nonce and bootScriptSha256");
    const { machineId, nonce, bootScriptSha256 } = b as Record<string, unknown>;
    if (!isId("machine", machineId) || typeof nonce !== "string" || !ANNOUNCE_NONCE_PATTERN.test(nonce) || typeof bootScriptSha256 !== "string" || !SHA256_HEX_PATTERN.test(bootScriptSha256)) {
      throw new HttpError("badRequest", "an announce is exactly machineId, nonce and bootScriptSha256");
    }
    const now = deps.now();
    // the machine's VM launch for its current incarnation, unless it's already terminated
    // (an enrolled one included: a valid second announce after enroll terminates too)
    const rows = await deps.db.all<LaunchRow>(
      `SELECT v.machine_id, v.incarnation, v.provider_machine_id, v.nonce_sha256, v.boot_script_sha256, v.ipv4, v.first_active_ms, v.announce_ms, v.watchdog_version
       FROM vm_launches v JOIN machines m ON m.id = v.machine_id AND m.incarnation = v.incarnation
       WHERE v.machine_id = ? AND v.outcome <> 'terminated'`,
      [machineId],
    );
    const r = rows[0];
    if (!r) throw REFUSED();
    // authenticate: nothing changes if any of these fails
    const ip = canonicalIpv4(ctx.req.headers.get("cf-connecting-ip"));
    const nonceOk = sameText(await sha256Hex(nonce), r.nonce_sha256);
    const scriptOk = sameText(bootScriptSha256, r.boot_script_sha256);
    if (!nonceOk || !scriptOk || ip === null || !sameText(ip, r.ipv4)) throw REFUSED();
    const end = async (reason: TerminateReason, claim: boolean) => {
      await markTerminate(deps.db, r, reason, now, claim);
      const env: JobEnv = { db: deps.db, now, vm: deps.vm, elapsedMs: () => 0 };
      const cur = await deps.db.all<{ watchdog_version: number }>(`SELECT watchdog_version FROM vm_launches WHERE machine_id = ? AND incarnation = ?`, [r.machine_id, r.incarnation]);
      if (cur[0]) deps.waitUntil(terminateAttempt(env, { ...r, watchdog_version: cur[0].watchdog_version }, reason));
      throw REFUSED();
    };
    // a second announce (a valid one, after the first)
    if (r.announce_ms !== null) return end("second-announce", false);
    // the deadline, then the provider's facts read again now
    if (now >= r.first_active_ms + ANNOUNCE_DEADLINE_MS) return end("deadline", true);
    const vm = deps.vm;
    const facts = vm ? await withDeadline<InstanceFacts>(() => vm.instanceFacts(r.provider_machine_id), "unavailable") : "unavailable";
    if (facts === "unavailable") return end("provider-unavailable", true);
    if (facts.state !== "active" || !facts.exclusive || facts.ipv4 !== r.ipv4) return end("provider-facts", true);
    // claim the one announce and issue, in one batch: the token row only if this claim won
    const token = base64url(deps.randomBytes(32));
    const tokenHash = await sha256Hex(token);
    const expires = now + BOOT_TOKEN_TTL_MS;
    try {
      await deps.db.batch([
        {
          sql: `UPDATE vm_launches SET announce_ms = ?, outcome = 'issued' WHERE machine_id = ? AND incarnation = ? AND announce_ms IS NULL AND outcome = 'launched'`,
          params: [now, r.machine_id, r.incarnation],
        },
        {
          sql: `INSERT INTO boot_tokens (token_sha256, machine_id, incarnation, provider_machine_id, nonce_sha256, issued_ms, expires_ms)
                SELECT ?, machine_id, incarnation, provider_machine_id, nonce_sha256, ?, ? FROM vm_launches
                WHERE machine_id = ? AND incarnation = ? AND announce_ms = ? AND outcome = 'issued'`,
          params: [tokenHash, now, expires, r.machine_id, r.incarnation, now],
        },
      ]);
    } catch {
      // (another announce claimed it within the same millisecond: its token row exists, so this one is the second)
      const won = await deps.db.all(`SELECT 1 FROM boot_tokens WHERE machine_id = ? AND incarnation = ?`, [r.machine_id, r.incarnation]);
      return end(won.length ? "second-announce" : "issue-failed", false);
    }
    const mine = await deps.db.all(`SELECT 1 FROM boot_tokens WHERE token_sha256 = ?`, [tokenHash]);
    if (mine.length !== 1) return end("second-announce", false);
    return json(200, { bootToken: token, expiresAt: toIso(expires) });
  },
};

/**
 * The watchdog job: launches that must end (marked to terminate; past the announce deadline
 * without enrolling; issued but the token unused past its expiry), at most WATCHDOG_BATCH a
 * run, longest unattempted first (and, among rows attempted at the same time, the least
 * attempted), each claimed before it's worked, none claimed past the budget. Returns how
 * many it attempted.
 */
export async function runVmWatchdog(env: JobEnv): Promise<number> {
  const rows = await env.db.all<{ machine_id: string; incarnation: number; provider_machine_id: string; watchdog_version: number; reason: string }>(
    `SELECT v.machine_id, v.incarnation, v.provider_machine_id, v.watchdog_version,
       CASE WHEN v.outcome = 'terminate' THEN v.terminate_reason
            WHEN v.outcome = 'issued' AND EXISTS (SELECT 1 FROM boot_tokens b WHERE b.machine_id = v.machine_id AND b.incarnation = v.incarnation AND b.used_ms IS NULL AND b.expires_ms <= ?) THEN 'token-expired'
            ELSE 'watchdog-deadline' END AS reason
     FROM vm_launches v
     WHERE v.outcome = 'terminate'
        OR (v.outcome IN ('launched', 'issued') AND ? >= v.first_active_ms + ?)
        OR (v.outcome = 'issued' AND EXISTS (SELECT 1 FROM boot_tokens b WHERE b.machine_id = v.machine_id AND b.incarnation = v.incarnation AND b.used_ms IS NULL AND b.expires_ms <= ?))
     ORDER BY v.watchdog_ms IS NOT NULL, v.watchdog_ms, v.watchdog_version, v.machine_id, v.incarnation
     LIMIT ?`,
    [env.now, env.now, ANNOUNCE_DEADLINE_MS, env.now, WATCHDOG_BATCH],
  );
  let attempted = 0;
  for (const r of rows) {
    if (env.elapsedMs() >= WATCHDOG_BUDGET_MS) break;
    if (await terminateAttempt(env, r, r.reason)) attempted++;
  }
  return attempted;
}
