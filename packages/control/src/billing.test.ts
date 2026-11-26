import { test } from "node:test";
import assert from "node:assert/strict";
import { BILLING_MODES, isBillingMode, newId } from "@sbgpu/api";
import { sqliteDb } from "./testing/sqlite.ts";
import { credentialForOrg } from "./billing.ts";
import { stmt, type Db } from "./db.ts";
import { T0, addMember, call, person, signIn, world } from "./testing/world.ts";

const org = (id: string, mode: string | null, margin = 0) =>
  stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'O', ?, ?, ?)`, id, mode, margin, T0);
const project = (id: string, orgId: string, override: number | null = null) =>
  stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, margin_bps_override, budget, created_ms) VALUES (?, ?, 'P', ?, ?, ?, 0, ?)`, id, orgId, T0, T0 + 1, override, T0);

/** An org of `mode`, with a project and a machine in it. */
async function machineIn(db: Db, mode: string) {
  const [o, p, a, m] = [newId("org"), newId("project"), newId("allocation"), newId("machine")];
  await db.batch([
    org(o, mode),
    project(p, o),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', 'mbr_x', 0, ?)`, a, p, T0),
    stmt(`INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, created_ms) VALUES (?, ?, ?, 'mbr_x', 'shadeform', 'L4', 1, 'X', 'starting', ?)`, m, p, a, T0),
  ]);
  return { orgId: o, projectId: p, machineId: m };
}
const accrue = (machineId: string, margin: number) =>
  stmt(`INSERT INTO machine_accruals (machine_id, incarnation, provider, provider_cost_per_hour, margin_bps, start_ms) VALUES (?, 1, 'shadeform', 1000, ?, ?)`, machineId, margin, T0);

test("the modes", () => {
  assert.deepEqual(BILLING_MODES, ["resold", "byok"]);
  for (const m of BILLING_MODES) assert.equal(isBillingMode(m), true);
  for (const x of ["", "Resold", "byok ", null, undefined, 0, ["resold"]]) assert.equal(isBillingMode(x), false, String(x));
});

test("the resolver: resold uses ours; byok without a key, an unknown org or an unknown provider gets none, never ours", async () => {
  const db = sqliteDb();
  const r = await machineIn(db, "resold");
  const b = await machineIn(db, "byok");
  assert.deepEqual(await credentialForOrg(db, r.orgId, "shadeform"), { use: "ours", provider: "shadeform" });
  assert.deepEqual(await credentialForOrg(db, b.orgId, "shadeform"), { use: "none", reason: "no-credential" });
  assert.deepEqual(await credentialForOrg(db, newId("org"), "shadeform"), { use: "none", reason: "no-such-org" });
  for (const p of ["", "aws", "Shadeform"]) {
    assert.deepEqual(await credentialForOrg(db, r.orgId, p), { use: "none", reason: "unknown-provider" }, p);
  }
});

test("the resolver fails closed on a stored mode it doesn't know (a later mode, or the triggers dropped)", async () => {
  const db = sqliteDb();
  const r = await machineIn(db, "resold");
  // (a database whose stored mode isn't one we know: read through a stand-in)
  const odd = (mode: unknown): Db => ({ ...db, all: async <T,>() => [{ billing_mode: mode }] as T[] });
  for (const mode of [null, "", "other", "RESOLD"]) {
    assert.deepEqual(await credentialForOrg(odd(mode), r.orgId, "shadeform"), { use: "none", reason: "no-such-org" }, String(mode));
  }
});

test("schema: every org states a known mode, which is then fixed", async () => {
  const db = sqliteDb();
  await assert.rejects(db.batch([org(newId("org"), null)]), /states its billing mode/);
  await assert.rejects(db.batch([org(newId("org"), "other")]));
  await assert.rejects(db.batch([org(newId("org"), "")]));
  const o = newId("org");
  await db.batch([org(o, "resold", 3000)]);
  for (const to of ["byok", null, "other"]) await assert.rejects(db.batch([stmt(`UPDATE orgs SET billing_mode = ? WHERE id = ?`, to, o)]), String(to));
  // other columns still change, and an update that leaves the mode alone passes
  await db.batch([stmt(`UPDATE orgs SET name = 'N', billing_mode = 'resold' WHERE id = ?`, o)]);
  assert.deepEqual({ ...(await db.all<{ name: string; billing_mode: string }>(`SELECT name, billing_mode FROM orgs WHERE id = ?`, [o]))[0] }, { name: "N", billing_mode: "resold" });
  const b = newId("org");
  await db.batch([org(b, "byok")]);
  await assert.rejects(db.batch([stmt(`UPDATE orgs SET billing_mode = 'resold' WHERE id = ?`, b)]), /is fixed/);
});

test("schema: byok runs at margin 0, for the org, its projects and every accrual", async () => {
  const db = sqliteDb();
  await assert.rejects(db.batch([org(newId("org"), "byok", 1)]), /margin 0/);
  const b = await machineIn(db, "byok");
  await assert.rejects(db.batch([stmt(`UPDATE orgs SET margin_bps = 1 WHERE id = ?`, b.orgId)]), /margin 0/);
  await assert.rejects(db.batch([project(newId("project"), b.orgId, 1)]), /resold organization's projects/);
  await db.batch([project(newId("project"), b.orgId, 0), project(newId("project"), b.orgId, null)]);
  await assert.rejects(db.batch([stmt(`UPDATE projects SET margin_bps_override = 500 WHERE id = ?`, b.projectId)]), /resold organization's projects/);
  await db.batch([stmt(`UPDATE projects SET margin_bps_override = 0 WHERE id = ?`, b.projectId)]);
  await assert.rejects(db.batch([accrue(b.machineId, 1)]), /resold organization's machines/);
  await db.batch([accrue(b.machineId, 0)]);
  // a resold org keeps its margins everywhere
  const r = await machineIn(db, "resold");
  await db.batch([
    stmt(`UPDATE orgs SET margin_bps = 4000 WHERE id = ?`, r.orgId),
    stmt(`UPDATE projects SET margin_bps_override = 500 WHERE id = ?`, r.projectId),
    project(newId("project"), r.orgId, 700),
    accrue(r.machineId, 500),
  ]);
  // a project moved into a byok org can't take its margin along
  const moved = newId("project");
  await db.batch([project(moved, r.orgId, 900)]);
  await assert.rejects(db.batch([stmt(`UPDATE projects SET org_id = ? WHERE id = ?`, b.orgId, moved)]), /same billing mode/);
});

test("schema: nothing moves between billing modes, whatever its margins or accruals", async () => {
  const db = sqliteDb();
  const move = (projectId: string, orgId: string) => db.batch([stmt(`UPDATE projects SET org_id = ? WHERE id = ?`, orgId, projectId)]);
  const mode = async (machineId: string) =>
    (await db.all<{ m: string }>(`SELECT o.billing_mode AS m FROM machines x JOIN projects p ON p.id = x.project_id JOIN orgs o ON o.id = p.org_id WHERE x.id = ?`, [machineId]))[0]!.m;
  // resold to byok, margin 0 on the project but a live accrual at margin 500: refused
  const r = await machineIn(db, "resold");
  await db.batch([accrue(r.machineId, 500)]);
  const b = await machineIn(db, "byok");
  await assert.rejects(move(r.projectId, b.orgId), /same billing mode/);
  assert.equal(await mode(r.machineId), "resold");
  assert.equal((await credentialForOrg(db, r.orgId, "shadeform")).use, "ours");
  // ... and without any accrual or margin: still refused
  const bare = newId("project");
  await db.batch([project(bare, r.orgId)]);
  await assert.rejects(move(bare, b.orgId), /same billing mode/);
  // byok to resold: refused
  await assert.rejects(move(b.projectId, r.orgId), /same billing mode/);
  assert.equal(await mode(b.machineId), "byok");
  // same mode: unchanged (a resold project with its live accrual and margin moves to another resold org)
  const r2 = await machineIn(db, "resold");
  await move(r.projectId, r2.orgId);
  assert.equal(await mode(r.machineId), "resold");
  const b2 = await machineIn(db, "byok");
  await move(b.projectId, b2.orgId);
  // a machine moving to a project of the other mode: refused; to one of the same mode: allowed
  const toProject = async (machineId: string, projectId: string) => {
    const a = newId("allocation");
    await db.batch([stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', 'mbr_y', 0, ?)`, a, projectId, T0)]);
    return db.batch([stmt(`UPDATE machines SET project_id = ?, allocation_id = ? WHERE id = ?`, projectId, a, machineId)]);
  };
  await assert.rejects(toProject(r2.machineId, b2.projectId), /same billing mode/);
  await assert.rejects(toProject(b2.machineId, r2.projectId), /same billing mode/);
  await toProject(r2.machineId, r.projectId);
  assert.equal(await mode(r2.machineId), "resold");
  // an update that leaves the org or project alone isn't a move
  await db.batch([stmt(`UPDATE projects SET org_id = org_id, name = 'Q' WHERE id = ?`, b.projectId), stmt(`UPDATE machines SET project_id = project_id WHERE id = ?`, b.machineId)]);
});

test("0011 makes every existing org resold", async () => {
  const [a, b] = [newId("org"), newId("org")];
  const w = await world({
    upgrade: {
      at: "0011",
      seed(raw) {
        for (const id of [a, b]) raw.prepare(`INSERT INTO orgs (id, name, margin_bps, created_ms) VALUES (?, 'Old', 3000, ?)`).run(id, T0);
      },
    },
  });
  const rows = await w.db.all<{ id: string; billing_mode: string; margin_bps: number }>(`SELECT id, billing_mode, margin_bps FROM orgs WHERE id IN (?, ?) ORDER BY id`, [a, b]);
  assert.deepEqual(rows.map((r) => ({ ...r })), [a, b].sort().map((id) => ({ id, billing_mode: "resold", margin_bps: 3000 })));
});

test("the organization's mode is on the wire", async () => {
  const w = await world();
  const { db } = w;
  const b = newId("org");
  await db.batch([org(b, "byok")]);
  const owner = await person(w, "o@example.com", "member");
  for (const [id, mode] of [[w.orgId, "resold"], [b, "byok"]] as const) {
    await db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) SELECT ?, user_id, 'viewer' FROM members WHERE id = ?`, id, owner.memberId)]);
    const { res, json } = await call(w, "GET", `/v1/orgs/${id}`, { cookie: owner.cookie });
    assert.equal(res.status, 200);
    assert.equal(json.billingMode, mode);
  }
});

test("a project carries its organization's mode, for members with no org role", async () => {
  const w = await world();
  const { db } = w;
  const [b, bp] = [newId("org"), newId("project")];
  await db.batch([org(b, "byok"), project(bp, b)]);
  // a plain project member in both (no org role at all)
  await addMember(w, "m@example.com", "member");
  await addMember(w, "m@example.com", "member", { projectId: bp });
  const cookie = await signIn(w, "m@example.com");
  for (const [projectId, mode] of [[w.projectId, "resold"], [bp, "byok"]] as const) {
    const { res, json } = await call(w, "GET", `/v1/projects/${projectId}`, { cookie });
    assert.equal(res.status, 200, projectId);
    assert.equal(json.billingMode, mode);
  }
  assert.equal((await call(w, "GET", `/v1/orgs/${b}`, { cookie })).res.status === 200, false); // (the org itself stays out of reach)
  // the org's listing carries it too
  const viewer = await person(w, "v@example.com", "member");
  await db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) SELECT ?, user_id, 'viewer' FROM members WHERE id = ?`, b, viewer.memberId)]);
  const { json } = await call(w, "GET", `/v1/orgs/${b}/projects`, { cookie: viewer.cookie });
  assert.deepEqual((json.items as { id: string; billingMode: string }[]).map((p) => [p.id, p.billingMode]), [[bp, "byok"]]);
});
