import { test } from "node:test";
import assert from "node:assert/strict";
import { isId, isPriceSplit, addSplits, type Machine } from "@sbgpu/api";
import { ApiError, createClient, type Client } from "../client.ts";
import { mockFetch } from "./fetch.ts";
import { seedDemo, type Demo } from "./seed.ts";
import { SAVE_BYTES } from "./backend.ts";

const MIN = 60_000;

function setup(): Demo & { as: (email: string) => Promise<Client> } {
  const demo = seedDemo();
  const client = createClient({ fetch: mockFetch(demo.backend) });
  return {
    ...demo,
    // The mock keeps one session; signing in switches it.
    as: async (email: string) => {
      await client.call("verifySignInLink", { body: { token: `mock:${email}` } });
      return client;
    },
  };
}

async function rejects(p: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ApiError, String(err));
    assert.equal(err.code, code);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });
}

async function startL4(c: Client, projectId: string): Promise<Machine> {
  return c.call("startMachine", { params: { projectId }, body: { gpuType: "L4" } });
}

test("sign-in: unauthenticated until signed in; bad tokens refused", async () => {
  const d = setup();
  const c = createClient({ fetch: mockFetch(d.backend) });
  await rejects(c.call("getMe"), "unauthenticated", 401);
  await rejects(c.call("verifySignInLink", { body: { token: "nope" } }), "unauthenticated");
  const me = await c.call("verifySignInLink", { body: { token: `mock:${d.emails.member}` } });
  assert.equal(me.user.email, d.emails.member);
  assert.deepEqual(me.projects.map((p) => [p.projectId, p.role]), [[d.projectId, "member"]]);
  await c.call("signOut", { body: {} });
  await rejects(c.call("getMe"), "unauthenticated");
});

test("an org owner is owner of the org's projects", async () => {
  const d = setup();
  const c = await d.as(d.emails.owner);
  const me = await c.call("getMe");
  assert.deepEqual(me.orgs.map((o) => o.role), ["owner"]);
  assert.equal(me.projects[0]?.role, "owner");
  const org = await c.call("getOrg", { params: { orgId: d.orgId } });
  assert.equal(org.unassignedCredit, 3_000_000_000);
});

test("quote: price split, start requirement and each refusal", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const ada = await d.as(d.emails.member);
  const l4 = await ada.call("quote", { params: p, body: { gpuType: "L4" } });
  assert.equal(l4.canStart, true);
  assert.equal("reason" in l4, false);
  assert.deepEqual(l4.offers.map((o) => o.provider), ["runpod", "hyperstack"]);
  assert.deepEqual(l4.offers[0]?.pricePerHour, { providerCost: 480_000, margin: 144_000, total: 624_000 });
  // (15 min + 60 s check + 60 s safety + 10 min reserve) at $0.624/h, rounded up.
  assert.equal(l4.requiredToStart, 280_800);
  assert.equal(l4.remaining, 25_000_000);

  const reason = async (gpuType: string) => (await ada.call("quote", { params: p, body: { gpuType } })).reason;
  assert.equal(await reason("A100-80GB"), "priceCap"); // $1.89 * 1.3 > $2.00
  assert.equal(await reason("A10"), "noCapacity");
  assert.equal(await reason("H100"), "policy"); // not an allowed type
  assert.equal(await reason("A6000"), undefined);
  assert.equal((await ada.call("quote", { params: p, body: { gpuType: "L4", chargeTo: "team" } })).canStart, true);

  const grace = await d.as(d.emails.lowMember);
  const low = await grace.call("quote", { params: p, body: { gpuType: "L4" } });
  assert.equal(low.reason, "allocationTooLow");
  assert.equal(low.canStart, false);
  assert.equal((await grace.call("quote", { params: p, body: { gpuType: "L4", chargeTo: "team" } })).reason, "policy"); // no team
  await rejects(startL4(grace, d.projectId), "allocationTooLow", 402);
  await rejects(grace.call("quote", { params: p, body: { gpuType: "not a type" } }), "badRequest");
});

test("the price list shows the cheapest allowed offer with stock", async () => {
  const d = setup();
  const c = await d.as(d.emails.member);
  const { items } = await c.call("listGpuTypes", { params: { projectId: d.projectId } });
  const byType = Object.fromEntries(items.map((i) => [i.gpuType, i]));
  assert.equal(byType.L4?.pricePerHour?.total, 624_000);
  assert.equal(byType.L4?.gpuMemoryGb, 24);
  assert.equal(byType.A6000?.pricePerHour?.total, 1_027_000);
  assert.equal(byType.A6000?.stock, "low");
  assert.equal(byType["A100-80GB"]?.pricePerHour, null);
  assert.equal(byType.A10?.stock, "none");
  assert.equal(byType.H100, undefined);
});

test("a machine boots, accrues per minute, saves and stops", async () => {
  const d = setup();
  const c = await d.as(d.emails.member);
  let m = await startL4(c, d.projectId);
  assert.equal(m.state, "starting");
  assert.equal(m.terminalAvailable, false);
  await rejects(c.call("openMachineSession", { params: { machineId: m.id }, body: {} }), "invalidState");
  await rejects(startL4(c, d.projectId), "concurrencyCap", 429); // one machine per member

  d.backend.advance(89_000);
  assert.equal((await c.call("getMachine", { params: { machineId: m.id } })).state, "starting");
  d.backend.advance(1000);
  m = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(m.state, "running");
  assert.equal(m.terminalAvailable, true);
  assert.equal(m.startedAt, "2027-02-01T09:01:30.000Z");
  assert.equal(m.maxSessionEndsAt, "2027-02-01T17:01:30.000Z");
  const session = await c.call("openMachineSession", { params: { machineId: m.id }, body: {} });
  assert.equal(session.expiresAt, "2027-02-01T09:02:30.000Z");

  d.backend.advance(60 * MIN - 90_000); // one hour since the start
  m = await c.call("getMachine", { params: { machineId: m.id } });
  assert.deepEqual(m.spent, { providerCost: 480_000, margin: 144_000, total: 624_000 });
  const spend = await c.call("getSpend", { params: { projectId: d.projectId } });
  const own = spend.meters.find((x) => x.allocationId === m.allocationId);
  assert.equal(own?.reserved, 114_400); // reserveCharge: 10 minutes + 1, at 10,400 a minute
  assert.equal(own?.remaining, 25_000_000 - 624_000 - 114_400);
  assert.equal(own?.currentRatePerHour.total, 624_000);
  assert.equal(spend.asOf, "2027-02-01T10:00:00.000Z");

  m = await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  assert.equal(m.state, "saving");
  assert.deepEqual(m.save.progress, { bytesDone: 0, bytesTotal: SAVE_BYTES });
  assert.equal(m.terminalAvailable, false);
  d.backend.advance(5000);
  m = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(m.save.progress?.bytesDone, (SAVE_BYTES * 5) / 6);
  d.backend.advance(1000);
  m = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(m.state, "stopping");
  assert.equal(m.save.lastSavedAt, "2027-02-01T10:00:06.000Z");
  d.backend.advance(15_000);
  m = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(m.state, "stopped");
  assert.equal(m.stopReason, "user");
  assert.equal(m.finalSaveIncomplete, false);
  assert.equal(m.stoppedAt, "2027-02-01T10:00:21.000Z");
  // Plus 21 s: $0.0028 provider + $0.00084 margin.
  assert.deepEqual(m.spent, { providerCost: 482_800, margin: 144_840, total: 627_640 });
  const after = (await c.call("getSpend", { params: { projectId: d.projectId } })).meters.find((x) => x.allocationId === m.allocationId);
  assert.equal(after?.reserved, 0);
  assert.equal(after?.currentRatePerHour.total, 0);
  d.backend.advance(10 * MIN);
  assert.equal((await c.call("getMachine", { params: { machineId: m.id } })).spent.total, 627_640); // nothing accrues when stopped
});

test("ledger: every entry is a valid split, and machine spend is their sum", async () => {
  const d = setup();
  const c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  d.backend.advance(37 * MIN + 13_000);
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(MIN);
  const manager = await d.as(d.emails.manager);
  const { items } = await manager.call("listLedger", { params: { projectId: d.projectId } });
  assert.ok(items.length > 30);
  for (const e of items) {
    assert.ok(isPriceSplit(e.amount));
    assert.ok(isId("ledgerEntry", e.id));
    assert.ok(e.seconds > 0 && e.seconds <= 60);
  }
  const machine = await manager.call("getMachine", { params: { machineId: m.id } });
  assert.deepEqual(machine.spent, addSplits(...items.map((e) => e.amount)));
  assert.equal(items.reduce((s, e) => s + e.seconds, 0), 37 * 60 + 13 + 6 + 15);
  const project = await manager.call("getProject", { params: { projectId: d.projectId } });
  assert.deepEqual(project.spent, machine.spent);
});

test("the hard stop saves and stops before the allocation runs out", async () => {
  const d = setup();
  const manager = await d.as(d.emails.manager);
  const { items: members } = await manager.call("listMembers", { params: { projectId: d.projectId } });
  const grace = members.find((x) => x.email === d.emails.lowMember);
  assert.ok(grace);
  await manager.call("setMemberAllocation", { params: { projectId: d.projectId, memberId: grace.id }, body: { amount: 400_000 } });
  const c = await d.as(d.emails.lowMember);
  const m = await startL4(c, d.projectId);
  // Each minute costs 10,400. The threshold is 2 min + 10 min reserve = 124,800 unspent:
  // after 26 minutes 129,600 is left (runs on); after 27, 119,200 (stops).
  d.backend.advance(26 * MIN);
  assert.equal((await c.call("getMachine", { params: { machineId: m.id } })).state, "running");
  d.backend.advance(MIN);
  const stopping = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(stopping.state, "saving");
  assert.equal(stopping.stopReason, "budget");
  d.backend.advance(MIN);
  const stopped = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.finalSaveIncomplete, false);
  assert.equal(stopped.spent.total, 280_800 + 3640);
  assert.ok(stopped.spent.total <= 400_000);
  await rejects(c.call("restartMachine", { params: { machineId: m.id }, body: {} }), "allocationTooLow");
});

test("idle and max-session stops save first and say why", async () => {
  const d = setup();
  const manager = await d.as(d.emails.manager);
  await manager.call("updateProject", { params: { projectId: d.projectId }, body: { policy: { maxSessionMinutes: 2 } } });
  const c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  d.backend.advance(90_000 + 2 * MIN - 1000);
  assert.equal((await c.call("getMachine", { params: { machineId: m.id } })).state, "running");
  d.backend.advance(1000);
  const ended = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(ended.state, "saving");
  assert.equal(ended.stopReason, "maxSession");

  const c2 = await d.as(d.emails.teamMember);
  const m2 = await startL4(c2, d.projectId);
  d.backend.advance(90_000);
  d.backend.markIdle(m2.id);
  const idle = await c2.call("getMachine", { params: { machineId: m2.id } });
  assert.equal(idle.state, "saving");
  assert.equal(idle.stopReason, "idle");
});

test("save now while running shows only in save", async () => {
  const d = setup();
  const c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  await rejects(c.call("saveMachine", { params: { machineId: m.id }, body: {} }), "invalidState");
  d.backend.advance(90_000);
  const saving = await c.call("saveMachine", { params: { machineId: m.id }, body: {} });
  assert.equal(saving.state, "running");
  assert.equal(saving.save.state, "saving");
  d.backend.advance(6000);
  const saved = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(saved.save.state, "idle");
  assert.equal(saved.save.lastSavedAt, "2027-02-01T09:01:36.000Z");
  assert.ok(isId("snapshot", saved.save.snapshotId));
});

test("members see and act on their own machines only", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const alan = await d.as(d.emails.teamMember);
  const m = await startL4(alan, d.projectId);
  const ada = await d.as(d.emails.member);
  await rejects(ada.call("getMachine", { params: { machineId: m.id } }), "notFound", 404);
  await rejects(ada.call("stopMachine", { params: { machineId: m.id }, body: {} }), "notFound");
  await rejects(ada.call("listMachines", { params: p, query: { all: "1" } }), "forbidden", 403);
  assert.deepEqual((await ada.call("listMachines", { params: p })).items, []);
  await rejects(ada.call("listMembers", { params: p }), "forbidden");
  await rejects(ada.call("getSpendCsv", { params: p, query: { by: "member" } }), "forbidden");

  const ta = await d.as(d.emails.assistant);
  assert.deepEqual((await ta.call("listMachines", { params: p, query: { all: "1" } })).items.map((x) => x.id), [m.id]);
  await rejects(ta.call("openMachineSession", { params: { machineId: m.id }, body: {} }), "forbidden");
  await rejects(ta.call("stopMachine", { params: { machineId: m.id }, body: { save: false } }), "forbidden");
  await rejects(ta.call("stopAllMachines", { params: p, body: { save: false } }), "forbidden");
  await rejects(ta.call("setMemberAllocation", { params: { ...p, memberId: "mbr_00000000000000000001" }, body: { amount: 1 } }), "forbidden");

  d.backend.advance(90_000);
  const manager = await d.as(d.emails.manager);
  const forced = await manager.call("stopMachine", { params: { machineId: m.id }, body: { save: false } });
  assert.equal(forced.state, "stopping");
  assert.equal(forced.stopReason, "manager");
  assert.equal(forced.finalSaveIncomplete, true);

  const outsider = await d.as("someone@else.example");
  await rejects(outsider.call("getProject", { params: p }), "notFound");
  await rejects(outsider.call("getOrg", { params: { orgId: d.orgId } }), "notFound");
});

test("stop all stops every accruing machine in the project", async () => {
  const d = setup();
  const ada = await d.as(d.emails.member);
  const a = await startL4(ada, d.projectId);
  const alan = await d.as(d.emails.teamMember);
  const b = await startL4(alan, d.projectId);
  d.backend.advance(90_000);
  const ta = await d.as(d.emails.assistant);
  const { stopping } = await ta.call("stopAllMachines", { params: { projectId: d.projectId }, body: {} });
  assert.deepEqual(stopping.sort(), [a.id, b.id].sort());
  const { items } = await ta.call("listMachines", { params: { projectId: d.projectId }, query: { all: "1" } });
  assert.deepEqual(items.map((m) => [m.state, m.stopReason]), [["saving", "manager"], ["saving", "manager"]]);
});

test("spend meters: members see their own and their team's", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const ada = await d.as(d.emails.member);
  const mine = await ada.call("getSpend", { params: p });
  assert.deepEqual(mine.meters.map((m) => m.holder.kind).sort(), ["member", "team"]);
  assert.equal(mine.meters.find((m) => m.holder.kind === "team")?.storage.quotaBytes, 50 * 1024 ** 3);
  const manager = await d.as(d.emails.manager);
  assert.equal((await manager.call("getSpend", { params: p })).meters.length, 10); // 8 members + 2 teams
  const project = await manager.call("getProject", { params: p });
  assert.equal(project.allocated, 4 * 25_000_000 + 200_000 + 2 * 50_000_000);
});

test("teams: members see their own team; a member is in one team at a time", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const ada = await d.as(d.emails.member);
  assert.deepEqual((await ada.call("listTeams", { params: p })).teams.map((t) => t.name), ["Team Qwen"]);
  const manager = await d.as(d.emails.manager);
  const { teams } = await manager.call("listTeams", { params: p });
  const [llama, qwen] = teams;
  assert.ok(llama && qwen);
  const adaId = qwen.memberIds[0] as string;
  await manager.call("updateMember", { params: { ...p, memberId: adaId }, body: { teamId: llama.id } });
  const after = (await manager.call("listTeams", { params: p })).teams;
  assert.equal(after.find((t) => t.id === qwen.id)?.memberIds.length, 0);
  assert.equal(after.find((t) => t.id === llama.id)?.memberIds.includes(adaId), true);
  await manager.call("updateMember", { params: { ...p, memberId: adaId }, body: { teamId: null } });
  assert.equal((await manager.call("listTeams", { params: p })).teams.find((t) => t.id === llama.id)?.memberIds.includes(adaId), false);
  const t = await manager.call("createTeam", { params: p, body: { name: " New ", allocation: 5 } });
  assert.equal(t.name, "New");
  await rejects(manager.call("createTeam", { params: p, body: { name: " " } }), "badRequest");
  await manager.call("deleteTeam", { params: { ...p, teamId: t.id } });
  await rejects(manager.call("deleteTeam", { params: { ...p, teamId: t.id } }), "notFound");
});

test("invites: validated, idempotent, and accepted at sign-in; only owners grant manager", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  await rejects(manager.call("inviteMembers", { params: p, body: { members: [{ email: "bad@" }] } }), "badRequest");
  await rejects(manager.call("inviteMembers", { params: p, body: { members: [{ email: "x@y.com", allocation: -1 }] } }), "badRequest");
  await rejects(manager.call("inviteMembers", { params: p, body: { members: [{ email: "boss@y.com", role: "manager" }] } }), "forbidden");
  const { members } = await manager.call("inviteMembers", { params: p, body: { members: [{ email: "New@Example.org", allocation: 7_000_000 }] } });
  assert.equal(members[0]?.status, "invited");
  assert.equal(members[0]?.email, "new@example.org");
  const again = await manager.call("inviteMembers", { params: p, body: { members: [{ email: "new@example.org" }] } });
  assert.equal(again.members[0]?.id, members[0]?.id);
  const newbie = await d.as("new@example.org");
  const me = await newbie.call("getMe");
  assert.equal(me.projects[0]?.role, "member");
  const meters = (await newbie.call("getSpend", { params: p })).meters;
  assert.equal(meters[0]?.amount, 7_000_000);
  const owner = await d.as(d.emails.owner);
  const boss = await owner.call("inviteMembers", { params: p, body: { members: [{ email: "boss@y.com", role: "manager" }] } });
  assert.equal(boss.members[0]?.role, "manager");
});

test("removing a member stops their machines", async () => {
  const d = setup();
  const ada = await d.as(d.emails.member);
  const m = await startL4(ada, d.projectId);
  d.backend.advance(90_000);
  const manager = await d.as(d.emails.manager);
  await manager.call("removeMember", { params: { projectId: d.projectId, memberId: m.memberId } });
  const after = await manager.call("getMachine", { params: { machineId: m.id } });
  assert.equal(after.state, "saving");
  assert.equal(after.stopReason, "manager");
  const removed = await d.as(d.emails.member);
  await rejects(removed.call("getProject", { params: { projectId: d.projectId } }), "notFound");
});

test("restart, delete and provider failure", async () => {
  const d = setup();
  const c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  await rejects(c.call("deleteMachine", { params: { machineId: m.id } }), "invalidState", 409);
  await rejects(c.call("restartMachine", { params: { machineId: m.id }, body: {} }), "invalidState");
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} }); // while starting: no save
  d.backend.advance(15_000);
  const stopped = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.spent.total, 2600); // 15 s
  const again = await c.call("restartMachine", { params: { machineId: m.id }, body: {} });
  assert.equal(again.state, "starting");
  assert.equal(again.stopReason, null);
  d.backend.advance(90_000);
  d.backend.failMachine(m.id, "host lost");
  const failed = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(failed.state, "failed");
  assert.equal(failed.stopReason, "provider");
  assert.equal(failed.error, "host lost");
  const spent = failed.spent.total;
  d.backend.advance(5 * MIN);
  assert.equal((await c.call("getMachine", { params: { machineId: m.id } })).spent.total, spent);
  assert.deepEqual(await c.call("deleteMachine", { params: { machineId: m.id } }), { ok: true });
  await rejects(c.call("getMachine", { params: { machineId: m.id } }), "notFound");
  assert.deepEqual((await c.call("listMachines", { params: { projectId: d.projectId } })).items, []);
});

test("project end: running machines save and stop; starts are refused", async () => {
  const d = setup();
  const manager = await d.as(d.emails.manager);
  await manager.call("updateProject", { params: { projectId: d.projectId }, body: { endsAt: "2027-02-01T09:05:00.000Z" } });
  await rejects(manager.call("updateProject", { params: { projectId: d.projectId }, body: { endsAt: "tomorrow" } }), "badRequest");
  const c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  d.backend.advance(5 * MIN);
  const ended = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(ended.state, "saving");
  assert.equal(ended.stopReason, "projectEnded");
  assert.equal((await c.call("quote", { params: { projectId: d.projectId }, body: { gpuType: "L4" } })).reason, "projectEnded");
});

test("spend CSV: three groupings, provider cost and margin columns, formulas neutralised", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  await manager.call("inviteMembers", { params: p, body: { members: [{ email: "eve@example.org", name: "=HYPERLINK(\"x\")" }] } });
  const ada = await d.as(d.emails.member);
  await startL4(ada, d.projectId);
  d.backend.advance(60 * MIN);
  const ta = await d.as(d.emails.assistant);
  const byMember = await ta.call("getSpendCsv", { params: p, query: { by: "member" } });
  const lines = byMember.split("\r\n");
  assert.equal(lines[0], "email,name,team,allocation_usd,provider_cost_usd,margin_usd,total_usd,remaining_usd");
  assert.ok(lines.includes("ada@example.org,Ada,Team Qwen,25,0.48,0.144,0.624,24.2616"), byMember);
  assert.ok(lines.includes('eve@example.org,"\'=HYPERLINK(""x"")",,0,0,0,0,0'), byMember);
  const byDay = await ta.call("getSpendCsv", { params: p, query: { by: "day" } });
  assert.equal(byDay, "date_utc,provider_cost_usd,margin_usd,total_usd\r\n2027-02-01,0.48,0.144,0.624\r\n");
  const byTeam = await ta.call("getSpendCsv", { params: p, query: { by: "team" } });
  assert.ok(byTeam.startsWith("team,members,allocation_usd,"));
  assert.ok(byTeam.includes("\r\nTeam Llama,2,50,0,0,0,50\r\n"));
  await rejects(ta.call("getSpendCsv", { params: p, query: { by: "week" as "day" } }), "badRequest");
});

test("unknown routes, agent routes and bad JSON", async () => {
  const d = setup();
  const f = mockFetch(d.backend);
  const res = await f("/v1/nope", { method: "GET" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: "notFound", message: "no route for GET /v1/nope" } });
  const bad = await f("/v1/auth/verify", { method: "POST", body: "{" });
  assert.equal(bad.status, 400);
  const c = await d.as(d.emails.owner);
  await rejects(c.call("agentHeartbeat", { body: {} as never }), "forbidden");
  await rejects(c.call("addOrgCredit", { params: { orgId: d.orgId }, body: { amount: 1, reference: "x" } }), "forbidden");
});

test("ids are deterministic and well-formed", () => {
  const d = seedDemo();
  for (const id of d.backend.projects.keys()) assert.ok(isId("project", id), id);
  for (const id of d.backend.members.keys()) assert.ok(isId("member", id), id);
  assert.equal(seedDemo().projectId, d.projectId);
  assert.throws(() => d.backend.advance(1500), RangeError);
  assert.throws(() => d.backend.advance(-1000), RangeError);
});

test("quote boundaries: the price cap and the start requirement are inclusive", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  await manager.call("updateProject", { params: p, body: { policy: { maxPricePerHour: 624_000 } } });
  const { items: members } = await manager.call("listMembers", { params: p });
  const grace = members.find((x) => x.email === d.emails.lowMember);
  assert.ok(grace);
  await manager.call("setMemberAllocation", { params: { ...p, memberId: grace.id }, body: { amount: 280_800 } });
  const c = await d.as(d.emails.lowMember);
  const q = await c.call("quote", { params: p, body: { gpuType: "L4" } });
  assert.equal(q.canStart, true);
  assert.deepEqual(q.offers.map((o) => o.provider), ["runpod"]); // hyperstack's $0.715 is over the cap
  await (await d.as(d.emails.manager)).call("setMemberAllocation", { params: { ...p, memberId: grace.id }, body: { amount: 280_799 } });
  assert.equal((await (await d.as(d.emails.lowMember)).call("quote", { params: p, body: { gpuType: "L4" } })).reason, "allocationTooLow");
  await (await d.as(d.emails.manager)).call("updateProject", { params: p, body: { policy: { maxPricePerHour: 623_999 } } });
  assert.equal((await (await d.as(d.emails.lowMember)).call("quote", { params: p, body: { gpuType: "L4" } })).reason, "priceCap");
});

test("quote: the project-wide machine cap", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  await manager.call("updateProject", { params: p, body: { policy: { maxConcurrentMachines: 1 } } });
  await startL4(await d.as(d.emails.member), d.projectId);
  const alan = await d.as(d.emails.teamMember);
  assert.equal((await alan.call("quote", { params: p, body: { gpuType: "L4" } })).reason, "concurrencyCap");
});

test("quote: not started yet, and the GPU count", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const c = await d.as(d.emails.member);
  assert.equal((await c.call("quote", { params: p, body: { gpuType: "L4", gpuCount: 2 } })).reason, "policy"); // no 2-GPU offers
  await (await d.as(d.emails.manager)).call("updateProject", { params: p, body: { startsAt: "2027-02-01T09:00:01.000Z" } });
  await d.as(d.emails.member);
  assert.equal((await c.call("quote", { params: p, body: { gpuType: "L4" } })).reason, "projectNotStarted");
  d.backend.advance(1000);
  assert.equal((await c.call("quote", { params: p, body: { gpuType: "L4" } })).canStart, true);
});

test("quote: providers, locality and countries narrow the offers", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  // One mock session: set the policy as the manager, then quote as the member.
  const setPolicy = async (policy: Record<string, unknown>) =>
    (await d.as(d.emails.manager)).call("updateProject", { params: p, body: { policy } });
  const quote = async () => (await d.as(d.emails.member)).call("quote", { params: p, body: { gpuType: "L4" } });
  const providers = async () => (await quote()).offers.map((o) => o.provider);
  await setPolicy({ allowedProviders: ["hyperstack"] });
  assert.deepEqual(await providers(), ["hyperstack"]);
  await setPolicy({ allowedProviders: ["runpod", "hyperstack"], locality: "europe" });
  assert.deepEqual(await providers(), ["runpod"]); // SE yes, CA no
  await setPolicy({ allowedProviders: ["hyperstack"] });
  assert.deepEqual((await (await d.as(d.emails.member)).call("quote", { params: p, body: { gpuType: "A6000" } })).offers.map((o) => o.country), ["NO"]); // EEA
  await setPolicy({ locality: "eu" });
  assert.equal((await (await d.as(d.emails.member)).call("quote", { params: p, body: { gpuType: "A6000" } })).reason, "policy"); // NO isn't EU
  await setPolicy({ allowedProviders: ["runpod", "hyperstack"], locality: "europe" });
  await setPolicy({ locality: "ca" });
  assert.deepEqual(await providers(), ["hyperstack"]);
  await setPolicy({ locality: "any", allowedCountries: ["CA"] });
  assert.deepEqual(await providers(), ["hyperstack"]);
  await setPolicy({ allowedCountries: ["GB"] });
  assert.equal((await quote()).reason, "policy");
});

test("org roles: a viewer can read but not create; an owner without a membership owns the projects", async () => {
  const d = setup();
  const viewer = d.backend.addUser("viewer@example.org");
  d.backend.setOrgRole(d.orgId, viewer.id, "viewer");
  const boss = d.backend.addUser("boss@example.org");
  d.backend.setOrgRole(d.orgId, boss.id, "owner");
  const v = await d.as("viewer@example.org");
  assert.equal((await v.call("getOrg", { params: { orgId: d.orgId } })).id, d.orgId);
  assert.equal((await v.call("listProjects", { params: { orgId: d.orgId } })).items.length, 1);
  const body = { name: "x", startsAt: "2027-02-01T00:00:00.000Z", endsAt: "2027-03-01T00:00:00.000Z", budget: 1 };
  await rejects(v.call("createProject", { params: { orgId: d.orgId }, body }), "forbidden");
  await rejects(v.call("getProject", { params: { projectId: d.projectId } }), "notFound"); // org viewers aren't project members
  const o = await d.as("boss@example.org");
  assert.equal((await o.call("getProject", { params: { projectId: d.projectId } })).id, d.projectId);
  await o.call("listMachines", { params: { projectId: d.projectId }, query: { all: "1" } });
});

test("only owners make or unmake managers", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  const { items } = await manager.call("listMembers", { params: p });
  const ta = items.find((m) => m.email === d.emails.assistant);
  const mgr = items.find((m) => m.email === d.emails.manager);
  assert.ok(ta && mgr);
  await rejects(manager.call("updateMember", { params: { ...p, memberId: ta.id }, body: { role: "manager" } }), "forbidden");
  await rejects(manager.call("updateMember", { params: { ...p, memberId: mgr.id }, body: { role: "member" } }), "forbidden");
  assert.equal((await manager.call("updateMember", { params: { ...p, memberId: ta.id }, body: { role: "member" } })).role, "member");
  const owner = await d.as(d.emails.owner);
  assert.equal((await owner.call("updateMember", { params: { ...p, memberId: ta.id }, body: { role: "manager" } })).role, "manager");
});

test("project totals count only the project's own allocations and spend", async () => {
  const d = setup();
  const other = d.backend.addProject(d.orgId, { name: "Other", budget: 1_000_000, startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-12-01T00:00:00.000Z" });
  d.backend.addMember(other.id, { email: "z@example.org", allocation: 999_000 });
  const manager = await d.as(d.emails.manager);
  assert.equal((await manager.call("getProject", { params: { projectId: d.projectId } })).allocated, 4 * 25_000_000 + 200_000 + 2 * 50_000_000);
});

test("a team with running machines can't be deleted", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const alan = await d.as(d.emails.teamMember);
  const m = await alan.call("startMachine", { params: p, body: { gpuType: "L4", chargeTo: "team" } });
  const manager = await d.as(d.emails.manager);
  const team = (await manager.call("listTeams", { params: p })).teams.find((t) => t.allocationId === m.allocationId);
  assert.ok(team);
  await rejects(manager.call("deleteTeam", { params: { ...p, teamId: team.id } }), "invalidState");
  await rejects(manager.call("createTeam", { params: p, body: { name: "y", allocation: -5 } }), "badRequest");
});

test("allocations may not add up to more than the project budget", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  // The seed allocates $200.20 of a $2,000 budget.
  const { items } = await manager.call("listMembers", { params: p });
  const ada = items.find((m) => m.email === d.emails.member);
  assert.ok(ada);
  const max = 2_000_000_000 - 200_200_000 + 25_000_000; // Ada's own $25 is replaced
  assert.equal((await manager.call("setMemberAllocation", { params: { ...p, memberId: ada.id }, body: { amount: max } })).amount, max);
  await rejects(manager.call("setMemberAllocation", { params: { ...p, memberId: ada.id }, body: { amount: max + 1 } }), "conflict", 409);
  await rejects(manager.call("inviteMembers", { params: p, body: { members: [{ email: "x@example.org", allocation: 1 }] } }), "conflict");
  await rejects(manager.call("createTeam", { params: p, body: { name: "t", allocation: 1 } }), "conflict");
  assert.equal((await manager.call("inviteMembers", { params: p, body: { members: [{ email: "x@example.org" }] } })).members.length, 1);
  await manager.call("setMemberAllocation", { params: { ...p, memberId: ada.id }, body: { amount: 0 } });
  await manager.call("createTeam", { params: p, body: { name: "t", allocation: max } });
  // Another project's allocations don't count against this one.
  const other = d.backend.addProject(d.orgId, { name: "Other", budget: 1_000_000_000, startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-12-01T00:00:00.000Z" });
  d.backend.addMember(other.id, { email: "z@example.org", allocation: 900_000_000 });
  await manager.call("setMemberAllocation", { params: { ...p, memberId: ada.id }, body: { amount: 0 } });
});

test("membership rules: managers manage members and assistants; owners manage everyone; one owner stays", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  const { items } = await manager.call("listMembers", { params: p });
  const byEmail = (e: string) => items.find((m) => m.email === e)!;
  const owner = byEmail(d.emails.owner);
  const mgr = byEmail(d.emails.manager);
  const ta = byEmail(d.emails.assistant);
  await rejects(manager.call("removeMember", { params: { ...p, memberId: owner.id } }), "forbidden");
  await rejects(manager.call("updateMember", { params: { ...p, memberId: mgr.id }, body: { name: "x" } }), "forbidden");
  await rejects(manager.call("inviteMembers", { params: p, body: { members: [{ email: "o@example.org", role: "owner" }] } }), "forbidden");
  assert.equal((await manager.call("updateMember", { params: { ...p, memberId: ta.id }, body: { role: "member" } })).role, "member");
  assert.deepEqual(await manager.call("removeMember", { params: { ...p, memberId: ta.id } }), { ok: true });
  await rejects(manager.call("removeMember", { params: { ...p, memberId: ta.id } }), "notFound");
  await rejects(manager.call("updateMember", { params: { ...p, memberId: ta.id }, body: { name: "y" } }), "notFound");
  const o = await d.as(d.emails.owner);
  await rejects(o.call("updateMember", { params: { ...p, memberId: owner.id }, body: { role: "manager" } }), "conflict", 409);
  await rejects(o.call("removeMember", { params: { ...p, memberId: owner.id } }), "conflict");
  await rejects(o.call("updateMember", { params: { ...p, memberId: mgr.id }, body: { role: "boss" as "owner" } }), "badRequest");
  assert.equal((await o.call("updateMember", { params: { ...p, memberId: mgr.id }, body: { role: "owner" } })).role, "owner");
  // Two owners now: one may step down.
  assert.equal((await o.call("updateMember", { params: { ...p, memberId: owner.id }, body: { role: "manager" } })).role, "manager");
});

test("a removed owner no longer counts as an owner", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const o = await d.as(d.emails.owner);
  const { items } = await o.call("listMembers", { params: p });
  const owner = items.find((m) => m.email === d.emails.owner)!;
  const mgr = items.find((m) => m.email === d.emails.manager)!;
  await o.call("updateMember", { params: { ...p, memberId: mgr.id }, body: { role: "owner" } });
  await o.call("removeMember", { params: { ...p, memberId: mgr.id } });
  await rejects(o.call("updateMember", { params: { ...p, memberId: owner.id }, body: { role: "manager" } }), "conflict");
});

test("the start requirement counts the allocation's running machines and unbilled seconds", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const ada = await d.as(d.emails.member);
  d.backend.advance(30_000);
  // 15 min + 60 s + 60 s + 10 min + 30 s unbilled = 27.5 min: 28 ledger minutes at 10,400.
  assert.equal((await ada.call("quote", { params: p, body: { gpuType: "L4" } })).requiredToStart, 291_200);
  d.backend.advance(30_000);
  const alan = await d.as(d.emails.teamMember);
  await alan.call("startMachine", { params: p, body: { gpuType: "L4", chargeTo: "team" } });
  const edsger = await d.as("edsger@example.org");
  // Alan's machine on the same team allocation doubles it: 27 minutes for 2 machines.
  assert.equal((await edsger.call("quote", { params: p, body: { gpuType: "L4", chargeTo: "team" } })).requiredToStart, 561_600);
  assert.equal((await edsger.call("quote", { params: p, body: { gpuType: "L4" } })).requiredToStart, 280_800);
});

test("each start of a machine is a new incarnation", async () => {
  const d = setup();
  const c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  assert.equal(m.incarnation, 1);
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(MIN);
  assert.equal((await c.call("restartMachine", { params: { machineId: m.id }, body: {} })).incarnation, 2);
});
