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
/** An announce body is at most this many bytes (contract r3). */
export const ANNOUNCE_MAX_BODY_BYTES = 1024;
export const WATCHDOG_BATCH = 20;
export const WATCHDOG_BUDGET_MS = 60_000;

type TerminateReason = "second-announce" | "provider-facts" | "provider-unavailable" | "deadline" | "issue-failed";

export const CREATE_DEADLINE_MS = 10 * 60_000;
export type VmProviderName = "hyperstack" | "shadeform" | "nebius";

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

/**
 * The provider's answer, or `fallback` on any throw (a synchronous one included) or past the
 * deadline. The deadline is checked twice: a timer races the call, and the answer's own
 * arrival is measured on a monotonic clock, so an answer that arrives late (the timer held
 * back by a busy event loop) is still refused. (This bounds our waiting, not the provider's
 * work: the adapter's own calls carry their own deadlines.)
 */
export async function withDeadline<T>(p: () => Promise<T>, fallback: T, deadlineMs = PROVIDER_CALL_DEADLINE_MS): Promise<T> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const v = await Promise.race([
      Promise.resolve()
        .then(p)
        .catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), deadlineMs);
      }),
    ]);
    return performance.now() - start < deadlineMs ? v : fallback;
  } finally {
    clearTimeout(timer);
  }
}

const REFUSED = () => new HttpError("forbidden", "refused");

/** Mark a launch for termination (keeping an earlier reason), unless it's already terminated. */
async function markTerminate(db: Db, r: LaunchRow, reason: TerminateReason, nowMs: number, claimAnnounce: boolean): Promise<void> {
  await db.run(
    `UPDATE vm_launches SET outcome = 'terminate', terminate_reason = COALESCE(terminate_reason, ?), next_ms = MIN(COALESCE(next_ms, ?), ?)${claimAnnounce ? ", announce_ms = COALESCE(announce_ms, ?)" : ""}
     WHERE machine_id = ? AND incarnation = ? AND outcome <> 'terminated'`,
    claimAnnounce ? [reason, nowMs, nowMs, nowMs, r.machine_id, r.incarnation] : [reason, nowMs, nowMs, r.machine_id, r.incarnation],
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
export async function terminateAttempt(env: JobEnv, r: { machine_id: string; incarnation: number; provider_machine_id: string | null; watchdog_version: number }, reason: string): Promise<boolean> {
  const claimed = await env.db.run(
    `UPDATE vm_launches SET watchdog_version = watchdog_version + 1, next_ms = ?,
       outcome = CASE WHEN outcome IN ('creating', 'launched', 'issued') THEN 'terminate' ELSE outcome END,
       terminate_reason = COALESCE(terminate_reason, ?)
     WHERE machine_id = ? AND incarnation = ? AND watchdog_version = ? AND outcome <> 'terminated' AND outcome <> 'enrolled'`,
    [env.now, reason, r.machine_id, r.incarnation, r.watchdog_version],
  );
  if (claimed.changes !== 1) return false;
  const vm = env.vm;
  if (!vm) return true; // (no adapter: the row stays eligible)
  // (no id recorded: the create's answer was lost. Finding the VM by its name is a provider
  // lookup not built yet, so the row stays eligible, and an orphan sweep will catch it.)
  const id = r.provider_machine_id;
  if (id === null) return true;
  await withDeadline(() => vm.terminate(id), undefined);
  const facts = await withDeadline<InstanceFacts>(() => vm.instanceFacts(id), "unavailable");
  if (facts !== "unavailable" && facts.state === "absent") {
    await env.db.batch([
      {
        sql: `UPDATE vm_launches SET outcome = 'terminated', terminated_ms = ?, next_ms = NULL WHERE machine_id = ? AND incarnation = ? AND outcome = 'terminate'`,
        params: [env.now, r.machine_id, r.incarnation],
      },
      ...closeAccrual(r.machine_id, r.incarnation, env.now),
    ]);
  }
  return true;
}

// ---------------------------------------------------------------- the launch, before announce

/**
 * The launch-intent row, written BEFORE the create request (no create unless this write
 * succeeded): 'creating', no provider id, no ACTIVE facts, due to the watchdog at the create
 * deadline.
 */
export async function recordLaunchIntent(
  db: Db,
  i: { machineId: string; incarnation: number; provider: VmProviderName; nonceSha256: string; bootScriptSha256: string; createdMs: number },
): Promise<void> {
  await db.batch([
    {
      sql: `INSERT INTO vm_launches (machine_id, incarnation, provider, nonce_sha256, boot_script_sha256, outcome, next_ms, created_ms)
            VALUES (?, ?, ?, ?, ?, 'creating', ?, ?)`,
      params: [i.machineId, i.incarnation, i.provider, i.nonceSha256, i.bootScriptSha256, i.createdMs + CREATE_DEADLINE_MS, i.createdMs],
    },
  ]);
}

const PROVIDER_ID = /^[^\s]{1,64}$/;

/**
 * The provider's id for a creating launch, once the create returned it: idempotent for the
 * same id, refused for a different one (or a launch past creating). "refused" means the
 * caller must not go on: it abandons the launch with the id it holds.
 */
export async function recordProviderId(db: Db, machineId: string, incarnation: number, providerMachineId: string): Promise<"recorded" | "refused"> {
  if (!PROVIDER_ID.test(providerMachineId)) return "refused";
  const r = await db.run(
    `UPDATE vm_launches SET provider_machine_id = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ? AND incarnation = ? AND outcome = 'creating'
       AND (provider_machine_id IS NULL OR provider_machine_id = ?)`,
    [providerMachineId, machineId, incarnation, providerMachineId],
  );
  return r.changes === 1 ? "recorded" : "refused";
}

/**
 * The move to ACTIVE, in one statement: it sets (or confirms) the id together with the
 * ACTIVE facts, and starts the announce deadline. Refused for another id, a malformed IPv4,
 * or a launch that isn't creating.
 */
export async function recordActive(
  db: Db,
  machineId: string,
  incarnation: number,
  f: { providerMachineId: string; ipv4: string; firstActiveMs: number },
): Promise<"launched" | "refused"> {
  if (!PROVIDER_ID.test(f.providerMachineId) || canonicalIpv4(f.ipv4) === null || !Number.isSafeInteger(f.firstActiveMs) || f.firstActiveMs < 0) return "refused";
  const r = await db.run(
    `UPDATE vm_launches SET outcome = 'launched', provider_machine_id = ?, ipv4 = ?, first_active_ms = ?, next_ms = ?,
       watchdog_version = watchdog_version + 1
     WHERE machine_id = ? AND incarnation = ? AND outcome = 'creating' AND (provider_machine_id IS NULL OR provider_machine_id = ?)`,
    [f.providerMachineId, f.ipv4, f.firstActiveMs, f.firstActiveMs + ANNOUNCE_DEADLINE_MS, machineId, incarnation, f.providerMachineId],
  );
  return r.changes === 1 ? "launched" : "refused";
}

/**
 * A launch that failed before its announce (the create failed, an id or ACTIVE write was
 * refused or failed, the VM never came up right): marked to terminate, and terminated now
 * with the id the caller holds, even if that id never reached the database. The mark stores
 * that id when the row has none, so the watchdog retries by it if this terminate fails (a row
 * that already has an id keeps its own). The durable row stays the watchdog's until the
 * provider confirms the VM absent.
 */
export async function abandonLaunch(env: JobEnv, machineId: string, incarnation: number, providerMachineId: string | null): Promise<void> {
  const known = providerMachineId !== null && PROVIDER_ID.test(providerMachineId) ? providerMachineId : null;
  try {
    await env.db.run(
      `UPDATE vm_launches SET outcome = 'terminate', terminate_reason = COALESCE(terminate_reason, 'create-failed'), next_ms = MIN(COALESCE(next_ms, ?), ?),
         provider_machine_id = COALESCE(provider_machine_id, ?), watchdog_version = watchdog_version + 1
       WHERE machine_id = ? AND incarnation = ? AND outcome IN ('creating', 'launched')`,
      [env.now, env.now, known, machineId, incarnation],
    );
  } catch {
    // (the row stays as it was: creating, due at its create deadline; the provider call below still goes)
  }
  const vm = env.vm;
  if (vm && known !== null) await withDeadline(() => vm.terminate(known), undefined);
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
    // the machine's VM launch for its current incarnation, unless it's already terminated or
    // was never ACTIVE (a creating launch, or one that failed before ACTIVE: nothing can
    // authenticate against it yet). An enrolled one is included: a valid second announce
    // after enroll terminates too.
    const rows = await deps.db.all<LaunchRow>(
      `SELECT v.machine_id, v.incarnation, v.provider_machine_id, v.nonce_sha256, v.boot_script_sha256, v.ipv4, v.first_active_ms, v.announce_ms, v.watchdog_version
       FROM vm_launches v JOIN machines m ON m.id = v.machine_id AND m.incarnation = v.incarnation
       WHERE v.machine_id = ? AND v.outcome <> 'terminated' AND v.ipv4 IS NOT NULL AND v.provider_machine_id IS NOT NULL`,
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
          sql: `UPDATE vm_launches SET announce_ms = ?, outcome = 'issued', next_ms = MIN(next_ms, ?) WHERE machine_id = ? AND incarnation = ? AND announce_ms IS NULL AND outcome = 'launched'`,
          params: [now, expires, r.machine_id, r.incarnation],
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
 * The watchdog's search (exported for its query-plan test): a range scan of the partial
 * index on next_ms in the index's own order, stopping at the batch. Due rows only; final
 * history and rows not yet due are never read.
 */
export const WATCHDOG_SELECT = `SELECT v.machine_id, v.incarnation, v.provider_machine_id, v.watchdog_version,
       CASE WHEN v.outcome = 'terminate' THEN v.terminate_reason
            WHEN v.outcome = 'creating' THEN 'create-deadline'
            WHEN v.outcome = 'issued' AND EXISTS (SELECT 1 FROM boot_tokens b WHERE b.machine_id = v.machine_id AND b.incarnation = v.incarnation AND b.used_ms IS NULL AND b.expires_ms <= ?) THEN 'token-expired'
            ELSE 'watchdog-deadline' END AS reason
     FROM vm_launches v
     WHERE v.next_ms IS NOT NULL AND v.next_ms <= ?
     ORDER BY v.next_ms, v.watchdog_version, v.machine_id, v.incarnation
     LIMIT ?`;

/**
 * The watchdog job: launches that must end (marked to terminate; past the announce deadline
 * without enrolling; issued but the token unused past its expiry), which is exactly
 * `next_ms <= now`, at most WATCHDOG_BATCH a run, earliest next_ms first (an attempt sets it
 * to the attempt's time, so attempted rows go behind every row due earlier; ties: the least
 * attempted), each claimed before it's worked, none claimed past the budget. Returns how
 * many it attempted.
 */
export async function runVmWatchdog(env: JobEnv): Promise<number> {
  const rows = await env.db.all<{ machine_id: string; incarnation: number; provider_machine_id: string | null; watchdog_version: number; reason: string }>(
    WATCHDOG_SELECT,
    [env.now, env.now, WATCHDOG_BATCH],
  );
  let attempted = 0;
  for (const r of rows) {
    if (env.elapsedMs() >= WATCHDOG_BUDGET_MS) break;
    if (await terminateAttempt(env, r, r.reason)) attempted++;
  }
  return attempted;
}
