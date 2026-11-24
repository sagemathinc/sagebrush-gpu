import { test } from "node:test";
import assert from "node:assert/strict";
import { canStartWithin, chargeBound, entrySplit, newId, reserveSeconds } from "@sbgpu/api";
import { accrualStatements, accrueAll, findHardStops, planAccrual, type AccrualMachine } from "./ledger.ts";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import { stmt } from "./db.ts";

const T0 = Date.UTC(2027, 1, 1, 10, 0, 0); // a minute boundary
const MIN = 60_000;

function machine(o: Partial<AccrualMachine> = {}): AccrualMachine {
  return {
    id: "mch_x",
    orgId: "org_x",
    projectId: "prj_x",
    allocationId: "alc_x",
    provider: "runpod",
    providerCostPerHour: 3_600_000,
    marginBps: 3000,
    accrualStartMs: T0,
    accrualEndMs: null,
    billedThroughMs: T0,
    ...o,
  };
}

test("planAccrual bills complete minutes, prorating the first", () => {
  const p = planAccrual(machine({ accrualStartMs: T0 + 30_000 }), T0 + 3 * MIN + 10_000);
  assert.deepEqual(
    p.entries.map((e) => [e.periodStartMs - T0, e.seconds]),
    [[0, 30], [MIN, 60], [2 * MIN, 60]],
  );
  assert.equal(p.billedThroughMs, T0 + 3 * MIN);
  assert.deepEqual(p.entries[1]!.split, entrySplit(3_600_000, 60, 3000));
  // the current, incomplete minute waits
  assert.deepEqual(planAccrual(machine(), T0 + MIN - 1).entries, []);
  assert.equal(planAccrual(machine(), T0 + MIN - 1).billedThroughMs, T0);
  assert.equal(planAccrual(machine(), T0 + MIN).entries.length, 1);
});

test("planAccrual: partial seconds round up, never past 60", () => {
  const e = planAccrual(machine({ accrualStartMs: T0 + 29_999 }), T0 + MIN).entries;
  assert.equal(e[0]!.seconds, 31); // 30.001 s -> 31
  assert.equal(planAccrual(machine({ accrualStartMs: T0 + 1 }), T0 + MIN).entries[0]!.seconds, 60);
  assert.equal(planAccrual(machine({ accrualStartMs: T0 + 59_999 }), T0 + MIN).entries[0]!.seconds, 1);
});

test("planAccrual: the final partial minute is billed once the accrual has ended", () => {
  const m = machine({ accrualEndMs: T0 + 2 * MIN + 20_000 });
  const p = planAccrual(m, T0 + 2 * MIN + 25_000);
  assert.deepEqual(p.entries.map((e) => e.seconds), [60, 60, 20]);
  assert.equal(p.billedThroughMs, T0 + 3 * MIN);
  // nothing more, ever
  assert.deepEqual(planAccrual({ ...m, billedThroughMs: p.billedThroughMs }, T0 + 99 * MIN).entries, []);
  // an end not yet reached by now isn't billed early
  assert.deepEqual(planAccrual(m, T0 + 2 * MIN + 19_999).entries.map((e) => e.seconds), [60, 60]);
  // an end exactly on a boundary leaves no partial minute
  const q = planAccrual(machine({ accrualEndMs: T0 + 2 * MIN }), T0 + 5 * MIN);
  assert.deepEqual(q.entries.map((e) => e.seconds), [60, 60]);
  assert.equal(q.billedThroughMs, T0 + 2 * MIN);
  // start and end in the same minute
  assert.deepEqual(planAccrual(machine({ accrualStartMs: T0 + 10_000, accrualEndMs: T0 + 15_500 }), T0 + 20_000).entries.map((e) => e.seconds), [6]);
  // zero accrual: no entry, but the minute is passed
  const z = planAccrual(machine({ accrualStartMs: T0, accrualEndMs: T0 }), T0 + 5 * MIN);
  assert.deepEqual(z.entries, []);
  const mid = planAccrual(machine({ accrualStartMs: T0 + 10_000, accrualEndMs: T0 + 10_000 }), T0 + 5 * MIN);
  assert.deepEqual(mid.entries, []); // no zero-second entry
  assert.equal(mid.billedThroughMs, T0 + MIN);
});

test("planAccrual caps minutes per run and refuses malformed machines", () => {
  const p = planAccrual(machine(), T0 + 10 * MIN, 4);
  assert.equal(p.entries.length, 4);
  assert.equal(p.billedThroughMs, T0 + 4 * MIN);
  assert.throws(() => planAccrual(machine({ billedThroughMs: T0 + 1 }), T0 + MIN), RangeError);
  assert.throws(() => planAccrual(machine({ accrualEndMs: T0 - 1 }), T0 + MIN), RangeError);
  assert.throws(() => planAccrual(machine(), NaN), RangeError);
  assert.throws(() => planAccrual(machine({ accrualStartMs: -1 }), T0), RangeError);
  assert.throws(() => planAccrual(machine(), T0 + MIN, -1), RangeError);
  assert.throws(() => planAccrual(machine({ providerCostPerHour: -1 }), T0 + MIN), RangeError);
});

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
      projectId,
      orgId,
      T0,
      T0 + 90 * 24 * 60 * MIN,
      o.reserveMinutes ?? 10,
      T0,
    ),
  ]);
  return { db, orgId, projectId };
}

async function allocation(s: Seed, amount: number): Promise<string> {
  const id = newId("allocation");
  await s.db.batch([stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', ?, ?, ?)`, id, s.projectId, newId("member"), amount, T0)]);
  return id;
}

async function startMachine(s: Seed, allocationId: string, rate: number, bps: number, startMs: number, saveEstimate = 0): Promise<string> {
  const id = newId("machine");
  await s.db.batch([
    stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center,
        provider_cost_per_hour, margin_bps, state, accrual_start_ms, billed_through_ms, save_estimate_seconds, created_ms)
       VALUES (?, ?, ?, ?, 'runpod', 'L4', 1, 'EU-SE-1', ?, ?, 'starting', ?, ?, ?, ?)`,
      id,
      s.projectId,
      allocationId,
      newId("member"),
      rate,
      bps,
      startMs,
      Math.floor(startMs / MIN) * MIN,
      saveEstimate,
      startMs,
    ),
  ]);
  return id;
}

const endMachine = (s: Seed, id: string, endMs: number) =>
  s.db.batch([stmt(`UPDATE machines SET accrual_end_ms = ?, state = 'stopped' WHERE id = ?`, endMs, id)]);

async function spent(s: Seed, allocationId: string): Promise<number> {
  const r = await s.db.all<{ t: number | null }>(`SELECT SUM(total) AS t FROM ledger_entries WHERE allocation_id = ?`, [allocationId]);
  return r[0]?.t ?? 0;
}

test("the schema refuses malformed rows", async () => {
  const s = await seed();
  const a = await allocation(s, 1000);
  const m = await startMachine(s, a, 3_600_000, 3000, T0);
  const entry = (o: Record<string, number | string>) => {
    const v = { period: T0, seconds: 60, cost: 60_000, margin: 18_000, total: 78_000, ...o };
    return s.db.batch([
      stmt(
        `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, machine_id, provider, period_start_ms, seconds,
          provider_cost_per_hour, margin_bps, provider_cost, margin, total, created_ms)
         VALUES (?, ?, ?, ?, 'compute', ?, 'runpod', ?, ?, 3600000, 3000, ?, ?, ?, ?)`,
        newId("ledgerEntry"), s.orgId, s.projectId, a, m, v.period, v.seconds, v.cost, v.margin, v.total, T0,
      ),
    ]);
  };
  await assert.rejects(entry({ seconds: 61 }));
  await assert.rejects(entry({ seconds: 0 }));
  await assert.rejects(entry({ period: T0 + 1 }));
  await assert.rejects(entry({ total: 78_001 }));
  await assert.rejects(entry({ cost: -1, total: 17_999 }));
  await entry({});
  await assert.rejects(entry({}), /UNIQUE/); // one entry per machine per minute
  await assert.rejects(s.db.batch([stmt(`UPDATE machines SET billed_through_ms = ? WHERE id = ?`, T0 + 1, m)]));
  await assert.rejects(s.db.batch([stmt(`UPDATE machines SET accrual_end_ms = ? WHERE id = ?`, T0 - 1, m)]));
  await assert.rejects(s.db.batch([stmt(`UPDATE machines SET provider_cost_per_hour = -1 WHERE id = ?`, m)]));
  await assert.rejects(s.db.batch([stmt(`UPDATE machines SET margin_bps = 1000001 WHERE id = ?`, m)]));
  await assert.rejects(s.db.batch([stmt(`UPDATE allocations SET amount = -1 WHERE id = ?`, a)]));
});

test("accrueAll writes the planned entries once", async () => {
  const s = await seed();
  const a = await allocation(s, 10 ** 12);
  const m = await startMachine(s, a, 3_600_000, 3000, T0 + 30_000);
  let r = await accrueAll(s.db, T0 + 3 * MIN + 5_000);
  assert.deepEqual([r.machines, r.entries, r.failed], [1, 3, []]);
  // 30 s + 60 s + 60 s at $3.60/h + 30% = 39_000 + 78_000 + 78_000
  assert.equal(await spent(s, a), 195_000);
  r = await accrueAll(s.db, T0 + 3 * MIN + 5_000);
  assert.deepEqual([r.machines, r.entries], [0, 0]);
  assert.equal(await spent(s, a), 195_000);
  const row = await s.db.all<{ b: number }>(`SELECT billed_through_ms AS b FROM machines WHERE id = ?`, [m]);
  assert.equal(row[0]!.b, T0 + 3 * MIN);
  await endMachine(s, m, T0 + 3 * MIN + 20_000);
  r = await accrueAll(s.db, T0 + 3 * MIN + 30_000);
  assert.equal(r.entries, 1);
  assert.equal(await spent(s, a), 195_000 + 26_000); // 20 s
  r = await accrueAll(s.db, T0 + 60 * MIN);
  assert.equal(r.entries, 0);
});

test("two runs from the same snapshot bill each minute once", async () => {
  const s = await seed();
  const a = await allocation(s, 10 ** 12);
  const id = await startMachine(s, a, 3_600_000, 0, T0);
  const m: AccrualMachine = { ...machine(), id, orgId: s.orgId, projectId: s.projectId, allocationId: a, marginBps: 0 };
  const now = T0 + 5 * MIN;
  const p1 = planAccrual(m, now);
  const p2 = planAccrual(m, now);
  await s.db.batch(accrualStatements(m, p1, now));
  await assert.rejects(s.db.batch(accrualStatements(m, p2, now)), /UNIQUE/);
  assert.equal(await spent(s, a), 5 * 60_000);
  const n = await s.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ledger_entries`);
  assert.equal(n[0]!.n, 5);
  // a failed batch writes nothing, and accrueAll reports it rather than throwing
  const r = await accrueAll(s.db, now);
  assert.deepEqual(r.failed, []);
});

test("accrueAll reports a machine whose batch fails, and keeps billing the others", async () => {
  const s = await seed();
  const a = await allocation(s, 10 ** 12);
  const bad = await startMachine(s, a, 3_600_000, 0, T0);
  const good = await startMachine(s, a, 3_600_000, 0, T0);
  // pre-write one of bad's minutes so its batch conflicts
  const m: AccrualMachine = { ...machine(), id: bad, orgId: s.orgId, projectId: s.projectId, allocationId: a, marginBps: 0 };
  const one = planAccrual(m, T0 + MIN);
  await s.db.batch(accrualStatements(m, one, T0 + MIN).slice(0, 1)); // the entry, not the billed-through move
  const r = await accrueAll(s.db, T0 + 3 * MIN);
  assert.deepEqual(r.failed, [bad]);
  assert.equal(r.machines, 1);
  const rows = await s.db.all<{ id: string; b: number }>(`SELECT id, billed_through_ms AS b FROM machines`);
  assert.deepEqual(Object.fromEntries(rows.map((x) => [x.id, x.b])), { [bad]: T0, [good]: T0 + 3 * MIN });
});

test("findHardStops at the boundary", async () => {
  const s = await seed({ reserveMinutes: 10 });
  const opts = { checkIntervalSeconds: 60, safetySeconds: 30 };
  // $3.60/h at 0%: 60_000 per minute. Window from the billed boundary: unbilled 15 s +
  // 60 + 30 + 600 = 705 s -> 12 minutes = 720_000 needed.
  const check = async (amount: number) => {
    const t = await seed({ reserveMinutes: 10 });
    const a = await allocation(t, amount);
    await startMachine(t, a, 3_600_000, 0, T0);
    await accrueAll(t.db, T0 + 2 * MIN + 15_000); // 2 minutes billed: 120_000
    return findHardStops(t.db, T0 + 2 * MIN + 15_000, opts);
  };
  assert.deepEqual(await check(120_000 + 720_000), []);
  const stops = await check(120_000 + 719_999);
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.unspent, 719_999);
  assert.equal(stops[0]!.threshold, 720_000);
  assert.equal(stops[0]!.machineIds.length, 1);
  void s;
});

test("findHardStops: unbilled time counts from the oldest billed boundary", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 10 * 60_000);
  await startMachine(s, a, 3_600_000, 0, T0);
  // no accrual run for 9.5 minutes: nothing billed, so the window is 570 s + 60 -> 11 min
  const stops = await findHardStops(s.db, T0 + 9 * MIN + 30_000, { checkIntervalSeconds: 60, safetySeconds: 0 });
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.threshold, 11 * 60_000);
});

test("findHardStops: the window starts at the OLDEST billed boundary of the running machines", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 10 ** 12);
  await startMachine(s, a, 3_600_000, 0, T0); // billed through T0, never accrued
  await startMachine(s, a, 3_600_000, 0, T0 + 5 * MIN); // billed through T0 + 5 min
  // from T0: 300 s unbilled + 60 s check = 6 minutes x 2 machines = 720_000
  await s.db.batch([stmt(`UPDATE allocations SET amount = ? WHERE id = ?`, 719_999, a)]);
  const stops = await findHardStops(s.db, T0 + 5 * MIN, { checkIntervalSeconds: 60, safetySeconds: 0 });
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.threshold, 720_000);
});

test("findHardStops: partial unbilled seconds round up", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 60_000);
  await startMachine(s, a, 3_600_000, 0, T0);
  // 59.5 s unbilled -> 60 s, + 1 s check = 61 s -> 2 minutes = 120_000 > 60_000
  const stops = await findHardStops(s.db, T0 + 59_500, { checkIntervalSeconds: 1, safetySeconds: 0 });
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.threshold, 120_000);
});

test("findHardStops stops an allocation that is already overdrawn", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 10 ** 12);
  await startMachine(s, a, 3_600_000, 0, T0);
  await accrueAll(s.db, T0 + 3 * MIN);
  await s.db.batch([stmt(`UPDATE allocations SET amount = 0 WHERE id = ?`, a)]); // a manager cut it
  const stops = await findHardStops(s.db, T0 + 3 * MIN, { checkIntervalSeconds: 60, safetySeconds: 0 });
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.unspent, -180_000);
});

test("findHardStops counts the unbilled charge of machines that have already stopped", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 5 * 60_000);
  const gone = await startMachine(s, a, 3_600_000, 0, T0);
  await endMachine(s, gone, T0 + 4 * MIN); // 4 minutes, nothing billed yet: 240_000 pending
  await startMachine(s, a, 3_600_000, 0, T0 + 4 * MIN);
  // unspent = 300_000 - 240_000 = 60_000; the running one needs 1 minute for a 60 s check
  const opts = { checkIntervalSeconds: 60, safetySeconds: 0 };
  let stops = await findHardStops(s.db, T0 + 4 * MIN, opts);
  assert.deepEqual(stops, []);
  await s.db.batch([stmt(`UPDATE allocations SET amount = amount - 1 WHERE id = ?`, a)]);
  stops = await findHardStops(s.db, T0 + 4 * MIN, opts);
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.unspent, 59_999);
  assert.equal(stops[0]!.machineIds.length, 1); // only the running one is stopped
});

test("findHardStops fails closed on a malformed reserve", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 10 ** 12);
  const m = await startMachine(s, a, 3_600_000, 0, T0);
  assert.deepEqual(await findHardStops(s.db, T0 + MIN, { checkIntervalSeconds: 60, safetySeconds: 0 }), []);
  const stops = await findHardStops(s.db, T0 + MIN, { checkIntervalSeconds: -60, safetySeconds: 0 });
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.threshold, null);
  void m;
});

test("findHardStops uses the longest save estimate of the running machines", async () => {
  const s = await seed({ reserveMinutes: 0 });
  const a = await allocation(s, 10 * 60_000);
  await startMachine(s, a, 3_600_000, 0, T0, 0);
  await startMachine(s, a, 0, 0, T0, 9 * 60); // free, but its save takes 9 minutes
  // 2 machines; only the paid one costs: 0 unbilled + 0 + 0 + 540 s = 9 minutes = 540_000
  assert.deepEqual(await findHardStops(s.db, T0, { checkIntervalSeconds: 0, safetySeconds: 0 }), []);
  await s.db.batch([stmt(`UPDATE machines SET save_estimate_seconds = 601 WHERE provider_cost_per_hour = 0`)]);
  const stops = await findHardStops(s.db, T0, { checkIntervalSeconds: 0, safetySeconds: 0 });
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.threshold, 11 * 60_000);
});

// ---------------------------------------------------------------- the guarantee

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

test("simulation: with starts gated and stops honored, no allocation is ever overdrawn", async () => {
  const r = rng(2027);
  let starts = 0;
  let hardStops = 0;
  let nearlySpent = 0;
  for (let trial = 0; trial < 40; trial++) {
    const reserveMinutes = int(r, 0, 5);
    const s = await seed({ reserveMinutes });
    const opts = { checkIntervalSeconds: 60, safetySeconds: int(r, 0, 45) };
    const amount = int(r, 0, 3_000_000);
    const a = await allocation(s, amount);
    const stopDeadline = new Map<string, number>(); // machine -> latest end
    const running = new Map<string, { providerCostPerHour: number; marginBps: number; save: number }>();
    let now = T0 + int(r, 0, 59_999);
    for (let tick = 0; tick < 90; tick++) {
      // the next check comes at most checkIntervalSeconds later
      now += int(r, 1, opts.checkIntervalSeconds) * 1000;
      for (const [id, end] of stopDeadline) {
        if (end <= now && running.has(id)) {
          await endMachine(s, id, end);
          running.delete(id);
        }
      }
      await accrueAll(s.db, now);
      for (const st of await findHardStops(s.db, now, opts)) {
        for (const id of st.machineIds) {
          if (stopDeadline.has(id)) continue;
          hardStops++;
          // worst case: it saves for the whole reserve and then the provider takes the safety time
          const m = running.get(id)!;
          const reserve = reserveSeconds(reserveMinutes, m.save);
          stopDeadline.set(id, now + (opts.safetySeconds + reserve) * 1000);
        }
      }
      // try a start now and then
      if (r() < 0.3 && running.size < 4) {
        const nm = { providerCostPerHour: int(r, 0, 4_000_000), marginBps: int(r, 0, 5000), save: int(r, 0, 300) };
        const live = [...running.entries()].filter(([id]) => !stopDeadline.has(id)).map(([, m]) => m);
        const billed = await s.db.all<{ b: number | null }>(
          `SELECT MIN(billed_through_ms) AS b FROM machines WHERE allocation_id = ? AND accrual_end_ms IS NULL`,
          [a],
        );
        const oldest = Math.min(billed[0]?.b ?? Math.floor(now / MIN) * MIN, Math.floor(now / MIN) * MIN);
        const pendingStopped = [...running.entries()].filter(([id]) => stopDeadline.has(id)).map(([, m]) => m);
        const unspent = amount - (await spent(s, a));
        const ok = canStartWithin({
          unspent,
          newMachine: nm,
          // machines already stopping still accrue until they end: count them as running
          running: [...live, ...pendingStopped],
          unbilledSeconds: Math.ceil((now - oldest) / 1000),
          minStartMinutes: 1,
          checkIntervalSeconds: opts.checkIntervalSeconds,
          safetySeconds: opts.safetySeconds,
          reserveSeconds: reserveSeconds(reserveMinutes, Math.max(nm.save, ...[...running.values()].map((m) => m.save))),
        });
        if (ok) {
          running.set(await startMachine(s, a, nm.providerCostPerHour, nm.marginBps, now, nm.save), nm);
          starts++;
        }
      }
    }
    // stop everything still running at its deadline (or now), then bill it all
    for (const id of running.keys()) await endMachine(s, id, stopDeadline.get(id) ?? now);
    await accrueAll(s.db, now + 24 * 60 * MIN);
    const total = await spent(s, a);
    assert.ok(total <= amount, `trial ${trial}: spent ${total} > allocation ${amount}`);
    if (amount > 0 && total >= amount / 2) nearlySpent++;
  }
  // the simulation must exercise what it claims: starts, hard stops, real spending
  assert.ok(starts >= 40, `starts ${starts}`);
  assert.ok(hardStops >= 10, `hard stops ${hardStops}`);
  assert.ok(nearlySpent >= 10, `trials spending at least half: ${nearlySpent}`);
});

test("the ledger never charges more than chargeBound for a window from a billed boundary", () => {
  const r = rng(5);
  for (let trial = 0; trial < 3000; trial++) {
    const m = machine({ providerCostPerHour: int(r, 0, 9_000_000), marginBps: int(r, 0, 20_000), accrualStartMs: T0 + int(r, 0, 59_999) });
    const windowS = int(r, 0, 4 * 3600);
    const end = T0 + windowS * 1000;
    const p = planAccrual({ ...m, accrualEndMs: Math.max(end, m.accrualStartMs) }, end + MIN);
    const charged = p.entries.reduce((t, e) => t + e.split.total, 0);
    assert.ok(charged <= chargeBound([m], windowS), `trial ${trial}`);
  }
});
