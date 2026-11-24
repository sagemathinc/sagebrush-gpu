import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, type Allocation, type Member } from "@sbgpu/api";
import { MAX_INVITES_PER_REQUEST, MEMBERS_PAGE_SIZE } from "./members.ts";
import { chunks, stmt } from "./db.ts";
import { T0, addMember, call, code, person, signIn, world, type World } from "./testing/world.ts";

const M = (w: World) => `/v1/projects/${w.projectId}/members`;
const invite = (w: World, cookie: string, members: unknown) => call(w, "POST", M(w), { cookie, body: { members } });
const count = async (w: World, sql: string, params: (string | number)[] = []) => (await w.db.all<{ n: number }>(sql, params))[0]!.n;
const allocationOf = async (w: World, memberId: string) =>
  (await w.db.all<{ amount: number }>(`SELECT amount FROM allocations WHERE holder_kind = 'member' AND holder_id = ?`, [memberId]))[0]?.amount;

// ---------------------------------------------------------------- invite

test("invite: members with their allocations; a person with an account joins as active", async () => {
  const w = await world({ budget: 1000 });
  const mgr = await person(w, "mgr@example.com", "manager");
  const known = await person(w, "known@example.org", "member"); // has an account
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE email = 'known@example.org'`)]);
  // a different project of the same org, so "known" can be invited here again? no: same project.
  // Invite into a second project instead, to exercise the account link.
  const p2 = newId("project");
  await w.db.batch([
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P2', ?, ?, 1000, ?)`, p2, w.orgId, T0, T0 + 1, T0),
    stmt(`INSERT INTO org_members (org_id, user_id, role) SELECT ?, user_id, 'owner' FROM members WHERE email = 'mgr@example.com'`, w.orgId),
  ]);
  const r = await call(w, "POST", `/v1/projects/${p2}/members`, {
    cookie: mgr.cookie,
    body: { members: [{ email: "New@Example.com", name: " Ada ", allocation: 300 }, { email: "known@example.org", role: "assistant" }] },
  });
  assert.equal(r.res.status, 200);
  const ms = (r.json as unknown as { members: Member[] }).members;
  assert.deepEqual(ms.map((m) => [m.email, m.role, m.status, m.name, m.projectId === p2]), [
    ["known@example.org", "assistant", "active", null, true],
    ["new@example.com", "member", "invited", "Ada", true],
  ]);
  assert.equal(ms[0]!.userId !== null, true);
  assert.equal(ms[1]!.userId, null);
  assert.equal(await allocationOf(w, ms[1]!.id), 300);
  assert.equal(await allocationOf(w, ms[0]!.id), 0);
  assert.equal(ms[1]!.allocationId.startsWith("alc_"), true);
  void known;
});

test("invite: who may invite whom", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const own = await person(w, "own@example.com", "owner");
  const asst = await person(w, "asst@example.com", "assistant");
  assert.equal(code(await invite(w, mgr.cookie, [{ email: "a@example.com" }])), "ok");
  assert.equal(code(await invite(w, mgr.cookie, [{ email: "b@example.com", role: "assistant" }])), "ok");
  assert.equal(code(await invite(w, mgr.cookie, [{ email: "c@example.com", role: "manager" }])), "forbidden");
  assert.equal(code(await invite(w, mgr.cookie, [{ email: "d@example.com", role: "owner" }])), "forbidden");
  // one forbidden row refuses the whole request
  assert.equal(code(await invite(w, mgr.cookie, [{ email: "e@example.com" }, { email: "f@example.com", role: "owner" }])), "forbidden");
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members WHERE email IN ('e@example.com', 'f@example.com')`), 0);
  assert.equal(code(await invite(w, own.cookie, [{ email: "g@example.com", role: "owner" }])), "ok");
  assert.equal(code(await invite(w, asst.cookie, [{ email: "h@example.com" }])), "forbidden"); // the route needs a manager
});

test("invite: malformed requests are refused whole", async () => {
  const w = await world();
  const own = await person(w, "own@example.com", "owner");
  const bad = async (members: unknown) => code(await invite(w, own.cookie, members));
  for (const m of [
    [],
    "a@example.com",
    [null],
    [[]],
    [{}],
    [{ email: "nope" }],
    [{ email: "a@example.com" }, { email: "A@example.com " }], // the same address twice
    [{ email: "a@example.com", role: "root" }],
    [{ email: "a@example.com", teamId: newId("team") }],
    [{ email: "a@example.com", allocation: -1 }],
    [{ email: "a@example.com", allocation: 1.5 }],
    [{ email: "a@example.com", allocation: "5" }],
    [{ email: "a@example.com", name: 5 }],
    [{ email: "a@example.com", name: "x".repeat(201) }],
  ]) {
    assert.equal(await bad(m), "badRequest", JSON.stringify(m).slice(0, 80));
  }
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members`), 1);
  // the row cap
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.com` }));
  assert.equal(await bad(many(MAX_INVITES_PER_REQUEST + 1)), "badRequest");
  assert.equal(await bad(many(MAX_INVITES_PER_REQUEST)), "ok");
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members`), MAX_INVITES_PER_REQUEST + 1);
  assert.equal(await bad([{ email: "a@example.com", name: "x".repeat(200) }]), "ok");
});

test("invite: an address already in the project is a conflict, and nothing is written", async () => {
  const w = await world();
  const own = await person(w, "own@example.com", "owner");
  await addMember(w, "old@example.com", "member", { status: "removed" });
  assert.equal(code(await invite(w, own.cookie, [{ email: "fresh@example.com" }, { email: "own@example.com" }])), "conflict");
  assert.equal(code(await invite(w, own.cookie, [{ email: "OLD@example.com" }])), "conflict");
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members WHERE email = 'fresh@example.com'`), 0);
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM allocations`), 2);
});

test("invitations at D1's bound-parameter cap: 99, 100 and 500 succeed whole, with no failure after the commit", async () => {
  for (const n of [99, 100, 500]) {
    const w = await world();
    const own = await person(w, "own@example.com", "owner");
    const list = Array.from({ length: n }, (_, i) => ({ email: `p${String(i).padStart(3, "0")}@example.com` }));
    const r = await invite(w, own.cookie, list);
    assert.equal(r.res.status, 200, `${n}: ${JSON.stringify(r.json).slice(0, 200)}`);
    const ms = (r.json as unknown as { members: Member[] }).members;
    assert.equal(ms.length, n);
    assert.deepEqual(ms.map((m) => m.email), list.map((x) => x.email)); // sorted by email, all of them
    assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members`), n + 1);
  }
});

test("the test database refuses what D1 refuses: more than 100 bound parameters", async () => {
  const w = await world();
  const ps = (k: number) => Array.from({ length: k }, (_, i) => i);
  const sql = (k: number) => `SELECT ${ps(k).map(() => "?").join(" + ")} AS n`;
  assert.equal((await w.db.all<{ n: number }>(sql(100), ps(100)))[0]!.n, 4950);
  await assert.rejects(w.db.all(sql(101), ps(101)), /too many SQL variables/);
  await assert.rejects(w.db.run(sql(101), ps(101)), /too many SQL variables/);
  await assert.rejects(w.db.batch([{ sql: sql(1), params: [1] }, { sql: sql(101), params: ps(101) }]), /too many SQL variables/);
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunks([], 2), []);
  assert.throws(() => chunks([1], 0), RangeError);
  assert.throws(() => chunks([1, 2, 3], 1.5), RangeError);
});

// ---------------------------------------------------------------- the budget invariant

test("allocations never exceed the project budget: invites and changes", async () => {
  const w = await world({ budget: 1000 });
  const own = await person(w, "own@example.com", "owner");
  assert.equal(code(await invite(w, own.cookie, [{ email: "a@example.com", allocation: 600 }, { email: "b@example.com", allocation: 401 }])), "conflict");
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members`), 1);
  assert.equal(code(await invite(w, own.cookie, [{ email: "a@example.com", allocation: 600 }, { email: "b@example.com", allocation: 400 }])), "ok");
  const ids = await w.db.all<{ id: string; email: string }>(`SELECT id, email FROM members ORDER BY email`);
  const a = ids.find((x) => x.email === "a@example.com")!.id;
  const set = (id: string, amount: unknown) => call(w, "PUT", `${M(w)}/${id}/allocation`, { cookie: own.cookie, body: { amount } });
  assert.equal(code(await set(a, 601)), "conflict");
  assert.equal(await allocationOf(w, a), 600);
  assert.equal(code(await set(a, 0)), "ok");
  assert.equal(code(await set(a, 600)), "ok");
  // the budget can't drop below what is allocated
  await assert.rejects(w.db.batch([stmt(`UPDATE projects SET budget = 999 WHERE id = ?`, w.projectId)]), /over-allocation/);
  await w.db.batch([stmt(`UPDATE projects SET budget = 1000 WHERE id = ?`, w.projectId)]);
  // nor can an allocation be inserted past it by any other path
  await assert.rejects(
    w.db.batch([stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', 'team_x', 1, ?)`, newId("allocation"), w.projectId, T0)]),
    /over-allocation/,
  );
});

test("the budget triggers count only their own project: valid changes beside a populated project", async () => {
  // two populated projects: P1 (budget 1000, allocated 600) and P2 (budget 1000, allocated 900)
  const w = await world({ budget: 1000 });
  const p2 = newId("project");
  await w.db.batch([stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P2', ?, ?, 1000, ?)`, p2, w.orgId, T0, T0 + 1, T0)]);
  const a = await addMember(w, "a@example.com", "member", { allocation: 600 });
  await addMember(w, "b@example.com", "member", { projectId: p2, allocation: 900 });
  const own = await person(w, "own@example.com", "owner");
  // an allocation change that fits its own project (600 -> 1000 of 1000), though the two
  // projects together would hold 1900
  assert.equal(code(await call(w, "PUT", `${M(w)}/${a}/allocation`, { cookie: own.cookie, body: { amount: 1000 } })), "ok");
  await w.db.batch([stmt(`UPDATE allocations SET amount = 600 WHERE holder_id = ?`, a)]);
  // a budget lowered to exactly its own allocations' sum
  await w.db.batch([stmt(`UPDATE projects SET budget = 600 WHERE id = ?`, w.projectId)]);
  assert.equal(await count(w, `SELECT budget AS n FROM projects WHERE id = ?`, [w.projectId]), 600);
  // and one below it is still refused
  await assert.rejects(w.db.batch([stmt(`UPDATE projects SET budget = 599 WHERE id = ?`, w.projectId)]), /over-allocation/);
});

test("two concurrent changes that each fit alone but not together: exactly one conflict", async () => {
  const w = await world({ budget: 1000 });
  const own = await person(w, "own@example.com", "owner");
  await invite(w, own.cookie, [{ email: "a@example.com" }, { email: "b@example.com" }]);
  const ids = await w.db.all<{ id: string }>(`SELECT id FROM members WHERE email IN ('a@example.com', 'b@example.com')`);
  const [x, y] = await Promise.all(
    ids.map((r) => call(w, "PUT", `${M(w)}/${r.id}/allocation`, { cookie: own.cookie, body: { amount: 600 } })),
  );
  assert.deepEqual([code(x!), code(y!)].sort(), ["conflict", "ok"]);
  assert.equal(await count(w, `SELECT SUM(amount) AS n FROM allocations WHERE project_id = ?`, [w.projectId]), 600);
  // and two concurrent invitations
  const v = await world({ budget: 1000 });
  const o2 = await person(v, "own@example.com", "owner");
  const [p, q] = await Promise.all([
    invite(v, o2.cookie, [{ email: "p@example.com", allocation: 700 }]),
    invite(v, o2.cookie, [{ email: "q@example.com", allocation: 700 }]),
  ]);
  assert.deepEqual([code(p!), code(q!)].sort(), ["conflict", "ok"]);
  assert.equal(await count(v, `SELECT COUNT(*) AS n FROM members`), 2);
});

test("setMemberAllocation: who, what and which", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const mem = await person(w, "mem@example.com", "member");
  const r = await call(w, "PUT", `${M(w)}/${mem.memberId}/allocation`, { cookie: mgr.cookie, body: { amount: 1234 } });
  assert.equal(r.res.status, 200);
  const a = r.json as unknown as Allocation;
  assert.deepEqual([a.amount, a.projectId, a.holder], [1234, w.projectId, { kind: "member", memberId: mem.memberId }]);
  assert.equal(a.updatedAt, new Date(T0).toISOString());
  assert.equal(code(await call(w, "PUT", `${M(w)}/${mem.memberId}/allocation`, { cookie: mem.cookie, body: { amount: 1 } })), "forbidden");
  for (const amount of [-1, 1.5, "1", null, 2 ** 53]) {
    assert.equal(code(await call(w, "PUT", `${M(w)}/${mem.memberId}/allocation`, { cookie: mgr.cookie, body: { amount } })), "badRequest", String(amount));
  }
  assert.equal(code(await call(w, "PUT", `${M(w)}/${newId("member")}/allocation`, { cookie: mgr.cookie, body: { amount: 1 } })), "notFound");
  // a member of another project, through this project's path
  const p2 = newId("project");
  await w.db.batch([stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P2', ?, ?, 1000, ?)`, p2, w.orgId, T0, T0 + 1, T0)]);
  const other = await addMember(w, "x@example.com", "member", { projectId: p2 });
  assert.equal(code(await call(w, "PUT", `${M(w)}/${other}/allocation`, { cookie: mgr.cookie, body: { amount: 1 } })), "notFound");
  assert.equal(await allocationOf(w, other), 0);
});

// ---------------------------------------------------------------- update and remove

test("updateMember: roles by authz, names, and the last owner", async () => {
  const w = await world();
  const own = await person(w, "own@example.com", "owner");
  const mgr = await person(w, "mgr@example.com", "manager");
  const mem = await person(w, "mem@example.com", "member");
  const up = (cookie: string, id: string, body: unknown) => call(w, "PATCH", `${M(w)}/${id}`, { cookie, body });
  assert.equal(code(await up(mgr.cookie, mem.memberId, { role: "assistant" })), "ok");
  assert.equal(code(await up(mgr.cookie, mem.memberId, { role: "manager" })), "forbidden");
  assert.equal(code(await up(mgr.cookie, own.memberId, { name: "x" })), "forbidden");
  assert.equal(code(await up(mem.cookie, mem.memberId, { name: "x" })), "forbidden");
  const r = await up(own.cookie, mem.memberId, { role: "manager", name: "  Grace " });
  assert.equal(r.res.status, 200);
  assert.deepEqual([(r.json as unknown as Member).role, (r.json as unknown as Member).name], ["manager", "Grace"]);
  // name: unchanged when absent, cleared by null
  assert.equal((await up(own.cookie, mem.memberId, { role: "member" })).json.name, "Grace");
  assert.equal((await up(own.cookie, mem.memberId, { name: null })).json.name, null);
  // the last owner can't be demoted, by authz and by the database
  assert.equal(code(await up(own.cookie, own.memberId, { role: "manager" })), "conflict");
  await assert.rejects(w.db.batch([stmt(`UPDATE members SET role = 'manager' WHERE id = ?`, own.memberId)]), /last-owner/);
  assert.equal(code(await up(own.cookie, own.memberId, { role: "owner" })), "ok");
  for (const body of [{ role: "root" }, { teamId: newId("team") }, { name: 5 }]) {
    assert.equal(code(await up(own.cookie, mem.memberId, body)), "badRequest", JSON.stringify(body));
  }
  assert.equal(code(await up(own.cookie, newId("member"), {})), "notFound");
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, mem.memberId)]);
  assert.equal(code(await up(own.cookie, mem.memberId, { name: "y" })), "invalidState");
});

test("two owners demoting each other at once: exactly one wins", async () => {
  const w = await world();
  const a = await person(w, "a@example.com", "owner");
  const b = await person(w, "b@example.com", "owner");
  const [x, y] = await Promise.all([
    call(w, "PATCH", `${M(w)}/${b.memberId}`, { cookie: a.cookie, body: { role: "member" } }),
    call(w, "PATCH", `${M(w)}/${a.memberId}`, { cookie: b.cookie, body: { role: "member" } }),
  ]);
  // exactly one wins; the loser is refused cleanly: a conflict (the last-owner rule) or, if
  // the winner demoted it first, forbidden (it's no longer a manager)
  const codes = [code(x!), code(y!)];
  assert.equal(codes.filter((c) => c === "ok").length, 1, String(codes));
  assert.ok(codes.every((c) => c === "ok" || c === "conflict" || c === "forbidden"), String(codes));
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members WHERE role = 'owner' AND status = 'active'`), 1);
});

test("an org owner demoting both member owners at once: the database keeps one, the other is a conflict", async () => {
  const w = await world();
  const a = await person(w, "a@example.com", "owner");
  const b = await person(w, "b@example.com", "owner");
  // an org owner: an owner of the project without being a member of it
  const p2 = newId("project");
  await w.db.batch([stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P2', ?, ?, 0, ?)`, p2, w.orgId, T0, T0 + 1, T0)]);
  await addMember(w, "org@example.com", "member", { projectId: p2 });
  const org = await signIn(w, "org@example.com");
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) SELECT ?, id, 'owner' FROM users WHERE email = 'org@example.com'`, w.orgId)]);
  // A barrier at the owner count makes the race certain: both requests read "two owners"
  // and pass authz before either writes, so the trigger must refuse the second.
  const inner = w.deps.db;
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  w.deps.db = {
    ...inner,
    async all<T>(sql: string, params?: (string | number | null)[]) {
      if (sql.includes("role = 'owner' AND status = 'active' AND id <> ?")) {
        if (++arrived === 2) open();
        await gate;
      }
      return inner.all<T>(sql, params);
    },
  };
  const [x, y] = await Promise.all([
    call(w, "PATCH", `${M(w)}/${a.memberId}`, { cookie: org, body: { role: "member" } }),
    call(w, "PATCH", `${M(w)}/${b.memberId}`, { cookie: org, body: { role: "member" } }),
  ]);
  assert.deepEqual([code(x!), code(y!)].sort(), ["conflict", "ok"]);
  const loser = [x!, y!].find((r) => r.res.status !== 200)!;
  assert.equal(loser.json.error?.message, "a project keeps at least one active owner");
  assert.equal(arrived, 2);
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members WHERE role = 'owner' AND status = 'active'`), 1);
});

test("removeMember: by authz, never the last owner, kept on record", async () => {
  const w = await world();
  const own = await person(w, "own@example.com", "owner");
  const mgr = await person(w, "mgr@example.com", "manager");
  const mem = await person(w, "mem@example.com", "member", );
  await call(w, "PUT", `${M(w)}/${mem.memberId}/allocation`, { cookie: own.cookie, body: { amount: 77 } });
  const del = (cookie: string, id: string) => call(w, "DELETE", `${M(w)}/${id}`, { cookie });
  assert.equal(code(await del(mgr.cookie, own.memberId)), "forbidden");
  assert.equal(code(await del(mem.cookie, mgr.memberId)), "forbidden");
  assert.equal(code(await del(mgr.cookie, mem.memberId)), "ok");
  const row = await w.db.all<{ status: string }>(`SELECT status FROM members WHERE id = ?`, [mem.memberId]);
  assert.equal(row[0]!.status, "removed");
  assert.equal(await allocationOf(w, mem.memberId), 77); // spend stays attributed
  assert.equal(code(await del(mgr.cookie, mem.memberId)), "invalidState");
  assert.equal(code(await del(own.cookie, own.memberId)), "conflict"); // the last owner
  await assert.rejects(w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, own.memberId)]), /last-owner/);
  assert.equal(code(await del(own.cookie, newId("member"))), "notFound");
  // with a second owner, an owner may leave
  const own2 = await person(w, "own2@example.com", "owner");
  assert.equal(code(await del(own.cookie, own.memberId)), "ok");
  void own2;
  // the removed member's session no longer reaches the project
  assert.equal(code(await call(w, "GET", `/v1/projects/${w.projectId}/members`, { cookie: mem.cookie })), "notFound");
});

test("schema: members are never deleted and keep their project and email", async () => {
  const w = await world();
  const id = await addMember(w, "a@example.com");
  await assert.rejects(w.db.batch([stmt(`DELETE FROM members WHERE id = ?`, id)]), /never deleted/);
  await assert.rejects(w.db.batch([stmt(`UPDATE members SET email = 'b@example.com' WHERE id = ?`, id)]), /keeps its project and email/);
  const p2 = newId("project");
  await w.db.batch([stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P2', ?, ?, 0, ?)`, p2, w.orgId, T0, T0 + 1, T0)]);
  await assert.rejects(w.db.batch([stmt(`UPDATE members SET project_id = ? WHERE id = ?`, p2, id)]), /keeps its project and email/);
  // an invited (not yet active) owner can be removed: the active-owner rule doesn't apply
  const inv = await addMember(w, "inv@example.com", "owner");
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, inv)]);
});

test("schema: only another ACTIVE owner of the SAME project lets the last one go", async () => {
  const w = await world();
  const a = await person(w, "a@example.com", "owner");
  // an invited owner and a removed owner don't count
  await addMember(w, "inv@example.com", "owner");
  await addMember(w, "gone@example.com", "owner", { status: "removed" });
  await assert.rejects(w.db.batch([stmt(`UPDATE members SET role = 'member' WHERE id = ?`, a.memberId)]), /last-owner/);
  // an active owner of ANOTHER project doesn't count
  const p2 = newId("project");
  await w.db.batch([stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P2', ?, ?, 0, ?)`, p2, w.orgId, T0, T0 + 1, T0)]);
  const other = await addMember(w, "b@example.com", "owner", { projectId: p2 });
  await signIn(w, "b@example.com"); // active now
  assert.equal((await w.db.all<{ status: string }>(`SELECT status FROM members WHERE id = ?`, [other]))[0]!.status, "active");
  await assert.rejects(w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, a.memberId)]), /last-owner/);
  // a second active owner here does
  await person(w, "c@example.com", "owner");
  await w.db.batch([stmt(`UPDATE members SET role = 'member' WHERE id = ?`, a.memberId)]);
});

// ---------------------------------------------------------------- list

test("listMembers: assistants and up, paged", async () => {
  const w = await world();
  const asst = await person(w, "asst@example.com", "assistant");
  const mem = await person(w, "mem@example.com", "member");
  assert.equal(code(await call(w, "GET", M(w), { cookie: mem.cookie })), "forbidden");
  for (let i = 0; i < MEMBERS_PAGE_SIZE + 3; i++) await addMember(w, `p${String(i).padStart(3, "0")}@example.com`);
  const all: Member[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r: Awaited<ReturnType<typeof call>> = await call(w, "GET", `${M(w)}${cursor ? `?cursor=${cursor}` : ""}`, { cookie: asst.cookie });
    assert.equal(r.res.status, 200);
    const page = r.json as unknown as { items: Member[]; next: string | null };
    assert.ok(page.items.length <= MEMBERS_PAGE_SIZE);
    all.push(...page.items);
    cursor = page.next;
    pages++;
  } while (cursor);
  assert.equal(pages, 2);
  assert.equal(all.length, MEMBERS_PAGE_SIZE + 5);
  assert.equal(new Set(all.map((m) => m.id)).size, all.length);
  assert.ok(all.every((m) => m.projectId === w.projectId && m.allocationId.startsWith("alc_")));
  // exactly a page: no next
  const v = await world();
  const a2 = await person(v, "asst@example.com", "assistant");
  for (let i = 0; i < MEMBERS_PAGE_SIZE - 1; i++) await addMember(v, `q${i}@example.com`);
  const one = (await call(v, "GET", `/v1/projects/${v.projectId}/members`, { cookie: a2.cookie })).json as unknown as { items: Member[]; next: string | null };
  assert.deepEqual([one.items.length, one.next], [MEMBERS_PAGE_SIZE, null]);
  void signIn;
});
