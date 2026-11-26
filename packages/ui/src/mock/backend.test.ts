import { test } from "node:test";
import assert from "node:assert/strict";
import { isId, isPriceSplit, addSplits, type Machine } from "@sbgpu/api";
import { ApiError, createClient, type Client } from "../client.ts";
import { mockFetch } from "./fetch.ts";
import { demoOffers, seedDemo, type Demo } from "./seed.ts";
import { MAX_TEAMS_PER_PROJECT, MEMBERS_PAGE, MockBackend, PAGE_SIZE, SAVE_BYTES } from "./backend.ts";

const MIN = 60_000;

function setup(): Demo & { as: (email: string) => Promise<Client> } {
  const demo = seedDemo();
  const client = createClient({ fetch: mockFetch(demo.backend) });
  return {
    ...demo,
    // The mock keeps one session; signing in switches it.
    as: async (email: string) => {
      assert.ok(demo.backend.signInAs(email), email);
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

test("sign-in: unauthenticated until signed in; an account with no invitation is refused", async () => {
  const d = setup();
  const c = createClient({ fetch: mockFetch(d.backend) });
  await rejects(c.call("getMe"), "unauthenticated", 401);
  assert.equal(d.backend.signInAs("stranger@example.org"), false);
  await rejects(c.call("getMe"), "unauthenticated", 401);
  assert.equal([...d.backend.users.values()].some((u) => u.email === "stranger@example.org"), false);
  assert.equal(d.backend.signInAs(` ${d.emails.member.toUpperCase()} `), true);
  const me = await c.call("getMe");
  assert.equal(me.user.email, d.emails.member);
  assert.deepEqual(me.projects.map((p) => [p.projectId, p.role]), [[d.projectId, "member"]]);
  // A refusal leaves the current session as it was.
  assert.equal(d.backend.signInAs("stranger@example.org"), false);
  assert.equal((await c.call("getMe")).user.email, d.emails.member);
  await c.call("signOut", { body: {} });
  await rejects(c.call("getMe"), "unauthenticated");
});

test("sign-in: an invited address is admitted, becomes a user, and its invitations turn active", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  await manager.call("inviteMembers", { params: p, body: { members: [{ email: "new@example.org" }] } });
  await manager.call("signOut", { body: {} });
  const users = d.backend.users.size;
  assert.equal(d.backend.signInAs("New@Example.org"), true);
  assert.equal(d.backend.users.size, users + 1);
  const c = createClient({ fetch: mockFetch(d.backend) });
  const me = await c.call("getMe");
  assert.equal(me.user.email, "new@example.org");
  assert.deepEqual(me.projects.map((x) => x.role), ["member"]);
  const member = [...d.backend.members.values()].find((m) => m.email === "new@example.org");
  assert.deepEqual([member?.status, member?.userId], ["active", me.user.id]);
  // Signing in again reuses the user.
  assert.equal(d.backend.signInAs("new@example.org"), true);
  assert.equal(d.backend.users.size, users + 1);
  // Someone removed from a project is still a user here, and signing in doesn't bring them back.
  const ada = [...d.backend.members.values()].find((m) => m.email === d.emails.member)!;
  await (await d.as(d.emails.manager)).call("removeMember", { params: { projectId: d.projectId, memberId: ada.id } });
  assert.equal(d.backend.signInAs(d.emails.member), true);
  assert.equal(ada.status, "removed");
  assert.deepEqual((await c.call("getMe")).projects, []);
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
  const { items, paused } = await c.call("listGpuTypes", { params: { projectId: d.projectId } });
  assert.deepEqual(paused, []); // the mock pauses no provider
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

test("updateProject checks every field as the control plane does, and changes only what is sent", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  const before = await manager.call("getProject", { params: p });
  const bad = async (body: object, message: RegExp) => {
    await assert.rejects(manager.call("updateProject", { params: p, body }), (err: unknown) => {
      assert.ok(err instanceof ApiError, String(err));
      assert.equal(err.code, "badRequest");
      assert.match(err.message, message);
      return true;
    });
  };
  await bad({ name: "   " }, /1 to 200 characters/);
  await bad({ name: "x".repeat(201) }, /1 to 200 characters/);
  await bad({ name: 7 }, /a project name is a string/);
  await bad({ endsAt: before.startsAt }, /endsAt must be after startsAt/);
  await bad({ startsAt: "2030-01-01T00:00:00.000Z" }, /endsAt must be after startsAt/);
  // A date that parses but isn't an ISO time is refused as such, whatever the order.
  await bad({ endsAt: "2030-01-01" }, /endsAt must be an ISO time/);
  await bad({ startsAt: "2020-01-01" }, /startsAt must be an ISO time/);
  await bad({ policy: { idleStopMinutes: 4 } }, /idleStopMinutes must be a whole number from 5 to 1440/);
  await bad({ policy: { colour: "red" } }, /unknown policy field: colour/);
  await bad({ policy: { allowedProviders: ["runpod", "runpod"] } }, /allowedProviders/);
  await bad({ labels: { project: "course" } }, /labels has exactly/);
  await bad({ labels: { project: " course", member: "student", manager: "instructor", assistant: "TA", team: "team" } }, /labels.project/);
  // Nothing was changed by the refusals.
  assert.deepEqual(await manager.call("getProject", { params: p }), before);

  const after = await manager.call("updateProject", { params: p, body: { name: "  Spring lab ", policy: { idleStopMinutes: 45 }, labels: null } });
  assert.equal(after.name, "Spring lab");
  assert.equal(after.labels, null);
  assert.deepEqual(after.policy, { ...before.policy, idleStopMinutes: 45 });
  assert.deepEqual([after.startsAt, after.endsAt], [before.startsAt, before.endsAt]);
  assert.equal((await manager.call("updateProject", { params: p, body: { name: "x".repeat(200) } })).name.length, 200);
  // Members can't change settings.
  const member = await d.as(d.emails.member);
  await rejects(member.call("updateProject", { params: p, body: { name: "Mine" } }), "forbidden", 403);
});

test("idle and max-session stops save first and say why", async () => {
  const d = setup();
  const manager = await d.as(d.emails.manager);
  await manager.call("updateProject", { params: { projectId: d.projectId }, body: { policy: { maxSessionMinutes: 15 } } });
  const c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  d.backend.advance(90_000 + 15 * MIN - 1000);
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

  d.backend.addUser("someone@else.example"); // a user here, in none of this org's projects
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
  assert.deepEqual([llama.memberCount, qwen.memberCount], [2, 1]);
  const inTeam = async (teamId: string) => (await manager.call("listMembers", { params: p, query: { teamId } })).items.map((m) => m.email);
  assert.deepEqual(await inTeam(qwen.id), ["ada@example.org"]);
  const adaId = (await manager.call("listMembers", { params: p, query: { teamId: qwen.id } })).items[0]!.id;
  await manager.call("updateMember", { params: { ...p, memberId: adaId }, body: { teamId: llama.id } });
  const after = (await manager.call("listTeams", { params: p })).teams;
  assert.equal(after.find((t) => t.id === qwen.id)?.memberCount, 0);
  assert.equal(after.find((t) => t.id === llama.id)?.memberCount, 3);
  assert.deepEqual(await inTeam(qwen.id), []);
  assert.ok((await inTeam(llama.id)).includes("ada@example.org"));
  await manager.call("updateMember", { params: { ...p, memberId: adaId }, body: { teamId: null } });
  assert.equal((await manager.call("listTeams", { params: p })).teams.find((t) => t.id === llama.id)?.memberCount, 2);
  assert.ok(!(await inTeam(llama.id)).includes("ada@example.org"));
  // A team must be a live team of this project, given as an id or null, as the control plane checks.
  await rejects(manager.call("updateMember", { params: { ...p, memberId: adaId }, body: { teamId: "team_nope" } }), "badRequest", 400);
  await rejects(manager.call("updateMember", { params: { ...p, memberId: adaId }, body: { teamId: 5 as unknown as string } }), "badRequest", 400);
  const elsewhere = d.backend.addProject(d.orgId, { name: "Elsewhere", budget: 0, startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-06-01T00:00:00.000Z" });
  const foreign = d.backend.addTeam(elsewhere.id, "Foreign", [], 0);
  await rejects(manager.call("updateMember", { params: { ...p, memberId: adaId }, body: { teamId: foreign.id } }), "badRequest", 400);
  await manager.call("deleteTeam", { params: { ...p, teamId: qwen.id } });
  await rejects(manager.call("updateMember", { params: { ...p, memberId: adaId }, body: { teamId: qwen.id } }), "badRequest", 400);
  assert.equal((await manager.call("listMembers", { params: p })).items.find((m) => m.id === adaId)?.teamId, null);
  // The role rules come before the team: a manager can't move the owner, whatever the team.
  const ownerId = (await manager.call("listMembers", { params: p })).items.find((m) => m.role === "owner")!.id;
  await rejects(manager.call("updateMember", { params: { ...p, memberId: ownerId }, body: { teamId: "team_nope" } }), "forbidden", 403);
  await rejects(manager.call("updateMember", { params: { ...p, memberId: ownerId }, body: { teamId: llama.id } }), "forbidden", 403);
  // ...but a malformed request is refused as such first, as the control plane parses before the role rules.
  await rejects(manager.call("updateMember", { params: { ...p, memberId: ownerId }, body: { teamId: 5 as unknown as string } }), "badRequest", 400);
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
  await rejects(c.call("getOrphanReport", {}), "forbidden");
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

test("deleting a team, as the control plane does: members leave, the allocation returns, its machines stop", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const alan = await d.as(d.emails.teamMember);
  const m = await alan.call("startMachine", { params: p, body: { gpuType: "L4", chargeTo: "team" } });
  d.backend.advance(90_000);
  const manager = await d.as(d.emails.manager);
  const team = (await manager.call("listTeams", { params: p })).teams.find((t) => t.allocationId === m.allocationId)!;
  assert.ok(team.memberCount > 0);
  const allocatedBefore = (await manager.call("getProject", { params: p })).allocated;
  assert.deepEqual(await manager.call("deleteTeam", { params: { ...p, teamId: team.id } }), { ok: true });
  assert.equal((await manager.call("listTeams", { params: p })).teams.some((t) => t.id === team.id), false);
  assert.equal((await manager.call("getProject", { params: p })).allocated, allocatedBefore - 50_000_000);
  const { items } = await manager.call("listMembers", { params: p });
  assert.equal(items.some((x) => x.teamId === team.id), false);
  // With nothing left on its allocation, the budget rules stop the machine, saving first.
  d.backend.advance(60_000);
  const after = await manager.call("getMachine", { params: { machineId: m.id } });
  assert.notEqual(after.state, "running");
  await rejects(manager.call("deleteTeam", { params: { ...p, teamId: team.id } }), "notFound");
  await rejects(manager.call("createTeam", { params: p, body: { name: "y", allocation: -5 } }), "badRequest");
});

test("team names as the control plane checks them: trimmed, 1-100 characters, unique; at most 200 teams; listed by name", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  const bad = async (body: object, code: string, message: RegExp, teamId?: string) => {
    const call = teamId === undefined ? manager.call("createTeam", { params: p, body: body as { name: string } }) : manager.call("updateTeam", { params: { ...p, teamId }, body });
    await assert.rejects(call, (err: unknown) => {
      assert.ok(err instanceof ApiError, String(err));
      assert.equal(err.code, code);
      assert.match(err.message, message);
      return true;
    });
  };
  await bad({ name: "   " }, "badRequest", /1 to 100 characters/);
  await bad({ name: "x".repeat(101) }, "badRequest", /1 to 100 characters/);
  await bad({ name: 5 }, "badRequest", /a team name is a string/);
  const zeta = await manager.call("createTeam", { params: p, body: { name: "  Zeta ", allocation: 0 } });
  assert.equal(zeta.name, "Zeta");
  await bad({ name: "Zeta" }, "conflict", /a team with that name exists/);
  // In any letter case, as the control plane's index on lower(name) holds it (A-Z folded only).
  await bad({ name: "zETA" }, "conflict", /a team with that name exists/);
  const eq = await manager.call("createTeam", { params: p, body: { name: "équipe" } });
  assert.equal((await manager.call("createTeam", { params: p, body: { name: "ÉQUIPE" } })).name, "ÉQUIPE");
  await bad({ name: "éQUIPE" }, "conflict", /a team with that name exists/);
  await manager.call("deleteTeam", { params: { ...p, teamId: eq.id } });
  // Names are unique within a project only.
  const other = d.backend.addProject(d.orgId, { name: "Other", budget: 0, startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-06-01T00:00:00.000Z" });
  const owner = await d.as(d.emails.owner);
  assert.equal((await owner.call("createTeam", { params: { projectId: other.id }, body: { name: "zeta" } })).name, "zeta");
  await d.as(d.emails.manager);
  const alpha = await manager.call("createTeam", { params: p, body: { name: "x".repeat(100) } });
  assert.equal(alpha.name.length, 100);
  await bad({ name: " Zeta" }, "conflict", /a team with that name exists/, alpha.id);
  await bad({ name: "ZETA" }, "conflict", /a team with that name exists/, alpha.id);
  // Renaming a team to its own name, or another case of it, is fine; a refused rename changes nothing.
  assert.equal((await manager.call("updateTeam", { params: { ...p, teamId: zeta.id }, body: { name: "Zeta" } })).name, "Zeta");
  assert.equal((await manager.call("updateTeam", { params: { ...p, teamId: zeta.id }, body: { name: "ZETA" } })).name, "ZETA");
  assert.equal((await manager.call("updateTeam", { params: { ...p, teamId: zeta.id }, body: { name: "Zeta" } })).name, "Zeta");
  assert.equal([...d.backend.teams.values()].find((t) => t.id === alpha.id)?.name, "x".repeat(100));
  assert.equal((await manager.call("updateTeam", { params: { ...p, teamId: zeta.id }, body: { name: " Alpha " } })).name, "Alpha");
  const names = (await manager.call("listTeams", { params: p })).teams.map((t) => t.name);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes("Alpha") && names.indexOf("Alpha") < names.indexOf("x".repeat(100)));
  // The cap: fill the project up to 200 teams, then one more is refused.
  const count = () => [...d.backend.teams.values()].filter((t) => t.projectId === d.projectId).length;
  while (count() < MAX_TEAMS_PER_PROJECT) d.backend.addTeam(d.projectId, `t${count()}`, [], 0);
  await bad({ name: "one too many" }, "conflict", /at most 200 teams/);
  await manager.call("deleteTeam", { params: { ...p, teamId: zeta.id } });
  assert.equal((await manager.call("createTeam", { params: p, body: { name: "fits again" } })).name, "fits again");
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
  // As the control plane answers: a removed member is a state, not a missing one.
  await rejects(manager.call("removeMember", { params: { ...p, memberId: ta.id } }), "invalidState", 409);
  await rejects(manager.call("updateMember", { params: { ...p, memberId: ta.id }, body: { name: "y" } }), "invalidState", 409);
  await rejects(manager.call("updateMember", { params: { ...p, memberId: ta.id }, body: { teamId: null } }), "invalidState", 409);
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

/** Stop and start one machine three times inside 09:00, 16 s each time. */
async function sameMinuteRestarts(d: ReturnType<typeof setup>, providerCost: number, marginBps: number) {
  d.backend.orgs.get(d.orgId)!.marginBps = marginBps;
  d.backend.offers = d.backend.offers.map((o) => (o.gpuType === "L4" && o.provider === "runpod" ? { ...o, providerCostPerHour: providerCost } : o));
  const c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  for (let i = 0; i < 3; i++) {
    if (i > 0) await c.call("restartMachine", { params: { machineId: m.id }, body: {} });
    d.backend.advance(1000);
    await c.call("stopMachine", { params: { machineId: m.id }, body: {} }); // while starting: no save
    d.backend.advance(15_000);
  }
  return { c, m };
}

function computeEntries(d: ReturnType<typeof setup>) {
  return d.backend.ledger.filter((e) => e.kind === "compute");
}

test("ledger: restarts within a minute share that minute's one entry, rounded once", async () => {
  const d = setup();
  const { c, m } = await sameMinuteRestarts(d, 120, 0);
  const entries = computeEntries(d);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.periodStart, "2027-02-01T09:00:00.000Z");
  assert.equal(entries[0]?.seconds, 48);
  // entrySplit(120, 48, 0): 1.6 micros, rounded once to 2 (three 16-second rows made 3).
  assert.deepEqual(entries[0]?.amount, { providerCost: 2, margin: 0, total: 2 });
  assert.deepEqual((await c.call("getMachine", { params: { machineId: m.id } })).spent, entries[0]?.amount);
  const meter = (await c.call("getSpend", { params: { projectId: d.projectId } })).meters.find((x) => x.allocationId === m.allocationId);
  assert.equal(meter?.spent.total, 2);
});

test("ledger: same-minute restart with a margin rounds the merged minute once", async () => {
  const d = setup();
  d.backend.orgs.get(d.orgId)!.marginBps = 3000;
  d.backend.offers = d.backend.offers.map((o) => (o.gpuType === "L4" && o.provider === "runpod" ? { ...o, providerCostPerHour: 120 } : o));
  const c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} }); // 0 s running, stops at 15 s
  d.backend.advance(15_000);
  await c.call("restartMachine", { params: { machineId: m.id }, body: {} });
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(15_000);
  const entries = computeEntries(d);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.seconds, 30);
  assert.deepEqual(entries[0]?.amount, { providerCost: 1, margin: 0, total: 1 }); // two 15-second rows made 2
});

/** Only one offer: L4 on runpod at `cost`, with the org's margin set to `marginBps`. */
function singleOffer(d: ReturnType<typeof setup>, cost: number, marginBps: number): void {
  d.backend.orgs.get(d.orgId)!.marginBps = marginBps;
  d.backend.offers = [{ ...demoOffers("2027-02-01T09:00:00.000Z")[0]!, providerCostPerHour: cost }];
}

async function setAllocation(d: ReturnType<typeof setup>, email: string, amount: number): Promise<void> {
  const manager = await d.as(d.emails.manager);
  const member = [...d.backend.members.values()].find((m) => m.email === email)!;
  await manager.call("setMemberAllocation", { params: { projectId: d.projectId, memberId: member.id }, body: { amount } });
}

test("pinned minute: a price drop can't overdraw near the budget (daybreak2's repro)", async () => {
  const d = setup();
  singleOffer(d, 6000, 0); // 100 micros a full minute
  let c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  d.backend.advance(1000);
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(15_000); // stopped at 09:00:16; the 16 s cost 27
  assert.equal(computeEntries(d)[0]?.amount.total, 27);
  await setAllocation(d, d.emails.member, 55);
  d.backend.offers = d.backend.offers.map((o) => ({ ...o, providerCostPerHour: 60 })); // 1 micro a minute
  c = await d.as(d.emails.member);
  // The rest of 09:00 is pinned at 6000: 100 for that minute + 27 more minutes at 1.
  const q = await c.call("quote", { params: { projectId: d.projectId }, body: { gpuType: "L4" } });
  assert.equal(q.canStart, true); // a new machine would have no pinned minute...
  await rejects(c.call("restartMachine", { params: { machineId: m.id }, body: {} }), "allocationTooLow"); // ...this one has
  d.backend.advance(10 * MIN);
  const spend = (await c.call("getSpend", { params: { projectId: d.projectId } })).meters.find((x) => x.allocationId === m.allocationId)!;
  assert.ok(spend.spent.total <= spend.amount, `overdrawn: ${spend.spent.total} > ${spend.amount}`);
});

test("pinned minute: after a price drop, a funded restart is charged the pinned minute, then the new rate", async () => {
  const d = setup();
  singleOffer(d, 6000, 0);
  let c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  d.backend.advance(1000);
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(15_000);
  await setAllocation(d, d.emails.member, 200);
  d.backend.offers = d.backend.offers.map((o) => ({ ...o, providerCostPerHour: 60 }));
  c = await d.as(d.emails.member);
  const again = await c.call("restartMachine", { params: { machineId: m.id }, body: {} });
  assert.equal(again.pricePerHour.providerCost, 60);
  d.backend.advance(44_000 + 2 * MIN);
  const [first, second, third] = computeEntries(d);
  assert.deepEqual([first?.periodStart, first?.seconds, first?.providerCostPerHour, first?.amount.total], ["2027-02-01T09:00:00.000Z", 60, 6000, 100]);
  assert.deepEqual([second?.providerCostPerHour, second?.amount.total, third?.amount.total], [60, 1, 1]);
  const spend = (await c.call("getSpend", { params: { projectId: d.projectId } })).meters.find((x) => x.allocationId === m.allocationId)!;
  assert.equal(spend.spent.total, 102);
  assert.ok(spend.spent.total + spend.reserved <= spend.amount);
});

test("pinned minute: after a price rise, the bound matches the pinned charge", async () => {
  const d = setup();
  singleOffer(d, 60, 0); // 1 micro a minute
  let c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  d.backend.advance(1000);
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(15_000);
  await setAllocation(d, d.emails.member, 10_000);
  d.backend.offers = d.backend.offers.map((o) => ({ ...o, providerCostPerHour: 6000 })); // 100 a minute
  c = await d.as(d.emails.member);
  // Restart at 09:00:16: window 16 + 900 + 60 + 60 + 600 s = 28 minutes; the first is
  // pinned at 1, the other 27 cost 100: 2701 (an unpinned bound would say 2800).
  const params = { projectId: d.projectId };
  assert.equal((await c.call("quote", { params, body: { gpuType: "L4" } })).requiredToStart, 2800); // a new machine: no pin
  await c.call("restartMachine", { params: { machineId: m.id }, body: {} });
  // While it runs in the pinned minute, the meter's reserve is pinned too: 11 minutes, the first at 1.
  const meter = (await c.call("getSpend", { params })).meters.find((x) => x.allocationId === m.allocationId)!;
  assert.equal(meter.reserved, 1 + 10 * 100);
  d.backend.advance(44_000 + MIN);
  const [first, second] = computeEntries(d);
  assert.deepEqual([first?.seconds, first?.providerCostPerHour, first?.amount.total], [60, 60, 1]);
  assert.deepEqual([second?.providerCostPerHour, second?.amount.total], [6000, 100]);
});

test("pinned minute: the restart's start requirement counts the pinned minute exactly", async () => {
  const d = setup();
  singleOffer(d, 60, 0);
  let c = await d.as(d.emails.member);
  const m = await startL4(c, d.projectId);
  d.backend.advance(1000);
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(15_000); // 16 s at 60/h: 0 micros so far
  d.backend.offers = d.backend.offers.map((o) => ({ ...o, providerCostPerHour: 6000 }));
  await setAllocation(d, d.emails.member, 2700); // one short of 1 + 27 * 100
  c = await d.as(d.emails.member);
  await rejects(c.call("restartMachine", { params: { machineId: m.id }, body: {} }), "allocationTooLow");
  await setAllocation(d, d.emails.member, 2701);
  c = await d.as(d.emails.member);
  assert.equal((await c.call("restartMachine", { params: { machineId: m.id }, body: {} })).state, "starting");
});

test("ledger: one entry per (machine, minute), and the seconds add up to the time accruing", async () => {
  const d = setup();
  const ada = await d.as(d.emails.member);
  const a = await startL4(ada, d.projectId);
  const alan = await d.as(d.emails.teamMember);
  const b = await startL4(alan, d.projectId);
  d.backend.advance(150_000);
  await alan.call("stopMachine", { params: { machineId: b.id }, body: {} }); // running: save 6 s, stop 15 s
  d.backend.advance(30_000);
  await alan.call("restartMachine", { params: { machineId: b.id }, body: {} });
  d.backend.advance(200_000);
  const keys = computeEntries(d).map((e) => `${e.machineId}|${e.periodStart}`);
  assert.equal(new Set(keys).size, keys.length);
  const secondsOf = (id: string) => computeEntries(d).filter((e) => e.machineId === id).reduce((s, e) => s + e.seconds, 0);
  // At 09:06:20 the ledger is billed to the 09:06:00 check.
  assert.equal(secondsOf(a.id), 360);
  // b: 150 s, then a 6 s save and a 15 s stop (stopped at 171 s); again from 180 s to 360 s.
  assert.equal(secondsOf(b.id), 171 + 180);
});

test("the clock: a start off the whole second is refused; off the minute, checks still run", async () => {
  assert.throws(() => new MockBackend({ startMs: Date.parse("2027-02-01T09:00:00.001Z") }), RangeError);
  assert.throws(() => new MockBackend({ startMs: Number.NaN }), RangeError);
  assert.throws(() => new MockBackend({ startMs: Date.parse("not a date") }), RangeError);
  assert.throws(() => new MockBackend({ startMs: 1e20 }), RangeError); // whole seconds, but past exact integers
  const b = new MockBackend({ startMs: Date.parse("2027-02-01T09:00:30.000Z") });
  const org = b.addOrg("O", 0, 1_000_000_000);
  const user = b.addUser("u@example.org");
  const project = b.addProject(org.id, {
    name: "P",
    budget: 100_000_000,
    startsAt: "2027-02-01T00:00:00.000Z",
    endsAt: "2027-02-01T09:02:00.000Z",
    policy: { allowedGpuTypes: ["L4"], allowedProviders: ["runpod"] },
  });
  b.addMember(project.id, { email: user.email, allocation: 10_000_000, userId: user.id });
  b.offers = demoOffers("2027-02-01T09:00:00.000Z");
  b.currentUserId = user.id;
  const c = createClient({ fetch: mockFetch(b) });
  const m = await startL4(c, project.id);
  b.advance(30_000); // the 09:01 check bills the first 30 s
  assert.deepEqual(computeEntries({ backend: b } as Demo & { as: never }).map((e) => [e.periodStart, e.seconds]), [["2027-02-01T09:00:00.000Z", 30]]);
  b.advance(60_000); // the 09:02 check: the project has ended
  const ended = await c.call("getMachine", { params: { machineId: m.id } });
  assert.equal(ended.stopReason, "projectEnded");
  assert.notEqual(ended.state, "running");
});

test("invites: a retry at the budget boundary and duplicates in a batch take budget once", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  const project = await manager.call("getProject", { params: p });
  const rest = project.budget - project.allocated;
  const first = await manager.call("inviteMembers", { params: p, body: { members: [{ email: "new@example.org", allocation: rest }] } });
  const again = await manager.call("inviteMembers", { params: p, body: { members: [{ email: "new@example.org", allocation: rest }] } });
  assert.equal(again.members[0]?.id, first.members[0]?.id);
  assert.equal((await manager.call("getProject", { params: p })).allocated, project.budget);
  await rejects(manager.call("inviteMembers", { params: p, body: { members: [{ email: "other@example.org", allocation: 1 }] } }), "conflict");

  const d2 = setup();
  const m2 = await d2.as(d2.emails.manager);
  const pr2 = await m2.call("getProject", { params: { projectId: d2.projectId } });
  const rest2 = pr2.budget - pr2.allocated;
  const batch = await m2.call("inviteMembers", {
    params: { projectId: d2.projectId },
    body: { members: [{ email: "dup@example.org", allocation: rest2 }, { email: "DUP@example.org", allocation: rest2 }] },
  });
  assert.equal(batch.members[0]?.id, batch.members[1]?.id);
  assert.equal((await m2.call("getProject", { params: { projectId: d2.projectId } })).allocated, pr2.budget);
});

test("ledger: a same-minute restart at a lower price keeps the minute's higher rate", async () => {
  const d = setup();
  d.backend.offers = d.backend.offers.map((o) => (o.gpuType === "L4" && o.provider === "runpod" ? { ...o, providerCostPerHour: 720_000 } : o));
  const c = await d.as(d.emails.member);
  const m = await c.call("startMachine", { params: { projectId: d.projectId }, body: { gpuType: "L4" } }); // hyperstack $0.55 is cheapest now
  d.backend.advance(5000);
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(15_000);
  d.backend.offers = d.backend.offers.map((o) => (o.gpuType === "L4" ? { ...o, providerCostPerHour: 360_000 } : o));
  await c.call("restartMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(40_000);
  const entries = computeEntries(d);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.providerCostPerHour, 550_000);
  assert.deepEqual(entries[0]?.amount, { providerCost: 9167, margin: 2750, total: 11_917 }); // entrySplit(550000, 60, 3000)
});

test("pinned minute: a teammate's quote counts a running machine's pinned minute", async () => {
  const d = setup();
  singleOffer(d, 60, 0);
  const params = { projectId: d.projectId };
  let alan = await d.as(d.emails.teamMember);
  const m = await alan.call("startMachine", { params, body: { gpuType: "L4", chargeTo: "team" } });
  d.backend.advance(1000);
  await alan.call("stopMachine", { params: { machineId: m.id }, body: {} });
  d.backend.advance(15_000);
  d.backend.offers = d.backend.offers.map((o) => ({ ...o, providerCostPerHour: 6000 }));
  alan = await d.as(d.emails.teamMember);
  await alan.call("restartMachine", { params: { machineId: m.id }, body: {} });
  const edsger = await d.as("edsger@example.org");
  // Two machines for 28 minutes at 100 = 5600, but Alan's rest of 09:00 is pinned at 1: 5501.
  assert.equal((await edsger.call("quote", { params, body: { gpuType: "L4", chargeTo: "team" } })).requiredToStart, 5501);
});

test("teams report a member count; their members page through listMembers?teamId=", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  const manager = await d.as(d.emails.manager);
  const team = await manager.call("createTeam", { params: p, body: { name: "Big" } });
  assert.equal(team.memberCount, 0);
  assert.equal("memberIds" in team, false); // never the list itself
  for (let i = 0; i < MEMBERS_PAGE + 5; i++) d.backend.addMember(d.projectId, { email: `p${i}@example.org` });
  const ids = [...d.backend.members.values()].filter((m) => m.email.startsWith("p")).map((m) => m.id);
  const updated = await manager.call("updateTeam", { params: { ...p, teamId: team.id }, body: { memberIds: ids } });
  assert.equal(updated.memberCount, MEMBERS_PAGE + 5);
  const first = await manager.call("listMembers", { params: p, query: { teamId: team.id } });
  assert.equal(first.items.length, MEMBERS_PAGE);
  assert.equal(first.next, String(MEMBERS_PAGE));
  const second = await manager.call("listMembers", { params: p, query: { teamId: team.id, cursor: first.next! } });
  assert.equal(second.items.length, 5);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.items, ...second.items].map((m) => m.id)).size, MEMBERS_PAGE + 5);
  // Removed members don't count and aren't listed.
  await manager.call("removeMember", { params: { ...p, memberId: ids[0]! } });
  assert.equal((await manager.call("listTeams", { params: p })).teams.find((t) => t.id === team.id)?.memberCount, MEMBERS_PAGE + 4);
  assert.equal((await manager.call("listMembers", { params: p, query: { teamId: team.id, cursor: String(MEMBERS_PAGE) } })).items.length, 4);
  assert.equal(MEMBERS_PAGE, 200); // the control plane's page size
  // Exactly one full page: no next.
  for (const id of ids.slice(1, 5)) await manager.call("removeMember", { params: { ...p, memberId: id } });
  const full = await manager.call("listMembers", { params: p, query: { teamId: team.id } });
  assert.deepEqual([full.items.length, full.next], [MEMBERS_PAGE, null]);
  // Replacing the list drops whoever isn't on it.
  const two = await manager.call("updateTeam", { params: { ...p, teamId: team.id }, body: { memberIds: ids.slice(10, 12) } });
  assert.equal(two.memberCount, 2);
  assert.deepEqual((await manager.call("listMembers", { params: p, query: { teamId: team.id } })).items.map((m) => m.id), ids.slice(10, 12));
  await manager.call("updateTeam", { params: { ...p, teamId: team.id }, body: { memberIds: ids.slice(5) } });
  await rejects(manager.call("listMembers", { params: p, query: { teamId: team.id, cursor: "-1" } }), "badRequest");
  await rejects(manager.call("listMembers", { params: p, query: { teamId: "team_zzzzzzzzzzzzzzzzzzzz" } }), "notFound");
  // Invites into a team count toward it; the team CSV counts the same way.
  await manager.call("inviteMembers", { params: p, body: { members: [{ email: "late@example.org", teamId: team.id }] } });
  assert.equal((await manager.call("listTeams", { params: p })).teams.find((t) => t.id === team.id)?.memberCount, MEMBERS_PAGE + 1); // 200 still active, plus one
  const ta = await d.as(d.emails.assistant);
  const csv = await ta.call("getSpendCsv", { params: p, query: { by: "team" } });
  assert.ok(csv.includes(`\r\nBig,${MEMBERS_PAGE + 1},`), csv.slice(0, 300));
});

test("every list pages: members, machines and the ledger, with an offset cursor", async () => {
  const d = setup();
  const p = { projectId: d.projectId };
  for (let i = 0; i < PAGE_SIZE; i++) d.backend.addMember(d.projectId, { email: `m${i}@example.org` });
  const manager = await d.as(d.emails.manager);
  const first = await manager.call("listMembers", { params: p });
  assert.deepEqual([first.items.length, first.next], [PAGE_SIZE, String(PAGE_SIZE)]);
  const rest = await manager.call("listMembers", { params: p, query: { cursor: first.next! } });
  assert.deepEqual([rest.items.length, rest.next], [8, null]); // 208 in all
  for (const bad of ["abc", "-1", "1.5", ""]) {
    await rejects(manager.call("listMembers", { params: p, query: { cursor: bad } }), "badRequest", 400);
  }
  // Machines and the ledger page the same way.
  const c = await d.as(d.emails.member);
  await startL4(c, d.projectId);
  d.backend.advance((PAGE_SIZE + 1) * MIN + 30_000); // 201 billed minutes
  const m2 = await d.as(d.emails.manager);
  const ledger = await m2.call("listLedger", { params: p });
  assert.deepEqual([ledger.items.length, ledger.next], [PAGE_SIZE, String(PAGE_SIZE)]);
  assert.equal((await m2.call("listLedger", { params: p, query: { cursor: ledger.next! } })).next, null);
  assert.deepEqual((await m2.call("listMachines", { params: p, query: { all: "1" } })).next, null);
  assert.deepEqual((await m2.call("listMachines", { params: p, query: { all: "1", cursor: "1" } })).items, []);
});

test("organizations: a byok one runs at margin 0; projects are listed a page at a time", async () => {
  const d = setup();
  assert.throws(() => d.backend.addOrg("Own keys", 3000, 0, "byok"), /margin 0/);
  const own = d.backend.addOrg("Own keys", 0, 1_000_000_000, "byok");
  assert.equal(own.billingMode, "byok");
  assert.equal(d.backend.addOrg("Resold", 2000, 0).billingMode, "resold");
  for (let i = 0; i < PAGE_SIZE + 1; i++) {
    d.backend.addProject(own.id, { name: `p${i}`, budget: 0, startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-06-01T00:00:00.000Z" });
  }
  const owner = [...d.backend.users.values()].find((u) => u.email === d.emails.owner)!;
  d.backend.setOrgRole(own.id, owner.id, "viewer");
  const c = await d.as(d.emails.owner);
  assert.equal((await c.call("getOrg", { params: { orgId: own.id } })).billingMode, "byok");
  const first = await c.call("listProjects", { params: { orgId: own.id } });
  assert.deepEqual([first.items.length, first.next], [PAGE_SIZE, String(PAGE_SIZE)]);
  const rest = await c.call("listProjects", { params: { orgId: own.id }, query: { cursor: String(PAGE_SIZE) } });
  assert.deepEqual([rest.items.map((p) => p.name), rest.next], [[`p${PAGE_SIZE}`], null]);
  // each project carries its organization's mode
  assert.deepEqual(new Set([...first.items, ...rest.items].map((p) => p.billingMode)), new Set(["byok"]));
  const resold = d.backend.addOrg("Resold 2", 2000, 0);
  assert.equal(d.backend.addProject(resold.id, { name: "r", budget: 0, startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-06-01T00:00:00.000Z" }).billingMode, "resold");
  // Someone with no role in the organization sees nothing of it.
  const ada = await d.as(d.emails.member);
  await rejects(ada.call("getOrg", { params: { orgId: own.id } }), "notFound", 404);
  await rejects(ada.call("listProjects", { params: { orgId: own.id } }), "notFound", 404);
});

test("moveProjectBudget, as the control plane moves it: an org owner only, both ways, to the exact bounds", async () => {
  const d = setup();
  const b = d.backend;
  const org = b.addOrg("Movers", 2000, 1_000);
  const project = b.addProject(org.id, { name: "P", budget: 400, startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-06-01T00:00:00.000Z" });
  const ownerUser = [...b.users.values()].find((u) => u.email === d.emails.owner)!;
  b.setOrgRole(org.id, ownerUser.id, "owner");
  const p = { projectId: project.id };
  const owner = await d.as(d.emails.owner);
  const move = (amount: unknown) => owner.call("moveProjectBudget", { params: p, body: { amount: amount as number } });
  const figures = () => [b.orgs.get(org.id)!.unassignedCredit, b.projects.get(project.id)!.budget];
  const refused = async (amount: unknown, code: string, message: RegExp) => {
    const before = figures();
    await assert.rejects(move(amount), (err: unknown) => {
      assert.ok(err instanceof ApiError, String(err));
      assert.equal(err.code, code);
      assert.match(err.message, message);
      return true;
    });
    assert.deepEqual(figures(), before, `${String(amount)} changed nothing`);
  };
  assert.deepEqual(figures(), [600, 400]);
  assert.equal((await move(300)).budget, 700);
  assert.deepEqual(figures(), [300, 700]);
  assert.equal((await move(-200)).budget, 500);
  assert.deepEqual(figures(), [500, 500]);
  // Returning so much that the organization's figure would pass the safe range is refused
  // on the organization's side, which is checked first (as the control plane's batch runs).
  await refused(-Number.MAX_SAFE_INTEGER, "conflict", /doesn't have that much unassigned credit/);
  // In: exactly what's unassigned, and not a micro-dollar more.
  await refused(501, "conflict", /doesn't have that much unassigned credit/);
  assert.equal((await move(500)).budget, 1000);
  assert.deepEqual(figures(), [0, 1000]);
  await refused(1, "conflict", /doesn't have that much unassigned credit/);
  // Back: not below zero...
  await refused(-1001, "conflict", /budget isn't that large/);
  assert.equal((await move(-1000)).budget, 0);
  await move(1000);
  // ...and not below what's allocated: exactly to it, and not a micro-dollar further.
  b.addMember(project.id, { email: "a@example.org", allocation: 450 });
  await refused(-551, "conflict", /below its allocations/);
  const after = await move(-550);
  assert.deepEqual([after.budget, after.allocated], [450, 450]);
  await refused(-1, "conflict", /below its allocations/);
  // A non-zero whole number of micro-dollars, or nothing at all.
  for (const bad of [0, 1.5, "5", null, Number.MAX_SAFE_INTEGER + 1, -0.5]) await refused(bad, "badRequest", /non-zero whole number/);
  // Only an owner of the organization: a project owner who isn't one, a manager, a viewer of the org.
  const po = b.addUser("po@example.org");
  b.addMember(project.id, { email: po.email, role: "owner", userId: po.id });
  b.setOrgRole(org.id, po.id, "viewer");
  const poClient = await d.as(po.email);
  await assert.rejects(poClient.call("moveProjectBudget", { params: p, body: { amount: 1 } }), (err: unknown) => err instanceof ApiError && err.code === "forbidden");
  const mgrUser = [...b.users.values()].find((u) => u.email === d.emails.manager)!;
  b.addMember(project.id, { email: mgrUser.email, role: "manager", userId: mgrUser.id });
  const mgr = await d.as(d.emails.manager);
  await assert.rejects(mgr.call("moveProjectBudget", { params: p, body: { amount: 1 } }), (err: unknown) => err instanceof ApiError && err.code === "forbidden");
  assert.deepEqual(figures(), [550, 450]);
});
