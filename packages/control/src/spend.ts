// The spend reads: GET /v1/projects/:projectId/spend (the meters), .../spend.csv and .../ledger.
// Read-only; the money figures are the ledger's own (ledger.ts) and the budget rules' (@sbgpu/api
// budget.ts), so a meter, a start's admission and the hard stop never disagree.
//
// A meter, per allocation, read in one statement (one snapshot of the allocation's sums and its
// machines' unbilled accrual):
// - spent: the allocation's ledger entries (billed: written once a minute has closed);
// - reserved: everything accrued but not yet billed, plus the final save of its running machines.
//   A stopped machine's unbilled minutes count exactly (pendingCharge). A running machine counts
//   from its billed-through mark: its unbilled minutes, the current minute and the final-save
//   window (the project's reserve or the machine's own save estimate, whichever is longer, plus
//   one minute), each minute in full at its pinned rate (runningBound). With no billing lag this
//   is exactly the contract's reserveCharge, pinned-minute correction included; with a lag the
//   unbilled minutes are held back too, so remaining is never overstated;
// - remaining: amount - spent - reserved, never below zero;
// - currentRatePerHour: the sum of its running machines' hourly prices;
// - asOf: the last ledger minute `spent` includes (the oldest billed-through mark among its
//   machines with unbilled accrual, at most the current minute).
// A meter is a reading, not an authorization: a start is decided by admission (start.ts), which
// also counts pending starts. A member sees their own allocation's meter and their current
// team's; assistant and above see all. Every sum is the database's or checked.

import {
  DEFAULT_POLICY,
  SPEND_CSV_GROUPINGS,
  addSplits,
  checkedAdd,
  csvDecimal,
  entrySplit,
  exactSum,
  isProviderId,
  mergePolicy,
  meterRemaining,
  minuteStart,
  projectRoleAtLeast,
  reserveSeconds,
  toCsv,
  toIso,
  usdDecimal,
  type CsvDecimal,
  type CsvValue,
  type LedgerEntry,
  type PriceSplit,
  type ProjectPolicy,
  type ProjectRole,
  type SpendCsvGrouping,
  type SpendMeter,
} from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import type { Db } from "./db.ts";
import { HttpError, SECURITY_HEADERS, json } from "./http.ts";
import { pendingCharge, runningBound, type LedgerMachine } from "./ledger.ts";

/** Ledger entries a page, at most. */
export const LEDGER_PAGE_SIZE = 200;

const ZERO: PriceSplit = { providerCost: 0, margin: 0, total: 0 };

interface MeterRow {
  kind: "alloc" | "interval";
  allocation_id: string;
  holder_kind: "member" | "team" | null;
  holder_id: string | null;
  amount: number | null;
  // (the allocation's ledger sums, as text: read exactly by exactSum)
  provider_cost: string | null;
  margin: string | null;
  total: string | null;
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

async function policyOf(db: Db, projectId: string): Promise<ProjectPolicy> {
  const r = await db.all<{ policy_json: string; final_save_reserve_minutes: number }>(
    `SELECT policy_json, final_save_reserve_minutes FROM projects WHERE id = ?`,
    [projectId],
  );
  const p = r[0];
  if (!p) throw new HttpError("notFound", "no such project");
  return { ...mergePolicy(DEFAULT_POLICY, JSON.parse(p.policy_json) as Partial<ProjectPolicy>), finalSaveReserveMinutes: p.final_save_reserve_minutes };
}

/** The meters of the project's allocations, all of them or only those `ids`. */
export async function meters(db: Db, projectId: string, nowMs: number, ids: readonly string[] | null): Promise<SpendMeter[]> {
  const policy = await policyOf(db, projectId);
  const rows = await db.all<MeterRow>(
    `SELECT 'alloc' AS kind, a.id AS allocation_id, a.holder_kind, a.holder_id, a.amount,
            (SELECT CAST(COALESCE(SUM(e.provider_cost), 0) AS TEXT) FROM ledger_entries e WHERE e.allocation_id = a.id) AS provider_cost,
            (SELECT CAST(COALESCE(SUM(e.margin), 0) AS TEXT) FROM ledger_entries e WHERE e.allocation_id = a.id) AS margin,
            (SELECT CAST(COALESCE(SUM(e.total), 0) AS TEXT) FROM ledger_entries e WHERE e.allocation_id = a.id) AS total,
            NULL AS machine_id, NULL AS billed_through_ms, NULL AS incarnation, NULL AS provider, NULL AS provider_cost_per_hour,
            NULL AS margin_bps, NULL AS start_ms, NULL AS end_ms, NULL AS save_estimate_seconds
     FROM allocations a WHERE a.project_id = ?
     UNION ALL
     SELECT 'interval', m.allocation_id, NULL, NULL, NULL, NULL, NULL, NULL, a.machine_id, m.billed_through_ms, a.incarnation, a.provider,
            a.provider_cost_per_hour, a.margin_bps, a.start_ms, a.end_ms, m.save_estimate_seconds
     FROM machine_accruals a JOIN machines m ON m.id = a.machine_id
     WHERE m.project_id = ? AND m.billed_through_ms IS NOT NULL AND (a.end_ms IS NULL OR a.end_ms > m.billed_through_ms)`,
    [projectId, projectId],
  );
  const machines = new Map<string, { m: LedgerMachine; estimate: number }>();
  for (const r of rows) {
    if (r.kind !== "interval") continue;
    let x = machines.get(r.machine_id!);
    if (!x) {
      x = { m: { id: r.machine_id!, orgId: "", projectId, allocationId: r.allocation_id, billedThroughMs: r.billed_through_ms!, intervals: [] }, estimate: r.save_estimate_seconds ?? 0 };
      machines.set(r.machine_id!, x);
    }
    x.m.intervals.push({ incarnation: r.incarnation!, provider: r.provider!, providerCostPerHour: r.provider_cost_per_hour!, marginBps: r.margin_bps!, startMs: r.start_ms!, endMs: r.end_ms });
  }
  for (const x of machines.values()) x.m.intervals.sort((a, b) => a.incarnation - b.incarnation);
  const now = minuteStart(nowMs);
  const out: SpendMeter[] = [];
  for (const a of rows) {
    if (a.kind !== "alloc" || (ids !== null && !ids.includes(a.allocation_id))) continue;
    let reserved = 0;
    let asOf = now;
    const rates: PriceSplit[] = [];
    for (const { m, estimate } of machines.values()) {
      if (m.allocationId !== a.allocation_id) continue;
      asOf = Math.min(asOf, m.billedThroughMs);
      const open = m.intervals.at(-1)!;
      if (open.endMs !== null) {
        reserved = checkedAdd(reserved, pendingCharge(m));
        continue;
      }
      const from = Math.min(m.billedThroughMs, now);
      const window = checkedAdd(checkedAdd((now - from) / 1000, reserveSeconds(policy.finalSaveReserveMinutes, estimate)), 60);
      reserved = checkedAdd(reserved, runningBound(m, from, window));
      rates.push(entrySplit(open.providerCostPerHour, 3600, open.marginBps));
    }
    const amount = a.amount!;
    const spent: PriceSplit = { providerCost: exactSum(a.provider_cost), margin: exactSum(a.margin), total: exactSum(a.total) };
    out.push({
      allocationId: a.allocation_id,
      holder: a.holder_kind === "member" ? { kind: "member", memberId: a.holder_id! } : { kind: "team", teamId: a.holder_id! },
      amount,
      spent,
      reserved,
      remaining: meterRemaining(amount, Math.max(0, spent.total), reserved),
      currentRatePerHour: rates.length > 0 ? addSplits(...rates) : ZERO,
      // (storage isn't metered by the control plane yet: none used)
      storage: { usedBytes: 0, quotaBytes: a.holder_kind === "member" ? policy.storageQuotaBytesPerMember : policy.storageQuotaBytesPerTeam },
      asOf: toIso(asOf),
    });
  }
  out.sort((x, y) => (x.holder.kind === y.holder.kind ? (x.allocationId < y.allocationId ? -1 : 1) : x.holder.kind === "member" ? -1 : 1));
  return out;
}

/** The allocations a plain member may see: their own, and their current team's. */
async function ownAllocations(db: Db, projectId: string, userId: string): Promise<string[]> {
  const r = await db.all<{ id: string }>(
    `SELECT a.id FROM allocations a JOIN members m ON m.project_id = a.project_id AND m.user_id = ? AND m.status = 'active'
     WHERE a.project_id = ? AND ((a.holder_kind = 'member' AND a.holder_id = m.id) OR (a.holder_kind = 'team' AND a.holder_id = m.team_id))`,
    [userId, projectId],
  );
  return r.map((x) => x.id);
}

// (money cells: exact decimals written as numbers, so a credit's minus is never taken for a formula)
const usd = (micros: number): CsvDecimal => csvDecimal(usdDecimal(micros));

/** The spend CSV, by member, team or UTC day, with the mock's columns. */
export async function spendCsv(db: Db, projectId: string, nowMs: number, by: SpendCsvGrouping): Promise<string> {
  const ms = new Map((await meters(db, projectId, nowMs, null)).map((m) => [m.allocationId, m]));
  const rows: CsvValue[][] = [];
  if (by === "member") {
    rows.push(["email", "name", "team", "allocation_usd", "provider_cost_usd", "margin_usd", "total_usd", "remaining_usd"]);
    const list = await db.all<{ email: string; name: string | null; team: string | null; allocation_id: string }>(
      `SELECT m.email, m.name, t.name AS team, a.id AS allocation_id FROM members m
       JOIN allocations a ON a.project_id = m.project_id AND a.holder_kind = 'member' AND a.holder_id = m.id
       LEFT JOIN teams t ON t.id = m.team_id
       WHERE m.project_id = ? AND m.status <> 'removed' ORDER BY m.email, m.id`,
      [projectId],
    );
    for (const r of list) {
      const m = ms.get(r.allocation_id)!;
      rows.push([r.email, r.name, r.team, usd(m.amount), usd(m.spent.providerCost), usd(m.spent.margin), usd(m.spent.total), usd(m.remaining)]);
    }
  } else if (by === "team") {
    rows.push(["team", "members", "allocation_usd", "provider_cost_usd", "margin_usd", "total_usd", "remaining_usd"]);
    const list = await db.all<{ name: string; members: number; allocation_id: string }>(
      `SELECT t.name, (SELECT COUNT(*) FROM members m WHERE m.team_id = t.id AND m.status <> 'removed') AS members, a.id AS allocation_id
       FROM teams t JOIN allocations a ON a.project_id = t.project_id AND a.holder_kind = 'team' AND a.holder_id = t.id
       WHERE t.project_id = ? AND t.deleted_ms IS NULL ORDER BY t.name, t.id`,
      [projectId],
    );
    for (const r of list) {
      const m = ms.get(r.allocation_id)!;
      rows.push([r.name, r.members, usd(m.amount), usd(m.spent.providerCost), usd(m.spent.margin), usd(m.spent.total), usd(m.remaining)]);
    }
  } else {
    rows.push(["date_utc", "provider_cost_usd", "margin_usd", "total_usd"]);
    const list = await db.all<{ day: string; provider_cost: string; margin: string; total: string }>(
      `SELECT strftime('%Y-%m-%d', period_start_ms / 1000, 'unixepoch') AS day,
              CAST(SUM(provider_cost) AS TEXT) AS provider_cost, CAST(SUM(margin) AS TEXT) AS margin, CAST(SUM(total) AS TEXT) AS total
       FROM ledger_entries WHERE project_id = ? GROUP BY day ORDER BY day`,
      [projectId],
    );
    for (const r of list) rows.push([r.day, usd(exactSum(r.provider_cost)), usd(exactSum(r.margin)), usd(exactSum(r.total))]);
  }
  return toCsv(rows);
}

interface EntryRow {
  id: string;
  org_id: string;
  project_id: string;
  allocation_id: string;
  kind: LedgerEntry["kind"];
  machine_id: string | null;
  provider: string | null;
  period_start_ms: number;
  seconds: number;
  provider_cost_per_hour: number | null;
  margin_bps: number;
  provider_cost: number;
  margin: number;
  total: number;
  note: string | null;
  created_ms: number;
}

const CURSOR = /^(\d{1,16})\.([a-z]{3}_[0-9a-z]{20})$/;

/** The project's ledger, newest first: a page and the cursor of the next (created_ms.id of its last entry). */
export async function ledgerPage(db: Db, projectId: string, cursor: string | null): Promise<{ items: LedgerEntry[]; next: string | null }> {
  let after: [number, string] | null = null;
  if (cursor !== null) {
    const m = CURSOR.exec(cursor);
    if (!m || !Number.isSafeInteger(Number(m[1]))) throw new HttpError("badRequest", "bad cursor");
    after = [Number(m[1]), m[2]!];
  }
  const rows = await db.all<EntryRow>(
    `SELECT id, org_id, project_id, allocation_id, kind, machine_id, provider, period_start_ms, seconds, provider_cost_per_hour,
            margin_bps, provider_cost, margin, total, note, created_ms
     FROM ledger_entries WHERE project_id = ?${after === null ? "" : " AND (created_ms < ? OR (created_ms = ? AND id < ?))"}
     ORDER BY created_ms DESC, id DESC LIMIT ?`,
    after === null ? [projectId, LEDGER_PAGE_SIZE + 1] : [projectId, after[0], after[0], after[1], LEDGER_PAGE_SIZE + 1],
  );
  const page = rows.slice(0, LEDGER_PAGE_SIZE);
  const items: LedgerEntry[] = page.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    allocationId: r.allocation_id,
    kind: r.kind,
    machineId: r.machine_id,
    provider: r.provider !== null && isProviderId(r.provider) ? r.provider : null,
    periodStart: toIso(r.period_start_ms),
    seconds: r.seconds,
    providerCostPerHour: r.provider_cost_per_hour,
    marginBps: r.margin_bps,
    amount: { providerCost: r.provider_cost, margin: r.margin, total: r.total },
    note: r.note,
    createdAt: toIso(r.created_ms),
  }));
  const last = page.at(-1);
  return { items, next: rows.length > LEDGER_PAGE_SIZE && last ? `${last.created_ms}.${last.id}` : null };
}

export const SPEND_HANDLERS: Handlers = {
  async getSpend(ctx: Ctx) {
    const { db, now } = ctx.deps;
    const projectId = ctx.params.projectId as string;
    const all = projectRoleAtLeast(ctx.projectRole as ProjectRole, "assistant");
    const ids = all ? null : await ownAllocations(db, projectId, ctx.userId as string);
    const t = now();
    const list = await meters(db, projectId, t, ids);
    const asOf = list.reduce((m, x) => Math.min(m, Date.parse(x.asOf)), minuteStart(t));
    return json(200, { meters: list, asOf: toIso(asOf) });
  },

  async getSpendCsv(ctx: Ctx) {
    const by = ctx.query.get("by");
    if (!(SPEND_CSV_GROUPINGS as readonly (string | null)[]).includes(by)) throw new HttpError("badRequest", "by must be member, team or day");
    const projectId = ctx.params.projectId as string;
    const body = await spendCsv(ctx.deps.db, projectId, ctx.deps.now(), by as SpendCsvGrouping);
    return new Response(body, {
      status: 200,
      headers: { ...SECURITY_HEADERS, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="spend-${by}.csv"` },
    });
  },

  async listLedger(ctx: Ctx) {
    return json(200, await ledgerPage(ctx.deps.db, ctx.params.projectId as string, ctx.query.get("cursor")));
  },
};
