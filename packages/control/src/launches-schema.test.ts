// The launch record (0014): one table for both launch modes, and mode-aware boot tokens. These
// rows pin every branch of the schema, every write across modes, the fixed fields' triggers,
// the keys tying a token to its launch, and the migration's guard.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { newId } from "@sbgpu/api";
import { stmt, type SqlValue } from "./db.ts";
import { sqliteDb } from "./testing/sqlite.ts";
import { runHeartbeatWatchdog } from "./heartbeat.ts";
import { ORIGIN, T0, addMember, world, type World } from "./testing/world.ts";
import { runVmWatchdog, type InstanceFacts, type VmProvider } from "./vm.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const H = sha("h");
const NUL = String.fromCharCode(0);

class FakeVm implements VmProvider {
  calls: string[] = [];
  async instanceFacts(id: string): Promise<InstanceFacts> {
    this.calls.push(`facts ${id}`);
    return { state: "absent", ipv4: null, exclusive: false };
  }
  async terminate(id: string): Promise<void> {
    this.calls.push(`terminate ${id}`);
  }
}

let w: World;
let vm: FakeVm;
let allocationId: string;
let memberId: string;
beforeEach(async () => {
  vm = new FakeVm();
  w = await world({ vm });
  memberId = await addMember(w, "m@example.com", "member", { allocation: 0 });
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
});

async function machine(provider = "runpod") {
  const id = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, ?, ?, 'L4', 1, 'X', 'starting', 1, ?)`,
      id, w.projectId, allocationId, memberId, provider, T0,
    ),
  ]);
  return id;
}

const insert = (table: string, v: Record<string, SqlValue>) => {
  const cols = Object.keys(v);
  return w.db.batch([{ sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: Object.values(v) }]);
};
// (a container launch inserted creating, with no id, gets its pinned rate in the same batch, as
// the intent writes it: 0015 lets a container launch take an id or leave creating only with one)
const container = (m: string, over: Record<string, SqlValue> = {}) => {
  const v: Record<string, SqlValue> = { machine_id: m, incarnation: 1, mode: "container", provider: "runpod", agent_sha256: H, credential_kind: "ours", account_kind: "platform", outcome: "creating", next_ms: T0, heartbeat_due_ms: T0, created_ms: T0, ...over };
  const cols = Object.keys(v);
  const rated = v["outcome"] === "creating" && (v["provider_machine_id"] ?? null) === null;
  return w.db.batch([
    { sql: `INSERT INTO launches (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: Object.values(v) },
    ...(rated ? [stmt(`INSERT INTO launch_rates (machine_id, incarnation, provider_cost_per_hour, margin_bps) VALUES (?, ?, 0, 0)`, m, v["incarnation"] ?? 1)] : []),
  ]);
};
const vmLaunch = (m: string, over: Record<string, SqlValue> = {}) =>
  insert("launches", { machine_id: m, incarnation: 1, mode: "vm", account_kind: "platform", provider: "shadeform", nonce_sha256: H, boot_script_sha256: H, agent_sha256: H, outcome: "creating", next_ms: T0, created_ms: T0, ...over });
const upd = (m: string, set: string, ...p: SqlValue[]) => w.db.batch([stmt(`UPDATE launches SET ${set} WHERE machine_id = ?`, ...p, m)]);
const token = (m: string, over: Record<string, SqlValue> = {}) =>
  insert("boot_tokens", { token_sha256: sha(m), machine_id: m, incarnation: 1, mode: "container", ...over });

test("launches: the mode is closed and fixed; a provider belongs to one mode", async () => {
  const m = await machine();
  await assert.rejects(container(m, { mode: "other" }), /CHECK/);
  await assert.rejects(container(m, { provider: "shadeform" }), /CHECK/); // (a VM provider for a container)
  const v = await machine("shadeform");
  await assert.rejects(vmLaunch(v, { provider: "runpod" }), /CHECK/); // (a container provider for a VM)
  await container(m);
  await vmLaunch(v);
  await assert.rejects(upd(m, `mode = 'vm'`), /mode is fixed/);
  await assert.rejects(upd(v, `mode = 'container'`), /mode is fixed/);
});

test("launches: the provider is fixed from the intent, in both modes, and for a VM after its id and token are bound", async () => {
  const c = await machine();
  await container(c);
  await assert.rejects(upd(c, `provider = 'shadeform'`), /provider is fixed/);
  await upd(c, `provider = 'runpod'`); // (the same value: no change)
  const v = await machine("shadeform");
  await vmLaunch(v);
  await assert.rejects(upd(v, `provider = 'nebius'`), /provider is fixed/); // (creating, before any id)
  // its id recorded, ACTIVE, and a boot token bound to that id
  await upd(v, `provider_machine_id = 'same-id', outcome = 'launched', ipv4 = '203.0.113.7', first_active_ms = ?`, T0);
  await token(v, { mode: "vm", provider_machine_id: "same-id", nonce_sha256: H, issued_ms: T0, expires_ms: T0 + 1 });
  for (const other of ["nebius", "hyperstack"]) await assert.rejects(upd(v, `provider = ?`, other), /provider is fixed/, other);
  await assert.rejects(upd(v, `provider = 'nebius', outcome = 'terminate', terminate_reason = 'abort', next_ms = ?`, T0), /provider is fixed/);
  const row = (await w.db.all<{ provider: string }>(`SELECT provider FROM launches WHERE machine_id = ?`, [v]))[0]!;
  assert.equal(row.provider, "shadeform");
  // and another provider may use the same external id, as its own launch
  const n = await machine("nebius");
  await vmLaunch(n, { provider: "nebius", provider_machine_id: "same-id" });
});

test("launches: which launch a row is (machine, incarnation) never changes, in both modes, before and after its id and token", async () => {
  const other = await machine();
  const moves: Array<[string, string, ...SqlValue[]]> = [
    ["another machine", `machine_id = ?`, other],
    ["another incarnation", `incarnation = 2`],
    ["both", `machine_id = ?, incarnation = 2`, other],
  ];
  const tryAll = async (m: string, when: string) => {
    for (const [why, set, ...p] of moves) await assert.rejects(upd(m, set, ...p), /identity is fixed/, `${when}: ${why}`);
    await upd(m, `machine_id = ?, incarnation = 1`, m); // (the same values)
  };
  const c = await machine();
  await container(c);
  await tryAll(c, "container, creating");
  await upd(c, `provider_machine_id = 'pod-c'`);
  await token(c, { provider_machine_id: "pod-c", issued_ms: T0, expires_ms: T0 + 120_000 });
  await tryAll(c, "container, with its id and token");
  const v = await machine("shadeform");
  await vmLaunch(v);
  await tryAll(v, "vm, creating");
  await upd(v, `provider_machine_id = 'vm-v', outcome = 'launched', ipv4 = '203.0.113.7', first_active_ms = ?`, T0);
  await token(v, { mode: "vm", provider_machine_id: "vm-v", nonce_sha256: H, issued_ms: T0, expires_ms: T0 + 1 });
  await tryAll(v, "vm, with its id and token");
  const rows = await w.db.all<{ machine_id: string; incarnation: number }>(`SELECT machine_id, incarnation FROM launches WHERE machine_id IN (?, ?) ORDER BY machine_id`, [c, v]);
  assert.deepEqual(rows.map((r) => [r.machine_id, r.incarnation]).sort(), [[c, 1], [v, 1]].sort());
});

test("launches: the account kind has no default: an intent that omits it is refused, in both modes", async () => {
  // (an explicit NULL is refused by NOT NULL alone; this is the omission, which a DEFAULT would accept)
  const omit = (v: Record<string, SqlValue>) => {
    const rest = { ...v };
    delete rest.account_kind;
    return insert("launches", rest);
  };
  const c = await machine();
  await assert.rejects(
    omit({ machine_id: c, incarnation: 1, mode: "container", provider: "runpod", agent_sha256: H, credential_kind: "ours", outcome: "creating", next_ms: T0, created_ms: T0 }),
    /NOT NULL constraint failed: launches\.account_kind/,
  );
  const v = await machine("shadeform");
  await assert.rejects(
    omit({ machine_id: v, incarnation: 1, mode: "vm", provider: "shadeform", nonce_sha256: H, boot_script_sha256: H, agent_sha256: H, outcome: "creating", next_ms: T0, created_ms: T0 }),
    /NOT NULL constraint failed: launches\.account_kind/,
  );
  assert.equal((await w.db.all(`SELECT 1 FROM launches WHERE machine_id IN (?, ?)`, [c, v])).length, 0);
});

test("launches: the account is pinned at the intent (the machine's organization then), and moves of the machine or its project don't change it", async () => {
  const other = newId("org");
  await w.db.batch([stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms, total_credit) VALUES (?, 'Other', 'resold', 3000, ?, 0)`, other, T0)]);
  const ORG = { credential_kind: "org", account_kind: "org", account_org_id: w.orgId };
  // the account's shape
  const c = await machine();
  await assert.rejects(container(c, { account_kind: "other" }), /CHECK/); // (a closed kind)
  await assert.rejects(container(c, { account_kind: null }), /NOT NULL/); // (always written, never inferred)
  await assert.rejects(container(c, { ...ORG, account_org_id: null }), /CHECK/); // (an org account names its organization)
  await assert.rejects(container(c, { account_org_id: w.orgId }), /CHECK/); // (ours names none)
  await assert.rejects(container(c, { ...ORG, credential_kind: "ours" }), /CHECK/); // (a container's account follows its credential)
  await assert.rejects(container(c, { credential_kind: "org" }), /CHECK/);
  const v = await machine("shadeform");
  await assert.rejects(vmLaunch(v, { account_kind: "org", account_org_id: w.orgId }), /CHECK/); // (a VM is ours under today's contract)
  // the organization must be the machine's at the intent, exactly
  await assert.rejects(container(c, { ...ORG, account_org_id: other }), /organization at the intent/);
  await container(c, ORG);
  // fixed: never changed, never cleared (the same values pass)
  for (const [why, set, ...p] of [
    ["another organization", `account_org_id = ?`, other],
    ["cleared", `account_org_id = NULL, account_kind = 'platform'`],
    ["the kind alone", `account_kind = 'platform'`],
  ] as Array<[string, string, ...SqlValue[]]>) {
    await assert.rejects(upd(c, set, ...p), /intent is fixed/, why);
  }
  await upd(c, `account_kind = 'org', account_org_id = ?`, w.orgId);
  // transfers after the intent: the launch keeps the account it was made in
  const pinned = async (m: string) => (await w.db.all<{ k: string; o: string | null }>(`SELECT account_kind AS k, account_org_id AS o FROM launches WHERE machine_id = ?`, [m])).map((r) => [r.k, r.o])[0];
  // (the machine moves to a project of the other organization; before and after its provider id)
  const p2 = newId("project");
  const a2 = newId("allocation");
  await w.db.batch([
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P2', ?, ?, 0, ?)`, p2, other, T0, T0 + 86_400_000, T0),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', ?, 0, ?)`, a2, p2, memberId, T0),
    stmt(`UPDATE machines SET project_id = ?, allocation_id = ? WHERE id = ?`, p2, a2, c),
  ]);
  assert.deepEqual(await pinned(c), ["org", w.orgId]);
  await upd(c, `provider_machine_id = 'pod-c'`);
  assert.deepEqual(await pinned(c), ["org", w.orgId]);
  // (a project of the first organization, with its machine, moves to the other organization)
  const p3 = newId("project");
  const a3 = newId("allocation");
  const d = newId("machine");
  await w.db.batch([
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P3', ?, ?, 0, ?)`, p3, w.orgId, T0, T0 + 86_400_000, T0),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', ?, 0, ?)`, a3, p3, memberId, T0),
    stmt(
      `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, ?, 'runpod', 'L4', 1, 'X', 'starting', 1, ?)`,
      d, p3, a3, memberId, T0,
    ),
  ]);
  await container(d, ORG);
  await w.db.batch([stmt(`UPDATE projects SET org_id = ? WHERE id = ?`, other, p3)]);
  assert.deepEqual(await pinned(d), ["org", w.orgId]); // (not the current owner, which is now the other organization)
  // a new intent after a move takes the owner at that time
  await assert.rejects(container(d, { ...ORG, incarnation: 2 }), /organization at the intent/);
  await container(d, { ...ORG, incarnation: 2, account_org_id: other });
  assert.deepEqual((await w.db.all<{ o: string }>(`SELECT account_org_id AS o FROM launches WHERE machine_id = ? AND incarnation = 2`, [d]))[0]!.o, other);
});

test("launches: the intent's pins never change, in both modes (the same value passes)", async () => {
  const c = await machine();
  await container(c);
  const v = await machine("shadeform");
  await vmLaunch(v);
  const H2 = sha("other");
  for (const m of [c, v]) {
    for (const [col, x] of [["created_ms", T0 + 1], ["created_ms", T0 - 1], ["agent_sha256", H2]] as const) {
      await assert.rejects(upd(m, `${col} = ?`, x), /intent is fixed/, `${col} ${x}`);
    }
    await upd(m, `created_ms = ?, agent_sha256 = ?`, T0, H); // (the same values)
  }
  for (const col of ["nonce_sha256", "boot_script_sha256"]) {
    await assert.rejects(upd(v, `${col} = ?`, H2), /intent is fixed/, col);
    await assert.rejects(upd(c, `${col} = ?`, H2), /intent is fixed/, `container ${col}`); // (none to set, ever)
  }
  await upd(v, `nonce_sha256 = ?, boot_script_sha256 = ?`, H, H);
});

test("launches: a provider id, once recorded, is fixed, in both modes and for a VM after its token is bound", async () => {
  const c = await machine();
  await container(c);
  await upd(c, `provider_machine_id = 'pod-1'`); // (NULL -> value: recorded)
  await upd(c, `provider_machine_id = 'pod-1'`); // (the same value)
  await assert.rejects(upd(c, `provider_machine_id = 'pod-2'`), /provider id is fixed/);
  await assert.rejects(upd(c, `provider_machine_id = NULL`), /provider id is fixed/);
  const v = await machine("shadeform");
  await vmLaunch(v);
  await upd(v, `provider_machine_id = 'vm-1'`);
  // launched (before any token: the seam a token's key alone wouldn't cover)
  await upd(v, `outcome = 'launched', ipv4 = '203.0.113.7', first_active_ms = ?`, T0);
  await assert.rejects(upd(v, `provider_machine_id = 'vm-2'`), /provider id is fixed/);
  await token(v, { mode: "vm", provider_machine_id: "vm-1", nonce_sha256: H, issued_ms: T0, expires_ms: T0 + 1 });
  for (const x of ["vm-2", null]) await assert.rejects(upd(v, `provider_machine_id = ?`, x), /provider id is fixed/, String(x));
  assert.equal((await w.db.all<{ p: string }>(`SELECT provider_machine_id AS p FROM launches WHERE machine_id = ?`, [v]))[0]!.p, "vm-1");
});

test("launches: the ACTIVE facts are set only by the ACTIVE transition, then fixed", async () => {
  const v = await machine("shadeform");
  await assert.rejects(vmLaunch(v, { ipv4: "203.0.113.7", first_active_ms: T0 }), /CHECK/); // (creating has none)
  await vmLaunch(v, { provider_machine_id: "vm-1" });
  // the facts come together (an insert isn't the ACTIVE transition, so the CHECK holds it)
  const h = await machine("shadeform");
  await assert.rejects(vmLaunch(h, { outcome: "terminate", terminate_reason: "abort", ipv4: "203.0.113.7" }), /CHECK/);
  await assert.rejects(vmLaunch(h, { outcome: "terminate", terminate_reason: "abort", first_active_ms: T0 }), /CHECK/);
  // entering launched from anything but creating doesn't set them
  const t = await machine("shadeform");
  await vmLaunch(t, { provider_machine_id: "vm-t", outcome: "terminate", terminate_reason: "abort" });
  await assert.rejects(
    upd(t, `outcome = 'launched', terminate_reason = NULL, ipv4 = '203.0.113.9', first_active_ms = ?`, T0),
    /ACTIVE facts are fixed/,
  );
  // only creating -> launched sets them
  await assert.rejects(upd(v, `ipv4 = '203.0.113.7', first_active_ms = ?`, T0), /ACTIVE facts are fixed/);
  await assert.rejects(upd(v, `outcome = 'terminate', terminate_reason = 'abort', ipv4 = '203.0.113.7', first_active_ms = ?`, T0), /ACTIVE facts are fixed/);
  await upd(v, `outcome = 'launched', ipv4 = '203.0.113.7', first_active_ms = ?`, T0);
  await upd(v, `ipv4 = '203.0.113.7', first_active_ms = ?`, T0); // (the same values)
  for (const [why, set, ...p] of [
    ["another address", `ipv4 = '203.0.113.8'`],
    ["a later first ACTIVE", `first_active_ms = ?`, T0 + 1],
    ["an earlier first ACTIVE", `first_active_ms = ?`, T0 - 1],
    ["both cleared", `ipv4 = NULL, first_active_ms = NULL`],
    ["cleared on terminate", `outcome = 'terminate', terminate_reason = 'abort', ipv4 = NULL, first_active_ms = NULL`],
  ] as Array<[string, string, ...SqlValue[]]>) {
    await assert.rejects(upd(v, set, ...p), /ACTIVE facts are fixed/, why);
  }
  // one fact cleared alone, in launched and (below) after it
  await assert.rejects(upd(v, `ipv4 = NULL`), /ACTIVE facts are fixed/, "the address alone cleared");
  await assert.rejects(upd(v, `first_active_ms = NULL`), /ACTIVE facts are fixed/, "the first ACTIVE alone cleared");
  // a later transition keeps them
  await upd(v, `outcome = 'terminate', terminate_reason = 'abort', next_ms = ?`, T0);
  await assert.rejects(upd(v, `ipv4 = NULL`), /ACTIVE facts are fixed/, "the address alone cleared, terminating");
  await assert.rejects(upd(v, `first_active_ms = NULL`), /ACTIVE facts are fixed/, "the first ACTIVE alone cleared, terminating");
  const r = (await w.db.all<{ ipv4: string; f: number }>(`SELECT ipv4, first_active_ms AS f FROM launches WHERE machine_id = ?`, [v]))[0]!;
  assert.deepEqual([r.ipv4, r.f], ["203.0.113.7", T0]);
});

test("launches: each mode carries its own columns, and never the other mode's", async () => {
  const m = await machine();
  for (const [col, v] of [["nonce_sha256", H], ["boot_script_sha256", H], ["announce_ms", T0]] as const) {
    await assert.rejects(container(m, { [col]: v }), /CHECK/, col);
  }
  await assert.rejects(container(m, { ipv4: "203.0.113.7", first_active_ms: T0 }), /CHECK/);
  await assert.rejects(container(m, { credential_kind: null }), /CHECK/);
  await assert.rejects(container(m, { credential_kind: "theirs" }), /CHECK/);
  const v = await machine("shadeform");
  for (const [col, x] of [["first_running_ms", T0], ["max_end_ms", T0 + 1], ["credential_kind", "ours"]] as const) {
    await assert.rejects(vmLaunch(v, { [col]: x }), /CHECK/, col);
  }
  await assert.rejects(vmLaunch(v, { nonce_sha256: null }), /CHECK/);
  await assert.rejects(vmLaunch(v, { boot_script_sha256: null }), /CHECK/);
  await container(m, { credential_kind: "org", account_kind: "org", account_org_id: w.orgId });
  await vmLaunch(v);
});

test("launches: terminated exactly with its time, in both modes", async () => {
  for (const [p, insert] of [["runpod", container], ["shadeform", vmLaunch]] as const) {
    const m = await machine(p);
    await assert.rejects(insert(m, { outcome: "terminated", terminate_reason: "abort", next_ms: null }), /CHECK/, `${p}: terminated without its time`);
    await assert.rejects(insert(m, { outcome: "terminate", terminate_reason: "abort", terminated_ms: T0 }), /CHECK/, `${p}: a time before terminated`);
    // (inserted creating, then marked to terminate: a container launch moves only with its rate, 0015)
    await insert(m);
    await upd(m, `outcome = 'terminate', terminate_reason = 'abort'`);
    await upd(m, `outcome = 'terminated', terminated_ms = ?, next_ms = NULL`, T0);
  }
});

test("launches: the container states (never launched; first running from issued on; a lifetime when enrolled)", async () => {
  const m = await machine();
  await assert.rejects(container(m, { outcome: "launched", provider_machine_id: "p", next_ms: T0 }), /CHECK/);
  await assert.rejects(container(m, { first_running_ms: T0 }), /CHECK/); // (creating hasn't been seen running)
  await assert.rejects(container(m, { max_end_ms: T0 + 1 }), /CHECK/); // (no lifetime before enroll)
  await container(m);
  await assert.rejects(upd(m, `outcome = 'issued', first_running_ms = ?`, T0), /CHECK/); // (no id)
  await assert.rejects(upd(m, `outcome = 'issued', provider_machine_id = 'p'`), /CHECK/); // (not seen running)
  await assert.rejects(upd(m, `outcome = 'issued', provider_machine_id = 'p', first_running_ms = ?`, T0 - 1), /CHECK/); // (before the intent)
  await upd(m, `outcome = 'issued', provider_machine_id = 'p', first_running_ms = ?`, T0 + 10);
  await assert.rejects(upd(m, `max_end_ms = ?`, T0 + 1), /CHECK/); // (issued has no lifetime)
  await assert.rejects(upd(m, `outcome = 'enrolled', next_ms = NULL`), /CHECK/); // (enrolled needs one)
  await assert.rejects(upd(m, `outcome = 'enrolled', next_ms = NULL, max_end_ms = ?`, T0), /CHECK/); // (not after the intent)
  await upd(m, `outcome = 'enrolled', next_ms = NULL, max_end_ms = ?`, T0 + 3_600_000);
  // terminate keeps them (and every new reason is in the closed list)
  for (const reason of ["connect-deadline", "abort", "eradication-failed", "member-stop", "idle-stop", "max-session", "hard-stop", "duplicate-name", "pod-exited"]) {
    await upd(m, `outcome = 'terminate', terminate_reason = ?, next_ms = ?`, reason, T0);
  }
  for (const bad of ["orphan", "abort" + NUL, "abort" + NUL + "x".repeat(1000), "Abort", ""]) {
    await assert.rejects(upd(m, `terminate_reason = ?`, bad), /CHECK/, JSON.stringify(bad.slice(0, 8)));
  }
});

test("launches: first running only moves earlier; a lifetime and a credential kind, once set, are fixed", async () => {
  const m = await machine();
  await container(m);
  await upd(m, `outcome = 'issued', provider_machine_id = 'p', first_running_ms = ?`, T0 + 100);
  await upd(m, `first_running_ms = ?`, T0 + 100); // (equal)
  await upd(m, `first_running_ms = ?`, T0 + 50); // (earlier: an older verified sample committing later)
  await assert.rejects(upd(m, `first_running_ms = ?`, T0 + 51), /only moves earlier/);
  await assert.rejects(upd(m, `first_running_ms = NULL, outcome = 'terminate', terminate_reason = 'abort', next_ms = ?`, T0), /only moves earlier/);
  await upd(m, `outcome = 'enrolled', next_ms = NULL, max_end_ms = ?`, T0 + 1000);
  for (const [why, v] of [["later", T0 + 2000], ["earlier", T0 + 500], ["null", null]] as const) {
    await assert.rejects(upd(m, `max_end_ms = ?`, v), /lifetime is fixed/, why);
  }
  await upd(m, `outcome = 'terminate', terminate_reason = 'max-session', next_ms = ?`, T0); // (terminate keeps it)
  assert.equal((await w.db.all<{ e: number }>(`SELECT max_end_ms AS e FROM launches WHERE machine_id = ?`, [m]))[0]!.e, T0 + 1000);
  for (const [from, to] of [["ours", "org"], ["ours", null]] as const) {
    void from;
    await assert.rejects(upd(m, `credential_kind = ?`, to), /credential kind is fixed|CHECK/, String(to));
  }
  const o = await machine();
  await container(o, { credential_kind: "org", account_kind: "org", account_org_id: w.orgId });
  await assert.rejects(upd(o, `credential_kind = 'ours'`), /credential kind is fixed/);
  // a VM row's credential kind stays NULL
  const v = await machine("shadeform");
  await vmLaunch(v);
  await assert.rejects(upd(v, `credential_kind = 'ours'`), /credential kind is fixed|CHECK/);
});

test("launches: an enrolled launch of either mode has a heartbeat due time, which only moves later", async () => {
  const m = await machine();
  await container(m, { heartbeat_due_ms: null });
  await upd(m, `outcome = 'issued', provider_machine_id = 'p', first_running_ms = ?`, T0);
  await assert.rejects(upd(m, `outcome = 'enrolled', next_ms = NULL, max_end_ms = ?`, T0 + 1), /CHECK/);
  await upd(m, `outcome = 'enrolled', next_ms = NULL, max_end_ms = ?, heartbeat_due_ms = ?`, T0 + 1, T0 + 5);
  await assert.rejects(upd(m, `heartbeat_due_ms = ?`, T0 + 4), /only moves later/);
  await assert.rejects(upd(m, `heartbeat_due_ms = NULL, outcome = 'terminate', terminate_reason = 'abort', next_ms = ?`, T0), /only moves later/);
  const v = await machine("shadeform");
  await vmLaunch(v, { outcome: "enrolled", provider_machine_id: "vm-1", ipv4: "203.0.113.7", first_active_ms: T0, announce_ms: T0, next_ms: null, heartbeat_due_ms: T0 });
  await assert.rejects(upd(v, `heartbeat_due_ms = ?`, T0 - 1), /only moves later/);
  const u = await machine("shadeform");
  await assert.rejects(vmLaunch(u, { outcome: "enrolled", provider_machine_id: "vm-2", ipv4: "203.0.113.8", first_active_ms: T0, announce_ms: T0, next_ms: null }), /CHECK/);
});

test("launches: one provider id is bound to at most one launch of that provider", async () => {
  const [a, b, c] = [await machine(), await machine(), await machine("shadeform")];
  await container(a, { provider_machine_id: "pod-1" });
  await assert.rejects(container(b, { provider_machine_id: "pod-1" }), /UNIQUE/);
  await container(b);
  await vmLaunch(c, { provider_machine_id: "pod-1" }); // (another provider's id space)
  await assert.rejects(upd(b, `provider_machine_id = 'pod-1'`), /UNIQUE/); // (recording a taken id)
  await upd(b, `provider_machine_id = 'pod-2'`);
});

test("boot_tokens: a VM token exactly as before; a token's mode is its launch's", async () => {
  const v = await machine("shadeform");
  await vmLaunch(v, { provider_machine_id: "vm-1" });
  const vmTok = (over: Record<string, SqlValue> = {}) => token(v, { mode: "vm", provider_machine_id: "vm-1", nonce_sha256: H, issued_ms: T0, expires_ms: T0 + 120_000, ...over });
  for (const [why, over] of [
    ["no provider id", { provider_machine_id: null }],
    ["no nonce", { nonce_sha256: null }],
    ["no window", { issued_ms: null, expires_ms: null }],
    ["an empty window", { expires_ms: T0 }],
    ["over 120 s", { expires_ms: T0 + 120_001 }],
    ["half a window", { expires_ms: null }],
    ["another mode than its launch's", { mode: "container", nonce_sha256: null }],
    ["another provider id than its launch's", { provider_machine_id: "vm-2" }],
  ] as const) {
    await assert.rejects(vmTok(over as Record<string, SqlValue>), /CHECK|FOREIGN KEY/, why);
  }
  await vmTok({ expires_ms: T0 + 1 });
  // the launch's id can't move away from its token's
  await assert.rejects(upd(v, `provider_machine_id = 'vm-3'`), /provider id is fixed/); // (and its token's key would refuse it too)
});

test("boot_tokens: a container token, pending until first running, then bound to its launch's id with exactly 120 s", async () => {
  const m = await machine();
  await container(m);
  await assert.rejects(token(m, { nonce_sha256: H }), /CHECK/); // (no nonce, ever)
  await assert.rejects(token(m, { mode: "vm" }), /CHECK|FOREIGN KEY/); // (another mode than its launch's)
  await assert.rejects(token(m, { issued_ms: T0 }), /CHECK/); // (half a window)
  await assert.rejects(token(m, { issued_ms: T0, expires_ms: T0 + 120_000 }), /CHECK/); // (a window needs the id)
  await token(m); // (pending: no id, no window)
  const set = (s: string, ...p: SqlValue[]) => w.db.batch([stmt(`UPDATE boot_tokens SET ${s} WHERE machine_id = ?`, ...p, m)]);
  await set(`used_ms = ?`, T0); // (revoked while pending)
  await set(`used_ms = NULL`);
  // its id must be its launch's
  await assert.rejects(set(`provider_machine_id = 'pod-x'`), /FOREIGN KEY/);
  await upd(m, `provider_machine_id = 'pod-1'`);
  await set(`provider_machine_id = 'pod-1'`);
  for (const [why, exp] of [["119 s", T0 + 119_999], ["121 s", T0 + 120_001]] as const) {
    await assert.rejects(set(`issued_ms = ?, expires_ms = ?`, T0, exp), /CHECK/, why);
  }
  await set(`issued_ms = ?, expires_ms = ?`, T0, T0 + 120_000);
  await assert.rejects(set(`provider_machine_id = NULL`), /CHECK/); // (a window keeps its id)
  for (const bad of ["pod-1" + NUL, "é".repeat(32), "x".repeat(65)]) await assert.rejects(set(`provider_machine_id = ?`, bad), /CHECK|FOREIGN KEY/, JSON.stringify(bad.slice(0, 6)));
});

test("gate reports belong to a launch", async () => {
  const v = await machine("shadeform");
  await assert.rejects(insert("gate_reports", { machine_id: v, incarnation: 1, words: "[]", at_ms: T0 }), /FOREIGN KEY/);
  await vmLaunch(v);
  await insert("gate_reports", { machine_id: v, incarnation: 1, words: "[]", at_ms: T0 });
});

test("0014 refuses to rebuild over existing launches, before changing anything", () => {
  let raw: import("node:sqlite").DatabaseSync | null = null;
  assert.throws(
    () =>
      sqliteDb({
        upgrade: {
          at: "0014",
          seed(r) {
            raw = r;
            r.exec("PRAGMA foreign_keys = OFF");
            r.prepare(`INSERT INTO vm_launches (machine_id, incarnation, provider, nonce_sha256, boot_script_sha256, agent_sha256, outcome, next_ms, created_ms)
                       VALUES ('mch_x', 1, 'hyperstack', ?, ?, ?, 'creating', 0, 0)`).run(H, H, H);
            r.exec("PRAGMA foreign_keys = ON");
          },
        },
      }),
    /malformed JSON/,
  );
  const names = (raw as unknown as import("node:sqlite").DatabaseSync).prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('vm_launches', 'launches')`).all() as Array<{ name: string }>;
  assert.deepEqual(names.map((n) => n.name), ["vm_launches"]); // (the old table, untouched)
});

test("launches and boot_tokens: text is bounded in stored bytes, ASCII where it must be, and never hides a NUL", async () => {
  const m = await machine();
  const hex63nul = "a".repeat(63) + NUL;
  for (const [why, over] of [
    ["an empty id", { provider_machine_id: "" }],
    ["a 65-byte id", { provider_machine_id: "x".repeat(65) }],
    ["a non-ASCII id", { provider_machine_id: "é".repeat(32) }],
    ["an id with a NUL", { provider_machine_id: "p" + NUL }],
    ["an agent hash with a NUL", { agent_sha256: hex63nul }],
    ["an agent hash, uppercase", { agent_sha256: H.toUpperCase() }],
    ["an agent hash, 63 bytes", { agent_sha256: H.slice(1) }],
  ] as const) {
    await assert.rejects(container(m, over as Record<string, SqlValue>), /CHECK/, why);
  }
  const v = await machine("shadeform");
  for (const [why, over] of [
    ["a nonce hash with a NUL", { nonce_sha256: hex63nul }],
    ["a nonce hash, 65 bytes", { nonce_sha256: H + "a" }],
    ["a script hash with a NUL", { boot_script_sha256: hex63nul }],
    ["a script hash, non-ASCII", { boot_script_sha256: "é".repeat(32) }],
    ["an IPv4, non-ASCII", { ipv4: "é".repeat(4), first_active_ms: T0, outcome: "terminate", terminate_reason: "abort" }],
    ["an IPv4, too long", { ipv4: "1".repeat(16), first_active_ms: T0, outcome: "terminate", terminate_reason: "abort" }],
  ] as const) {
    await assert.rejects(vmLaunch(v, over as Record<string, SqlValue>), /CHECK/, why);
  }
  await vmLaunch(v, { provider_machine_id: "vm-1" });
  const vmTok = (over: Record<string, SqlValue>) => token(v, { mode: "vm", provider_machine_id: "vm-1", nonce_sha256: H, issued_ms: T0, expires_ms: T0 + 1, ...over });
  for (const [why, over] of [
    ["a token hash with a NUL", { token_sha256: hex63nul }],
    ["a token hash, uppercase", { token_sha256: H.toUpperCase() }],
    ["a nonce hash with a NUL", { nonce_sha256: hex63nul }],
    ["a nonce hash, uppercase", { nonce_sha256: H.toUpperCase() }],
  ] as const) {
    await assert.rejects(vmTok(over as Record<string, SqlValue>), /CHECK/, why);
  }
});

test("boot_tokens: one per launch, and a token's mode is its launch's even while pending", async () => {
  const v = await machine("shadeform");
  await vmLaunch(v, { provider_machine_id: "vm-1" });
  // a pending container-shaped token on a VM launch: only the mode key refuses it
  await assert.rejects(token(v, { mode: "container" }), /FOREIGN KEY/);
  await token(v, { mode: "vm", provider_machine_id: "vm-1", nonce_sha256: H, issued_ms: T0, expires_ms: T0 + 1 });
  await assert.rejects(token(v, { token_sha256: sha("another"), mode: "vm", provider_machine_id: "vm-1", nonce_sha256: H, issued_ms: T0, expires_ms: T0 + 1 }), /UNIQUE/);
  const c = await machine();
  await container(c);
  await token(c);
  await assert.rejects(token(c, { token_sha256: sha("another") }), /UNIQUE/);
});

test("the VM paths never touch a container launch: the VM watchdog, the heartbeat watchdog, enroll", async () => {
  const env = { db: w.db, now: T0 + 10 * 3_600_000, vm, elapsedMs: () => 0 };
  const rows = async () => w.db.all(`SELECT * FROM launches ORDER BY machine_id`);
  // due to terminate, and enrolled long silent
  const a = await machine();
  await container(a, { provider_machine_id: "pod-a", outcome: "terminate", terminate_reason: "abort", next_ms: T0 });
  const b = await machine();
  await container(b, { provider_machine_id: "pod-b", outcome: "enrolled", first_running_ms: T0, max_end_ms: T0 + 1, next_ms: null, heartbeat_due_ms: T0 });
  await w.db.batch([stmt(`UPDATE machines SET state = 'running' WHERE id = ?`, b)]);
  const before = await rows();
  assert.equal(await runVmWatchdog(env), 0);
  assert.equal(await runHeartbeatWatchdog(env), 0);
  assert.deepEqual([await rows(), vm.calls], [before, []]);
  // a container's boot token presented to the VM enroll: refused, nothing used or changed
  const c = await machine();
  await container(c, { provider_machine_id: "pod-c", outcome: "issued", first_running_ms: T0 });
  const bootToken = randomBytes(32).toString("base64url");
  await token(c, { token_sha256: sha(bootToken), provider_machine_id: "pod-c", issued_ms: T0, expires_ms: T0 + 120_000 });
  const tokens = await w.db.all(`SELECT * FROM boot_tokens`);
  const launchesBefore = await rows();
  const res = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootToken, agentVersion: "1.0.0", agentSha256: H, mode: "vm", gpu: null, hostname: "c", gate: { v: 1, pass: true, fail: [] } }),
  }));
  await Promise.all(w.pending.splice(0));
  assert.deepEqual([res.status, await res.json()], [403, { error: { code: "forbidden", message: "refused" } }]); // (as an unknown token)
  assert.deepEqual([await w.db.all(`SELECT * FROM boot_tokens`), await rows(), vm.calls], [tokens, launchesBefore, []]);
});
