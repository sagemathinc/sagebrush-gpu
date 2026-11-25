import { test } from "node:test";
import assert from "node:assert/strict";
import type { Machine, Member, SpendMeter, Team } from "@sbgpu/api";
import { MAX_TEAM_NAME_LENGTH, bulkPlan, checkTeamName, csvFilename, filterRows, invitePreview, memberRows, sortRows, teamRows, type MemberRow } from "./manage.ts";

function member(id: string, email: string, over: Partial<Member> = {}): Member {
  return {
    id,
    projectId: "prj_1",
    userId: null,
    email,
    name: null,
    role: "member",
    status: "active",
    teamId: null,
    allocationId: `alc_${id}`,
    createdAt: "2027-02-01T00:00:00.000Z",
    ...over,
  };
}

function meter(allocationId: string, amount: number, spent: number, reserved = 0, usedBytes = 0): SpendMeter {
  return {
    allocationId,
    holder: { kind: "member", memberId: allocationId.slice(4) },
    amount,
    spent: { providerCost: spent, margin: 0, total: spent },
    reserved,
    remaining: Math.max(0, amount - spent - reserved),
    currentRatePerHour: { providerCost: 0, margin: 0, total: 0 },
    storage: { usedBytes, quotaBytes: 1 },
    asOf: "2027-02-01T00:00:00.000Z",
  };
}

const machine = (memberId: string, state: Machine["state"]) => ({ memberId, state }) as Machine;

const MEMBERS = [
  member("a", "ada@example.org", { name: "Ada", teamId: "team_q" }),
  member("b", "bob@example.org", { name: "Bob" }),
  member("c", "cy@example.org", { status: "invited" }),
  member("d", "dee@example.org", { status: "removed" }),
  member("e", "eve@example.org", { name: "Eve", role: "assistant", teamId: "team_q" }),
];
const METERS = [meter("alc_a", 25_000_000, 5_000_000, 100_000, 2048), meter("alc_b", 10_000_000, 9_700_000), meter("alc_c", 0, 0), meter("alc_e", 1_000_000, 0)];
const TEAMS = [{ id: "team_q", name: "Team Qwen" } as Team];
const MACHINES = [machine("a", "running"), machine("a", "stopped"), machine("b", "starting"), machine("b", "saving"), machine("e", "deleted")];

const rows = () => memberRows(MEMBERS, METERS, MACHINES, TEAMS);

test("memberRows joins meters, teams and running machines; removed members are left out", () => {
  const r = rows();
  assert.deepEqual(r.map((x) => x.email), ["ada@example.org", "bob@example.org", "cy@example.org", "eve@example.org"]);
  const ada = r[0]!;
  assert.deepEqual(
    { team: ada.team, allocation: ada.allocation, spent: ada.spent, remaining: ada.remaining, band: ada.band, running: ada.running, storage: ada.storageBytes },
    { team: "Team Qwen", allocation: 25_000_000, spent: 5_000_000, remaining: 19_900_000, band: "ok", running: 1, storage: 2048 },
  );
  assert.equal(r[1]!.running, 2); // starting and saving both accrue
  assert.equal(r[1]!.band, "critical"); // 0.3 of 10 left
  assert.equal(r[2]!.band, "empty");
  assert.equal(r[2]!.team, null);
  assert.equal(r[3]!.running, 0);
  // A member without a meter (not loaded yet) shows zeros.
  const lone = memberRows([member("z", "z@example.org", { teamId: "team_gone" })], [], [], []);
  assert.deepEqual([lone[0]!.allocation, lone[0]!.spent, lone[0]!.storageBytes, lone[0]!.team], [0, 0, 0, null]);
});

test("filterRows: every word must match email, name, team, role or status", () => {
  const r = rows();
  assert.equal(filterRows(r, "").length, 4);
  assert.equal(filterRows(r, "   ").length, 4);
  assert.deepEqual(filterRows(r, "qwen").map((x) => x.email), ["ada@example.org", "eve@example.org"]);
  assert.deepEqual(filterRows(r, "QWEN assistant").map((x) => x.email), ["eve@example.org"]);
  assert.deepEqual(filterRows(r, "invited").map((x) => x.email), ["cy@example.org"]);
  assert.deepEqual(filterRows(r, "bob").map((x) => x.email), ["bob@example.org"]);
  assert.deepEqual(filterRows(r, "nobody"), []);
});

test("sortRows: by number or text, either way; missing names and teams last; ties by email", () => {
  const r = rows();
  const emails = (x: MemberRow[]) => x.map((y) => y.email[0]).join("");
  assert.equal(emails(sortRows(r, "allocation")), "ceba");
  assert.equal(emails(sortRows(r, "allocation", true)), "abec");
  assert.equal(emails(sortRows(r, "spent")), "ceab"); // c and e tie at 0: by email
  assert.equal(emails(sortRows(r, "remaining")), "cbea");
  assert.equal(emails(sortRows(r, "running", true)), "bace");
  assert.equal(emails(sortRows(r, "name")), "abec");
  assert.equal(emails(sortRows(r, "name", true)), "ebac"); // cy has no name: still last
  assert.equal(emails(sortRows(r, "team")), "aebc"); // Team Qwen, then no team (by email)
  assert.equal(emails(sortRows(r, "team", true)), "aebc");
  assert.equal(emails(sortRows(r, "email", true)), "ecba");
  assert.equal(emails(r), "abce"); // the input is untouched
});

test("bulkPlan: set or add; unchanged members left out; the budget headroom after", () => {
  const r = rows();
  const project = { budget: 100_000_000, allocated: 36_000_000 };
  const set = bulkPlan(r, new Set(["a", "b", "c"]), "set", 10_000_000, project);
  assert.deepEqual(set.changes.map((c) => [c.memberId, c.from, c.to]), [
    ["a", 25_000_000, 10_000_000],
    ["c", 0, 10_000_000],
  ]);
  assert.equal(set.delta, -5_000_000);
  assert.equal(set.headroomAfter, 69_000_000);
  const add = bulkPlan(r, new Set(["b", "e", "nobody"]), "add", 70_000_000, project);
  assert.deepEqual(add.changes.map((c) => c.to), [80_000_000, 71_000_000]);
  assert.equal(add.delta, 140_000_000);
  assert.equal(add.headroomAfter, -76_000_000);
  assert.deepEqual(bulkPlan(r, new Set(["a"]), "add", 0, project).changes, []);
  assert.deepEqual(bulkPlan(r, new Set(), "set", 5, project), { changes: [], delta: 0, headroomAfter: 64_000_000 });
  assert.throws(() => bulkPlan(r, new Set(["a"]), "set", -1, project), RangeError);
  assert.throws(() => bulkPlan(r, new Set(["a"]), "set", 1.5, project), RangeError);
});

test("invitePreview separates new addresses from members, duplicates and junk", () => {
  const p = invitePreview("New@Example.org, ada@example.org\nnew@example.org; nope\nDee <dee@example.org>\nCY@example.org", MEMBERS);
  assert.deepEqual(p, {
    toInvite: ["new@example.org", "dee@example.org"], // dee was removed: invited afresh
    already: ["ada@example.org", "cy@example.org"],
    duplicates: ["new@example.org"],
    invalid: ["nope"],
  });
  assert.deepEqual(invitePreview("", MEMBERS), { toInvite: [], already: [], duplicates: [], invalid: [] });
});

test("csvFilename", () => {
  assert.equal(csvFilename("Fine-tuning lab", "member", "2027-02-01T09:30:00.000Z"), "fine-tuning-lab-spend-by-member-2027-02-01.csv");
  assert.equal(csvFilename("  ../../Évil<>name  ", "day", "2027-03-04"), "vil-name-spend-by-day-2027-03-04.csv");
  assert.equal(csvFilename("***", "team", "2027-03-04"), "project-spend-by-team-2027-03-04.csv");
  assert.equal(csvFilename("x".repeat(100), "day", "2027-03-04").length, 60 + "-spend-by-day-2027-03-04.csv".length);
});

function team(id: string, name: string, memberCount = 0): Team {
  return { id, projectId: "prj_1", name, memberCount, allocationId: `alc_${id}`, createdAt: "2027-02-01T00:00:00.000Z" };
}

test("teamRows: by name, each with its own meter; a team without one shows zeros", () => {
  const onTeam = (allocationId: string, state: Machine["state"]) => ({ allocationId, state }) as Machine;
  const machines = [onTeam("alc_t2", "running"), onTeam("alc_t2", "saving"), onTeam("alc_t2", "stopped"), onTeam("alc_t1", "starting"), onTeam("alc_a", "running")];
  const rows = teamRows([team("t2", "beta", 3), team("t1", "Alpha", 2), team("t3", "gamma")], [meter("alc_t2", 50_000_000, 20_000_000, 5_000_000), meter("alc_t1", 10_000_000, 9_000_000)], machines);
  assert.deepEqual(rows.map((r) => r.running), [1, 2, 0]); // stopped ones and other allocations don't count
  assert.deepEqual(rows.map((r) => r.name), ["Alpha", "beta", "gamma"]); // code-point order, as the server sorts
  assert.deepEqual(rows[1], { teamId: "t2", name: "beta", memberCount: 3, allocation: 50_000_000, spent: 20_000_000, remaining: 25_000_000, band: rows[1]!.band, running: 2 });
  assert.deepEqual([rows[0]!.allocation, rows[0]!.spent, rows[0]!.remaining], [10_000_000, 9_000_000, 1_000_000]);
  assert.notEqual(rows[0]!.band, rows[1]!.band); // 10% left is flagged, 50% isn't
  assert.deepEqual([rows[2]!.allocation, rows[2]!.spent, rows[2]!.remaining, rows[2]!.memberCount], [0, 0, 0, 0]);
  assert.deepEqual(teamRows([], [], machines), []);
});

test("checkTeamName: trimmed, 1 to 100 characters, not another team's name", () => {
  const teams = [team("t1", "Alpha"), team("t2", "Beta")];
  assert.deepEqual(checkTeamName("  Gamma ", teams), { ok: true, name: "Gamma" });
  assert.deepEqual(checkTeamName("   ", teams), { ok: false, reason: "A name has 1 to 100 characters." });
  assert.deepEqual(checkTeamName("x".repeat(MAX_TEAM_NAME_LENGTH + 1), teams), { ok: false, reason: "A name has 1 to 100 characters." });
  assert.deepEqual(checkTeamName("x".repeat(MAX_TEAM_NAME_LENGTH), teams), { ok: true, name: "x".repeat(100) });
  assert.deepEqual(checkTeamName(" Beta", teams), { ok: false, reason: "There's already one called Beta." });
  assert.deepEqual(checkTeamName("beta", teams), { ok: true, name: "beta" }); // the server compares exactly
  // Renaming a team to its own name is fine; to another's isn't.
  assert.deepEqual(checkTeamName("Beta", teams, "t2"), { ok: true, name: "Beta" });
  assert.deepEqual(checkTeamName("Alpha", teams, "t2"), { ok: false, reason: "There's already one called Alpha." });
});
