import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_IDS } from "@sbgpu/api";
import { sqliteDb } from "./testing/sqlite.ts";

// "vast" is in the contract (PROVIDER_IDS) for the mock-only Vast adapter, but Vast isn't live: no
// adapter is wired, and the database still refuses any row for it. Allowing 'vast' here is a
// separate migration, for when Vast goes live. Each refusal is checked against the same row for a
// live provider, with foreign keys off, so it's the provider CHECK that refuses and nothing else.

test("the database refuses a 'vast' row in every table with a provider column", () => {
  assert.ok((PROVIDER_IDS as readonly string[]).includes("vast"));
  const db = sqliteDb();
  db.raw.exec("PRAGMA foreign_keys = OFF");
  const rows: Array<[string, (p: string) => void]> = [
    [
      "machines",
      (p) =>
        db.raw
          .prepare(
            `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, created_ms)
             VALUES (?, 'prj_x', 'alc_x', 'mem_x', ?, 'L4', 1, 'machine-4242', 'starting', 0)`,
          )
          .run(`mch_${p}`, p),
    ],
    [
      "machine_accruals",
      (p) =>
        db.raw
          .prepare(
            `INSERT INTO machine_accruals (machine_id, incarnation, provider, provider_cost_per_hour, margin_bps, start_ms)
             VALUES (?, 1, ?, 100, 0, 0)`,
          )
          .run(`mch_${p}`, p),
    ],
    [
      "availability_observations",
      (p) =>
        db.raw
          .prepare(
            `INSERT INTO availability_observations (provider, gpu_type, gpu_count, data_center, country, observed_ms, source, outcome)
             VALUES (?, 'L4', 1, 'machine-4242', 'SE', 0, 'listing', 'unknown')`,
          )
          .run(p),
    ],
  ];
  for (const [table, insert] of rows) {
    insert("nebius");
    assert.throws(() => insert("vast"), /CHECK constraint failed/, table);
  }
});

test("no provider CHECK in the schema admits 'vast'", () => {
  // Every table that constrains a provider: none lists 'vast'. (ledger_entries.provider has no CHECK
  // of its own: a compute entry must match its machine's accrual, which refuses 'vast' above.)
  const db = sqliteDb();
  const tables = db.raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%provider IN (%'").all() as Array<{ name: string; sql: string }>;
  assert.deepEqual(tables.map((t) => t.name).sort(), ["availability_observations", "machine_accruals", "machines", "launches"].sort());
  for (const t of tables) {
    for (const m of t.sql.matchAll(/provider IN \(([^)]*)\)/g)) assert.ok(!m[1]!.includes("'vast'"), t.name);
  }
});
