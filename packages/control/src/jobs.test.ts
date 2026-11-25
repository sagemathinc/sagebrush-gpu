import { test } from "node:test";
import assert from "node:assert/strict";
import { PRUNE_BATCH, SCHEDULED_JOBS, pruneAuthStates, pruneSessions, heartbeatWatchdog, vmWatchdog } from "./jobs.ts";
import { stmt } from "./db.ts";
import { sqliteDb } from "./testing/sqlite.ts";

const T = 1_800_000_000_000;

test("the job list, in order", () => {
  assert.deepEqual(SCHEDULED_JOBS.map((j) => j.name), [pruneSessions.name, pruneAuthStates.name, heartbeatWatchdog.name, vmWatchdog.name]);
});

test("prune sign-in states: expired ones only, at most a batch per run, soonest expired first", async () => {
  const db = sqliteDb();
  const hex = (i: number) => i.toString(16).padStart(64, "0");
  const stmts = [];
  // (state i expired i seconds before state 0)
  for (let i = 0; i < PRUNE_BATCH + 100; i++) stmts.push(stmt(`INSERT INTO auth_states (nonce_sha256, expires_ms) VALUES (?, ?)`, hex(i), T - i * 1000));
  stmts.push(stmt(`INSERT INTO auth_states (nonce_sha256, expires_ms) VALUES (?, ?)`, "f".repeat(64), T + 1));
  await db.batch(stmts);
  const n = async () => (await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM auth_states`))[0]!.n;
  const has = async (h: string) => (await db.all(`SELECT 1 FROM auth_states WHERE nonce_sha256 = ?`, [h])).length === 1;
  assert.equal(await pruneAuthStates.run({ db, now: T, vm: null, elapsedMs: () => 0 }), PRUNE_BATCH);
  assert.equal(await n(), 101);
  assert.deepEqual([await has(hex(0)), await has(hex(PRUNE_BATCH + 99))], [true, false]);
  assert.equal(await pruneAuthStates.run({ db, now: T, vm: null, elapsedMs: () => 0 }), 100);
  assert.equal(await n(), 1);
  assert.ok(await has("f".repeat(64)));
  assert.equal(await pruneAuthStates.run({ db, now: T, vm: null, elapsedMs: () => 0 }), 0);
});
