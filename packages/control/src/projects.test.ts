import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, newId, type Organization, type Project } from "@sbgpu/api";
import { PROJECTS_PAGE_SIZE, addOrgCredit } from "./projects.ts";
import { stmt } from "./db.ts";
import { T0, addMember, call, code, person, signIn, world, type World } from "./testing/world.ts";

const MAX = Number.MAX_SAFE_INTEGER;
const ISO = (ms: number) => new Date(ms).toISOString();
const START = ISO(T0);
const END = ISO(T0 + 86_400_000);

async function orgOwner(w: World, email = "owner@example.com"): Promise<string> {
  const p = await person(w, email, "member");
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) SELECT ?, user_id, 'owner' FROM members WHERE id = ?`, w.orgId, p.memberId)]);
  return p.cookie;
}

async function orgRow(w: World) {
  return { ...(await w.db.all<{ u: number; t: number }>(`SELECT unassigned_credit AS u, total_credit AS t FROM orgs WHERE id = ?`, [w.orgId]))[0]! };
}

/** total credit = unassigned + every project's budget (the world's seed project starts with its own budget, so it's left out). */
async function balanced(w: World, exclude: string[] = []) {
  const o = await orgRow(w);
  const b = await w.db.all<{ s: number | null }>(
    `SELECT SUM(budget) AS s FROM projects WHERE org_id = ? AND id NOT IN (${exclude.map(() => "?").join(",") || "''"})`,
    [w.orgId, ...exclude],
  );
  return o.t === o.u + (b[0]!.s ?? 0);
}

const create = (w: World, cookie: string, body: Record<string, unknown>) =>
  call(w, "POST", `/v1/orgs/${w.orgId}/projects`, { cookie, body: { name: "P", startsAt: START, endsAt: END, budget: 0, ...body } });

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
  assert.ok(await balanced(w, [w.projectId]));
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
  assert.ok(await balanced(w, [w.projectId]));
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
  assert.ok(await balanced(w, [w.projectId]));
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
  assert.ok(await balanced(w, [w.projectId]));
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
  await w.db.batch([stmt(`INSERT INTO orgs (id, name, margin_bps, created_ms) VALUES (?, 'B', 0, ?)`, other, T0)]);
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
