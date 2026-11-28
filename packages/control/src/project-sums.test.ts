// A project's money totals are exact or refused (audit S10-F4): each ledger row is a safe integer, but their
// SUM need not be, and a rounded total is never shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newId } from "@sbgpu/api";
import { stmt } from "./db.ts";
import { exactSum } from "./projects.ts";
import { T0, call, code, person, world } from "./testing/world.ts";

test("exactSum: safe integers pass, an empty sum is zero, anything else is refused", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  for (const v of [0, 1, -1, MAX, -MAX]) assert.equal(exactSum(v), v);
  assert.equal(exactSum(null), 0);
  assert.equal(exactSum(undefined), 0);
  for (const v of [2 ** 53, -(2 ** 53), 2 ** 54, 1.5, "12", 12n, NaN, Infinity]) assert.throws(() => exactSum(v), /exact range/, String(v));
});

test("a project whose ledger total passes 2^53 - 1 is refused, never shown rounded; a total at the bound is shown", async () => {
  const w = await world({ budget: 1000 });
  const own = await person(w, "own@example.com", "owner");
  const alloc = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [own.memberId]))[0]!.id;
  const row = (total: number) =>
    stmt(
      `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, created_ms) VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 0, ?, 0, ?, ?)`,
      newId("ledgerEntry"), w.orgId, w.projectId, alloc, T0, total, total, T0,
    );
  const get = () => call(w, "GET", `/v1/projects/${w.projectId}`, { cookie: own.cookie });
  await w.db.batch([row(Number.MAX_SAFE_INTEGER - 1), row(1)]);
  const at = await get();
  assert.equal(code(at), "ok");
  assert.equal((at.json as unknown as { spent: { total: number } }).spent.total, Number.MAX_SAFE_INTEGER);
  await w.db.batch([row(1)]);
  const past = await get();
  assert.equal(past.res.status, 500);
  assert.equal(code(past), "internal");
});

test("a database that hands back an unsafe sum as a rounded Number (as D1 may) is refused too", async () => {
  const w = await world({ budget: 1000 });
  const own = await person(w, "own@example.com", "owner");
  const all = w.db.all.bind(w.db);
  for (const field of ["p", "m", "t"]) {
    w.db.all = (async (sql: string, params?: (string | number | null)[]) => {
      const r = await all<Record<string, unknown>>(sql, params);
      return sql.includes("SUM(provider_cost)") ? [{ project_id: w.projectId, p: 0, m: 0, t: 0, [field]: 2 ** 53 }] : r;
    }) as typeof w.db.all;
    const r = await call(w, "GET", `/v1/projects/${w.projectId}`, { cookie: own.cookie });
    assert.equal(code(r), "internal", field);
  }
});
