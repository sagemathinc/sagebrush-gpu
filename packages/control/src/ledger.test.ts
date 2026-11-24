import { test } from "node:test";
import assert from "node:assert/strict";
import { canStartWithin, chargeBound, entrySplit, newId, reserveSeconds } from "@sbgpu/api";
import {
  MAX_MINUTES_PER_RUN,
  accrualStatements,
  accrueAll,
  closeAccrual,
  findHardStops,
  fullMinuteCharge,
  openAccrual,
  pendingCharge,
  planAccrual,
  runningBound,
  type AccrualInterval,
  type LedgerMachine,
} from "./ledger.ts";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import { d1Db, stmt, type D1Like, type SqlValue } from "./db.ts";

const T0 = Date.UTC(2027, 1, 1, 10, 0, 0); // a minute boundary
const MIN = 60_000;
const MAX = Number.MAX_SAFE_INTEGER;

const iv = (o: Partial<AccrualInterval> = {}): AccrualInterval => ({
  incarnation: 0,
  provider: "runpod",
  providerCostPerHour: 3_600_000,
  marginBps: 3000,
  startMs: T0,
  endMs: null,
  ...o,
});

function machine(intervals: AccrualInterval[] = [iv()], billedThroughMs = T0): LedgerMachine {
  return { id: "mch_x", orgId: "org_x", projectId: "prj_x", allocationId: "alc_x", billedThroughMs, intervals };
}

const secs = (m: LedgerMachine, now: number) => planAccrual(m, now).entries.map((e) => [(e.periodStartMs - T0) / MIN, e.seconds]);

// ---------------------------------------------------------------- planning

test("planAccrual bills closed minutes, prorating the first", () => {
  const p = planAccrual(machine([iv({ startMs: T0 + 30_000 })]), T0 + 3 * MIN + 10_000);
  assert.deepEqual(p.entries.map((e) => [(e.periodStartMs - T0) / MIN, e.seconds]), [[0, 30], [1, 60], [2, 60]]);
  assert.equal(p.billedThroughMs, T0 + 3 * MIN);
  assert.deepEqual(p.entries[1]!.split, entrySplit(3_600_000, 60, 3000));
  assert.deepEqual(planAccrual(machine(), T0 + MIN - 1).entries, []); // the current minute waits
  assert.equal(planAccrual(machine(), T0 + MIN - 1).billedThroughMs, T0);
  assert.equal(planAccrual(machine(), T0 + MIN).entries.length, 1);
});

test("planAccrual: partial seconds round up once, never past 60", () => {
  assert.deepEqual(secs(machine([iv({ startMs: T0 + 29_999 })]), T0 + MIN), [[0, 31]]);
  assert.deepEqual(secs(machine([iv({ startMs: T0 + 1 })]), T0 + MIN), [[0, 60]]);
  assert.deepEqual(secs(machine([iv({ startMs: T0 + 59_999 })]), T0 + MIN), [[0, 1]]);
});

test("planAccrual: an ended machine's last minute waits until the minute closes", () => {
  const m = machine([iv({ endMs: T0 + 2 * MIN + 20_000 })]);
  assert.deepEqual(secs(m, T0 + 2 * MIN + 25_000), [[0, 60], [1, 60]]);
  assert.deepEqual(secs(m, T0 + 3 * MIN), [[0, 60], [1, 60], [2, 20]]);
  const p = planAccrual(m, T0 + 3 * MIN);
  assert.equal(p.billedThroughMs, T0 + 3 * MIN);
  assert.deepEqual(planAccrual({ ...m, billedThroughMs: p.billedThroughMs }, T0 + 99 * MIN).entries, []);
  assert.equal(planAccrual({ ...m, billedThroughMs: p.billedThroughMs }, T0 + 99 * MIN).billedThroughMs, T0 + 3 * MIN);
  // an end exactly on a boundary leaves no partial minute
  const q = planAccrual(machine([iv({ endMs: T0 + 2 * MIN })]), T0 + 5 * MIN);
  assert.deepEqual(q.entries.map((e) => e.seconds), [60, 60]);
  assert.equal(q.billedThroughMs, T0 + 2 * MIN);
  // zero-length intervals: no entry, but the minute passes
  const mid = planAccrual(machine([iv({ startMs: T0 + 10_000, endMs: T0 + 10_000 })]), T0 + 5 * MIN);
  assert.deepEqual(mid.entries, []);
  assert.equal(mid.billedThroughMs, T0 + MIN);
});

test("planAccrual: a restart within a minute adds to its entry at the PINNED (first fragment's) rate", () => {
  const m = machine([
    iv({ incarnation: 0, providerCostPerHour: 3_600_000, startMs: T0 + 10_000, endMs: T0 + 20_000 }),
    iv({ incarnation: 1, provider: "hyperstack", providerCostPerHour: 1_800_000, marginBps: 0, startMs: T0 + 30_000, endMs: T0 + MIN + 45_500 }),
  ]);
  const p = planAccrual(m, T0 + 2 * MIN);
  assert.equal(p.entries.length, 2);
  const [a, b] = p.entries;
  assert.equal(a!.seconds, 40); // 10 s + 30 s, one entry
  assert.deepEqual([a!.provider, a!.providerCostPerHour, a!.marginBps], ["runpod", 3_600_000, 3000]);
  assert.deepEqual(a!.split, entrySplit(3_600_000, 40, 3000));
  // the new placement's rate applies from the next minute
  assert.equal(b!.seconds, 46);
  assert.deepEqual([b!.provider, b!.providerCostPerHour, b!.marginBps], ["hyperstack", 1_800_000, 0]);
  // fragments summing past 59 s with sub-second gaps still round once, capped at 60
  const two = machine([iv({ incarnation: 0, startMs: T0, endMs: T0 + 30_000 }), iv({ incarnation: 1, startMs: T0 + 30_000 })]);
  assert.deepEqual(secs(two, T0 + MIN), [[0, 60]]);
});

test("planAccrual enforces its per-run ceiling and refuses malformed machines", () => {
  const p = planAccrual(machine(), T0 + 10 * MIN, 4);
  assert.equal(p.entries.length, 4);
  assert.equal(p.billedThroughMs, T0 + 4 * MIN);
  assert.equal(planAccrual(machine(), T0 + 3000 * MIN).entries.length, MAX_MINUTES_PER_RUN);
  assert.throws(() => planAccrual(machine(), T0 + MIN, MAX_MINUTES_PER_RUN + 1), RangeError);
  assert.throws(() => planAccrual(machine(), T0 + MIN, -1), RangeError);
  assert.throws(() => planAccrual(machine([iv()], T0 + 1), T0 + MIN), RangeError);
  assert.throws(() => planAccrual(machine([iv({ endMs: T0 - 1 })]), T0 + MIN), RangeError);
  assert.throws(() => planAccrual(machine(), NaN), RangeError);
  assert.throws(() => planAccrual(machine([iv({ startMs: 1.5 })]), T0), RangeError);
  assert.throws(() => planAccrual(machine([iv({ providerCostPerHour: -1 })]), T0 + MIN), RangeError);
  assert.throws(() => planAccrual(machine([iv({ marginBps: 0.5 })]), T0 + MIN), RangeError);
  assert.throws(() => planAccrual(machine([iv({ incarnation: 0, endMs: null }), iv({ incarnation: 1, startMs: T0 + MIN })]), T0 + MIN), RangeError);
  assert.throws(() => planAccrual(machine([iv({ incarnation: 0, endMs: T0 + MIN }), iv({ incarnation: 1, startMs: T0 + 30_000 })]), T0 + MIN), RangeError);
  assert.throws(() => planAccrual(machine([iv({ incarnation: 1, endMs: T0 + 1 }), iv({ incarnation: 0, startMs: T0 + MIN })]), T0 + MIN), RangeError);
});

// ---------------------------------------------------------------- pending and bounds

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** Every entry the ledger will ever write, by planning in capped runs. */
function plannedTotal(m: LedgerMachine, now: number): number {
  let total = 0;
  let cur = m;
  for (;;) {
    const p = planAccrual(cur, now);
    for (const e of p.entries) total += e.split.total;
    if (p.billedThroughMs === cur.billedThroughMs) return total;
    cur = { ...cur, billedThroughMs: p.billedThroughMs };
  }
}

test("pendingCharge equals what the ledger will write, for random restarts and long backlogs", () => {
  const r = rng(11);
  for (let trial = 0; trial < 400; trial++) {
    const intervals: AccrualInterval[] = [];
    let t = T0 + int(r, 0, 59_999);
    const n = int(r, 1, 5);
    for (let k = 0; k < n; k++) {
      const len = r() < 0.3 ? int(r, 0, 59_999) : int(r, 0, 3000 * MIN);
      intervals.push(iv({ incarnation: k, providerCostPerHour: int(r, 0, 9_000_000), marginBps: int(r, 0, 9000), startMs: t, endMs: t + len }));
      t += len + (r() < 0.5 ? int(r, 0, 59_999) : int(r, 0, 10 * MIN)); // restarts often land in the same minute
    }
    const m = machine(intervals, Math.floor(intervals[0]!.startMs / MIN) * MIN);
    assert.equal(pendingCharge(m), plannedTotal(m, t + 2 * MIN), `trial ${trial}`);
  }
});

test("pendingCharge is bounded by intervals, not minutes: ten years of backlog", () => {
  const years = 10 * 365 * 24 * 60; // minutes
  const m = machine([iv({ providerCostPerHour: 3_600_000, marginBps: 0, startMs: T0, endMs: T0 + years * MIN + 30_000 })]);
  const t = performance.now();
  assert.equal(pendingCharge(m), years * 60_000 + 30_000);
  assert.ok(performance.now() - t < 50, "pendingCharge took too long");
  assert.throws(() => pendingCharge(machine([iv({ endMs: null })])), RangeError);
  assert.throws(() => pendingCharge(machine([iv({ incarnation: 0, endMs: T0 + MIN }), iv({ incarnation: 1, startMs: T0 + MIN })], T0 + 2 * MIN)), RangeError);
  assert.throws(() => pendingCharge(machine([iv({ providerCostPerHour: 2 ** 50, marginBps: 0, endMs: T0 + years * MIN })])), RangeError);
  // each minute is safe (2^40/h -> ~1.8e10 a minute), the count times it is not
  assert.throws(() => pendingCharge(machine([iv({ providerCostPerHour: 2 ** 40, marginBps: 0, endMs: T0 + 1_000_000 * MIN })])), RangeError);
  // already billed parts are not pending
  assert.equal(pendingCharge(machine([iv({ marginBps: 0, endMs: T0 + 5 * MIN })], T0 + 3 * MIN)), 120_000);
  assert.equal(pendingCharge(machine([iv({ marginBps: 0, endMs: T0 + 5 * MIN })], T0 + 5 * MIN)), 0);
});

test("runningBound equals the contract's chargeBound for a machine without restarts", () => {
  const r = rng(3);
  for (let trial = 0; trial < 2000; trial++) {
    const rate = int(r, 0, 9_000_000);
    const bps = int(r, 0, 9000);
    const start = T0 + int(r, 0, 10 * MIN);
    const w0 = Math.floor(start / MIN) * MIN - int(r, 0, 3) * MIN;
    const window = int(r, 0, 5 * 3600);
    const m = machine([iv({ providerCostPerHour: rate, marginBps: bps, startMs: start })], Math.floor(start / MIN) * MIN);
    assert.equal(runningBound(m, w0, window), chargeBound([{ providerCostPerHour: rate, marginBps: bps }], window), `trial ${trial}`);
  }
});

test("runningBound pins the restart minute's rate, then uses the new one", () => {
  const hi = { providerCostPerHour: 3_600_000, marginBps: 0 }; // 60_000 per minute
  const lo = { providerCostPerHour: 360_000, marginBps: 0 }; // 6_000 per minute
  // price drop: high until 10:00:20, low from 10:00:40
  const drop = machine([iv({ incarnation: 0, ...hi, startMs: T0, endMs: T0 + 20_000 }), iv({ incarnation: 1, ...lo, startMs: T0 + 40_000 })]);
  assert.equal(runningBound(drop, T0, 180), 60_000 + 2 * 6_000);
  // price rise: low first, then high in the same minute; the minute stays low
  const rise = machine([iv({ incarnation: 0, ...lo, startMs: T0, endMs: T0 + 20_000 }), iv({ incarnation: 1, ...hi, startMs: T0 + 40_000 })]);
  assert.equal(runningBound(rise, T0, 180), 6_000 + 2 * 60_000);
  // and the ledger agrees exactly when it runs the whole window
  // the ledger charges exactly the bound, less the unused part of the restart minute
  // (40 s of fragments in it, charged at the pinned rate)
  for (const m of [drop, rise]) assert.equal(plannedTotal(m, T0 + 3 * MIN), runningBound(m, T0, 180) - partialFirst(m));
  // a lagged accrual: earlier unbilled minutes take the highest rate and margin seen
  const lag = machine([iv({ incarnation: 0, ...hi, marginBps: 100, startMs: T0, endMs: T0 + 2 * MIN }), iv({ incarnation: 1, ...lo, marginBps: 5000, startMs: T0 + 3 * MIN })]);
  assert.equal(runningBound(lag, T0, 300), 3 * fullMinuteCharge({ providerCostPerHour: 3_600_000, marginBps: 5000 }) + 2 * fullMinuteCharge({ ...lo, marginBps: 5000 }));
  // a window ending just before the restart minute: only the earlier minutes
  assert.equal(runningBound(lag, T0, 180), 3 * fullMinuteCharge({ providerCostPerHour: 3_600_000, marginBps: 5000 }));
  assert.equal(runningBound(lag, T0, 181), 3 * fullMinuteCharge({ providerCostPerHour: 3_600_000, marginBps: 5000 }) + fullMinuteCharge({ ...lo, marginBps: 5000 }));
  // the restart minute (pinned high) just past the window's end counts nothing
  const edge = machine([iv({ incarnation: 0, ...hi, startMs: T0, endMs: T0 + 3 * MIN + 10_000 }), iv({ incarnation: 1, ...lo, startMs: T0 + 3 * MIN + 30_000 })]);
  assert.equal(runningBound(edge, T0, 180), 3 * 60_000);
  assert.equal(runningBound(edge, T0, 181), 4 * 60_000);
  assert.equal(runningBound(edge, T0, 241), 4 * 60_000 + 6_000);
  assert.throws(() => runningBound(machine([iv({ endMs: T0 + MIN })]), T0, 60), RangeError);
  assert.throws(() => runningBound(machine(), T0 + 1, 60), RangeError);
  assert.throws(() => runningBound(machine(), T0, -1), RangeError);
});

/** The ledger charges partial minutes less than a full one: the gap between bound and charge. */
function partialFirst(m: LedgerMachine): number {
  // In both cases above the first minute has 40 s of fragments, charged at the pinned rate.
  const pin = m.intervals[0]!;
  return fullMinuteCharge(pin) - entrySplit(pin.providerCostPerHour, 40, pin.marginBps).total;
}

// ---------------------------------------------------------------- database

interface Seed {
  db: TestDb;
  orgId: string;
  projectId: string;
}

async function seed(o: { reserveMinutes?: number } = {}): Promise<Seed> {
  const db = sqliteDb();
  const orgId = newId("org");
  const projectId = newId("project");
  await db.batch([
    stmt(`INSERT INTO orgs (id, name, margin_bps, created_ms) VALUES (?, 'o', 3000, ?)`, orgId, T0),
    stmt(
      `INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, final_save_reserve_minutes, created_ms) VALUES (?, ?, 'p', ?, ?, 10000000000, ?, ?)`,
      projectId, orgId, T0, T0 + 90 * 24 * 60 * MIN, o.reserveMinutes ?? 10, T0,
    ),
  ]);
  return { db, orgId, projectId };
}

async function allocation(s: Seed, amount: number, projectId = s.projectId): Promise<string> {
  const id = newId("allocation");
  await s.db.batch([stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', ?, ?, ?)`, id, projectId, newId("member"), amount, T0)]);
  return id;
}

async function startMachine(s: Seed, allocationId: string, rate: number, bps: number, startMs: number, saveEstimate = 0): Promise<string> {
  const id = newId("machine");
  await s.db.batch([
    stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, save_estimate_seconds, created_ms)
       VALUES (?, ?, ?, ?, 'runpod', 'L4', 1, 'EU-SE-1', 'starting', ?, ?)`,
      id, s.projectId, allocationId, newId("member"), saveEstimate, startMs,
    ),
    ...openAccrual(id, { incarnation: 0, provider: "runpod", providerCostPerHour: rate, marginBps: bps, startMs }),
  ]);
  return id;
}

const endMachine = (s: Seed, id: string, inc: number, endMs: number) => s.db.batch(closeAccrual(id, inc, endMs));
const restart = (s: Seed, id: string, inc: number, rate: number, bps: number, startMs: number) =>
  s.db.batch(openAccrual(id, { incarnation: inc, provider: "hyperstack", providerCostPerHour: rate, marginBps: bps, startMs }));

async function spent(s: Seed, allocationId: string): Promise<number> {
  const r = await s.db.all<{ t: number | null }>(`SELECT SUM(total) AS t FROM ledger_entries WHERE allocation_id = ?`, [allocationId]);
  return r[0]?.t ?? 0;
}
async function count(s: Seed, sql: string, params: SqlValue[] = []): Promise<number> {
  return (await s.db.all<{ n: number }>(sql, params))[0]!.n;
}

function computeEntry(s: Seed, o: Record<string, SqlValue>) {
  const v: Record<string, SqlValue> = {
    org: s.orgId, project: s.projectId, allocation: "", machine: "", provider: "runpod", rate: 3_600_000, bps: 3000,
    period: T0, seconds: 60, cost: 60_000, margin: 18_000, total: 78_000, created: T0, ...o,
  };
  return s.db.batch([
    stmt(
      `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, machine_id, provider, period_start_ms, seconds,
        provider_cost_per_hour, margin_bps, provider_cost, margin, total, created_ms)
       VALUES (?, ?, ?, ?, 'compute', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("ledgerEntry"), v.org!, v.project!, v.allocation!, v.machine!, v.provider!, v.period!, v.seconds!, v.rate!, v.bps!, v.cost!, v.margin!, v.total!, v.created!,
    ),
  ]);
}

test("schema: compute entries, the unique minute, and immutability", async () => {
  const s = await seed();
  const a = await allocation(s, 1000);
  const m = await startMachine(s, a, 3_600_000, 3000, T0);
  const e = (o: Record<string, SqlValue> = {}) => computeEntry(s, { allocation: a, machine: m, ...o });
  await assert.rejects(e({ seconds: 61 }));
  await assert.rejects(e({ seconds: 0 }));
  await assert.rejects(e({ period: T0 + 1 }));
  await assert.rejects(e({ total: 78_001 }));
  await assert.rejects(e({ cost: -1, total: 17_999 }));
  await e();
  await assert.rejects(e(), /UNIQUE/);
  await assert.rejects(s.db.batch([stmt(`UPDATE ledger_entries SET total = 0, provider_cost = 0, margin = 0`)]), /never updated/);
  await assert.rejects(s.db.batch([stmt(`DELETE FROM ledger_entries`)]), /never deleted/);
});

test("schema: tenant integrity of the whole tuple (SEC H1)", async () => {
  const s = await seed();
  const a = await allocation(s, 1000);
  const m = await startMachine(s, a, 3_600_000, 3000, T0);
  // another tenant
  const other = await seed();
  const orgB = other.orgId;
  await s.db.batch([
    stmt(`INSERT INTO orgs (id, name, margin_bps, created_ms) VALUES (?, 'b', 0, ?)`, orgB, T0),
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'pb', ?, ?, 0, ?)`, other.projectId, orgB, T0, T0 + MIN, T0),
  ]);
  const allocB = await allocation(s, 1000, other.projectId);
  const e = (o: Record<string, SqlValue>) => computeEntry(s, { allocation: a, machine: m, ...o });
  await assert.rejects(e({ org: orgB }), /FOREIGN KEY/); // project of another org
  await assert.rejects(e({ project: other.projectId, org: orgB, allocation: allocB }), /FOREIGN KEY/); // machine of another project
  await assert.rejects(e({ allocation: allocB }), /FOREIGN KEY/); // allocation of another project
  // the provider, rate and margin must be the minute's pinned fragment's
  await assert.rejects(e({ provider: "hyperstack" }), /pinned/);
  await assert.rejects(e({ rate: 1, cost: 0, margin: 0, total: 0 }), /pinned/);
  await assert.rejects(e({ bps: 0, margin: 0, total: 60_000 }), /pinned/);
  await assert.rejects(e({ period: T0 - MIN }), /pinned/); // before the machine accrued
  await e({}); // the right tuple goes in
  // an adjustment (no machine) still can't charge another project's allocation
  const adj = (allocationId: string) =>
    s.db.batch([
      stmt(
        `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, created_ms)
         VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 0, -5, 0, -5, ?)`,
        newId("ledgerEntry"), s.orgId, s.projectId, allocationId, T0, T0,
      ),
    ]);
  await assert.rejects(adj(allocB), /FOREIGN KEY/);
  await adj(a);
  // a machine can't pair its project with another project's allocation
  await assert.rejects(
    s.db.batch([
      stmt(
        `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, created_ms)
         VALUES (?, ?, ?, 'mbr_x', 'runpod', 'L4', 1, 'X', 'starting', ?)`,
        newId("machine"), s.projectId, allocB, T0,
      ),
    ]),
    /FOREIGN KEY/,
  );
});

test("schema: integers only, within the safe range (SEC H2)", async () => {
  const s = await seed();
  const a = await allocation(s, 1000);
  const m = await startMachine(s, a, 3_600_000, 3000, T0);
  const bad = async (sql: string, ...params: SqlValue[]) => assert.rejects(s.db.batch([stmt(sql, ...params)]), Error, sql);
  for (const v of [1.5, MAX + 1, -1]) {
    await bad(`UPDATE allocations SET amount = ? WHERE id = ?`, v, a);
    await bad(`UPDATE allocations SET updated_ms = ? WHERE id = ?`, v, a);
    await bad(`UPDATE projects SET budget = ? WHERE id = ?`, v, s.projectId);
    await bad(`UPDATE projects SET created_ms = ? WHERE id = ?`, v, s.projectId);
    await bad(`UPDATE orgs SET created_ms = ? WHERE id = ?`, v, s.orgId);
    await bad(`UPDATE machines SET created_ms = ? WHERE id = ?`, v, m);
    await bad(`UPDATE machines SET incarnation = ? WHERE id = ?`, v, m);
    await bad(`UPDATE machines SET save_estimate_seconds = ? WHERE id = ?`, v, m);
    await bad(
      `INSERT INTO machine_accruals (machine_id, incarnation, provider, provider_cost_per_hour, margin_bps, start_ms) VALUES (?, 1, 'runpod', ?, 0, ?)`,
      m, v, T0 + MIN,
    );
    await assert.rejects(computeEntry(s, { allocation: a, machine: m, created: v }));
  }
  await bad(`UPDATE machines SET billed_through_ms = ? WHERE id = ?`, 1.5, m);
  await bad(`UPDATE machines SET billed_through_ms = ? WHERE id = ?`, 9007199254740980, m); // safe but not a boundary
  await bad(`UPDATE projects SET margin_bps_override = ? WHERE id = ?`, 0.5, s.projectId);
  await bad(`UPDATE orgs SET margin_bps = ? WHERE id = ?`, 1_000_001, s.orgId);
  await bad(`UPDATE allocations SET amount = 'abc' WHERE id = ?`, a); // STRICT: no text in INTEGER
  await bad(`UPDATE allocations SET amount = '5.5' WHERE id = ?`, a);
});

test("schema: accrual intervals are ordered, closed once, never before billed minutes, and kept", async () => {
  const s = await seed();
  const a = await allocation(s, 10 ** 12);
  const m = await startMachine(s, a, 3_600_000, 3000, T0);
  await assert.rejects(restart(s, m, 1, 1, 0, T0 + MIN), /ordered/); // one still open
  await accrueAll(s.db, T0 + 3 * MIN);
  await assert.rejects(endMachine(s, m, 0, T0 + 2 * MIN), /billed minutes/); // before the billed mark
  await endMachine(s, m, 0, T0 + 3 * MIN + 10_000);
  await assert.rejects(endMachine(s, m, 0, T0 + 4 * MIN).then(async () => {
    // closeAccrual only touches an open interval: a second close changes nothing
    const r = await s.db.all<{ e: number }>(`SELECT end_ms AS e FROM machine_accruals WHERE machine_id = ?`, [m]);
    if (r[0]!.e !== T0 + 3 * MIN + 10_000) return;
    throw new Error("unchanged, as required");
  }), /as required/);
  await assert.rejects(s.db.batch([stmt(`UPDATE machine_accruals SET end_ms = ? WHERE machine_id = ?`, T0 + 5 * MIN, m)]), /closed, once/);
  await assert.rejects(restart(s, m, 1, 1, 0, T0 + 3 * MIN + 5_000), /ordered/); // overlaps
  await assert.rejects(restart(s, m, 0, 1, 0, T0 + 4 * MIN), /ordered|UNIQUE|PRIMARY/); // same incarnation
  await restart(s, m, 1, 1, 0, T0 + 3 * MIN + 10_000); // right after, in the same minute: fine
  // a restart may not start inside a minute that is already billed
  const u = await seed();
  const ua = await allocation(u, 10 ** 12);
  const um = await startMachine(u, ua, 3_600_000, 3000, T0);
  await endMachine(u, um, 0, T0 + 10_000);
  await accrueAll(u.db, T0 + 2 * MIN); // billed through T0 + 1 min
  await assert.rejects(restart(u, um, 1, 1, 0, T0 + 30_000), /unbilled/);
  await restart(u, um, 1, 1, 0, T0 + MIN);
  await assert.rejects(s.db.batch([stmt(`DELETE FROM machine_accruals`)]), /kept/);
});

test("accrueAll writes each closed minute once", async () => {
  const s = await seed();
  const a = await allocation(s, 10 ** 12);
  const m = await startMachine(s, a, 3_600_000, 3000, T0 + 30_000);
  let r = await accrueAll(s.db, T0 + 3 * MIN + 5_000);
  assert.deepEqual([r.machines, r.entries, r.failed], [1, 3, []]);
  assert.equal(await spent(s, a), 39_000 + 78_000 + 78_000);
  r = await accrueAll(s.db, T0 + 3 * MIN + 5_000);
  assert.deepEqual([r.machines, r.entries], [0, 0]);
  await endMachine(s, m, 0, T0 + 3 * MIN + 20_000);
  r = await accrueAll(s.db, T0 + 3 * MIN + 30_000);
  assert.equal(r.entries, 0); // that minute hasn't closed
  r = await accrueAll(s.db, T0 + 4 * MIN);
  assert.equal(r.entries, 1);
  assert.equal(await spent(s, a), 195_000 + 26_000);
  r = await accrueAll(s.db, T0 + 60 * MIN);
  assert.deepEqual([r.machines, r.entries], [0, 0]);
});

test("a late failure in a batch rolls back every entry and the billed-through mark (TESTS T1)", async () => {
  const s = await seed();
  const a = await allocation(s, 10 ** 12);
  const id = await startMachine(s, a, 3_600_000, 0, T0);
  const m = machine([iv({ marginBps: 0 })]);
  Object.assign(m, { id, orgId: s.orgId, projectId: s.projectId, allocationId: a });
  // pre-write the SECOND minute; a 3-minute batch then fails on its second statement
  const plan = planAccrual(m, T0 + 3 * MIN);
  await s.db.batch(accrualStatements(m, { entries: [plan.entries[1]!], billedThroughMs: T0 }, T0).slice(0, 1));
  await assert.rejects(s.db.batch(accrualStatements(m, plan, T0 + 3 * MIN)), /UNIQUE/);
  assert.equal(await count(s, `SELECT COUNT(*) AS n FROM ledger_entries`), 1); // the first minute is NOT left behind
  assert.equal(await count(s, `SELECT COUNT(*) AS n FROM ledger_entries WHERE period_start_ms = ?`, [T0]), 0);
  assert.equal(await count(s, `SELECT billed_through_ms AS n FROM machines WHERE id = ?`, [id]), T0);
  // the mark update itself failing (not a boundary) rolls back the entries before it
  const t = await seed();
  const a2 = await allocation(t, 10 ** 12);
  const id2 = await startMachine(t, a2, 3_600_000, 0, T0);
  const m2 = { ...m, id: id2, orgId: t.orgId, projectId: t.projectId, allocationId: a2 };
  const p2 = planAccrual(m2, T0 + 3 * MIN);
  await assert.rejects(t.db.batch(accrualStatements(m2, { ...p2, billedThroughMs: T0 + 3 * MIN + 1 }, T0)));
  assert.equal(await count(t, `SELECT COUNT(*) AS n FROM ledger_entries`), 0);
  assert.equal(await count(t, `SELECT billed_through_ms AS n FROM machines WHERE id = ?`, [id2]), T0);
});

test("two runs from the same snapshot bill each minute once", async () => {
  const s = await seed();
  const a = await allocation(s, 10 ** 12);
  const id = await startMachine(s, a, 3_600_000, 0, T0);
  const m: LedgerMachine = { ...machine([iv({ marginBps: 0 })]), id, orgId: s.orgId, projectId: s.projectId, allocationId: a };
  const now = T0 + 5 * MIN;
  await s.db.batch(accrualStatements(m, planAccrual(m, now), now));
  await assert.rejects(s.db.batch(accrualStatements(m, planAccrual(m, now), now)), /UNIQUE/);
  assert.equal(await spent(s, a), 5 * 60_000);
  assert.equal(await count(s, `SELECT COUNT(*) AS n FROM ledger_entries`), 5);
});

test("accrueAll reports a machine whose batch fails, and keeps billing the others", async () => {
  const s = await seed();
  const a = await allocation(s, 10 ** 12);
  const bad = await startMachine(s, a, 3_600_000, 0, T0);
  const good = await startMachine(s, a, 3_600_000, 0, T0);
  const m: LedgerMachine = { ...machine([iv({ marginBps: 0 })]), id: bad, orgId: s.orgId, projectId: s.projectId, allocationId: a };
  await s.db.batch(accrualStatements(m, planAccrual(m, T0 + MIN), T0 + MIN).slice(0, 1)); // the entry, not the mark
  const r = await accrueAll(s.db, T0 + 3 * MIN);
  assert.deepEqual(r.failed, [bad]);
  assert.equal(r.machines, 1);
  const rows = await s.db.all<{ id: string; b: number }>(`SELECT id, billed_through_ms AS b FROM machines`);
  assert.deepEqual(Object.fromEntries(rows.map((x) => [x.id, x.b])), { [bad]: T0, [good]: T0 + 3 * MIN });
});

test("d1Db sends one awaited batch of bound statements, and propagates rejection", async () => {
  const calls: string[] = [];
  let reject = false;
  const fake: D1Like = {
    prepare(sql: string) {
      calls.push(`prepare ${sql}`);
      return {
        bind(...values: SqlValue[]) {
          calls.push(`bind ${JSON.stringify(values)}`);
          return { sql, values, all: async () => ({ results: [{ sql, values }] }) } as never;
        },
      };
    },
    async batch(statements) {
      calls.push(`batch ${statements.length}`);
      await new Promise((r) => setTimeout(r, 5));
      calls.push("batch done");
      if (reject) throw new Error("D1 says no");
    },
  };
  const db = d1Db(fake);
  await db.batch([stmt("A ?", 1), stmt("B ?, ?", "x", null)]);
  assert.deepEqual(calls, ["prepare A ?", 'bind [1]', "prepare B ?, ?", 'bind ["x",null]', "batch 2", "batch done"]);
  calls.length = 0;
  await db.batch([]);
  assert.deepEqual(calls, []);
  reject = true;
  await assert.rejects(db.batch([stmt("C")]), /D1 says no/);
  assert.deepEqual(await db.all("SELECT ?", [7]), [{ sql: "SELECT ?", values: [7] }]);
});

// ---------------------------------------------------------------- hard stops

const opts = { checkIntervalSeconds: 60, safetySeconds: 30 };

test("findHardStops at the boundary", async () => {
  const check = async (amount: number) => {
    const t = await seed({ reserveMinutes: 10 });
    const a = await allocation(t, amount);
    await startMachine(t, a, 3_600_000, 0, T0);
    await accrueAll(t.db, T0 + 2 * MIN + 15_000); // 2 minutes billed: 120_000
    // window from T0+2m: 15 + 60 + 30 + 600 = 705 s -> 12 minutes = 720_000
    return findHardStops(t.db, T0 + 2 * MIN + 15_000, opts);
  };
  assert.deepEqual(await check(120_000 + 720_000), []);
  const stops = await check(120_000 + 719_999);
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.unspent, 719_999);
  assert.equal(stops[0]!.threshold, 720_000);
});

test("findHardStops: the window starts at the oldest billed boundary of the running machines", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 719_999);
  await startMachine(s, a, 3_600_000, 0, T0); // billed through T0
  await startMachine(s, a, 3_600_000, 0, T0 + 5 * MIN); // billed through T0 + 5 min
  // from T0: 300 + 60 = 360 s = 6 minutes, for both machines = 720_000
  const stops = await findHardStops(s.db, T0 + 5 * MIN, { checkIntervalSeconds: 60, safetySeconds: 0 });
  assert.equal(stops[0]?.threshold, 720_000);
});

test("findHardStops: partial unbilled seconds round up", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 60_000);
  await startMachine(s, a, 3_600_000, 0, T0);
  // 59.5 s -> 60 s, + 1 s = 61 s -> 2 minutes
  const stops = await findHardStops(s.db, T0 + 59_500, { checkIntervalSeconds: 1, safetySeconds: 0 });
  assert.equal(stops[0]?.threshold, 120_000);
});

test("findHardStops stops an allocation that is already overdrawn", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 10 ** 12);
  await startMachine(s, a, 3_600_000, 0, T0);
  await accrueAll(s.db, T0 + 3 * MIN);
  await s.db.batch([stmt(`UPDATE allocations SET amount = 0 WHERE id = ?`, a)]);
  const stops = await findHardStops(s.db, T0 + 3 * MIN, opts);
  assert.equal(stops[0]?.unspent, -180_000);
});

test("findHardStops counts the exact pending charge of ended machines", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 5 * 60_000);
  const gone = await startMachine(s, a, 3_600_000, 0, T0);
  await endMachine(s, gone, 0, T0 + 4 * MIN); // 240_000 pending, nothing billed
  await startMachine(s, a, 3_600_000, 0, T0 + 4 * MIN);
  const o = { checkIntervalSeconds: 60, safetySeconds: 0 };
  assert.deepEqual(await findHardStops(s.db, T0 + 4 * MIN, o), []);
  await s.db.batch([stmt(`UPDATE allocations SET amount = amount - 1 WHERE id = ?`, a)]);
  const stops = await findHardStops(s.db, T0 + 4 * MIN, o);
  assert.equal(stops[0]?.unspent, 59_999);
  assert.equal(stops[0]?.machineIds.length, 1); // only the running one
});

test("findHardStops with an ended backlog of over 1440 minutes (LIMITS H1)", async () => {
  const run = async (slack: number) => {
    const s = await seed({ reserveMinutes: 0 });
    const backlog = 2000; // minutes, never accrued
    const a = await allocation(s, backlog * 60_000 + 30_000 + 60_000 + slack);
    const old = await startMachine(s, a, 3_600_000, 0, T0);
    await endMachine(s, old, 0, T0 + backlog * MIN + 30_000);
    await startMachine(s, a, 3_600_000, 0, T0 + backlog * MIN + 40_000);
    // the running one needs 1 minute (40 s in, 20 s unbilled + 0 check: still its minute)
    return findHardStops(s.db, T0 + backlog * MIN + 40_000, { checkIntervalSeconds: 0, safetySeconds: 0 });
  };
  assert.deepEqual(await run(0), []);
  const stops = await run(-1);
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.unspent, 59_999);
});

test("findHardStops fails closed on unsafe pending, a malformed period, or bad data", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, MAX);
  const huge = await startMachine(s, a, 2 ** 50, 0, T0);
  await endMachine(s, huge, 0, T0 + 1000 * 24 * 60 * MIN); // pending past the safe range
  await startMachine(s, a, 1, 0, T0 + 1000 * 24 * 60 * MIN);
  const stops = await findHardStops(s.db, T0 + 1000 * 24 * 60 * MIN, { checkIntervalSeconds: 60, safetySeconds: 0 });
  assert.equal(stops.length, 1);
  assert.deepEqual([stops[0]!.unspent, stops[0]!.threshold], [null, null]);
  const t = await seed({ reserveMinutes: 0 });
  const b = await allocation(t, 10 ** 12);
  await startMachine(t, b, 3_600_000, 0, T0);
  assert.deepEqual(await findHardStops(t.db, T0 + MIN, { checkIntervalSeconds: 60, safetySeconds: 0 }), []);
  assert.equal((await findHardStops(t.db, T0 + MIN, { checkIntervalSeconds: -60, safetySeconds: 0 })).length, 1);
  assert.equal((await findHardStops(t.db, T0 + MIN, { checkIntervalSeconds: 0.5, safetySeconds: 0 })).length, 1);
  assert.equal((await findHardStops(t.db, T0 - 1000, { checkIntervalSeconds: 60, safetySeconds: 0 })).length, 1); // a clock before the mark
});

test("findHardStops uses the longest save estimate of the running machines", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 10 * 60_000);
  await startMachine(s, a, 3_600_000, 0, T0, 0);
  await startMachine(s, a, 0, 0, T0, 9 * 60);
  assert.deepEqual(await findHardStops(s.db, T0, { checkIntervalSeconds: 0, safetySeconds: 0 }), []);
  await s.db.batch([stmt(`UPDATE machines SET save_estimate_seconds = 601 WHERE save_estimate_seconds = 540`)]);
  const stops = await findHardStops(s.db, T0, { checkIntervalSeconds: 0, safetySeconds: 0 });
  assert.equal(stops[0]?.threshold, 11 * 60_000);
});

test("pinned rate: a price-drop restart near the budget never overdraws (daybreak2's case)", async () => {
  const s = await seed({ reserveMinutes: 0 });
  // 55 micro-$: the old placement costs 1 micro-$ per second ($3.60/h), the new one 1/10 of that
  const a = await allocation(s, 55);
  const m = await startMachine(s, a, 3600, 0, T0); // 1 micro-$/s -> 60 per full minute
  await endMachine(s, m, 0, T0 + 20_000); // 20 s at the high rate
  await restart(s, m, 1, 360, 0, T0 + 25_000); // re-placed at a lower rate, same minute
  // the minute is pinned at 3600/h: its entry will be 55 s at 1/s = 55; with a 0 s check the
  // bound for the minute is a full minute at the pinned rate: 60 > 55 -> stop
  const stops = await findHardStops(s.db, T0 + 25_000, { checkIntervalSeconds: 0, safetySeconds: 0 });
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.threshold, 60);
  // honor it: stopped at the end of the safety time (0): now
  await endMachine(s, m, 1, T0 + 25_000);
  await accrueAll(s.db, T0 + MIN);
  assert.ok((await spent(s, a)) <= 55, `spent ${await spent(s, a)}`);
  assert.equal(await spent(s, a), 20); // 20 s at the pinned rate; the new fragment ended at once (0 s)
});

test("pinned rate: after a price rise, the bound and the ledger agree", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 10 ** 9);
  const m = await startMachine(s, a, 360, 0, T0); // 6 per minute
  await endMachine(s, m, 0, T0 + 10_000);
  await restart(s, m, 1, 3600, 0, T0 + 10_000); // 60 per minute, from the next minute
  const stops = await findHardStops(s.db, T0 + 10_000, { checkIntervalSeconds: 170, safetySeconds: 0 });
  assert.deepEqual(stops, []);
  // the window is 10 + 170 = 180 s: minute 0 pinned at 6, minutes 1-2 at 60
  const rows = await s.db.all<{ b: number }>(`SELECT billed_through_ms AS b FROM machines WHERE id = ?`, [m]);
  assert.equal(rows[0]!.b, T0);
  const lm = machine(
    [iv({ incarnation: 0, providerCostPerHour: 360, marginBps: 0, startMs: T0, endMs: T0 + 10_000 }), iv({ incarnation: 1, provider: "hyperstack", providerCostPerHour: 3600, marginBps: 0, startMs: T0 + 10_000 })],
    T0,
  );
  assert.equal(runningBound(lm, T0, 180), 6 + 60 + 60);
  await accrueAll(s.db, T0 + 3 * MIN);
  assert.equal(await spent(s, a), 6 + 60 + 60); // the machine ran every second: bound == charge
});

// ---------------------------------------------------------------- the guarantee

test("simulation: with starts gated, restarts, and stops honored, no allocation is ever overdrawn", async () => {
  const r = rng(2027);
  let starts = 0;
  let restarts = 0;
  let hardStops = 0;
  let nearlySpent = 0;
  for (let trial = 0; trial < 40; trial++) {
    const reserveMinutes = int(r, 0, 5);
    const s = await seed({ reserveMinutes });
    const o = { checkIntervalSeconds: 60, safetySeconds: int(r, 0, 45) };
    const amount = int(r, 0, 3_000_000);
    const a = await allocation(s, amount);
    // machine -> its live state
    const live = new Map<string, { inc: number; rate: number; bps: number; save: number; deadline: number | null; open: boolean }>();
    let now = T0 + int(r, 0, 59_999);
    for (let tick = 0; tick < 90; tick++) {
      now += int(r, 1, o.checkIntervalSeconds) * 1000;
      for (const [id, x] of live) {
        if (x.open && x.deadline !== null && x.deadline <= now) {
          await endMachine(s, id, x.inc, x.deadline);
          x.open = false;
        }
      }
      await accrueAll(s.db, now);
      for (const st of await findHardStops(s.db, now, o)) {
        for (const id of st.machineIds) {
          const x = live.get(id)!;
          if (x.deadline !== null) continue;
          hardStops++;
          x.deadline = now + (o.safetySeconds + reserveSeconds(reserveMinutes, x.save)) * 1000;
        }
      }
      // starts and restarts, gated by the contract's canStartWithin over the bound
      if (r() < 0.3) {
        const ended = [...live.entries()].filter(([, x]) => !x.open && x.deadline === null);
        const isRestart = ended.length > 0 && r() < 0.5;
        const nm = { providerCostPerHour: int(r, 0, 4_000_000), marginBps: int(r, 0, 5000), save: int(r, 0, 300) };
        const unbilled = await s.db.all<{ b: number | null }>(
          `SELECT MIN(m.billed_through_ms) AS b FROM machines m JOIN machine_accruals x ON x.machine_id = m.id
           WHERE m.allocation_id = ? AND x.end_ms IS NULL`,
          [a],
        );
        const w0 = Math.min(unbilled[0]?.b ?? Math.floor(now / MIN) * MIN, Math.floor(now / MIN) * MIN);
        // running machines count at the highest rate they could be charged (pinned or current)
        const running = [...live.values()].filter((x) => x.open).map((x) => ({ providerCostPerHour: x.rate, marginBps: x.bps }));
        let newRate: { providerCostPerHour: number; marginBps: number } = nm;
        if (isRestart) {
          const [, x] = ended[0]!;
          // the restart minute may be pinned at the old placement's rate
          newRate = { providerCostPerHour: Math.max(x.rate, nm.providerCostPerHour), marginBps: Math.max(x.bps, nm.marginBps) };
        }
        const ok = canStartWithin({
          unspent: amount - (await spent(s, a)) - (await pendingOf(s, a, now)),
          newMachine: newRate,
          running,
          unbilledSeconds: Math.ceil((now - w0) / 1000),
          minStartMinutes: 1,
          checkIntervalSeconds: o.checkIntervalSeconds,
          safetySeconds: o.safetySeconds,
          reserveSeconds: reserveSeconds(reserveMinutes, Math.max(nm.save, ...[...live.values()].map((x) => x.save))),
        });
        if (ok && isRestart) {
          const [id, x] = ended[0]!;
          x.inc++;
          await restart(s, id, x.inc, nm.providerCostPerHour, nm.marginBps, now);
          Object.assign(x, { rate: nm.providerCostPerHour, bps: nm.marginBps, save: nm.save, open: true });
          restarts++;
        } else if (ok) {
          const id = await startMachine(s, a, nm.providerCostPerHour, nm.marginBps, now, nm.save);
          live.set(id, { inc: 0, rate: nm.providerCostPerHour, bps: nm.marginBps, save: nm.save, deadline: null, open: true });
          starts++;
        }
      }
      // some machines stop on their own (users), which makes restarts possible
      for (const [id, x] of live) {
        if (x.open && x.deadline === null && r() < 0.05) {
          await endMachine(s, id, x.inc, now);
          x.open = false;
        }
      }
    }
    for (const [id, x] of live) if (x.open) await endMachine(s, id, x.inc, x.deadline ?? now);
    await accrueAll(s.db, now + 24 * 60 * MIN);
    const total = await spent(s, a);
    assert.ok(total <= amount, `trial ${trial}: spent ${total} > allocation ${amount}`);
    if (amount > 0 && total >= amount / 2) nearlySpent++;
  }
  assert.ok(starts >= 40, `starts ${starts}`);
  assert.ok(restarts >= 5, `restarts ${restarts}`);
  assert.ok(hardStops >= 10, `hard stops ${hardStops}`);
  assert.ok(nearlySpent >= 10, `trials spending at least half: ${nearlySpent}`);
});

/** The exact pending charge of an allocation's ended machines (as findHardStops computes it). */
async function pendingOf(s: Seed, allocationId: string, _now: number): Promise<number> {
  const rows = await s.db.all<{ machine_id: string; billed_through_ms: number; incarnation: number; provider: string; provider_cost_per_hour: number; margin_bps: number; start_ms: number; end_ms: number | null }>(
    `SELECT a.machine_id, m.billed_through_ms, a.incarnation, a.provider, a.provider_cost_per_hour, a.margin_bps, a.start_ms, a.end_ms
     FROM machine_accruals a JOIN machines m ON m.id = a.machine_id
     WHERE m.allocation_id = ? AND (a.end_ms IS NULL OR a.end_ms > m.billed_through_ms) ORDER BY a.machine_id, a.incarnation`,
    [allocationId],
  );
  const by = new Map<string, LedgerMachine>();
  for (const x of rows) {
    const m = by.get(x.machine_id) ?? { ...machine([]), id: x.machine_id, billedThroughMs: x.billed_through_ms, intervals: [] };
    m.intervals.push({ incarnation: x.incarnation, provider: x.provider, providerCostPerHour: x.provider_cost_per_hour, marginBps: x.margin_bps, startMs: x.start_ms, endMs: x.end_ms });
    by.set(x.machine_id, m);
  }
  let t = 0;
  for (const m of by.values()) if (m.intervals.at(-1)?.endMs !== null) t += pendingCharge(m);
  return t;
}

test("the ledger never charges more than chargeBound for a window from a billed boundary", () => {
  const r = rng(5);
  for (let trial = 0; trial < 3000; trial++) {
    const rate = int(r, 0, 9_000_000);
    const bps = int(r, 0, 20_000);
    const start = T0 + int(r, 0, 59_999);
    const windowS = int(r, 0, 4 * 3600);
    const m = machine([iv({ providerCostPerHour: rate, marginBps: bps, startMs: start, endMs: Math.max(T0 + windowS * 1000, start) })]);
    assert.ok(pendingCharge(m) <= chargeBound([{ providerCostPerHour: rate, marginBps: bps }], windowS), `trial ${trial}`);
  }
});
