import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, type Allocation, type Member, type Team } from "@sbgpu/api";
import { MAX_TEAMS_PER_PROJECT, MAX_TEAM_MEMBERS_PER_REQUEST } from "./teams.ts";
import { stmt } from "./db.ts";
import { T0, addMember, call, code, person, world, type World } from "./testing/world.ts";

const TP = (w: World) => `/v1/projects/${w.projectId}/teams`;
const create = (w: World, cookie: string, body: unknown) => call(w, "POST", TP(w), { cookie, body });
const count = async (w: World, sql: string, params: (string | number)[] = []) => (await w.db.all<{ n: number }>(sql, params))[0]!.n;
const teamOf = async (w: World, memberId: string) => (await w.db.all<{ t: string | null }>(`SELECT team_id AS t FROM members WHERE id = ?`, [memberId]))[0]!.t;

/** A team's member ids, read the paged way (listMembers?teamId=). */
async function teamMembers(w: World, cookie: string, teamId: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const r: Awaited<ReturnType<typeof call>> = await call(w, "GET", `/v1/projects/${w.projectId}/members?teamId=${teamId}${cursor ? `&cursor=${cursor}` : ""}`, { cookie });
    assert.equal(r.res.status, 200);
    const page = r.json as unknown as { items: Member[]; next: string | null };
    out.push(...page.items.map((m) => m.id));
    cursor = page.next;
  } while (cursor);
  return out;
}

async function otherProject(w: World, budget = 0): Promise<string> {
  const p = newId("project");
  await w.db.batch([stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P2', ?, ?, ?, ?)`, p, w.orgId, T0, T0 + 1, budget, T0)]);
  return p;
}

test("createTeam: a named team with members and its own allocation", async () => {
  const w = await world({ budget: 1000 });
  const mgr = await person(w, "mgr@example.com", "manager");
  const a = await addMember(w, "a@example.com");
  const b = await addMember(w, "b@example.com");
  const r = await create(w, mgr.cookie, { name: "  Red team ", memberIds: [b, a, a], allocation: 250 });
  assert.equal(r.res.status, 200);
  const t = r.json as unknown as Team;
  assert.equal(t.name, "Red team");
  assert.equal(t.projectId, w.projectId);
  assert.equal(t.memberCount, 2);
  assert.deepEqual(await teamMembers(w, mgr.cookie, t.id), [a, b].sort());
  assert.match(t.id, /^team_/);
  assert.match(t.allocationId, /^alc_/);
  assert.equal(t.createdAt, new Date(T0).toISOString());
  assert.deepEqual([await teamOf(w, a), await teamOf(w, b)], [t.id, t.id]);
  const al = await w.db.all<{ amount: number; holder_kind: string; holder_id: string }>(`SELECT amount, holder_kind, holder_id FROM allocations WHERE id = ?`, [t.allocationId]);
  assert.deepEqual({ ...al[0] }, { amount: 250, holder_kind: "team", holder_id: t.id });
  // members of another project are left alone
  const elsewhere = await addMember(w, "else@example.com", "member", { projectId: await otherProject(w) });
  const c = await addMember(w, "c@example.com");
  const t3 = (await create(w, mgr.cookie, { name: "Blue", memberIds: [c] })).json as unknown as Team;
  assert.equal(t3.memberCount, 1);
  assert.deepEqual(await teamMembers(w, mgr.cookie, t3.id), [c]);
  assert.equal(await teamOf(w, elsewhere), null);
  // without members or allocation
  const e = (await create(w, mgr.cookie, { name: "Empty" })).json as unknown as Team;
  assert.equal(e.memberCount, 0);
  assert.equal((await w.db.all<{ amount: number }>(`SELECT amount FROM allocations WHERE id = ?`, [e.allocationId]))[0]!.amount, 0);
});

test("createTeam: managers and up; malformed requests refused whole", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const asst = await person(w, "asst@example.com", "assistant");
  assert.equal(code(await create(w, asst.cookie, { name: "x" })), "forbidden");
  const removed = await addMember(w, "gone@example.com", "member", { status: "removed" });
  const elsewhere = await addMember(w, "else@example.com", "member", { projectId: await otherProject(w) });
  for (const body of [
    {},
    { name: "" },
    { name: "   " },
    { name: 5 },
    { name: "x".repeat(101) },
    { name: "ok", memberIds: "m" },
    { name: "ok", memberIds: [5] },
    { name: "ok", memberIds: [[1]] },
    { name: "ok", memberIds: [{}] },
    { name: "ok", memberIds: [newId("member")] },
    { name: "ok", memberIds: [removed] },
    { name: "ok", memberIds: [elsewhere] },

    { name: "ok", allocation: -1 },
    { name: "ok", allocation: 0.5 },
  ]) {
    assert.equal(code(await create(w, mgr.cookie, body)), "badRequest", JSON.stringify(body).slice(0, 80));
  }
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM teams`), 0);
  assert.equal(code(await create(w, mgr.cookie, { name: "x".repeat(100) })), "ok");
  // the member-list cap, with real members: 500 fit, 501 don't
  const stmts = [];
  const many: string[] = [];
  for (let i = 0; i < MAX_TEAM_MEMBERS_PER_REQUEST + 1; i++) {
    const id = newId("member");
    many.push(id);
    stmts.push(stmt(`INSERT INTO members (id, project_id, email, role, status, created_ms) VALUES (?, ?, ?, 'member', 'invited', ?)`, id, w.projectId, `m${i}@example.com`, T0));
    stmts.push(stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', ?, 0, ?)`, newId("allocation"), w.projectId, id, T0));
  }
  await w.db.batch(stmts);
  assert.equal(code(await create(w, mgr.cookie, { name: "too many", memberIds: many })), "badRequest");
  assert.equal(((await create(w, mgr.cookie, { name: "full", memberIds: many.slice(1) })).json as unknown as Team).memberCount, MAX_TEAM_MEMBERS_PER_REQUEST);
});

test("a team deleted between the check and the write: a conflict, nothing half-done", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const a = await addMember(w, "a@example.com");
  const t = (await create(w, mgr.cookie, { name: "T" })).json as unknown as Team;
  // delete the team just before the update's batch runs
  const inner = w.deps.db;
  w.deps.db = {
    ...inner,
    async batch(stmts) {
      await inner.batch([stmt(`UPDATE teams SET deleted_ms = ? WHERE id = ?`, T0, t.id)]);
      w.deps.db = inner;
      return inner.batch(stmts);
    },
  };
  const r = await call(w, "PATCH", `${TP(w)}/${t.id}`, { cookie: mgr.cookie, body: { memberIds: [a] } });
  assert.deepEqual([code(r), r.json.error?.message], ["conflict", "the team was deleted"]);
  assert.equal(await teamOf(w, a), null);
});

test("team names are unique among a project's live teams, case-insensitively", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const t = (await create(w, mgr.cookie, { name: "Blue" })).json as unknown as Team;
  assert.equal(code(await create(w, mgr.cookie, { name: "blue" })), "conflict");
  assert.equal(code(await call(w, "PATCH", `${TP(w)}/${(await create(w, mgr.cookie, { name: "Green" })).json.id}`, { cookie: mgr.cookie, body: { name: "BLUE" } })), "conflict");
  // another project may use the name
  const p2 = await otherProject(w);
  await w.db.batch([stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'Blue', ?)`, newId("team"), p2, T0)]);
  // a deleted team's name is free again
  assert.equal(code(await call(w, "DELETE", `${TP(w)}/${t.id}`, { cookie: mgr.cookie })), "ok");
  assert.equal(code(await create(w, mgr.cookie, { name: "Blue" })), "ok");
});

test("at most 200 live teams per project, also under concurrent creates", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const stmts = [];
  for (let i = 0; i < MAX_TEAMS_PER_PROJECT - 1; i++) {
    const id = newId("team");
    stmts.push(stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, ?, ?)`, id, w.projectId, `t${i}`, T0));
    stmts.push(stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, 0, ?)`, newId("allocation"), w.projectId, id, T0));
  }
  await w.db.batch(stmts);
  // at 199: two at once, exactly one gets the last slot
  const [x, y] = await Promise.all([create(w, mgr.cookie, { name: "last-a" }), create(w, mgr.cookie, { name: "last-b" })]);
  assert.deepEqual([code(x!), code(y!)].sort(), ["conflict", "ok"]);
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM teams WHERE deleted_ms IS NULL`), MAX_TEAMS_PER_PROJECT);
  const loser = [x!, y!].find((r) => r.res.status !== 200)!;
  assert.match(loser.json.error!.message, /at most 200 teams/);
  // a deleted team frees a slot
  const one = (await w.db.all<{ id: string }>(`SELECT id FROM teams LIMIT 1`))[0]!.id;
  assert.equal(code(await call(w, "DELETE", `${TP(w)}/${one}`, { cookie: mgr.cookie })), "ok");
  assert.equal(code(await create(w, mgr.cookie, { name: "again" })), "ok");
  // the cap is per project
  const p2 = await otherProject(w);
  await w.db.batch([stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'x', ?)`, newId("team"), p2, T0)]);
});

test("a team's allocation counts against the budget", async () => {
  const w = await world({ budget: 1000 });
  const mgr = await person(w, "mgr@example.com", "manager");
  await addMember(w, "a@example.com", "member", { allocation: 600 });
  assert.equal(code(await create(w, mgr.cookie, { name: "Big", allocation: 401 })), "conflict");
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM teams`), 0); // nothing half-made
  const t = (await create(w, mgr.cookie, { name: "Fits", allocation: 400 })).json as unknown as Team;
  const set = (amount: unknown) => call(w, "PUT", `${TP(w)}/${t.id}/allocation`, { cookie: mgr.cookie, body: { amount } });
  assert.equal(code(await set(401)), "conflict");
  const r = await set(100);
  assert.equal(r.res.status, 200);
  const a = r.json as unknown as Allocation;
  assert.deepEqual([a.amount, a.holder, a.id], [100, { kind: "team", teamId: t.id }, t.allocationId]);
  for (const amount of [-1, 1.5, "1", null]) assert.equal(code(await set(amount)), "badRequest");
  assert.equal(code(await call(w, "PUT", `${TP(w)}/${newId("team")}/allocation`, { cookie: mgr.cookie, body: { amount: 1 } })), "notFound");
});

test("updateTeam: rename, and the member list replaces the team's members", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const [a, b, c] = [await addMember(w, "a@example.com"), await addMember(w, "b@example.com"), await addMember(w, "c@example.com")];
  const t1 = (await create(w, mgr.cookie, { name: "One", memberIds: [a, b] })).json as unknown as Team;
  const t2 = (await create(w, mgr.cookie, { name: "Two", memberIds: [c] })).json as unknown as Team;
  const up = (id: string, body: unknown) => call(w, "PATCH", `${TP(w)}/${id}`, { cookie: mgr.cookie, body });
  const r = await up(t1.id, { name: "Uno", memberIds: [b, c] });
  assert.equal(r.res.status, 200);
  assert.deepEqual([(r.json as unknown as Team).name, (r.json as unknown as Team).memberCount], ["Uno", 2]);
  assert.deepEqual(await teamMembers(w, mgr.cookie, t1.id), [b, c].sort());
  // a left, c moved from team Two
  assert.deepEqual([await teamOf(w, a), await teamOf(w, b), await teamOf(w, c)], [null, t1.id, t1.id]);
  assert.equal(((await up(t2.id, {})).json as unknown as Team).memberCount, 0);
  // the name alone leaves members; an empty list clears them
  assert.equal(((await up(t1.id, { name: "Ein" })).json as unknown as Team).memberCount, 2);
  assert.deepEqual(await teamMembers(w, mgr.cookie, t1.id), [b, c].sort());
  assert.equal(((await up(t1.id, { memberIds: [] })).json as unknown as Team).memberCount, 0);
  assert.deepEqual(await teamMembers(w, mgr.cookie, t1.id), []);
  assert.equal(code(await up(t1.id, { name: "" })), "badRequest");
  assert.equal(code(await up(t1.id, { memberIds: [newId("member")] })), "badRequest");
  assert.equal(code(await up(newId("team"), { name: "x" })), "notFound");
  // a team of another project, through this project's path
  const p2 = await otherProject(w);
  const foreign = newId("team");
  await w.db.batch([stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'F', ?)`, foreign, p2, T0), stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, 0, ?)`, newId("allocation"), p2, foreign, T0)]);
  assert.equal(code(await up(foreign, { name: "x" })), "notFound");
  assert.equal(code(await call(w, "DELETE", `${TP(w)}/${foreign}`, { cookie: mgr.cookie })), "notFound");
});

test("large member lists stay within D1's parameter cap: 150 members created, replaced and listed", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const ids: string[] = [];
  for (let i = 0; i < 300; i++) ids.push(await addMember(w, `p${String(i).padStart(3, "0")}@example.com`));
  const t = (await create(w, mgr.cookie, { name: "Big", memberIds: ids.slice(0, 150) })).json as unknown as Team;
  assert.equal(t.memberCount, 150);
  assert.deepEqual(await teamMembers(w, mgr.cookie, t.id), [...ids.slice(0, 150)].sort());
  const r = await call(w, "PATCH", `${TP(w)}/${t.id}`, { cookie: mgr.cookie, body: { memberIds: ids.slice(100, 300) } });
  assert.equal(r.res.status, 200);
  assert.equal((r.json as unknown as Team).memberCount, 200);
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members WHERE team_id = ?`, [t.id]), 200);
  const list = (await call(w, "GET", TP(w), { cookie: mgr.cookie })).json as unknown as { teams: Team[] };
  assert.equal(list.teams[0]!.memberCount, 200);
  assert.deepEqual(await teamMembers(w, mgr.cookie, t.id), [...ids.slice(100, 300)].sort());
});

test("a team that grows past any request's cap: team responses stay small, members are paged", async () => {
  const w = await world();
  const own = await person(w, "own@example.com", "owner");
  const t = (await create(w, own.cookie, { name: "Huge" })).json as unknown as Team;
  // three 500-invite requests into the same team
  for (let k = 0; k < 3; k++) {
    const list = Array.from({ length: 500 }, (_, i) => ({ email: `k${k}-${String(i).padStart(3, "0")}@example.com`, teamId: t.id }));
    assert.equal((await call(w, "POST", `/v1/projects/${w.projectId}/members`, { cookie: own.cookie, body: { members: list } })).res.status, 200);
  }
  const small = (r: Awaited<ReturnType<typeof call>>) => JSON.stringify(r.json).length;
  const listed = await call(w, "GET", TP(w), { cookie: own.cookie });
  const renamed = await call(w, "PATCH", `${TP(w)}/${t.id}`, { cookie: own.cookie, body: { name: "Huger" } });
  const created = await create(w, own.cookie, { name: "Other" });
  for (const [name, r] of [["list", listed], ["rename", renamed], ["create", created]] as const) {
    assert.equal(r.res.status, 200, name);
    assert.ok(small(r) < 1000, `${name}: ${small(r)} bytes`);
  }
  assert.equal((listed.json as unknown as { teams: Team[] }).teams.find((x) => x.id === t.id)!.memberCount, 1500);
  assert.equal((renamed.json as unknown as Team).memberCount, 1500);
  // the members themselves: 1500 in pages of at most 200
  let pages = 0;
  let cursor: string | null = null;
  let seen = 0;
  do {
    const r: Awaited<ReturnType<typeof call>> = await call(w, "GET", `/v1/projects/${w.projectId}/members?teamId=${t.id}${cursor ? `&cursor=${cursor}` : ""}`, { cookie: own.cookie });
    const page = r.json as unknown as { items: Member[]; next: string | null };
    assert.ok(page.items.length <= 200);
    assert.ok(page.items.every((m) => m.teamId === t.id));
    seen += page.items.length;
    cursor = page.next;
    pages++;
  } while (cursor);
  assert.deepEqual([seen, pages], [1500, 8]);
});

test("listMembers?teamId= lists only that team's current members, of this project", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const [a, b, c] = [await addMember(w, "a@example.com"), await addMember(w, "b@example.com"), await addMember(w, "c@example.com")];
  const t1 = (await create(w, mgr.cookie, { name: "One", memberIds: [a, b] })).json as unknown as Team;
  const t2 = (await create(w, mgr.cookie, { name: "Two", memberIds: [c] })).json as unknown as Team;
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, b)]);
  assert.deepEqual(await teamMembers(w, mgr.cookie, t1.id), [a]);
  assert.deepEqual(await teamMembers(w, mgr.cookie, t2.id), [c]);
  assert.deepEqual(await teamMembers(w, mgr.cookie, newId("team")), []);
  // another project's team, through this project's path: nothing of theirs
  const p2 = await otherProject(w);
  const foreignTeam = newId("team");
  await w.db.batch([stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'F', ?)`, foreignTeam, p2, T0)]);
  const fm = await addMember(w, "f@example.com", "member", { projectId: p2 });
  await w.db.batch([stmt(`UPDATE members SET team_id = ? WHERE id = ?`, foreignTeam, fm)]);
  assert.deepEqual(await teamMembers(w, mgr.cookie, foreignTeam), []);
  // without the filter, the whole project (removed members included, as before)
  const all = (await call(w, "GET", `/v1/projects/${w.projectId}/members`, { cookie: mgr.cookie })).json as unknown as { items: Member[] };
  assert.equal(all.items.length, 4);
});

test("deleteTeam: members leave, the allocation returns to the project, the team stays on record", async () => {
  const w = await world({ budget: 1000 });
  const mgr = await person(w, "mgr@example.com", "manager");
  const a = await addMember(w, "a@example.com");
  const gone = await addMember(w, "gone@example.com");
  const t = (await create(w, mgr.cookie, { name: "T", memberIds: [a, gone], allocation: 1000 })).json as unknown as Team;
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, gone)]);
  assert.equal(code(await call(w, "DELETE", `${TP(w)}/${t.id}`, { cookie: mgr.cookie })), "ok");
  assert.deepEqual([await teamOf(w, a), await teamOf(w, gone)], [null, null]); // removed members too
  assert.equal((await w.db.all<{ amount: number }>(`SELECT amount FROM allocations WHERE id = ?`, [t.allocationId]))[0]!.amount, 0);
  assert.equal(code(await create(w, mgr.cookie, { name: "U", allocation: 1000 })), "ok"); // the budget is free again
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM teams WHERE id = ?`, [t.id]), 1);
  assert.equal(code(await call(w, "DELETE", `${TP(w)}/${t.id}`, { cookie: mgr.cookie })), "notFound");
  assert.equal(code(await call(w, "PUT", `${TP(w)}/${t.id}/allocation`, { cookie: mgr.cookie, body: { amount: 0 } })), "notFound");
  assert.equal(code(await call(w, "DELETE", `${TP(w)}/${t.id}`, { cookie: (await person(w, "m@example.com", "member")).cookie })), "forbidden");
});

test("schema: a member's team is a live team of its project; deleted teams stay deleted and empty", async () => {
  const w = await world();
  const a = await addMember(w, "a@example.com");
  const live = newId("team");
  const p2 = await otherProject(w);
  const foreign = newId("team");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'L', ?)`, live, w.projectId, T0),
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'F', ?)`, foreign, p2, T0),
  ]);
  await assert.rejects(w.db.batch([stmt(`UPDATE members SET team_id = ? WHERE id = ?`, foreign, a)]), /team:/);
  await assert.rejects(w.db.batch([stmt(`UPDATE members SET team_id = 'team_nope' WHERE id = ?`, a)]), /team:/);
  await assert.rejects(
    w.db.batch([stmt(`INSERT INTO members (id, project_id, email, role, status, team_id, created_ms) VALUES (?, ?, 'z@example.com', 'member', 'invited', ?, ?)`, newId("member"), w.projectId, foreign, T0)]),
    /team:/,
  );
  await w.db.batch([stmt(`UPDATE members SET team_id = ? WHERE id = ?`, live, a)]);
  // a team with members can't be deleted
  await assert.rejects(w.db.batch([stmt(`UPDATE teams SET deleted_ms = ? WHERE id = ?`, T0, live)]), /keeps no members/);
  await w.db.batch([stmt(`UPDATE members SET team_id = NULL WHERE id = ?`, a), stmt(`UPDATE teams SET deleted_ms = ? WHERE id = ?`, T0, live)]);
  // removed members count too: a deleted team keeps no members at all
  const t2 = newId("team");
  const gone = await addMember(w, "gone@example.com");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'G', ?)`, t2, w.projectId, T0),
    stmt(`UPDATE members SET team_id = ?, status = 'removed' WHERE id = ?`, t2, gone),
  ]);
  await assert.rejects(w.db.batch([stmt(`UPDATE teams SET deleted_ms = ? WHERE id = ?`, T0, t2)]), /keeps no members/);
  // no one joins a deleted team, and it never comes back
  await assert.rejects(w.db.batch([stmt(`UPDATE members SET team_id = ? WHERE id = ?`, live, a)]), /team:/);
  await assert.rejects(w.db.batch([stmt(`UPDATE teams SET deleted_ms = NULL WHERE id = ?`, live)]), /stays deleted/);
  await assert.rejects(w.db.batch([stmt(`UPDATE teams SET deleted_ms = ? WHERE id = ?`, T0 + 1, live)]), /stays deleted/);
  await assert.rejects(w.db.batch([stmt(`UPDATE teams SET project_id = ? WHERE id = ?`, p2, foreign + "")]).then(() => w.db.batch([stmt(`UPDATE teams SET project_id = ? WHERE id = ?`, w.projectId, foreign)])), /keeps its project/);
  await assert.rejects(w.db.batch([stmt(`DELETE FROM teams WHERE id = ?`, live)]), /never deleted/);
  for (const name of ["", " x", "x ", "y".repeat(101)]) {
    await assert.rejects(w.db.batch([stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, ?, ?)`, newId("team"), w.projectId, name, T0)]), Error, name);
  }
});

test("listTeams: assistants see every live team; members only their own", async () => {
  const w = await world();
  const mgr = await person(w, "mgr@example.com", "manager");
  const asst = await person(w, "asst@example.com", "assistant");
  const mem = await person(w, "mem@example.com", "member");
  const lone = await person(w, "lone@example.com", "member");
  const gone = await addMember(w, "gone@example.com");
  const red = (await create(w, mgr.cookie, { name: "Red", memberIds: [mem.memberId, gone] })).json as unknown as Team;
  const blue = (await create(w, mgr.cookie, { name: "Blue" })).json as unknown as Team;
  for (const n of ["Yellow", "Orange", "Green", "Amber"]) await create(w, mgr.cookie, { name: n });
  const dead = (await create(w, mgr.cookie, { name: "Dead" })).json as unknown as Team;
  await call(w, "DELETE", `${TP(w)}/${dead.id}`, { cookie: mgr.cookie });
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, gone)]);
  const list = async (cookie: string) => ((await call(w, "GET", TP(w), { cookie })).json as unknown as { teams: Team[] }).teams;
  assert.deepEqual((await list(asst.cookie)).map((t) => t.name), ["Amber", "Blue", "Green", "Orange", "Red", "Yellow"]); // live only, by name
  const own = await list(mem.cookie);
  assert.deepEqual(own.map((t) => t.id), [red.id]);
  assert.equal(own[0]!.memberCount, 1); // removed members aren't counted
  assert.deepEqual(await list(lone.cookie), []);
  void blue;
});

test("members: invitations and updates take a team of the project", async () => {
  const w = await world();
  const own = await person(w, "own@example.com", "owner");
  const t = (await create(w, own.cookie, { name: "T" })).json as unknown as Team;
  const r = await call(w, "POST", `/v1/projects/${w.projectId}/members`, { cookie: own.cookie, body: { members: [{ email: "a@example.com", teamId: t.id }] } });
  assert.equal(r.res.status, 200);
  const m = (r.json as unknown as { members: Member[] }).members[0]!;
  assert.equal(m.teamId, t.id);
  const up = (body: unknown) => call(w, "PATCH", `/v1/projects/${w.projectId}/members/${m.id}`, { cookie: own.cookie, body });
  assert.equal(((await up({ teamId: null })).json as unknown as Member).teamId, null);
  assert.equal(((await up({ teamId: t.id })).json as unknown as Member).teamId, t.id);
  assert.equal(((await up({ name: "x" })).json as unknown as Member).teamId, t.id); // absent: unchanged
  assert.equal(code(await up({ teamId: 5 })), "badRequest");
  assert.equal(code(await up({ teamId: [t.id] })), "badRequest");
  assert.equal(code(await up({ teamId: {} })), "badRequest");
  assert.equal(code(await up({ teamId: newId("team") })), "badRequest");
  const p2 = await otherProject(w);
  const foreign = newId("team");
  await w.db.batch([stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'F', ?)`, foreign, p2, T0)]);
  assert.equal(code(await up({ teamId: foreign })), "badRequest");
  assert.equal(code(await call(w, "POST", `/v1/projects/${w.projectId}/members`, { cookie: own.cookie, body: { members: [{ email: "b@example.com", teamId: foreign }] } })), "badRequest");
  assert.equal(await count(w, `SELECT COUNT(*) AS n FROM members WHERE email = 'b@example.com'`), 0);
});
