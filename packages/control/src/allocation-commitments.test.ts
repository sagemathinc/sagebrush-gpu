// An allocation never gives back money it has already committed (0023, audit S10-F2): rows that try to free
// spent or encumbered credit and spend it again through another allocation, by every write that lowers one
// (a member's or team's new amount, a team's deletion), through the routes and by raw SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newId } from "@sbgpu/api";
import { stmt } from "./db.ts";
import { T0, call, code, person, world, type World } from "./testing/world.ts";

const M = (w: World) => `/v1/projects/${w.projectId}/members`;
const allocationOf = async (w: World, holderId: string) =>
  (await w.db.all<{ id: string; amount: number }>(`SELECT id, amount FROM allocations WHERE holder_id = ?`, [holderId]))[0]!;

/** A ledger total charged to an allocation (an adjustment row: the trigger reads totals, whatever the kind). */
async function spend(w: World, allocationId: string, total: number) {
  await w.db.batch([
    stmt(
      `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, created_ms) VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 0, ?, 0, ?, ?)`,
      newId("ledgerEntry"), w.orgId, w.projectId, allocationId, T0, total, total, T0,
    ),
  ]);
}

/** A machine paid from `allocationId`, in `state`; with `unbilled`, an accrual that ends past its billed-through mark. */
async function machine(w: World, allocationId: string, memberId: string, state: string, unbilled = false) {
  const id = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, ?, 'runpod', 'L4', 1, 'X', ?, 1, ?)`,
      id, w.projectId, allocationId, memberId, state, T0,
    ),
  ]);
  if (unbilled) {
    await w.db.batch([
      stmt(`INSERT INTO machine_accruals (machine_id, incarnation, provider, provider_cost_per_hour, margin_bps, start_ms, end_ms) VALUES (?, 1, 'runpod', 1000, 0, ?, ?)`, id, T0, T0 + 120_000),
      stmt(`UPDATE machines SET billed_through_ms = ? WHERE id = ?`, T0, id),
    ]);
  }
  return id;
}

test("spent credit can't be freed by lowering a member's allocation, and so can't be spent again elsewhere", async () => {
  const w = await world({ budget: 1000 });
  const own = await person(w, "own@example.com", "owner");
  const a = await person(w, "a@example.com", "member");
  const b = await person(w, "b@example.com", "member");
  const set = (id: string, amount: number) => call(w, "PUT", `${M(w)}/${id}/allocation`, { cookie: own.cookie, body: { amount } });
  assert.equal(code(await set(a.memberId, 600)), "ok");
  assert.equal(code(await set(b.memberId, 400)), "ok");
  await spend(w, (await allocationOf(w, a.memberId)).id, 500);
  // A has spent 500 of 600: only the unspent 100 can go back
  const below = await set(a.memberId, 100);
  assert.equal(code(below), "conflict");
  assert.match(below.json.error!.message, /already spent/);
  assert.equal((await allocationOf(w, a.memberId)).amount, 600);
  assert.equal(code(await set(a.memberId, 499)), "conflict");
  assert.equal(code(await set(a.memberId, 500)), "ok", "down to exactly what it spent");
  // the freed 100 is all B can gain: A's spent 500 stays allocated
  assert.equal(code(await set(b.memberId, 501)), "conflict");
  assert.equal(code(await set(b.memberId, 500)), "ok");
  // raw SQL can't lower it either
  await assert.rejects(w.db.batch([stmt(`UPDATE allocations SET amount = 0 WHERE id = ?`, (await allocationOf(w, a.memberId)).id)]), /what it has spent/);
  // nor can the project's budget be returned past the spend (0003: the budget covers the allocations)
  await assert.rejects(w.db.batch([stmt(`UPDATE projects SET budget = 999 WHERE id = ?`, w.projectId)]), /over-allocation/);
  // raising an allocation is never refused here, even below what it spent (an overshoot)
  await spend(w, (await allocationOf(w, b.memberId)).id, 700);
  assert.equal(code(await set(b.memberId, 450)), "conflict", "B spent 700 of 500: no decrease at all");
});

test("encumbered credit can't be freed: no decrease while a machine may accrue or time is unbilled", async () => {
  const w = await world({ budget: 1000 });
  const own = await person(w, "own@example.com", "owner");
  const a = await person(w, "a@example.com", "member");
  const set = (amount: number) => call(w, "PUT", `${M(w)}/${a.memberId}/allocation`, { cookie: own.cookie, body: { amount } });
  assert.equal(code(await set(600)), "ok");
  const alloc = (await allocationOf(w, a.memberId)).id;
  for (const state of ["starting", "running", "saving", "stopping"]) {
    const m = await machine(w, alloc, a.memberId, state);
    const r = await set(500);
    assert.equal(code(r), "conflict", state);
    assert.match(r.json.error!.message, /stop them/, state);
    assert.equal(code(await set(700)), "ok", `${state}: an increase is fine`);
    assert.equal(code(await set(600)), "conflict", `${state}: and so is no decrease back`);
    await w.db.batch([stmt(`UPDATE machines SET state = 'stopped' WHERE id = ?`, m)]);
    assert.equal(code(await set(600)), "ok", `${state}: stopped, it can be lowered again`);
  }
  // stopped, but with time not yet billed
  await machine(w, alloc, a.memberId, "stopped", true);
  assert.equal(code(await set(500)), "conflict", "unbilled time");
  await assert.rejects(w.db.batch([stmt(`UPDATE allocations SET amount = 1 WHERE id = ?`, alloc)]), /unbilled time/);
  // a stopped or failed machine with nothing owed doesn't hold anything
  const w2 = await world({ budget: 1000 });
  const own2 = await person(w2, "own@example.com", "owner");
  const c = await person(w2, "c@example.com", "member");
  const set2 = (amount: number) => call(w2, "PUT", `${M(w2)}/${c.memberId}/allocation`, { cookie: own2.cookie, body: { amount } });
  await set2(300);
  for (const state of ["stopped", "failed", "deleted"]) await machine(w2, (await allocationOf(w2, c.memberId)).id, c.memberId, state);
  assert.equal(code(await set2(0)), "ok");
});

test("deleting a team returns only its unspent credit, and is refused while its machines run", async () => {
  const w = await world({ budget: 1000 });
  const mgr = await person(w, "mgr@example.com", "manager");
  const x = await person(w, "x@example.com", "member");
  const TP = `/v1/projects/${w.projectId}/teams`;
  const t = (await call(w, "POST", TP, { cookie: mgr.cookie, body: { name: "Red", memberIds: [x.memberId], allocation: 300 } })).json as unknown as { id: string; allocationId: string };
  await spend(w, t.allocationId, 120);
  const m = await machine(w, t.allocationId, x.memberId, "running");
  const refused = await call(w, "DELETE", `${TP}/${t.id}`, { cookie: mgr.cookie });
  assert.equal(code(refused), "conflict");
  assert.match(refused.json.error!.message, /stop them/);
  assert.equal((await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM teams WHERE id = ? AND deleted_ms IS NULL`, [t.id]))[0]!.n, 1, "the team stays");
  await w.db.batch([stmt(`UPDATE machines SET state = 'stopped' WHERE id = ?`, m)]);
  assert.equal(code(await call(w, "DELETE", `${TP}/${t.id}`, { cookie: mgr.cookie })), "ok");
  assert.equal((await w.db.all<{ amount: number }>(`SELECT amount FROM allocations WHERE id = ?`, [t.allocationId]))[0]!.amount, 120, "what it spent stays allocated");
  // so the rest of the budget is 880, not 1000
  const set = (amount: number) => call(w, "PUT", `${M(w)}/${x.memberId}/allocation`, { cookie: mgr.cookie, body: { amount } });
  assert.equal(code(await set(881)), "conflict");
  assert.equal(code(await set(880)), "ok");
});

test("a team that spent more than its allocation keeps its whole allocation when deleted", async () => {
  const w = await world({ budget: 1000 });
  const mgr = await person(w, "mgr@example.com", "manager");
  const TP = `/v1/projects/${w.projectId}/teams`;
  const t = (await call(w, "POST", TP, { cookie: mgr.cookie, body: { name: "Blue", memberIds: [], allocation: 200 } })).json as unknown as { id: string; allocationId: string };
  await spend(w, t.allocationId, 250);
  assert.equal(code(await call(w, "DELETE", `${TP}/${t.id}`, { cookie: mgr.cookie })), "ok");
  assert.equal((await w.db.all<{ amount: number }>(`SELECT amount FROM allocations WHERE id = ?`, [t.allocationId]))[0]!.amount, 200);
  // and one that spent nothing (or was refunded below zero) gives everything back
  const u = (await call(w, "POST", TP, { cookie: mgr.cookie, body: { name: "Green", memberIds: [], allocation: 100 } })).json as unknown as { id: string; allocationId: string };
  await spend(w, u.allocationId, -30);
  assert.equal(code(await call(w, "DELETE", `${TP}/${u.id}`, { cookie: mgr.cookie })), "ok");
  assert.equal((await w.db.all<{ amount: number }>(`SELECT amount FROM allocations WHERE id = ?`, [u.allocationId]))[0]!.amount, 0);
});
