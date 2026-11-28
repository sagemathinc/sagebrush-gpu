import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, isId, newId, type Organization, type Project } from "@sbgpu/api";
import type { DatabaseSync } from "node:sqlite";
import { sqliteDb } from "./testing/sqlite.ts";
import { CreditReferenceConflict, PROJECTS_PAGE_SIZE, addOrgCredit, normalizeCreditReference } from "./projects.ts";
import { stmt } from "./db.ts";
import { T0, addMember, call, code, person, signIn, world, type World } from "./testing/world.ts";

const MAX = Number.MAX_SAFE_INTEGER;
const ISO = (ms: number) => new Date(ms).toISOString();
const START = ISO(T0);
const END = ISO(T0 + 86_400_000);

async function orgOwner(w: World, email = "owner@example.com", orgId = w.orgId): Promise<string> {
  const p = await person(w, email, "member");
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) SELECT ?, user_id, 'owner' FROM members WHERE id = ?`, orgId, p.memberId)]);
  return p.cookie;
}

async function orgRow(w: World, orgId = w.orgId) {
  return { ...(await w.db.all<{ u: number; t: number }>(`SELECT unassigned_credit AS u, total_credit AS t FROM orgs WHERE id = ?`, [orgId]))[0]! };
}

/**
 * Every organization's and project's balances agree with the credit events, the whole
 * database, nothing excluded: total = the credits; unassigned + the projects' budgets =
 * total; each budget = its moves in less its moves out.
 */
async function audit(db: World["db"]) {
  const orgs = await db.all<{ id: string; u: number; t: number; credit: number; moved: number; budgets: number }>(`
    SELECT o.id, o.unassigned_credit AS u, o.total_credit AS t,
      (SELECT COALESCE(SUM(amount), 0) FROM credit_events WHERE org_id = o.id AND kind = 'credit') AS credit,
      (SELECT COALESCE(SUM(CASE kind WHEN 'to_project' THEN amount WHEN 'from_project' THEN -amount ELSE 0 END), 0) FROM credit_events WHERE org_id = o.id) AS moved,
      (SELECT COALESCE(SUM(budget), 0) FROM projects WHERE org_id = o.id) AS budgets
    FROM orgs o`);
  for (const o of orgs) {
    assert.equal(o.t, o.credit, `org ${o.id}: total vs credits`);
    assert.equal(o.u + o.budgets, o.t, `org ${o.id}: unassigned + budgets vs total`);
    assert.equal(o.u, o.credit - o.moved, `org ${o.id}: unassigned vs events`);
  }
  const projects = await db.all<{ id: string; budget: number; moved: number }>(`
    SELECT p.id, p.budget,
      (SELECT COALESCE(SUM(CASE kind WHEN 'to_project' THEN amount ELSE -amount END), 0) FROM credit_events WHERE project_id = p.id) AS moved
    FROM projects p`);
  for (const p of projects) assert.equal(p.budget, p.moved, `project ${p.id}: budget vs events`);
  return orgs.length;
}

const create = (w: World, cookie: string, body: Record<string, unknown>) =>
  call(w, "POST", `/v1/orgs/${w.orgId}/projects`, { cookie, body: { name: "P", startsAt: START, endsAt: END, budget: 0, ...body } });

test("G02-2: an operator credit is keyed by its reference, once per organization; a replay credits nothing", async () => {
  const w = await world({ budget: 0 });
  const events = async () => (await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM credit_events WHERE kind = 'credit'`))[0]!.n;
  // the audit's repro: the same $5,000 for the same wire, twice
  const first = await addOrgCredit(w.db, w.orgId, 5_000_000_000, "WIRE-2026-001", T0);
  const again = await addOrgCredit(w.db, w.orgId, 5_000_000_000, "WIRE-2026-001", T0 + 1);
  assert.deepEqual([again.unassignedCredit, again.totalCredit], [first.unassignedCredit, first.totalCredit]);
  assert.deepEqual(await orgRow(w), { u: 5_000_000_000, t: 5_000_000_000 }, "not $10,000");
  assert.equal(await events(), 1);
  // the same reference with another amount: refused, nothing written
  await assert.rejects(addOrgCredit(w.db, w.orgId, 4_000_000_000, "WIRE-2026-001", T0 + 2), CreditReferenceConflict);
  assert.deepEqual(await orgRow(w), { u: 5_000_000_000, t: 5_000_000_000 });
  assert.equal(await events(), 1);
  // typed by hand: case and spacing make no second credit (one reference, stored normalized)
  for (const typed of ["wire-2026-001", " WIRE-2026-001 ", "Wire-2026-001\t"]) {
    const o = await addOrgCredit(w.db, w.orgId, 5_000_000_000, typed, T0 + 3);
    assert.equal(o.unassignedCredit, 5_000_000_000, JSON.stringify(typed));
  }
  await assert.rejects(addOrgCredit(w.db, w.orgId, 1, "  wire-2026-001", T0 + 3), CreditReferenceConflict, "another amount, typed differently");
  assert.equal(await events(), 1);
  await addOrgCredit(w.db, w.orgId, 1, "WIRE-2026-002", T0 + 3);
  assert.equal(await events(), 2);
  // two racing calls with one new reference: one credit
  await Promise.all([addOrgCredit(w.db, w.orgId, 7, "PO 9", T0 + 4), addOrgCredit(w.db, w.orgId, 7, "PO 9", T0 + 4)]);
  assert.deepEqual(await orgRow(w), { u: 5_000_000_008, t: 5_000_000_008 });
  assert.equal(await events(), 3);
});

test("credit references are normalized: trimmed, inner whitespace collapsed, upper-cased; empty after that is refused", async () => {
  const w = await world({ budget: 0 });
  await addOrgCredit(w.db, w.orgId, 3, "  po   77\n  extra ", T0);
  const stored = await w.db.all<{ reference: string }>(`SELECT reference FROM credit_events WHERE kind = 'credit'`);
  assert.deepEqual(stored.map((r) => r.reference), ["PO 77 EXTRA"], "the stored form is the key");
  await addOrgCredit(w.db, w.orgId, 3, "PO 77 extra", T0 + 1);
  assert.deepEqual(await orgRow(w), { u: 3, t: 3 }, "the same reference: a replay");
  for (const blank of [" ", "\t\n", "   "]) await assert.rejects(addOrgCredit(w.db, w.orgId, 1, blank, T0), RangeError, JSON.stringify(blank));
  // the length is checked after normalizing: 200 characters plus padding is allowed, 201 is not
  await addOrgCredit(w.db, w.orgId, 1, `  ${"a".repeat(200)}  `, T0 + 2);
  await assert.rejects(addOrgCredit(w.db, w.orgId, 1, "b".repeat(201), T0), RangeError);
});

test("G02-2: the database refuses a second credit with one reference, a REPLACE of the kept one included", async () => {
  const w = await world({ budget: 0 });
  await addOrgCredit(w.db, w.orgId, 100, "INV-7", T0);
  const raw = (sql: string) => w.db.run(sql, [newId("creditEvent"), w.orgId, T0]);
  await assert.rejects(raw(`INSERT INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES (?, ?, 'credit', 100, 'INV-7', ?)`), /once per organization/);
  await assert.rejects(raw(`INSERT OR REPLACE INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES (?, ?, 'credit', 999, 'INV-7', ?)`), /once per organization/);
  const kept = await w.db.all<{ amount: number }>(`SELECT amount FROM credit_events WHERE reference = 'INV-7'`);
  assert.deepEqual(kept.map((k) => k.amount), [100], "the kept credit is still there, unchanged");
});

test("G02-2: the migration refuses a database where one organization already has two credits with one reference", () => {
  assert.throws(
    () =>
      sqliteDb({
        upgrade: {
          at: "0029",
          seed(raw) {
            raw.prepare(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES ('org_aaaaaaaaaaaaaaaaaaaa', 'Old', 'resold', 0, 0)`).run();
            for (const id of ["cre_1", "cre_2"]) raw.prepare(`INSERT INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES (?, 'org_aaaaaaaaaaaaaaaaaaaa', 'credit', 5, 'WIRE-1', 0)`).run(id);
          },
        },
      }),
    /malformed JSON/,
  );
});

/** A database at 0029 over credits stored before it: each [org, amount, reference], the org's balances their sum. */
function creditsBefore0029(credits: readonly (readonly [string, number, string])[]) {
  return sqliteDb({
    upgrade: {
      at: "0029",
      seed(raw) {
        for (const org of new Set(credits.map(([o]) => o))) {
          const sum = credits.filter(([o]) => o === org).reduce((a, [, n]) => a + n, 0);
          raw.prepare(`INSERT INTO orgs (id, name, billing_mode, margin_bps, unassigned_credit, total_credit, created_ms) VALUES (?, 'Old', 'resold', 0, ?, ?, 0)`).run(org, sum, sum);
        }
        for (const [i, [org, amount, reference]] of credits.entries()) {
          raw.prepare(`INSERT INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES (?, ?, 'credit', ?, ?, 0)`).run(`cre_old${i}`, org, amount, reference);
        }
      },
    },
  });
}
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

test("G02-2 upgrade: 0029 normalizes the credit references already stored, so typing one again is a replay, not a second credit", async () => {
  const db = creditsBefore0029([
    [ORG_A, 5_000_000_000, " wire\t 7 "],
    [ORG_A, 3, "stripe:in_lower"],
    [ORG_B, 5_000_000_000, "wire 7"],
  ]);
  const refs = await db.all<{ id: string; reference: string }>(`SELECT id, reference FROM credit_events ORDER BY id`);
  assert.deepEqual(refs.map((r) => r.reference), ["WIRE 7", "stripe:in_lower", "WIRE 7"], "operators' normalized; a reserved one kept exactly; another org may share one");
  const o = await addOrgCredit(db, ORG_A, 5_000_000_000, "WIRE 7", T0);
  assert.equal(o.totalCredit, 5_000_000_003, "a replay: $5,000 once, not $10,000");
  assert.equal(o.unassignedCredit, 5_000_000_003);
  await assert.rejects(addOrgCredit(db, ORG_A, 1, "wire 7", T0), CreditReferenceConflict);
  assert.equal((await db.all(`SELECT 1 FROM credit_events WHERE kind = 'credit'`)).length, 3);
  // and the events are append-only again afterwards
  assert.throws(() => db.raw.prepare(`UPDATE credit_events SET reference = 'X' WHERE id = 'cre_old0'`).run(), /never updated/);
});

test("G02-2 upgrade: 0029's SQL normalization is normalizeCreditReference's, over ASCII references", () => {
  const typed = ["inv-1", " PO\t77 \n", "a\u000bb\fc\rd", "  Wire   2026 - 001  ", "x", "Mixed Case\t\t\tTabs", " ".repeat(98) + "z" + "\t".repeat(98) + "y", "~!@#$%^&*()_+{}|:\"<>?`-=[]\;',./"];
  const db = creditsBefore0029(typed.map((t, i) => [`org_${String(i).padStart(20, "c")}`, 1, t] as const));
  const stored = db.raw.prepare(`SELECT reference FROM credit_events ORDER BY id`).all().map((r) => r.reference);
  assert.deepEqual(stored, typed.map(normalizeCreditReference));
});

test("G02-2 upgrade: 0029 refuses, for a human, references that would collide once normalized, or that it can't normalize exactly", () => {
  const refused = (credits: readonly (readonly [string, number, string])[]) => assert.throws(() => creditsBefore0029(credits), /malformed JSON/, JSON.stringify(credits));
  refused([[ORG_A, 5, "WIRE 7"], [ORG_A, 5, " wire  7"]]);
  refused([[ORG_A, 5, "wire\t7"], [ORG_A, 9, "Wire 7 "]]);
  refused([[ORG_A, 5, "WIRE 7"]]);
  refused([[ORG_A, 5, "café"]]);
  refused([[ORG_A, 5, "inv\u00011"]]);
  refused([[ORG_A, 5, " \t\n "]]);
  // the same two in different organizations are fine
  creditsBefore0029([[ORG_A, 5, "WIRE 7"], [ORG_B, 5, " wire  7"]]);
});

test("addOrgCredit: operators add credit, recorded; refused without a valid amount, reference or org", async () => {
  const w = await world({ budget: 0 });
  const o = await addOrgCredit(w.db, w.orgId, 1_000_000, "INV-1", T0);
  assert.deepEqual([o.unassignedCredit, o.totalCredit], [1_000_000, 1_000_000]);
  await addOrgCredit(w.db, w.orgId, 5, "PO 77", T0 + 1);
  assert.deepEqual(await orgRow(w), { u: 1_000_005, t: 1_000_005 });
  const ev = await w.db.all<{ kind: string; amount: number; reference: string; project_id: string | null }>(`SELECT kind, amount, reference, project_id FROM credit_events ORDER BY created_ms`);
  assert.deepEqual(ev.map((e) => ({ ...e })), [
    { kind: "credit", amount: 1_000_000, reference: "INV-1", project_id: null },
    { kind: "credit", amount: 5, reference: "PO 77", project_id: null },
  ]);
  for (const amount of [0, -1, 1.5, NaN, MAX + 1]) await assert.rejects(addOrgCredit(w.db, w.orgId, amount, "x", T0), RangeError, String(amount));
  for (const ref of ["", "x".repeat(201), 5 as unknown as string]) await assert.rejects(addOrgCredit(w.db, w.orgId, 1, ref, T0), RangeError);
  await assert.rejects(addOrgCredit(w.db, newId("org"), 1, "x", T0), RangeError);
  // past the safe range: refused, nothing changes
  await assert.rejects(addOrgCredit(w.db, w.orgId, MAX - 1_000_000, "big", T0));
  assert.deepEqual(await orgRow(w), { u: 1_000_005, t: 1_000_005 });
  assert.equal((await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM credit_events`))[0]!.n, 2);
  assert.equal("addOrgCredit" in (await import("./app.ts")).HANDLERS, false); // never over HTTP
  assert.equal(code(await call(w, "POST", `/v1/orgs/${w.orgId}/credit`, { cookie: await orgOwner(w), body: { amount: 1, reference: "x" } })), "forbidden");
});

test("getOrg: org members only", async () => {
  const w = await world({ budget: 0 });
  await addOrgCredit(w.db, w.orgId, 700, "INV", T0);
  const own = await orgOwner(w);
  const r = await call(w, "GET", `/v1/orgs/${w.orgId}`, { cookie: own });
  const o = r.json as unknown as Organization;
  assert.deepEqual([o.id, o.name, o.marginBps, o.unassignedCredit, o.totalCredit, o.createdAt], [w.orgId, "Org", 3000, 700, 700, ISO(T0)]);
  const stranger = (await person(w, "s@example.com", "owner")).cookie; // a project owner, not an org member
  assert.equal(code(await call(w, "GET", `/v1/orgs/${w.orgId}`, { cookie: stranger })), "notFound");
});

test("createProject: the budget comes out of unassigned credit, in one step", async () => {
  const w = await world({ budget: 0 });
  await addOrgCredit(w.db, w.orgId, 10_000, "INV", T0);
  const own = await orgOwner(w);
  const r = await create(w, own, { name: "  Fine-tuning  ", budget: 4_000, policy: { allowedGpuTypes: ["L4"], finalSaveReserveMinutes: 15 }, labels: { project: "Course", member: "Student", manager: "Instructor", assistant: "TA", team: "Group" } });
  assert.equal(r.res.status, 200, JSON.stringify(r.json));
  const p = r.json as unknown as Project;
  assert.deepEqual([p.name, p.orgId, p.budget, p.allocated, p.startsAt, p.endsAt, p.marginBpsOverride], ["Fine-tuning", w.orgId, 4_000, 0, START, END, null]);
  assert.deepEqual(p.spent, { providerCost: 0, margin: 0, total: 0 });
  assert.deepEqual(p.policy, { ...DEFAULT_POLICY, allowedGpuTypes: ["L4"], finalSaveReserveMinutes: 15 });
  assert.equal(p.labels?.member, "Student");
  assert.deepEqual(await orgRow(w), { u: 6_000, t: 10_000 });
  await audit(w.db);
  // only what differs from the defaults is stored; the reserve lives in its column
  const row = await w.db.all<{ policy_json: string; f: number }>(`SELECT policy_json, final_save_reserve_minutes AS f FROM projects WHERE id = ?`, [p.id]);
  assert.deepEqual([JSON.parse(row[0]!.policy_json), row[0]!.f], [{ allowedGpuTypes: ["L4"] }, 15]);
  const ev = await w.db.all<{ kind: string; amount: number; project_id: string }>(`SELECT kind, amount, project_id FROM credit_events WHERE kind <> 'credit'`);
  assert.deepEqual(ev.map((e) => ({ ...e })), [{ kind: "to_project", amount: 4_000, project_id: p.id }]);
  // a zero budget writes no credit event
  assert.equal(code(await create(w, own, { name: "Free" })), "ok");
  assert.equal((await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM credit_events WHERE kind <> 'credit'`))[0]!.n, 1);
  // more than the unassigned credit: a conflict, and nothing is created or moved
  const over = await create(w, own, { name: "Too big", budget: 6_001 });
  assert.equal(code(over), "conflict");
  assert.equal((await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM projects WHERE name = 'Too big'`))[0]!.n, 0);
  assert.deepEqual(await orgRow(w), { u: 6_000, t: 10_000 });
  assert.equal(code(await create(w, own, { name: "Exactly", budget: 6_000 })), "ok");
  assert.deepEqual(await orgRow(w), { u: 0, t: 10_000 });
});

test("createProject: org owners only; malformed requests refused", async () => {
  const w = await world({ budget: 0 });
  await addOrgCredit(w.db, w.orgId, 100, "INV", T0);
  const own = await orgOwner(w);
  const viewer = await person(w, "v@example.com", "member");
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) SELECT ?, user_id, 'viewer' FROM members WHERE id = ?`, w.orgId, viewer.memberId)]);
  assert.equal(code(await create(w, viewer.cookie, {})), "forbidden");
  for (const body of [
    { name: "" },
    { name: "x".repeat(201) },
    { name: 5 },
    { startsAt: "2027-02-01" },
    { endsAt: START },
    { endsAt: ISO(T0 - 1) },
    { budget: -1 },
    { budget: 1.5 },
    { budget: "5" },
    { policy: { maxGpus: 2 } },
    { policy: { idleStopMinutes: 4 } },
    { policy: [] },
    { labels: { project: "x" } },
    { labels: "x" },
  ]) {
    assert.equal(code(await create(w, own, body)), "badRequest", JSON.stringify(body));
  }
  assert.equal((await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM projects`))[0]!.n, 1); // only the seed
  assert.equal(code(await create(w, own, { name: "x".repeat(200), endsAt: ISO(T0 + 1) })), "ok");
});

test("two concurrent creates that each fit the credit alone but not together: exactly one conflict", async () => {
  const w = await world({ budget: 0 });
  await addOrgCredit(w.db, w.orgId, 1000, "INV", T0);
  const own = await orgOwner(w);
  const [a, b] = await Promise.all([create(w, own, { name: "A", budget: 700 }), create(w, own, { name: "B", budget: 700 })]);
  assert.deepEqual([code(a!), code(b!)].sort(), ["conflict", "ok"]);
  assert.deepEqual(await orgRow(w), { u: 300, t: 1000 });
  await audit(w.db);
});

test("getProject: allocated and spent from the project's allocations and ledger", async () => {
  const w = await world({ budget: 10_000 });
  const mem = await person(w, "m@example.com", "member");
  await addMember(w, "a@example.com", "member", { allocation: 1_500 });
  await w.db.batch([stmt(`UPDATE allocations SET amount = 2000 WHERE holder_id = ?`, mem.memberId)]);
  // ledger entries (adjustments keep the fixture simple)
  const alloc = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [mem.memberId]))[0]!.id;
  for (const [p, m] of [[100, 30], [50, 15]]) {
    await w.db.batch([stmt(
      `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, created_ms) VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 3000, ?, ?, ?, ?)`,
      newId("ledgerEntry"), w.orgId, w.projectId, alloc, T0, p!, m!, p! + m!, T0,
    )]);
  }
  const r = await call(w, "GET", `/v1/projects/${w.projectId}`, { cookie: mem.cookie });
  const p = r.json as unknown as Project;
  assert.deepEqual([p.budget, p.allocated, p.spent], [10_000, 3_500, { providerCost: 150, margin: 45, total: 195 }]);
  assert.deepEqual(p.policy, DEFAULT_POLICY);
  assert.equal(p.labels, null);
});

test("updateProject: managers change names, dates, labels and the policy (merged)", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const mem = await person(w, "mem@example.com", "member");
  const P = `/v1/projects/${w.projectId}`;
  const up = (cookie: string, body: unknown) => call(w, "PATCH", P, { cookie, body });
  assert.equal(code(await up(mem.cookie, { name: "x" })), "forbidden");
  let p = (await up(mgr.cookie, { name: " Renamed ", policy: { idleStopMinutes: 60, allowedProviders: ["nebius"] } })).json as unknown as Project;
  assert.equal(p.name, "Renamed");
  assert.deepEqual([p.policy.idleStopMinutes, p.policy.allowedProviders, p.policy.maxSessionMinutes], [60, ["nebius"], DEFAULT_POLICY.maxSessionMinutes]);
  // a later patch keeps earlier changes
  p = (await up(mgr.cookie, { policy: { finalSaveReserveMinutes: 20 } })).json as unknown as Project;
  assert.deepEqual([p.policy.idleStopMinutes, p.policy.finalSaveReserveMinutes], [60, 20]);
  assert.equal((await w.db.all<{ f: number }>(`SELECT final_save_reserve_minutes AS f FROM projects WHERE id = ?`, [w.projectId]))[0]!.f, 20);
  // back to a default: no longer stored
  p = (await up(mgr.cookie, { policy: { idleStopMinutes: DEFAULT_POLICY.idleStopMinutes, allowedProviders: [] } })).json as unknown as Project;
  assert.deepEqual(JSON.parse((await w.db.all<{ j: string }>(`SELECT policy_json AS j FROM projects WHERE id = ?`, [w.projectId]))[0]!.j), {});
  // labels set and cleared; absent leaves them
  const labels = { project: "Course", member: "Student", manager: "Instructor", assistant: "TA", team: "Group" };
  assert.deepEqual(((await up(mgr.cookie, { labels })).json as unknown as Project).labels, labels);
  assert.deepEqual(((await up(mgr.cookie, { name: "N" })).json as unknown as Project).labels, labels);
  assert.equal(((await up(mgr.cookie, { labels: null })).json as unknown as Project).labels, null);
  // dates: one at a time, still in order
  const later = ISO(T0 + 2 * 86_400_000);
  assert.equal(((await up(mgr.cookie, { endsAt: later })).json as unknown as Project).endsAt, later);
  assert.equal(code(await up(mgr.cookie, { startsAt: later })), "badRequest");
  assert.equal(code(await up(mgr.cookie, { startsAt: ISO(T0 + 3 * 86_400_000) })), "badRequest");
  for (const body of [{ name: "" }, { policy: { nope: 1 } }, { labels: [] }, { endsAt: "tomorrow" }]) {
    assert.equal(code(await up(mgr.cookie, body)), "badRequest", JSON.stringify(body));
  }
});

test("moveProjectBudget: only an org owner moves credit, both ways, never below zero or the allocations", async () => {
  const w = await world({ budget: 0 });
  await addOrgCredit(w.db, w.orgId, 1000, "INV", T0);
  const own = await orgOwner(w);
  const p = (await create(w, own, { budget: 400 })).json as unknown as Project;
  const M = `/v1/projects/${p.id}/budget`;
  const move = (cookie: string, amount: unknown) => call(w, "POST", M, { cookie, body: { amount } });
  let r = await move(own, 300);
  assert.equal((r.json as unknown as Project).budget, 700);
  assert.deepEqual(await orgRow(w), { u: 300, t: 1000 });
  r = await move(own, -200);
  assert.equal((r.json as unknown as Project).budget, 500);
  assert.deepEqual(await orgRow(w), { u: 500, t: 1000 });
  await audit(w.db);
  // too much either way: a conflict, nothing moves
  assert.equal(code(await move(own, 501)), "conflict");
  assert.equal(code(await move(own, -501)), "conflict");
  assert.deepEqual(await orgRow(w), { u: 500, t: 1000 });
  // not below what's allocated
  await addMember(w, "a@example.com", "member", { projectId: p.id, allocation: 450 });
  assert.equal(code(await move(own, -51)), "conflict");
  assert.equal(code(await move(own, -50)), "ok");
  for (const amount of [0, 1.5, "5", null, MAX + 1]) assert.equal(code(await move(own, amount)), "badRequest", String(amount));
  // a project owner who doesn't own the organization can't move money
  const po = await addMember(w, "po@example.com", "owner", { projectId: p.id });
  const poCookie = await signIn(w, "po@example.com");
  assert.equal(code(await move(poCookie, 1)), "forbidden");
  void po;
  // nor does one who only views the organization
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) SELECT ?, user_id, 'viewer' FROM members WHERE project_id = ? AND email = 'po@example.com'`, w.orgId, p.id)]);
  assert.equal((await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM org_members WHERE role = 'viewer'`))[0]!.n, 1);
  assert.equal(code(await move(poCookie, 1)), "forbidden");
  const ev = await w.db.all<{ kind: string; amount: number }>(`SELECT kind, amount FROM credit_events WHERE project_id = ? ORDER BY rowid`, [p.id]);
  assert.deepEqual(ev.map((e) => [e.kind, e.amount]), [["to_project", 400], ["to_project", 300], ["from_project", 200], ["from_project", 50]]);
  await audit(w.db);
});

test("two concurrent moves that each fit but not together: exactly one conflict", async () => {
  const w = await world({ budget: 0 });
  await addOrgCredit(w.db, w.orgId, 1000, "INV", T0);
  const own = await orgOwner(w);
  const p = (await create(w, own, { budget: 0 })).json as unknown as Project;
  const [a, b] = await Promise.all([600, 600].map((amount) => call(w, "POST", `/v1/projects/${p.id}/budget`, { cookie: own, body: { amount } })));
  assert.deepEqual([code(a!), code(b!)].sort(), ["conflict", "ok"]);
  assert.deepEqual(await orgRow(w), { u: 400, t: 1000 });
});

test("listProjects: org members, paged", async () => {
  const w = await world({ budget: 0 });
  const own = await orgOwner(w);
  // exactly one full page (the seed plus PROJECTS_PAGE_SIZE - 1): no next page
  for (let i = 0; i < PROJECTS_PAGE_SIZE - 1; i++) await create(w, own, { name: `p${i}` });
  const one = (await call(w, "GET", `/v1/orgs/${w.orgId}/projects`, { cookie: own })).json as unknown as { items: Project[]; next: string | null };
  assert.deepEqual([one.items.length, one.next], [PROJECTS_PAGE_SIZE, null]);
  for (let i = PROJECTS_PAGE_SIZE - 1; i < PROJECTS_PAGE_SIZE + 10; i++) await create(w, own, { name: `p${i}` });
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r: Awaited<ReturnType<typeof call>> = await call(w, "GET", `/v1/orgs/${w.orgId}/projects${cursor ? `?cursor=${cursor}` : ""}`, { cookie: own });
    const page = r.json as unknown as { items: Project[]; next: string | null };
    assert.ok(page.items.length <= PROJECTS_PAGE_SIZE);
    seen.push(...page.items.map((x) => x.id));
    cursor = page.next;
    pages++;
  } while (cursor);
  assert.deepEqual([pages, seen.length, new Set(seen).size], [2, PROJECTS_PAGE_SIZE + 11, PROJECTS_PAGE_SIZE + 11]);
  // another org's projects aren't listed, and its list isn't reachable
  const other = newId("org");
  await w.db.batch([stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'B', 'resold', 0, ?)`, other, T0)]);
  assert.equal(code(await call(w, "GET", `/v1/orgs/${other}/projects`, { cookie: own })), "notFound");
});

test("schema: credit events and stored policy are well-formed, balances never negative", async () => {
  const w = await world({ budget: 0 });
  const ev = (o: Record<string, string | number | null>) => {
    const v = { kind: "credit", amount: 1, project: null, reference: "x", ...o };
    return w.db.batch([stmt(`INSERT INTO credit_events (id, org_id, kind, amount, project_id, reference, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`, newId("creditEvent"), w.orgId, v.kind, v.amount, v.project, v.reference, T0)]);
  };
  await ev({});
  await assert.rejects(ev({ amount: 0 }));
  await assert.rejects(ev({ amount: -5 }));
  await assert.rejects(ev({ reference: null })); // a credit names its invoice
  await assert.rejects(ev({ project: w.projectId })); // and no project
  await assert.rejects(ev({ kind: "to_project", reference: null })); // a move names its project
  await assert.rejects(ev({ kind: "to_project", project: w.projectId })); // and no invoice
  await ev({ kind: "to_project", project: w.projectId, reference: null });
  await assert.rejects(ev({ kind: "to_project", project: newId("project"), reference: null }), /FOREIGN KEY/);
  await assert.rejects(ev({ kind: "refund" }));
  await assert.rejects(w.db.batch([stmt(`UPDATE credit_events SET amount = 2`)]), /never updated/);
  await assert.rejects(w.db.batch([stmt(`DELETE FROM credit_events`)]), /never deleted/);
  await assert.rejects(w.db.batch([stmt(`UPDATE orgs SET unassigned_credit = -1`)]));
  await assert.rejects(w.db.batch([stmt(`UPDATE orgs SET total_credit = ?`, MAX + 1)]));
  await assert.rejects(w.db.batch([stmt(`UPDATE projects SET policy_json = '[]'`)]));
  await assert.rejects(w.db.batch([stmt(`UPDATE projects SET policy_json = 'nope'`)]));
  await assert.rejects(w.db.batch([stmt(`UPDATE projects SET labels_json = '"x"'`)]));
  await w.db.batch([stmt(`UPDATE projects SET labels_json = NULL`)]);
});

// ---- upgrading: migration 0006 over projects funded before credit accounting

const DAY = 86_400_000;
const oldOrg = (raw: DatabaseSync, id: string) => raw.prepare(`INSERT INTO orgs (id, name, margin_bps, created_ms) VALUES (?, 'Old', 3000, ?)`).run(id, T0);
const oldProject = (raw: DatabaseSync, orgId: string, budget: number, createdMs = T0) => {
  const id = newId("project");
  raw.prepare(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Old', ?, ?, ?, ?)`).run(id, orgId, T0, T0 + DAY, budget, createdMs);
  return id;
};

test("0006 opens balances for projects funded before it, with their history, and the API keeps them balanced", async () => {
  const [A, B, C, D] = [newId("org"), newId("org"), newId("org"), newId("org")];
  let a1 = "", a3 = "", b1 = "";
  const w = await world({
    upgrade: {
      at: "0006",
      seed(raw) {
        for (const o of [A, B, C, D]) oldOrg(raw, o);
        a1 = oldProject(raw, A, 1000, T0 + 5);
        oldProject(raw, A, 0, T0 + 1); // (unfunded: no event, and not the opening time)
        a3 = oldProject(raw, A, 250, T0 + 9);
        b1 = oldProject(raw, B, 500, T0 + 2);
        oldProject(raw, D, 0); // C has no projects; D only an unfunded one
      },
    },
  });
  for (const [o, t] of [[A, 1250], [B, 500], [C, 0], [D, 0]] as const) assert.deepEqual(await orgRow(w, o), { u: 0, t }, o);
  const ev = await w.db.all<{ id: string; org_id: string; kind: string; amount: number; project_id: string | null; reference: string | null; created_ms: number }>(
    `SELECT * FROM credit_events WHERE org_id IN (?, ?, ?, ?) ORDER BY org_id, kind, amount`, [A, B, C, D]);
  const want = [
    { org_id: A, kind: "credit", amount: 1250, project_id: null, created_ms: T0 + 5 },
    { org_id: A, kind: "to_project", amount: 250, project_id: a3, created_ms: T0 + 9 },
    { org_id: A, kind: "to_project", amount: 1000, project_id: a1, created_ms: T0 + 5 },
    { org_id: B, kind: "credit", amount: 500, project_id: null, created_ms: T0 + 2 },
    { org_id: B, kind: "to_project", amount: 500, project_id: b1, created_ms: T0 + 2 },
  ].sort((x, y) => (x.org_id < y.org_id ? -1 : x.org_id > y.org_id ? 1 : 0));
  assert.deepEqual(ev.map(({ org_id, kind, amount, project_id, created_ms }) => ({ org_id, kind, amount, project_id, created_ms })), want);
  for (const e of ev) {
    assert.ok(isId("creditEvent", e.id), e.id);
    assert.equal(e.reference, e.kind === "credit" ? "opening balance: project budgets before credit accounting" : null);
  }
  assert.equal(await audit(w.db), 5); // (the world's own org too)
  // the API from there: both directions on old projects, a new project, refusals; all balanced
  const own = await orgOwner(w, "a-owner@example.com", A);
  const move = (p: string, amount: number) => call(w, "POST", `/v1/projects/${p}/budget`, { cookie: own, body: { amount } });
  assert.equal(code(await move(a1, -300)), "ok");
  assert.deepEqual(await orgRow(w, A), { u: 300, t: 1250 });
  assert.equal(code(await move(a3, 100)), "ok");
  assert.equal(code(await move(a1, -701)), "conflict"); // (more than its budget)
  assert.equal(code(await move(a3, 201)), "conflict"); // (more than the unassigned credit)
  assert.equal(code(await call(w, "POST", `/v1/orgs/${A}/projects`, { cookie: own, body: { name: "New", startsAt: START, endsAt: END, budget: 200 } })), "ok");
  assert.deepEqual(await orgRow(w, A), { u: 0, t: 1250 });
  assert.equal(code(await move(b1, -1)), "notFound"); // (another organization's project)
  await addOrgCredit(w.db, A, 50, "INV-2", T0);
  assert.equal(code(await move(a1, -700)), "ok");
  assert.deepEqual(await orgRow(w, A), { u: 750, t: 1300 });
  await audit(w.db);
});

test("0006: opening event ids are fresh, even for an org and a project whose ids share their suffix", async () => {
  const suffix = "a".repeat(20);
  const org = `org_${suffix}`;
  const project = `prj_${suffix}`;
  const org2 = `org_${"b".repeat(20)}`;
  const w = await world({
    upgrade: {
      at: "0006",
      seed(raw) {
        oldOrg(raw, org);
        oldOrg(raw, org2);
        raw.prepare(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Old', ?, ?, 1000, ?)`).run(project, org, T0, T0 + DAY, T0);
        // (and a project whose suffix is another org's)
        raw.prepare(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Old', ?, ?, 300, ?)`).run(`prj_${"b".repeat(20)}`, org, T0, T0 + DAY, T0);
        oldProject(raw, org2, 70);
      },
    },
  });
  const ids = (await w.db.all<{ id: string }>(`SELECT id FROM credit_events WHERE org_id IN (?, ?)`, [org, org2])).map((r) => r.id);
  assert.equal(ids.length, 5); // 2 opening credits, 3 moves
  assert.equal(new Set(ids).size, 5);
  for (const id of ids) {
    assert.ok(isId("creditEvent", id), id);
    assert.ok(!id.endsWith(suffix) && !id.endsWith("b".repeat(20)), id);
  }
  assert.deepEqual(await orgRow(w, org), { u: 0, t: 1300 });
  assert.deepEqual(await orgRow(w, org2), { u: 0, t: 70 });
  await audit(w.db);
  // the API carries on from there
  const own = await orgOwner(w, "same@example.com", org);
  assert.equal(code(await call(w, "POST", `/v1/projects/${project}/budget`, { cookie: own, body: { amount: -400 } })), "ok");
  assert.deepEqual(await orgRow(w, org), { u: 400, t: 1300 });
  await audit(w.db);
});

test("0006 refuses budgets that add up past the safe range, before changing anything", () => {
  for (const budgets of [
    [MAX, 1], // just past the safe range
    Array.from({ length: 1025 }, () => MAX), // past 2^63: SQLite's own integer overflow
  ]) {
    let raw: DatabaseSync | null = null;
    const org = newId("org");
    assert.throws(() => sqliteDb({ upgrade: { at: "0006", seed(r) {
      raw = r;
      oldOrg(r, org);
      for (const b of budgets) oldProject(r, org, b);
    } } }), /malformed JSON|integer overflow/, String(budgets.length));
    const r = raw as unknown as DatabaseSync;
    // nothing of 0006 was applied: no new columns, no new table
    assert.deepEqual((r.prepare(`SELECT name FROM pragma_table_info('orgs') WHERE name LIKE '%credit%'`).all()), []);
    assert.deepEqual(r.prepare(`SELECT name FROM sqlite_master WHERE name = 'credit_events'`).all(), []);
  }
  // exactly the safe range is fine; another organization's budgets don't add to it
  const org = newId("org");
  const other = newId("org");
  const db = sqliteDb({ upgrade: { at: "0006", seed(r) {
    oldOrg(r, org);
    oldOrg(r, other);
    oldProject(r, org, MAX - 1);
    oldProject(r, org, 1);
    oldProject(r, other, MAX);
  } } });
  const t = db.raw.prepare(`SELECT id, total_credit AS t FROM orgs ORDER BY t`).all().map((x) => ({ ...x }));
  assert.deepEqual(t.map((x) => x.t), [MAX, MAX]);
});
