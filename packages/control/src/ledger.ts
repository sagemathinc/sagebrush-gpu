// The ledger: per-minute accrual, and the hard-stop check that reads it.
//
// THE LEDGER RULE (the contract's, see @sbgpu/api budget.ts): one compute entry per
// machine per UTC minute, charging entrySplit(rate, seconds, marginBps) for the seconds
// the machine accrued in that minute, at the rate recorded on the machine at start. A
// minute is billed once its usage is final: when the minute has ended, or when the
// machine's accrual has ended inside it. Entries are never updated. Each machine's
// billed_through_ms (always a minute boundary) moves forward in the same transaction as
// its entries, and the unique (machine, minute) index makes a concurrent second run of
// the same minutes fail as a whole.

import {
  LEDGER_MINUTE_SECONDS,
  entrySplit,
  newId,
  reserveSeconds,
  shouldHardStop,
  hardStopThreshold,
  type HardStopInput,
  type PriceSplit,
} from "@sbgpu/api";
import { stmt, type Db, type Stmt } from "./db.ts";

const MINUTE_MS = LEDGER_MINUTE_SECONDS * 1000;
/** At most this many minutes per machine per run (a day), to bound a batch. */
export const MAX_MINUTES_PER_RUN = 24 * 60;

export interface AccrualMachine {
  id: string;
  orgId: string;
  projectId: string;
  allocationId: string;
  provider: string;
  providerCostPerHour: number;
  marginBps: number;
  accrualStartMs: number;
  accrualEndMs: number | null;
  billedThroughMs: number;
}

export interface PlannedEntry {
  periodStartMs: number;
  seconds: number;
  split: PriceSplit;
}

export interface AccrualPlan {
  entries: PlannedEntry[];
  billedThroughMs: number;
}

function checkMs(name: string, x: unknown): asserts x is number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) throw new RangeError(`${name} must be a non-negative safe integer, got ${String(x)}`);
}

/**
 * The entries to write for one machine at `nowMs`: every minute from billedThroughMs on
 * whose usage is final, up to `maxMinutes` of them. Minutes with no accrual are skipped
 * (no entry), but still passed.
 */
export function planAccrual(m: AccrualMachine, nowMs: number, maxMinutes = MAX_MINUTES_PER_RUN): AccrualPlan {
  checkMs("nowMs", nowMs);
  checkMs("accrualStartMs", m.accrualStartMs);
  checkMs("billedThroughMs", m.billedThroughMs);
  checkMs("maxMinutes", maxMinutes);
  if (m.accrualEndMs !== null) {
    checkMs("accrualEndMs", m.accrualEndMs);
    if (m.accrualEndMs < m.accrualStartMs) throw new RangeError("accrual ends before it starts");
  }
  if (m.billedThroughMs % MINUTE_MS !== 0) throw new RangeError("billedThroughMs is not a minute boundary");
  const end = m.accrualEndMs;
  const entries: PlannedEntry[] = [];
  let b = m.billedThroughMs;
  for (let n = 0; n < maxMinutes; n++) {
    if (end !== null && b >= end) break;
    const minuteEnd = b + MINUTE_MS;
    const complete = minuteEnd <= nowMs;
    const finalPartial = end !== null && end <= nowMs && end < minuteEnd;
    if (!complete && !finalPartial) break;
    const from = Math.max(b, m.accrualStartMs);
    const to = end === null ? minuteEnd : Math.min(minuteEnd, end);
    if (to > from) {
      // Part of a second is billed as a second; a minute never exceeds 60.
      const seconds = Math.ceil((to - from) / 1000);
      entries.push({ periodStartMs: b, seconds, split: entrySplit(m.providerCostPerHour, seconds, m.marginBps) });
    }
    b = minuteEnd;
  }
  return { entries, billedThroughMs: b };
}

interface MachineRow {
  id: string;
  org_id: string;
  project_id: string;
  allocation_id: string;
  provider: string;
  provider_cost_per_hour: number;
  margin_bps: number;
  accrual_start_ms: number;
  accrual_end_ms: number | null;
  billed_through_ms: number;
}

const MACHINE_COLUMNS = `m.id, p.org_id, m.project_id, m.allocation_id, m.provider, m.provider_cost_per_hour,
  m.margin_bps, m.accrual_start_ms, m.accrual_end_ms, m.billed_through_ms`;

function toMachine(r: MachineRow): AccrualMachine {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    allocationId: r.allocation_id,
    provider: r.provider,
    providerCostPerHour: r.provider_cost_per_hour,
    marginBps: r.margin_bps,
    accrualStartMs: r.accrual_start_ms,
    accrualEndMs: r.accrual_end_ms,
    billedThroughMs: r.billed_through_ms,
  };
}

/** The writes for one machine's plan: its entries and the guarded billed-through move. */
export function accrualStatements(m: AccrualMachine, plan: AccrualPlan, nowMs: number): Stmt[] {
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
      m.provider,
      e.periodStartMs,
      e.seconds,
      m.providerCostPerHour,
      m.marginBps,
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
  /** Machines whose batch failed (e.g. another run billed the same minutes first). */
  failed: string[];
}

/** Bill every machine's final minutes up to `nowMs`; each machine in its own transaction. */
export async function accrueAll(db: Db, nowMs: number, maxMinutes = MAX_MINUTES_PER_RUN): Promise<AccrualReport> {
  const rows = await db.all<MachineRow>(
    `SELECT ${MACHINE_COLUMNS} FROM machines m JOIN projects p ON p.id = m.project_id
     WHERE m.accrual_start_ms IS NOT NULL AND (m.accrual_end_ms IS NULL OR m.billed_through_ms < m.accrual_end_ms)`,
  );
  const report: AccrualReport = { machines: 0, entries: 0, failed: [] };
  for (const r of rows) {
    const m = toMachine(r);
    const plan = planAccrual(m, nowMs, maxMinutes);
    if (plan.billedThroughMs === m.billedThroughMs) continue;
    try {
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
  unspent: number;
  threshold: number | null;
}

interface ActiveRow extends MachineRow {
  amount: number;
  final_save_reserve_minutes: number;
  save_estimate_seconds: number;
}

/**
 * The allocations whose accruing machines must stop now (saving first), by the contract's
 * shouldHardStop. unspent = the allocation's amount, minus its ledger entries, minus the
 * exact charge still to be written for machines whose accrual has ended. The window
 * starts at the oldest billed-through boundary of its running machines.
 */
export async function findHardStops(db: Db, nowMs: number, opts: HardStopOptions): Promise<HardStop[]> {
  const rows = await db.all<ActiveRow>(
    `SELECT ${MACHINE_COLUMNS}, a.amount, p.final_save_reserve_minutes, m.save_estimate_seconds
     FROM machines m JOIN allocations a ON a.id = m.allocation_id JOIN projects p ON p.id = m.project_id
     WHERE m.accrual_start_ms IS NOT NULL AND (m.accrual_end_ms IS NULL OR m.billed_through_ms < m.accrual_end_ms)`,
  );
  const byAllocation = new Map<string, ActiveRow[]>();
  for (const r of rows) {
    const list = byAllocation.get(r.allocation_id) ?? [];
    list.push(r);
    byAllocation.set(r.allocation_id, list);
  }
  const stops: HardStop[] = [];
  for (const [allocationId, list] of byAllocation) {
    const running = list.filter((r) => r.accrual_end_ms === null);
    if (running.length === 0) continue;
    const spentRows = await db.all<{ spent: number | null }>(`SELECT SUM(total) AS spent FROM ledger_entries WHERE allocation_id = ?`, [allocationId]);
    let pending = 0;
    for (const r of list) {
      if (r.accrual_end_ms === null) continue;
      for (const e of planAccrual(toMachine(r), Math.max(nowMs, r.accrual_end_ms), Number.MAX_SAFE_INTEGER).entries) pending += e.split.total;
    }
    const first = list[0] as ActiveRow;
    const unspent = first.amount - (spentRows[0]?.spent ?? 0) - pending;
    const oldest = Math.min(...running.map((r) => r.billed_through_ms));
    const input: HardStopInput = {
      unspent,
      machines: running.map((r) => ({ providerCostPerHour: r.provider_cost_per_hour, marginBps: r.margin_bps })),
      unbilledSeconds: Math.ceil((nowMs - oldest) / 1000),
      checkIntervalSeconds: opts.checkIntervalSeconds,
      safetySeconds: opts.safetySeconds,
      reserveSeconds: 0,
    };
    let threshold: number | null = null;
    let stop: boolean;
    try {
      input.reserveSeconds = reserveSeconds(first.final_save_reserve_minutes, Math.max(...running.map((r) => r.save_estimate_seconds)));
      threshold = hardStopThreshold(input);
      stop = shouldHardStop(input);
    } catch {
      stop = true; // fail closed
    }
    if (stop) stops.push({ allocationId, machineIds: running.map((r) => r.id), unspent, threshold });
  }
  return stops;
}
