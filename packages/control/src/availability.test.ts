import assert from "node:assert/strict";
import { test } from "node:test";
import type { AvailabilityObservation } from "@sbgpu/providers";
import {
  MAX_OBSERVATIONS,
  MAX_OBSERVATIONS_PER_WRITE,
  MAX_REPORT_ROWS,
  observationsInWindow,
  recordObservations,
  storedAvailabilityReport,
} from "./availability.ts";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db, SqlValue, Stmt } from "./db.ts";
import { MIGRATIONS_DIR, sqliteDb } from "./testing/sqlite.ts";

const NOW = 1_800_000_000_000;
const obs = (observedMs: number, extra: Partial<AvailabilityObservation> = {}): AvailabilityObservation =>
  ({
    provider: "runpod", gpuType: "L4", gpuCount: 1, dataCenter: "EU-SE-1", country: "SE", observedMs,
    quotedCostPerHour: 690_000, source: "launch", outcome: "launched", readyMs: 90_000, ...extra,
  }) as AvailabilityObservation;

const count = (db: ReturnType<typeof sqliteDb>) =>
  Number((db.raw.prepare("SELECT count(*) AS n FROM availability_observations").get() as { n: number }).n);

test("observations round-trip through the store", async () => {
  const db = sqliteDb();
  const written = [
    obs(NOW - 3),
    obs(NOW - 2, { source: "listing", outcome: "low", readyMs: null, country: null, quotedCostPerHour: null }),
    obs(NOW - 1, { outcome: "no_capacity", readyMs: null }),
  ];
  await recordObservations(db, written, NOW);
  const { observations, truncated } = await observationsInWindow(db, NOW - 10, NOW);
  assert.deepEqual(observations, written);
  assert.equal(truncated, false);
});

test("a write is validated whole before anything is stored", async () => {
  const db = sqliteDb();
  await assert.rejects(recordObservations(db, [obs(NOW), obs(NOW, { gpuCount: 0 })], NOW), RangeError);
  assert.equal(count(db), 0);
  await assert.rejects(recordObservations(db, Array.from({ length: MAX_OBSERVATIONS_PER_WRITE + 1 }, () => obs(NOW)), NOW), RangeError);
  assert.equal(count(db), 0);
  await recordObservations(db, [], NOW);
  await recordObservations(db, Array.from({ length: MAX_OBSERVATIONS_PER_WRITE }, () => obs(NOW)), NOW);
  assert.equal(count(db), MAX_OBSERVATIONS_PER_WRITE);
});

test("the schema guarantees shapes and character sets (the GPU catalog is checkObservation's)", () => {
  const db = sqliteDb();
  const ins = (cols: string, vals: string) => () => db.raw.exec(`INSERT INTO availability_observations (provider, gpu_type, gpu_count, data_center, country, observed_ms, source, outcome, quoted_cost_per_hour, ready_ms) VALUES (${cols}${vals})`);
  const ok = "'runpod', 'L4', 1, 'EU-SE-1', 'SE', 1, ";
  ins(ok, "'launch', 'launched', 0, 0")();
  // Accepted by the schema, refused by checkObservation: an unknown but well-formed GPU type.
  ins("'runpod', 'TPU', 1, 'EU-SE-1', 'SE', 1, ", "'launch', 'launched', 0, 0")();
  for (const bad of [
    ["'gcp', 'L4', 1, 'EU-SE-1', 'SE', 1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', 'T P U', 1, 'EU-SE-1', 'SE', 1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', '', 1, 'EU-SE-1', 'SE', 1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', 'L4', 0, 'EU-SE-1', 'SE', 1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', 'L4', 1, 'EU SE 1', 'SE', 1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', 'L4', 1, 'EU/SE', 'SE', 1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', 'L4', 1, 'EU-SE-1', 'se', 1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', 'L4', 1, 'EU-SE-1', '!!', 1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', 'L4', 1, 'EU-SE-1', 'SWE', 1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', 'L4', 1, 'EU-SE-1', 'SE', -1, ", "'launch', 'launched', 0, 0"],
    ["'runpod', 'L4', 1, 'EU-SE-1', 'SE', 9007199254740992, ", "'launch', 'launched', 0, 0"],
    [ok, "'listing', 'launched', 0, NULL"],
    [ok, "'launch', 'high', 0, NULL"],
    [ok, "'launch', 'no_capacity', 0, 5"],
    [ok, "'listing', 'high', 0, 5"],
    [ok, "'launch', 'launched', -1, NULL"],
    [ok, "'launch', 'launched', 1000000001, NULL"],
    [ok, "'launch', 'launched', 0, 86400001"],
    [ok, "'launch', 'launched', 0.5, NULL"],
  ]) {
    assert.throws(ins(bad[0]!, bad[1]!), JSON.stringify(bad));
  }
  assert.throws(() => db.raw.exec("INSERT INTO availability_retention (id, pruned_through_ms) VALUES (2, 1)"));
  assert.throws(() => db.raw.exec("INSERT INTO availability_retention (id, pruned_through_ms) VALUES (1, -1)"));
});

test("the store prunes the oldest rows beyond MAX_OBSERVATIONS, in the same write", async () => {
  const db = sqliteDb();
  // Fill to exactly the cap with old rows (observed_ms 1..cap).
  db.raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_OBSERVATIONS})
    INSERT INTO availability_observations (provider, gpu_type, gpu_count, data_center, country, observed_ms, source, outcome, quoted_cost_per_hour, ready_ms)
    SELECT 'runpod', 'L4', 1, 'EU-SE-1', 'SE', i, 'listing', 'high', NULL, NULL FROM n`);
  assert.equal(count(db), MAX_OBSERVATIONS);
  await recordObservations(db, [obs(NOW - 2), obs(NOW - 1), obs(NOW)], NOW);
  assert.equal(count(db), MAX_OBSERVATIONS);
  const oldest = db.raw.prepare("SELECT min(observed_ms) AS m FROM availability_observations").get() as { m: number };
  assert.equal(Number(oldest.m), 4);
  const newest = db.raw.prepare("SELECT count(*) AS n FROM availability_observations WHERE observed_ms >= ?").get(NOW - 2) as { n: number };
  assert.equal(Number(newest.n), 3);
});

test("below the cap nothing is pruned", async () => {
  const db = sqliteDb();
  await recordObservations(db, [obs(1), obs(2)], NOW);
  await recordObservations(db, [obs(3)], NOW);
  assert.equal(count(db), 3);
});

test("window reads are half-open, ordered, and say when they were cut short", async () => {
  const db = sqliteDb();
  await recordObservations(db, [obs(NOW - 5), obs(NOW - 4), obs(NOW - 3), obs(NOW - 2), obs(NOW - 1), obs(NOW)], NOW);
  const all = await observationsInWindow(db, NOW - 4, NOW);
  assert.deepEqual(all.observations.map((o) => o.observedMs), [NOW - 4, NOW - 3, NOW - 2, NOW - 1]);
  assert.equal(all.truncated, false);
  const cut = await observationsInWindow(db, NOW - 4, NOW, 3);
  assert.deepEqual(cut.observations.map((o) => o.observedMs), [NOW - 4, NOW - 3, NOW - 2]);
  assert.equal(cut.truncated, true);
  const exact = await observationsInWindow(db, NOW - 4, NOW, 4);
  assert.equal(exact.truncated, false);
  for (const limit of [0, -1, 1.5, MAX_REPORT_ROWS + 1]) {
    await assert.rejects(observationsInWindow(db, NOW - 10, NOW, limit), RangeError, String(limit));
  }
});

/** A Db that counts its reads, around another Db. */
function recording(db: Db): Db & { reads: number } {
  const r = {
    reads: 0,
    all<T>(sql: string, params?: SqlValue[]) {
      r.reads++;
      return db.all<T>(sql, params);
    },
    run: (sql: string, params?: SqlValue[]) => db.run(sql, params),
    batch: (stmts: Stmt[]) => db.batch(stmts),
  };
  return r;
}

test("invalid windows are refused before any read", async () => {
  const db = recording(sqliteDb());
  for (const [f, t] of [[NOW, NOW - 10], [-1, 10], [0, Number.NaN], [0, 367 * 86_400_000], [10, 10]]) {
    await assert.rejects(storedAvailabilityReport(db, f!, t!), RangeError, `${f} ${t}`);
    await assert.rejects(observationsInWindow(db, f!, t!), RangeError, `${f} ${t}`);
  }
  assert.equal(db.reads, 0);
});

test("storedAvailabilityReport reports from the store, and checks the window first", async () => {
  const db = sqliteDb();
  await recordObservations(db, [obs(NOW - 2), obs(NOW - 1, { outcome: "no_capacity", readyMs: null })], NOW);
  const r = await storedAvailabilityReport(db, NOW - 10, NOW);
  assert.equal(r.observations, 2);
  assert.deepEqual(r.groups[0]!.launches.capacity, { launched: 1, of: 2 });
  await assert.rejects(storedAvailabilityReport(db, NOW, NOW - 10), RangeError);
});

// ---------------------------------------------------------------- LIMITS H1: retention coverage

/** Fill the store to exactly the cap with no_capacity launches at observed_ms 1..cap. */
function fillToCap(raw: DatabaseSync): void {
  raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_OBSERVATIONS})
    INSERT INTO availability_observations (provider, gpu_type, gpu_count, data_center, country, observed_ms, source, outcome, quoted_cost_per_hour, ready_ms)
    SELECT 'runpod', 'L4', 1, 'EU-SE-1', 'SE', i, 'launch', 'no_capacity', NULL, NULL FROM n`);
}

test("a fresh store's reports are complete, even where nothing was ever measured", async () => {
  const db = sqliteDb();
  const r = await storedAvailabilityReport(db, 1, 2);
  assert.deepEqual([r.observations, r.truncated, r.prunedThroughMs, r.complete], [0, false, null, true]);
});

test("pruning marks fully and partially pruned windows incomplete; recent windows stay complete", async () => {
  const db = sqliteDb();
  fillToCap(db.raw);
  const before = await storedAvailabilityReport(db, 1, 4);
  assert.deepEqual([before.observations, before.complete, before.prunedThroughMs], [3, true, null]);
  await recordObservations(db, [obs(NOW)], NOW); // prunes observed_ms 1
  const full = await storedAvailabilityReport(db, 1, 2);
  assert.deepEqual([full.observations, full.complete, full.prunedThroughMs], [0, false, 1]);
  const partial = await storedAvailabilityReport(db, 1, 4);
  assert.deepEqual([partial.observations, partial.complete], [2, false]);
  const after = await storedAvailabilityReport(db, 2, 4);
  assert.deepEqual([after.observations, after.complete], [2, true]);
  const recent = await storedAvailabilityReport(db, NOW - 10, NOW + 1);
  assert.deepEqual([recent.observations, recent.complete], [1, true]);
  // The mark only moves forward, and with each prune.
  await recordObservations(db, [obs(NOW), obs(NOW)], NOW); // prunes 2 and 3
  assert.equal((await storedAvailabilityReport(db, NOW - 10, NOW + 1)).prunedThroughMs, 3);
  assert.equal((await storedAvailabilityReport(db, 3, 5)).complete, false);
  assert.equal((await storedAvailabilityReport(db, 4, 5)).complete, true);
});

test("ties: pruning one of two rows at the same time marks that time incomplete", async () => {
  const db = sqliteDb();
  fillToCap(db.raw);
  db.raw.exec("UPDATE availability_observations SET observed_ms = 1 WHERE observed_ms = 2"); // two rows at ms 1
  await recordObservations(db, [obs(NOW)], NOW); // prunes one of them
  const r = await storedAvailabilityReport(db, 1, 2);
  assert.deepEqual([r.observations, r.complete, r.prunedThroughMs], [1, false, 1]);
});

test("a backdated insert below the mark doesn't make its window look complete", async () => {
  const db = sqliteDb();
  fillToCap(db.raw);
  await recordObservations(db, [obs(NOW)], NOW); // mark = 1
  await recordObservations(db, [obs(0)], NOW); // backdated; pruned at once as the oldest
  const r = await storedAvailabilityReport(db, 0, 2);
  assert.equal(r.complete, false);
  assert.equal(r.prunedThroughMs, 1);
});

test("concurrent writes keep the cap and the mark consistent", async () => {
  const db = sqliteDb();
  fillToCap(db.raw);
  await Promise.all([recordObservations(db, [obs(NOW - 1)], NOW), recordObservations(db, [obs(NOW - 2), obs(NOW - 3)], NOW)]);
  assert.equal(count(db), MAX_OBSERVATIONS);
  assert.equal((await storedAvailabilityReport(db, NOW - 10, NOW + 1)).prunedThroughMs, 3);
  assert.equal((await storedAvailabilityReport(db, 3, 5)).complete, false);
});

test("a failed write moves neither the rows nor the mark", async () => {
  const db = sqliteDb();
  fillToCap(db.raw);
  db.raw.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON availability_retention BEGIN SELECT RAISE(ABORT, 'boom'); END");
  await assert.rejects(recordObservations(db, [obs(NOW)], NOW), /boom/);
  assert.equal(count(db), MAX_OBSERVATIONS);
  assert.equal((await storedAvailabilityReport(db, 1, 2)).complete, true);
});

/** A Db over a database file (what a restarted control plane reopens). */
function fileDb(path: string, migrate: boolean): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(path);
  if (migrate) for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  return {
    raw,
    async all<T>(sql: string, params: SqlValue[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlValue[] = []) {
      return { changes: Number(raw.prepare(sql).run(...params).changes) };
    },
    async batch(stmts: Stmt[]) {
      raw.exec("BEGIN");
      try {
        for (const s of stmts) raw.prepare(s.sql).run(...s.params);
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

test("the mark survives reopening the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbgpu-availability-"));
  try {
    const path = join(dir, "control.db");
    const first = fileDb(path, true);
    fillToCap(first.raw);
    await recordObservations(first, [obs(NOW)], NOW);
    first.raw.close();
    const reopened = fileDb(path, false);
    const r = await storedAvailabilityReport(reopened, 1, 2);
    assert.deepEqual([r.observations, r.complete, r.prunedThroughMs], [0, false, 1]);
    reopened.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
