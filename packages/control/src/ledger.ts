// The ledger: per-minute accrual, and the hard-stop check that reads it.
//
// THE LEDGER RULE (the contract's; see the notes in @sbgpu/api budget.ts):
// - One compute entry per machine per UTC minute, keyed (machine, minute), written once
//   the minute has closed and never updated.
// - Its seconds are those of all the machine's accrual intervals in that minute, summed
//   and rounded up once (at most 60): a restart within the minute adds to the same entry.
// - Its rate is PINNED: the rate of the machine's first fragment in that minute. A new
//   placement's rate applies from the next UTC minute.
// - Its charge is entrySplit(pinned rate, seconds, pinned margin).
// Each machine's billed_through_ms (a minute boundary) moves forward in the same
// transaction as its entries, and the unique (machine, minute) index makes a concurrent
// second run of the same minutes fail as a whole.

import {
  LEDGER_MINUTE_SECONDS,
  checkedAdd,
  checkedMul,
  entrySplit,
  isBasisPoints,
  newId,
  reserveSeconds,
  type PriceSplit,
} from "@sbgpu/api";
import { stmt, type Db, type Stmt } from "./db.ts";

const MINUTE_MS = LEDGER_MINUTE_SECONDS * 1000;
/** At most this many minutes per machine per accrual run (a day): an enforced ceiling. */
export const MAX_MINUTES_PER_RUN = 24 * 60;

/** One placement of a machine, with its rate snapshot, while it accrued. */
export interface AccrualInterval {
  incarnation: number;
  provider: string;
  providerCostPerHour: number;
  marginBps: number;
  startMs: number;
  endMs: number | null;
}

export interface LedgerMachine {
  id: string;
  orgId: string;
  projectId: string;
  allocationId: string;
  billedThroughMs: number;
  /** The intervals not yet fully billed, in incarnation order. */
  intervals: AccrualInterval[];
}

export interface PlannedEntry {
  periodStartMs: number;
  seconds: number;
  /** The pinned fragment's placement. */
  provider: string;
  providerCostPerHour: number;
  marginBps: number;
  split: PriceSplit;
}

export interface AccrualPlan {
  entries: PlannedEntry[];
  billedThroughMs: number;
}

const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
const ceilMinute = (ms: number) => Math.ceil(ms / MINUTE_MS) * MINUTE_MS;

function checkMs(name: string, x: unknown): asserts x is number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) throw new RangeError(`${name} must be a non-negative safe integer, got ${String(x)}`);
}

/** Refuses a machine whose intervals are malformed, unordered, overlapping, or open before the last. */
export function checkLedgerMachine(m: LedgerMachine): void {
  checkMs("billedThroughMs", m.billedThroughMs);
  if (m.billedThroughMs % MINUTE_MS !== 0) throw new RangeError("billedThroughMs is not a minute boundary");
  let prevEnd = -1;
  let prevInc = -1;
  m.intervals.forEach((iv, i) => {
    checkMs(`interval ${i} incarnation`, iv.incarnation);
    checkMs(`interval ${i} startMs`, iv.startMs);
    checkMs(`interval ${i} providerCostPerHour`, iv.providerCostPerHour);
    if (!isBasisPoints(iv.marginBps)) throw new RangeError(`interval ${i} marginBps is invalid`);
    if (iv.incarnation <= prevInc) throw new RangeError("intervals are not in incarnation order");
    if (iv.startMs < prevEnd) throw new RangeError("intervals overlap");
    if (iv.endMs === null) {
      if (i !== m.intervals.length - 1) throw new RangeError("only the last interval may be open");
    } else {
      checkMs(`interval ${i} endMs`, iv.endMs);
      if (iv.endMs < iv.startMs) throw new RangeError("an interval ends before it starts");
      prevEnd = iv.endMs;
    }
    prevInc = iv.incarnation;
  });
}

/** The machine's fragments in the minute starting at `b`, in time order. */
function fragments(intervals: readonly AccrualInterval[], b: number, nowMs: number): Array<{ iv: AccrualInterval; ms: number }> {
  const out: Array<{ iv: AccrualInterval; ms: number }> = [];
  const e = b + MINUTE_MS;
  for (const iv of intervals) {
    const from = Math.max(b, iv.startMs);
    const to = Math.min(e, iv.endMs ?? nowMs);
    if (to > from) out.push({ iv, ms: to - from });
  }
  return out;
}

/** The entry for one minute's fragments: seconds summed, rounded up once; the first fragment's rate. */
function minuteEntry(b: number, frags: Array<{ iv: AccrualInterval; ms: number }>): PlannedEntry | null {
  if (frags.length === 0) return null;
  let ms = 0;
  for (const f of frags) ms += f.ms;
  // fragments in a minute are disjoint, so ms <= 60_000 and seconds <= 60
  const seconds = Math.ceil(ms / 1000);
  const pin = frags[0]!.iv;
  return {
    periodStartMs: b,
    seconds,
    provider: pin.provider,
    providerCostPerHour: pin.providerCostPerHour,
    marginBps: pin.marginBps,
    split: entrySplit(pin.providerCostPerHour, seconds, pin.marginBps),
  };
}

/** The total a full minute at this placement's rate costs. */
export function fullMinuteCharge(iv: { providerCostPerHour: number; marginBps: number }): number {
  return entrySplit(iv.providerCostPerHour, LEDGER_MINUTE_SECONDS, iv.marginBps).total;
}

/**
 * The entries to write for one machine at `nowMs`: every CLOSED minute (minute end <=
 * now) from billedThroughMs on, up to `maxMinutes` (at most MAX_MINUTES_PER_RUN).
 * Minutes with no accrual get no entry but are passed; billing stops after the end of
 * the last closed interval when no interval is open.
 */
export function planAccrual(m: LedgerMachine, nowMs: number, maxMinutes = MAX_MINUTES_PER_RUN): AccrualPlan {
  checkMs("nowMs", nowMs);
  checkMs("maxMinutes", maxMinutes);
  if (maxMinutes > MAX_MINUTES_PER_RUN) throw new RangeError(`maxMinutes is capped at ${MAX_MINUTES_PER_RUN}`);
  checkLedgerMachine(m);
  const last = m.intervals[m.intervals.length - 1];
  const doneAt = last === undefined ? m.billedThroughMs : last.endMs === null ? null : ceilMinute(last.endMs);
  const entries: PlannedEntry[] = [];
  let b = m.billedThroughMs;
  for (let n = 0; n < maxMinutes; n++) {
    if (doneAt !== null && b >= doneAt) break;
    if (b + MINUTE_MS > nowMs) break;
    const e = minuteEntry(b, fragments(m.intervals, b, nowMs));
    if (e) entries.push(e);
    b += MINUTE_MS;
  }
  return { entries, billedThroughMs: b };
}

/**
 * Everything still to be charged for a machine with no open interval, in space and time
 * linear in its intervals (not its minutes): the boundary minutes (those containing an
 * interval's unaligned start or end) are charged as the ledger will charge them, and
 * every other minute is a full minute of exactly one interval.
 */
export function pendingCharge(m: LedgerMachine): number {
  checkLedgerMachine(m);
  if (m.intervals.some((iv) => iv.endMs === null)) throw new RangeError("pendingCharge needs every interval closed");
  const B = m.billedThroughMs;
  const ivs = m.intervals.filter((iv) => (iv.endMs as number) > B);
  const boundary = new Set<number>();
  let total = 0;
  for (const iv of ivs) {
    const s = Math.max(iv.startMs, B);
    const e = iv.endMs as number;
    if (s % MINUTE_MS !== 0) boundary.add(floorMinute(s));
    if (e % MINUTE_MS !== 0) boundary.add(floorMinute(e));
    // whole minutes inside [s, e) that hold no other fragment
    const full = Math.max(0, (floorMinute(e) - ceilMinute(s)) / MINUTE_MS);
    total = checkedAdd(total, checkedMul(full, fullMinuteCharge(iv)));
  }
  const endAll = Math.max(...ivs.map((iv) => iv.endMs as number), B);
  for (const b of boundary) {
    const e = minuteEntry(b, fragments(ivs, b, endAll));
    if (e) total = checkedAdd(total, e.split.total);
  }
  return total;
}

/**
 * The most the ledger can charge a RUNNING machine for the window of `windowSeconds`
 * from the minute boundary W0: the open placement's rate for minutes after the one it
 * started in; the pinned rate (first fragment's) for that minute; and, for any earlier
 * unbilled minutes (only when accrual has lagged), the highest rate and margin among its
 * unbilled intervals. Each minute is counted as a full minute.
 */
export function runningBound(m: LedgerMachine, w0: number, windowSeconds: number): number {
  checkLedgerMachine(m);
  checkMs("w0", w0);
  checkMs("windowSeconds", windowSeconds);
  if (w0 % MINUTE_MS !== 0) throw new RangeError("w0 is not a minute boundary");
  const open = m.intervals[m.intervals.length - 1];
  if (!open || open.endMs !== null) throw new RangeError("runningBound needs an open interval");
  const n = Math.ceil(windowSeconds / LEDGER_MINUTE_SECONDS);
  const c = floorMinute(open.startMs);
  const pinned = (fragments(m.intervals, c, open.startMs + MINUTE_MS)[0]?.iv ?? open) as AccrualInterval;
  let maxRate = 0;
  let maxBps = 0;
  for (const iv of m.intervals) {
    maxRate = Math.max(maxRate, iv.providerCostPerHour);
    maxBps = Math.max(maxBps, iv.marginBps);
  }
  const idx = (c - w0) / MINUTE_MS; // the window index of minute c (may be < 0 or >= n)
  const nBefore = Math.min(n, Math.max(0, idx));
  const nAt = idx >= 0 && idx < n ? 1 : 0;
  const nAfter = n - nBefore - nAt;
  let t = checkedMul(nBefore, fullMinuteCharge({ providerCostPerHour: maxRate, marginBps: maxBps }));
  t = checkedAdd(t, checkedMul(nAt, fullMinuteCharge(pinned)));
  return checkedAdd(t, checkedMul(nAfter, fullMinuteCharge(open)));
}

// ---------------------------------------------------------------- database

interface IntervalRow {
  machine_id: string;
  org_id: string;
  project_id: string;
  allocation_id: string;
  billed_through_ms: number;
  incarnation: number;
  provider: string;
  provider_cost_per_hour: number;
  margin_bps: number;
  start_ms: number;
  end_ms: number | null;
  amount: number;
  final_save_reserve_minutes: number;
  save_estimate_seconds: number;
}

/** Every machine with unbilled accrual, with its unbilled intervals. */
async function loadUnbilled(db: Db): Promise<Array<{ m: LedgerMachine; row: IntervalRow }>> {
  const rows = await db.all<IntervalRow>(
    `SELECT a.machine_id, p.org_id, m.project_id, m.allocation_id, m.billed_through_ms, a.incarnation, a.provider,
       a.provider_cost_per_hour, a.margin_bps, a.start_ms, a.end_ms, al.amount, p.final_save_reserve_minutes,
       m.save_estimate_seconds
     FROM machine_accruals a
     JOIN machines m ON m.id = a.machine_id
     JOIN projects p ON p.id = m.project_id
     JOIN allocations al ON al.id = m.allocation_id
     WHERE m.billed_through_ms IS NOT NULL AND (a.end_ms IS NULL OR a.end_ms > m.billed_through_ms)
     ORDER BY a.machine_id, a.incarnation`,
  );
  const byMachine = new Map<string, { m: LedgerMachine; row: IntervalRow }>();
  for (const r of rows) {
    let x = byMachine.get(r.machine_id);
    if (!x) {
      x = {
        m: { id: r.machine_id, orgId: r.org_id, projectId: r.project_id, allocationId: r.allocation_id, billedThroughMs: r.billed_through_ms, intervals: [] },
        row: r,
      };
      byMachine.set(r.machine_id, x);
    }
    x.m.intervals.push({
      incarnation: r.incarnation,
      provider: r.provider,
      providerCostPerHour: r.provider_cost_per_hour,
      marginBps: r.margin_bps,
      startMs: r.start_ms,
      endMs: r.end_ms,
    });
  }
  return [...byMachine.values()];
}

/** Open a placement's accrual interval (sets billed-through on the first one). */
export function openAccrual(
  machineId: string,
  iv: { incarnation: number; provider: string; providerCostPerHour: number; marginBps: number; startMs: number },
): Stmt[] {
  return [
    stmt(
      `INSERT INTO machine_accruals (machine_id, incarnation, provider, provider_cost_per_hour, margin_bps, start_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      machineId,
      iv.incarnation,
      iv.provider,
      iv.providerCostPerHour,
      iv.marginBps,
      iv.startMs,
    ),
    stmt(`UPDATE machines SET billed_through_ms = COALESCE(billed_through_ms, ?) WHERE id = ?`, floorMinute(iv.startMs), machineId),
  ];
}

/** Close the open interval of a placement, when the provider confirms the stop. */
export function closeAccrual(machineId: string, incarnation: number, endMs: number): Stmt[] {
  return [stmt(`UPDATE machine_accruals SET end_ms = ? WHERE machine_id = ? AND incarnation = ? AND end_ms IS NULL`, endMs, machineId, incarnation)];
}

/** The writes for one machine's plan: its entries and the guarded billed-through move. */
export function accrualStatements(m: LedgerMachine, plan: AccrualPlan, nowMs: number): Stmt[] {
  const stmts = plan.entries.map((e) =>
    stmt(
      `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, machine_id, provider, period_start_ms,
        seconds, provider_cost_per_hour, margin_bps, provider_cost, margin, total, created_ms)
       VALUES (?, ?, ?, ?, 'compute', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("ledgerEntry"),
      m.orgId,
      m.projectId,
      m.allocationId,
      m.id,
      e.provider,
      e.periodStartMs,
      e.seconds,
      e.providerCostPerHour,
      e.marginBps,
      e.split.providerCost,
      e.split.margin,
      e.split.total,
      nowMs,
    ),
  );
  stmts.push(
    stmt(`UPDATE machines SET billed_through_ms = ? WHERE id = ? AND billed_through_ms = ?`, plan.billedThroughMs, m.id, m.billedThroughMs),
  );
  return stmts;
}

export interface AccrualReport {
  machines: number;
  entries: number;
  /** Machines whose batch failed (e.g. another run billed the same minutes first) or whose data is malformed. */
  failed: string[];
}

/** Bill every machine's closed minutes up to `nowMs`; each machine in its own transaction. */
export async function accrueAll(db: Db, nowMs: number, maxMinutes = MAX_MINUTES_PER_RUN): Promise<AccrualReport> {
  const report: AccrualReport = { machines: 0, entries: 0, failed: [] };
  for (const { m } of await loadUnbilled(db)) {
    try {
      const plan = planAccrual(m, nowMs, maxMinutes);
      if (plan.billedThroughMs === m.billedThroughMs) continue;
      await db.batch(accrualStatements(m, plan, nowMs));
      report.machines++;
      report.entries += plan.entries.length;
    } catch {
      report.failed.push(m.id);
    }
  }
  return report;
}

export interface HardStopOptions {
  checkIntervalSeconds: number;
  safetySeconds: number;
}

export interface HardStop {
  allocationId: string;
  machineIds: string[];
  /** Null when the figures couldn't be computed (the stop is then fail-closed). */
  unspent: number | null;
  threshold: number | null;
}

/**
 * The allocations whose running machines must stop now (saving first). For each
 * allocation with a running machine:
 *   unspent = amount - its ledger entries - the exact pending charge of its machines
 *             with no open interval (pendingCharge);
 *   threshold = the sum of runningBound over its running machines, for the window from
 *             the oldest billed boundary among them of unbilled + check + safety +
 *             reserve seconds (the contract's hard-stop periods);
 *   stop when unspent < threshold.
 * Any invalid figure or overflow stops the allocation (fail closed).
 */
export async function findHardStops(db: Db, nowMs: number, opts: HardStopOptions): Promise<HardStop[]> {
  const byAllocation = new Map<string, Array<{ m: LedgerMachine; row: IntervalRow }>>();
  for (const x of await loadUnbilled(db)) {
    const list = byAllocation.get(x.m.allocationId) ?? [];
    list.push(x);
    byAllocation.set(x.m.allocationId, list);
  }
  const stops: HardStop[] = [];
  for (const [allocationId, list] of byAllocation) {
    const running = list.filter((x) => x.m.intervals.at(-1)?.endMs === null);
    if (running.length === 0) continue;
    let unspent: number | null = null;
    let threshold: number | null = null;
    let stop = true;
    try {
      const spentRows = await db.all<{ spent: number | null }>(`SELECT SUM(total) AS spent FROM ledger_entries WHERE allocation_id = ?`, [allocationId]);
      let pending = 0;
      for (const x of list) if (x.m.intervals.at(-1)?.endMs !== null) pending = checkedAdd(pending, pendingCharge(x.m));
      const amount = list[0]!.row.amount;
      // amount and the checked sum are both in [0, MAX_SAFE_INTEGER], so this is safe
      unspent = amount - checkedAdd(spentRows[0]?.spent ?? 0, pending);
      const w0 = Math.min(...running.map((x) => x.m.billedThroughMs));
      const unbilled = Math.ceil((nowMs - w0) / 1000);
      const reserve = reserveSeconds(list[0]!.row.final_save_reserve_minutes, Math.max(...running.map((x) => x.row.save_estimate_seconds)));
      let window = 0;
      for (const [name, v] of [["unbilled", unbilled], ["check", opts.checkIntervalSeconds], ["safety", opts.safetySeconds], ["reserve", reserve]] as const) {
        checkMs(name, v);
        window = checkedAdd(window, v);
      }
      let t = 0;
      for (const x of running) t = checkedAdd(t, runningBound(x.m, w0, window));
      threshold = t;
      stop = unspent < threshold;
    } catch {
      stop = true;
    }
    if (stop) stops.push({ allocationId, machineIds: running.map((x) => x.m.id), unspent, threshold });
  }
  return stops;
}
