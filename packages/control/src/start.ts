// Starting a machine: admission and the machines row (start-admission design r3, SEC and LIMITS
// clear; new machines only, resold only). The container start path calls admitStart before its
// launch intent; it ends a start that never came up with abandonStart / failStartStmts, and the
// scheduler ends one whose intent never came (failStaleStarts).
//
// admitStart is one consistent read, then one guarded batch:
// - Who: the session's user's active member row in the project (never a member the caller
//   names), within the project's dates; for a team payer, their current team.
// - The offer: one control's start path listed from the provider in this same request, at most
//   60 s old by control's clock, of exactly the requested GPU type and count. Its provider, GPU
//   type, count, data center and cost are pinned on the row, and the launch is built from them.
// - The account: control decides (resold: ours, account 'platform'); byok is refused for now.
// - The price: the all-in full-minute price (entrySplit for 60 s, times 60) at the margin control
//   resolves (the project's override, else the org's) must not exceed the policy's
//   maxPricePerHour, nor the caller's quote ceiling.
// - Money: the allocation's commitments are its accruing machines (each at the highest rate
//   among its unbilled intervals) and every admitted machine still starting with no accrual for
//   its incarnation, at its admitted rate (a pending liability). The hard stop over the
//   commitments refuses first (budgetExhausted); then canStartWithin (allocationTooLow). Both
//   fail closed. The money is read in one statement, so it is one snapshot.
// - The write: the allocation's start_version compare-and-swap, then the machine in 'starting'
//   with its area keys, its admitted facts and rate, only while no restore claims either key
//   and the member (and team) are still as read; each followed by the abort guard. So of two
//   admissions that read the same state one commits, and every committed one is counted by
//   every later read until its accrual opens (counted through its interval, never twice) or it
//   leaves 'starting'.

import {
  DEFAULT_POLICY,
  canStartWithin,
  checkedMul,
  entrySplit,
  isGpuTypeId,
  isProviderId,
  mergePolicy,
  newId,
  reserveSeconds,
  shouldHardStop,
  type MeteredMachine,
  type Offer,
  type ProjectPolicy,
  type ProviderId,
} from "@sbgpu/api";
import type { Db, Stmt } from "./db.ts";
import { stmt } from "./db.ts";
import { pendingCharge, type LedgerMachine } from "./ledger.ts";

/** How old an offer may be (control's clock) and still be admitted. */
export const OFFER_FRESH_MS = 60_000;
/** A start whose launch intent hasn't come this long after admission is failed (its liability released). */
export const START_INTENT_GRACE_MS = 120_000;
/** The hard stop's periods: until the next check, and the margin for a late check or a slow stop. */
export const HARD_STOP_PERIODS = Object.freeze({ checkIntervalSeconds: 60, safetySeconds: 60 });
/** The stale cleanup's rows per run, at most. */
export const STALE_START_BATCH = 100;

const MINUTE_MS = 60_000;
const DATA_CENTER = /^[A-Za-z0-9._-]{1,64}$/;
const COST_MAX = 1_000_000_000;

/** An offer control's start path listed from the provider adapter, stamped with control's clock at the listing. */
export interface ListedOffer {
  offer: Offer;
  listedAtMs: number;
}

export interface StartRequest {
  /** The session's authenticated user (ctx.userId): the member is theirs, never one the caller names. */
  userId: string;
  projectId: string;
  payer: "member" | "team";
  /** What the member asked for; the offer must be exactly this. */
  gpuType: string;
  gpuCount: number;
  listed: ListedOffer;
  /** The most the member agreed to pay per hour, all in (the quote they saw); optional. */
  quoteMaxPerHour?: number;
}

const REQUEST_KEYS = new Set(["userId", "projectId", "payer", "gpuType", "gpuCount", "listed", "quoteMaxPerHour"]);

/** Why an admission was refused: a closed list (the route picks the words). */
export type StartRefusal =
  | "restartNotSupported"
  | "badRequest"
  | "staleOffer"
  | "offerMismatch"
  | "notMember"
  | "noTeam"
  | "projectNotStarted"
  | "projectEnded"
  | "byokNotYetAvailable"
  | "overPolicyPrice"
  | "overQuote"
  | "hardStop"
  | "allocationTooLow"
  | "restoreInProgress"
  | "busy";

const CODE: Record<StartRefusal, "invalidState" | "badRequest" | "noCapacity" | "notFound" | "projectNotStarted" | "projectEnded" | "policy" | "priceCap" | "budgetExhausted" | "allocationTooLow" | "conflict"> = {
  restartNotSupported: "invalidState",
  badRequest: "badRequest",
  staleOffer: "noCapacity",
  offerMismatch: "badRequest",
  notMember: "notFound",
  noTeam: "notFound",
  projectNotStarted: "projectNotStarted",
  projectEnded: "projectEnded",
  byokNotYetAvailable: "policy",
  overPolicyPrice: "priceCap",
  overQuote: "priceCap",
  hardStop: "budgetExhausted",
  allocationTooLow: "allocationTooLow",
  restoreInProgress: "invalidState",
  busy: "conflict",
};

export type StartAdmission =
  | {
      ok: true;
      machineId: string;
      incarnation: 1;
      allocationId: string;
      memberAreaKey: string;
      teamAreaKey: string | null;
      /** Build the LaunchSpec from these alone; maxProviderCostPerHour is the admitted provider cost. */
      launch: { provider: ProviderId; gpuType: string; gpuCount: number; dataCenter: string; maxProviderCostPerHour: number };
      rate: { providerCostPerHour: number; marginBps: number };
      credentialKind: "ours";
      accountKind: "platform";
    }
  | { ok: false; code: (typeof CODE)[StartRefusal]; why: StartRefusal };

const refuse = (why: StartRefusal): StartAdmission => ({ ok: false, code: CODE[why], why });
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

/** The all-in hourly price of a rate, as the ledger charges full minutes: the minute's entry, times 60. */
export function hourlyPrice(providerCostPerHour: number, marginBps: number): number {
  return checkedMul(entrySplit(providerCostPerHour, 60, marginBps).total, 60);
}

interface Context {
  member_id: string;
  team_id: string | null;
  starts_ms: number;
  ends_ms: number;
  policy_json: string;
  final_save_reserve_minutes: number;
  margin_bps_override: number | null;
  org_margin_bps: number;
  billing_mode: string;
}

interface MoneyRow {
  kind: "alloc" | "interval" | "pending";
  allocation_id: string;
  amount: number | null;
  start_version: number | null;
  spent: number | null;
  adjusted: number | null;
  machine_id: string | null;
  billed_through_ms: number | null;
  incarnation: number | null;
  provider: string | null;
  provider_cost_per_hour: number | null;
  margin_bps: number | null;
  start_ms: number | null;
  end_ms: number | null;
  save_estimate_seconds: number | null;
}

/**
 * The payer allocation's money, read in one statement (one snapshot): the allocation (amount,
 * start_version, its ledger total), its machines' unbilled accrual intervals, and its admitted
 * machines still starting with no accrual for their incarnation.
 */
function moneyQuery(projectId: string, holderKind: "member" | "team", holderId: string) {
  const who = `al.project_id = ? AND al.holder_kind = ? AND al.holder_id = ?`;
  return {
    sql: `SELECT 'alloc' AS kind, al.id AS allocation_id, al.amount, al.start_version,
         (SELECT COALESCE(SUM(e.total), 0) FROM ledger_entries e WHERE e.allocation_id = al.id) AS spent,
         (SELECT COALESCE(SUM(e.total), 0) FROM ledger_entries e WHERE e.allocation_id = al.id AND e.kind <> 'compute') AS adjusted,
         NULL AS machine_id, NULL AS billed_through_ms, NULL AS incarnation, NULL AS provider, NULL AS provider_cost_per_hour,
         NULL AS margin_bps, NULL AS start_ms, NULL AS end_ms, NULL AS save_estimate_seconds
       FROM allocations al WHERE ${who}
     UNION ALL
     SELECT 'interval', m.allocation_id, NULL, NULL, NULL, NULL, a.machine_id, m.billed_through_ms, a.incarnation, a.provider,
         a.provider_cost_per_hour, a.margin_bps, a.start_ms, a.end_ms, m.save_estimate_seconds
       FROM machine_accruals a JOIN machines m ON m.id = a.machine_id JOIN allocations al ON al.id = m.allocation_id
       WHERE ${who} AND m.billed_through_ms IS NOT NULL AND (a.end_ms IS NULL OR a.end_ms > m.billed_through_ms)
     UNION ALL
     SELECT 'pending', m.allocation_id, NULL, NULL, NULL, NULL, m.id, NULL, m.incarnation, m.provider,
         m.admitted_cost_per_hour, m.admitted_margin_bps, NULL, NULL, NULL
       FROM machines m JOIN allocations al ON al.id = m.allocation_id
       WHERE ${who} AND m.state = 'starting' AND m.admitted_cost_per_hour IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM machine_accruals a WHERE a.machine_id = m.id AND a.incarnation = m.incarnation)`,
    params: [projectId, holderKind, holderId, projectId, holderKind, holderId, projectId, holderKind, holderId],
  };
}

interface Money {
  allocationId: string;
  startVersion: number;
  /** As read, for the write's guard: the allocation's amount and its non-compute ledger total (adjustments). */
  amount: number;
  adjusted: number;
  unspent: number;
  /** Every commitment: accruing machines (at their highest unbilled rate) and pending starts (at their admitted rate). */
  commitments: MeteredMachine[];
  unbilledSeconds: number;
  saveEstimateSeconds: number;
}

/** The money, or null if there is no such allocation. Throws on any figure it can't trust (the caller refuses). */
function money(rows: MoneyRow[], nowMs: number): Money | null {
  const alloc = rows.find((r) => r.kind === "alloc");
  if (!alloc) return null;
  if (!isCount(alloc.amount) || !isCount(alloc.start_version) || typeof alloc.spent !== "number" || !Number.isSafeInteger(alloc.spent) || typeof alloc.adjusted !== "number" || !Number.isSafeInteger(alloc.adjusted)) {
    throw new RangeError("allocation figures");
  }
  const machines = new Map<string, LedgerMachine & { saveEstimate: number }>();
  for (const r of rows.filter((x) => x.kind === "interval")) {
    let m = machines.get(r.machine_id!);
    if (!m) {
      m = { id: r.machine_id!, orgId: "", projectId: "", allocationId: r.allocation_id, billedThroughMs: r.billed_through_ms!, intervals: [], saveEstimate: r.save_estimate_seconds ?? 0 };
      machines.set(r.machine_id!, m);
    }
    m.intervals.push({ incarnation: r.incarnation!, provider: r.provider!, providerCostPerHour: r.provider_cost_per_hour!, marginBps: r.margin_bps!, startMs: r.start_ms!, endMs: r.end_ms });
  }
  let pending = 0;
  const commitments: MeteredMachine[] = [];
  let w0 = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  let saveEstimateSeconds = 0;
  for (const m of machines.values()) {
    m.intervals.sort((a, b) => a.startMs - b.startMs);
    const open = m.intervals.at(-1)?.endMs === null;
    if (!open) {
      pending += pendingCharge(m);
      continue;
    }
    // (an accruing machine at the highest rate and margin among its unbilled intervals: never below what the ledger will charge)
    commitments.push({
      providerCostPerHour: Math.max(...m.intervals.map((i) => i.providerCostPerHour)),
      marginBps: Math.max(...m.intervals.map((i) => i.marginBps)),
    });
    w0 = Math.min(w0, m.billedThroughMs);
    saveEstimateSeconds = Math.max(saveEstimateSeconds, m.saveEstimate);
  }
  for (const r of rows.filter((x) => x.kind === "pending")) commitments.push({ providerCostPerHour: r.provider_cost_per_hour!, marginBps: r.margin_bps! });
  const unspent = alloc.amount - alloc.spent - pending;
  if (!Number.isSafeInteger(unspent)) throw new RangeError("unspent");
  return { allocationId: alloc.allocation_id, startVersion: alloc.start_version, amount: alloc.amount, adjusted: alloc.adjusted, unspent, commitments, unbilledSeconds: Math.ceil((nowMs - w0) / 1000), saveEstimateSeconds };
}

/** The member's area key, and their team's: as 0017 pins them on a live machine. */
export const memberAreaKey = (projectId: string, memberId: string) => `m:${projectId}:${memberId}`;
export const teamAreaKey = (projectId: string, teamId: string) => `t:${projectId}:${teamId}`;

/** Admit a new machine's start, or refuse it with nothing written. */
export async function admitStart(db: Db, nowMs: number, req: StartRequest): Promise<StartAdmission> {
  // the request's shape, before anything is read: a machine named (a restart) is not this path
  if (typeof req !== "object" || req === null) return refuse("badRequest");
  if ("machineId" in req) return refuse("restartNotSupported");
  if (Object.keys(req).some((k) => !REQUEST_KEYS.has(k))) return refuse("badRequest");
  const { userId, projectId, payer, gpuType, gpuCount, listed, quoteMaxPerHour } = req;
  if (typeof userId !== "string" || typeof projectId !== "string" || (payer !== "member" && payer !== "team")) return refuse("badRequest");
  if (!isGpuTypeId(gpuType) || !Number.isSafeInteger(gpuCount) || gpuCount < 1 || gpuCount > 64) return refuse("badRequest");
  if (quoteMaxPerHour !== undefined && !isCount(quoteMaxPerHour)) return refuse("badRequest");
  // the offer: control's own listing, fresh, exactly what was asked for
  const o = listed?.offer;
  if (typeof listed !== "object" || listed === null || typeof o !== "object" || o === null || !isCount(listed.listedAtMs)) return refuse("badRequest");
  if (listed.listedAtMs > nowMs || nowMs - listed.listedAtMs > OFFER_FRESH_MS) return refuse("staleOffer");
  if (!isProviderId(o.provider) || o.provider === "vast" || typeof o.dataCenter !== "string" || !DATA_CENTER.test(o.dataCenter)) return refuse("offerMismatch");
  if (!isCount(o.providerCostPerHour) || o.providerCostPerHour > COST_MAX) return refuse("offerMismatch");
  if (o.gpuType !== gpuType || o.gpuCount !== gpuCount) return refuse("offerMismatch");

  // who, and where
  const ctx = (
    await db.all<Context>(
      `SELECT m.id AS member_id, m.team_id, p.starts_ms, p.ends_ms, p.policy_json, p.final_save_reserve_minutes, p.margin_bps_override,
              o.margin_bps AS org_margin_bps, o.billing_mode
       FROM members m JOIN projects p ON p.id = m.project_id JOIN orgs o ON o.id = p.org_id
       WHERE m.project_id = ? AND m.user_id = ? AND m.status = 'active'`,
      [projectId, userId],
    )
  )[0];
  if (!ctx) return refuse("notMember");
  if (nowMs < ctx.starts_ms) return refuse("projectNotStarted");
  if (nowMs >= ctx.ends_ms) return refuse("projectEnded");
  if (payer === "team" && ctx.team_id === null) return refuse("noTeam");
  if (ctx.billing_mode !== "resold") return refuse("byokNotYetAvailable");

  // the price
  let policy: ProjectPolicy;
  let marginBps: number;
  let price: number;
  try {
    policy = mergePolicy(DEFAULT_POLICY, JSON.parse(ctx.policy_json) as Partial<ProjectPolicy>);
    marginBps = ctx.margin_bps_override ?? ctx.org_margin_bps;
    price = hourlyPrice(o.providerCostPerHour, marginBps);
  } catch {
    return refuse("overPolicyPrice");
  }
  if (!(price <= policy.maxPricePerHour)) return refuse("overPolicyPrice");
  if (quoteMaxPerHour !== undefined && price > quoteMaxPerHour) return refuse("overQuote");

  // money: one snapshot of the payer allocation
  const holderId = payer === "member" ? ctx.member_id : ctx.team_id!;
  const q = moneyQuery(projectId, payer, holderId);
  const newMachine: MeteredMachine = { providerCostPerHour: o.providerCostPerHour, marginBps };
  let mn: Money | null;
  try {
    mn = money(await db.all<MoneyRow>(q.sql, q.params), nowMs);
  } catch {
    return refuse("hardStop");
  }
  if (!mn) return refuse("allocationTooLow");
  const periods = { ...HARD_STOP_PERIODS, reserveSeconds: 0 };
  try {
    periods.reserveSeconds = reserveSeconds(ctx.final_save_reserve_minutes, mn.saveEstimateSeconds);
  } catch {
    return refuse("hardStop");
  }
  if (shouldHardStop({ unspent: mn.unspent, machines: mn.commitments, unbilledSeconds: mn.unbilledSeconds, ...periods })) return refuse("hardStop");
  if (!canStartWithin({ unspent: mn.unspent, newMachine, running: mn.commitments, unbilledSeconds: mn.unbilledSeconds, minStartMinutes: policy.minStartMinutes, ...periods })) {
    return refuse("allocationTooLow");
  }

  // the write: the CAS, then the machine (no restore claim on either key; the member and team as read)
  const machineId = newId("machine");
  const mKey = memberAreaKey(projectId, ctx.member_id);
  const tKey = ctx.team_id === null ? null : teamAreaKey(projectId, ctx.team_id);
  const guard = stmt(`INSERT INTO enroll_guard (ok) SELECT 0 WHERE changes() <> 1`);
  try {
    await db.batch([
      // (the CAS binds every input of the money decision that can change under it: the version
      // (another admission), the amount (an allocation change) and the non-compute ledger total (an
      // adjustment). Accrual's compute entries only move money the read already counted.)
      stmt(
        `UPDATE allocations SET start_version = start_version + 1 WHERE id = ? AND start_version = ? AND amount = ?
           AND (SELECT COALESCE(SUM(e.total), 0) FROM ledger_entries e WHERE e.allocation_id = allocations.id AND e.kind <> 'compute') = ?`,
        mn.allocationId, mn.startVersion, mn.amount, mn.adjusted,
      ),
      guard,
      stmt(
        `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms,
                               member_area_key, team_area_key, admitted_cost_per_hour, admitted_margin_bps)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'starting', 1, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM area_restores r WHERE r.state = 'claimed' AND r.area_key IN (?, ?))
           AND EXISTS (SELECT 1 FROM members x WHERE x.id = ? AND x.project_id = ? AND x.user_id = ? AND x.status = 'active' AND x.team_id IS ?)
           AND EXISTS (SELECT 1 FROM projects p JOIN orgs o ON o.id = p.org_id WHERE p.id = ? AND p.starts_ms = ? AND p.ends_ms = ? AND p.policy_json = ?
             AND p.final_save_reserve_minutes = ? AND p.margin_bps_override IS ? AND o.margin_bps = ? AND o.billing_mode = 'resold')`,
        machineId, projectId, mn.allocationId, ctx.member_id, o.provider, o.gpuType, o.gpuCount, o.dataCenter, nowMs,
        mKey, tKey, o.providerCostPerHour, marginBps,
        mKey, tKey ?? mKey,
        ctx.member_id, projectId, userId, ctx.team_id,
        projectId, ctx.starts_ms, ctx.ends_ms, ctx.policy_json, ctx.final_save_reserve_minutes, ctx.margin_bps_override, ctx.org_margin_bps,
      ),
      guard,
    ]);
  } catch (e) {
    if (!(e instanceof Error && /CHECK constraint failed: ok = 1/.test(e.message))) throw e;
    // (which guard: a restore claim, or the member gone; anything else read has changed (another
    // admission, the allocation, an adjustment, the project or its organization): busy, and a retry
    // decides again on what is current)
    const claimed = await db.all(`SELECT 1 FROM area_restores WHERE state = 'claimed' AND area_key IN (?, ?)`, [mKey, tKey ?? mKey]);
    if (claimed.length > 0) return refuse("restoreInProgress");
    const still = await db.all(`SELECT 1 FROM members WHERE id = ? AND project_id = ? AND user_id = ? AND status = 'active' AND team_id IS ?`, [ctx.member_id, projectId, userId, ctx.team_id]);
    return refuse(still.length === 1 ? "busy" : "notMember");
  }
  return {
    ok: true,
    machineId,
    incarnation: 1,
    allocationId: mn.allocationId,
    memberAreaKey: mKey,
    teamAreaKey: tKey,
    launch: { provider: o.provider, gpuType: o.gpuType, gpuCount: o.gpuCount, dataCenter: o.dataCenter, maxProviderCostPerHour: o.providerCostPerHour },
    rate: { providerCostPerHour: o.providerCostPerHour, marginBps },
    credentialKind: "ours",
    accountKind: "platform",
  };
}

const toFailed = (machineId: string, incarnation: number) =>
  stmt(`UPDATE machines SET state = 'failed' WHERE id = ? AND incarnation = ? AND state = 'starting'`, machineId, incarnation);

/** A start whose launch didn't start ("not-started"): 'starting' to 'failed' at that incarnation, its liability released. For the start path's own batch. */
export function abandonStartStmts(machineId: string, incarnation: number): Stmt[] {
  return [toFailed(machineId, incarnation)];
}

/** The same, as its own batch. True if it moved the machine. */
export async function abandonStart(db: Db, machineId: string, incarnation: number): Promise<boolean> {
  const s = toFailed(machineId, incarnation);
  return (await db.run(s.sql, s.params)).changes === 1;
}

/** A launch that ended before it enrolled: for the batch that writes the launch 'terminated'. Leaves a machine that moved on alone. */
export function failStartStmts(machineId: string, incarnation: number): Stmt[] {
  return [toFailed(machineId, incarnation)];
}

/**
 * Scheduled: admitted machines still starting START_INTENT_GRACE_MS after admission with no
 * launch intent for their incarnation (a crash between the admission and the intent) fail, which
 * releases their liability. Guarded on the state, the incarnation and no intent, in one statement:
 * an intent recorded first keeps the machine; one arriving after is refused by the launches trigger.
 */
export async function failStaleStarts(db: Db, nowMs: number): Promise<number> {
  // (one statement: the candidates and the update are one snapshot, so an intent recorded first is seen)
  const r = await db.run(
    `UPDATE machines SET state = 'failed' WHERE id IN (
       SELECT m.id FROM machines m WHERE m.state = 'starting' AND m.admitted_cost_per_hour IS NOT NULL AND m.created_ms <= ?
         AND NOT EXISTS (SELECT 1 FROM launches l WHERE l.machine_id = m.id AND l.incarnation = m.incarnation)
       ORDER BY m.created_ms LIMIT ?)`,
    [nowMs - START_INTENT_GRACE_MS, STALE_START_BATCH],
  );
  return r.changes;
}
