// The mock's workspace snapshots (contract r3.1): saves commit snapshots to the machine's member
// area, the caller acts only on their own area and their current team's, names are unique and
// capped, retention keeps the newest unnamed ones, every named one and the current one, and a
// restore writes a new current snapshot only while no machine writes the area and no restore
// claims it; a start into a claimed area is refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_STATUS, SNAPSHOT_REFUSALS, memberAreaKey, teamAreaKey, type Snapshot, type SnapshotRefusal } from "@sbgpu/api";
import { ApiError, createClient, type Client } from "../client.ts";
import { BOOT_SECONDS, SAVE_BYTES, SAVE_BYTES_PER_SECOND, PROVIDER_STOP_SECONDS } from "./backend.ts";
import { mockFetch } from "./fetch.ts";
import { seedDemo } from "./seed.ts";

const SEC = 1000;
const SAVE_SECONDS = Math.ceil(SAVE_BYTES / SAVE_BYTES_PER_SECOND);

function world() {
  const demo = seedDemo();
  const b = demo.backend;
  const client = createClient({ fetch: mockFetch(b) });
  const as = (email: string): Client => {
    assert.ok(b.signInAs(email), email);
    return client;
  };
  const p = { projectId: demo.projectId };
  const memberId = (email: string) => [...b.members.values()].find((m) => m.email === email)!.id;
  const teamId = (name: string) => [...b.teams.values()].find((t) => t.name === name)!.id;
  const mine = (email: string) => memberAreaKey(demo.projectId, memberId(email));
  const team = (name: string) => teamAreaKey(demo.projectId, teamId(name));
  const list = async (email: string, area: "member" | "team") => (await as(email).call("listSnapshots", { params: p, query: { area } })).items;
  const start = async (email: string) => (await as(email).call("startMachine", { params: p, body: { gpuType: "L4" } })).id;
  const running = async (email: string) => {
    const id = await start(email);
    b.advance(BOOT_SECONDS * SEC);
    assert.equal(b.machines.get(id)!.m.state, "running");
    return id;
  };
  const stopped = (id: string) => {
    b.advance((SAVE_SECONDS + PROVIDER_STOP_SECONDS + 1) * SEC);
    assert.equal(b.machines.get(id)!.m.state, "stopped");
  };
  const restore = (email: string, snapshotId: string, area: "member" | "team") =>
    as(email).call("restoreSnapshot", { params: { ...p, snapshotId }, body: { area } });
  const name = (email: string, snapshotId: string, area: "member" | "team", n: string | null) =>
    as(email).call("nameSnapshot", { params: { ...p, snapshotId }, body: { area, name: n } });
  return { ...demo, b, as, p, mine, team, teamId, memberId, list, start, running, stopped, restore, name };
}

async function refused(promise: Promise<unknown>, refusal: SnapshotRefusal): Promise<void> {
  const { code, message } = SNAPSHOT_REFUSALS[refusal];
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ApiError, String(err));
    assert.deepEqual([err.code, err.status, err.message], [code, ERROR_STATUS[code], message]);
    return true;
  });
}

const view = (s: Snapshot) => [s.kind, s.name, s.current, s.restoredFrom === null ? null : "from"];

test("a save commits a snapshot to the machine's member area, now current; a stop's save is final", async () => {
  const w = world();
  const ada = w.emails.member;
  const id = await w.running(ada);
  assert.deepEqual(await w.list(ada, "member"), []);
  await w.as(ada).call("saveMachine", { params: { machineId: id } });
  w.b.advance(SAVE_SECONDS * SEC);
  const [first] = await w.list(ada, "member");
  assert.deepEqual(first, {
    id: w.b.machines.get(id)!.m.save.snapshotId,
    area: "member",
    createdAt: first!.createdAt,
    kind: "manual",
    bytes: SAVE_BYTES,
    name: null,
    machineId: id,
    current: true,
    restoredFrom: null,
  });
  await w.as(ada).call("stopMachine", { params: { machineId: id }, body: {} });
  w.stopped(id);
  assert.deepEqual((await w.list(ada, "member")).map(view), [["final", null, true, null], ["manual", null, false, null]]); // newest first
  assert.deepEqual(await w.list(ada, "team"), []); // (the mock's saves go to the member area only)
  const listing = await w.as(ada).call("listSnapshots", { params: w.p, query: { area: "member" } });
  assert.deepEqual([listing.keepLast, listing.namedMax], [10, 5]);
});

test("only the caller's own areas: another's snapshot is notFound, a team area needs a team, area is member or team", async () => {
  const w = world();
  const adaSnap = w.b.seedSnapshot(w.mine(w.emails.member));
  const qwen = w.b.seedSnapshot(w.team("Team Qwen"));
  assert.equal((await w.list(w.emails.member, "member"))[0]!.id, adaSnap);
  assert.equal((await w.list(w.emails.member, "team"))[0]!.id, qwen);
  assert.deepEqual(await w.list(w.emails.teamMember, "member"), []); // Alan sees only his own
  assert.deepEqual(await w.list(w.emails.teamMember, "team"), []); // and Team Llama's, not Qwen's
  await refused(w.restore(w.emails.teamMember, adaSnap, "member"), "notFound");
  await refused(w.restore(w.emails.teamMember, qwen, "team"), "notFound");
  await refused(w.name(w.emails.teamMember, adaSnap, "member", "mine now"), "notFound");
  await refused(w.restore(w.emails.member, qwen, "member"), "notFound"); // (the right caller, the wrong area)
  await refused(w.list(w.emails.lowMember, "team"), "notFound"); // Grace has no team
  await refused(w.as(w.emails.member).call("listSnapshots", { params: w.p, query: { area: "project-data" as "member" } }), "badRequest");
  await refused(w.as(w.emails.member).call("restoreSnapshot", { params: { ...w.p, snapshotId: adaSnap }, body: { area: "member", extra: 1 } as never }), "badRequest");
  // a member who leaves the team loses its area at once
  w.b.members.get(w.memberId(w.emails.member))!.teamId = null;
  await refused(w.list(w.emails.member, "team"), "notFound");
  await refused(w.restore(w.emails.member, qwen, "team"), "notFound");
});

test("names: set, changed and cleared; unique in the area; at most snapshotNamedMax; fixed words for a bad one", async () => {
  const w = world();
  const ada = w.emails.member;
  const [a, b2, c] = [w.b.seedSnapshot(w.mine(ada)), w.b.seedSnapshot(w.mine(ada)), w.b.seedSnapshot(w.mine(ada))];
  assert.equal((await w.name(ada, a!, "member", "before I break it")).name, "before I break it");
  await refused(w.name(ada, b2!, "member", "before I break it"), "nameTaken");
  assert.equal((await w.name(ada, a!, "member", "before I break it")).name, "before I break it"); // (its own name again)
  assert.equal((await w.name(ada, a!, "member", "renamed")).name, "renamed");
  // another area may use the same name
  const qwen = w.b.seedSnapshot(w.team("Team Qwen"));
  assert.equal((await w.name(ada, qwen, "team", "renamed")).name, "renamed");
  for (const bad of ["", " x", "x\n", "a".repeat(65)]) await refused(w.name(ada, b2!, "member", bad), "badName");
  await refused(w.as(ada).call("nameSnapshot", { params: { ...w.p, snapshotId: b2! }, body: { area: "member" } as never }), "badRequest");
  await refused(w.as(ada).call("nameSnapshot", { params: { ...w.p, snapshotId: b2! }, body: { area: "x", name: "ok" } as never }), "badRequest");
  // the cap
  await w.as(w.emails.manager).call("updateProject", { params: w.p, body: { policy: { snapshotNamedMax: 2 } } });
  assert.equal((await w.name(ada, b2!, "member", "two")).name, "two");
  await refused(w.name(ada, c!, "member", "three"), "tooManyNamed");
  assert.equal((await w.name(ada, b2!, "member", "two, renamed")).name, "two, renamed"); // (a rename isn't a new one)
  assert.equal((await w.name(ada, b2!, "member", null)).name, null);
  assert.equal((await w.name(ada, c!, "member", "three")).name, "three");
});

test("a save with a name names the snapshot it commits; a bad or taken name refuses the save; a failed save names nothing", async () => {
  const w = world();
  const ada = w.emails.member;
  const id = await w.running(ada);
  const save = (body: object) => w.as(ada).call("saveMachine", { params: { machineId: id }, body: body as { name?: string } });
  await refused(save({ name: " x" }), "badName");
  await refused(save({ name: "x", area: "member" }), "badRequest");
  await save({ name: "checkpoint 1" });
  w.b.advance(SAVE_SECONDS * SEC);
  assert.deepEqual((await w.list(ada, "member")).map(view), [["manual", "checkpoint 1", true, null]]);
  await refused(save({ name: "checkpoint 1" }), "nameTaken");
  await w.as(w.emails.manager).call("updateProject", { params: w.p, body: { policy: { snapshotNamedMax: 1 } } });
  await refused(save({ name: "checkpoint 2" }), "tooManyNamed");
  await w.as(w.emails.manager).call("updateProject", { params: w.p, body: { policy: { snapshotNamedMax: 5 } } });
  await save({ name: "lost" });
  w.b.failMachine(id, "gone");
  assert.equal(w.b.machines.get(id)!.pendingName, null);
  assert.deepEqual((await w.list(ada, "member")).map((s) => s.name), ["checkpoint 1"]);
});

test("retention: the newest snapshotKeepLast unnamed ones, every named one, and the current one", async () => {
  const w = world();
  const ada = w.emails.member;
  await w.as(w.emails.manager).call("updateProject", { params: w.p, body: { policy: { snapshotKeepLast: 2 } } });
  const key = w.mine(ada);
  const ids = [w.b.seedSnapshot(key, { name: "old but named" }), w.b.seedSnapshot(key), w.b.seedSnapshot(key), w.b.seedSnapshot(key)];
  assert.deepEqual((await w.list(ada, "member")).map((s) => s.id), [ids[3], ids[2], ids[0]]);
  // a restore of a named snapshot is itself unnamed, and current; the oldest unnamed goes
  const r = await w.restore(ada, ids[0]!, "member");
  assert.deepEqual((await w.list(ada, "member")).map((s) => s.id), [r.id, ids[3], ids[0]]);
});

test("restore: a new current snapshot from the target, while nothing writes the area; another restore undoes it", async () => {
  const w = world();
  const ada = w.emails.member;
  const id = await w.running(ada);
  await w.as(ada).call("saveMachine", { params: { machineId: id } });
  w.b.advance(SAVE_SECONDS * SEC);
  const [good] = await w.list(ada, "member");
  // the machine writes both its member area and its team's (Team Qwen): no restore of either
  const qwen = w.b.seedSnapshot(w.team("Team Qwen"));
  await refused(w.restore(ada, good!.id, "member"), "writerRunning");
  await refused(w.restore(ada, qwen, "team"), "writerRunning");
  await w.as(ada).call("stopMachine", { params: { machineId: id }, body: {} });
  await refused(w.restore(ada, good!.id, "member"), "writerRunning"); // (still saving, then stopping)
  w.stopped(id);
  const [bad] = await w.list(ada, "member");
  assert.equal(bad!.kind, "final");
  const r = await w.restore(ada, good!.id, "member");
  assert.deepEqual(
    { ...r, id: "", createdAt: "" },
    { id: "", area: "member", createdAt: "", kind: "restore", bytes: good!.bytes, name: null, machineId: null, current: true, restoredFrom: good!.id },
  );
  assert.deepEqual((await w.list(ada, "member")).map(view), [["restore", null, true, "from"], ["final", null, false, null], ["manual", null, false, null]]);
  // nothing was deleted: restoring the final save undoes it
  const back = await w.restore(ada, bad!.id, "member");
  assert.equal(back.restoredFrom, bad!.id);
  assert.equal((await w.list(ada, "member")).length, 4);
  const t = await w.restore(ada, qwen, "team");
  assert.deepEqual([t.area, t.kind, t.current], ["team", "restore", true]);
});

test("a restore in progress: a second is restoreInProgress (before the writer check); start and restart are startDuringRestore", async () => {
  const w = world();
  const ada = w.emails.member;
  const snap = w.b.seedSnapshot(w.mine(ada));
  const id = await w.running(ada);
  w.b.holdRestore(w.mine(ada));
  await refused(w.restore(ada, snap, "member"), "restoreInProgress"); // (a claim and a writer: the claim's refusal)
  await w.as(ada).call("stopMachine", { params: { machineId: id }, body: {} });
  w.stopped(id);
  await refused(w.as(ada).call("restartMachine", { params: { machineId: id } }), "startDuringRestore");
  assert.equal(w.b.machines.get(id)!.m.state, "stopped");
  await refused(w.start(ada), "startDuringRestore");
  w.b.releaseRestore(w.mine(ada));
  // a claim on the team area blocks it too; another team's doesn't
  w.b.holdRestore(w.team("Team Llama"));
  await w.as(ada).call("restartMachine", { params: { machineId: id } });
  await w.as(ada).call("stopMachine", { params: { machineId: id }, body: {} });
  w.b.advance((BOOT_SECONDS + PROVIDER_STOP_SECONDS + 1) * SEC);
  w.b.holdRestore(w.team("Team Qwen"));
  await refused(w.as(ada).call("restartMachine", { params: { machineId: id } }), "startDuringRestore");
  await refused(w.start(ada), "startDuringRestore");
  await refused(w.start(w.emails.teamMember), "startDuringRestore"); // (Alan is in Llama: claimed too)
  w.b.releaseRestore(w.team("Team Llama"));
  await w.start(w.emails.teamMember);
});

test("a team move while running (C1): the machine writes its pinned areas until it stops, and the new team's only after a restart", async () => {
  const w = world();
  const alan = w.emails.teamMember;
  const llama = w.b.seedSnapshot(w.team("Team Llama"));
  const qwen = w.b.seedSnapshot(w.team("Team Qwen"));
  const id = await w.running(alan);
  await w.as(w.emails.manager).call("updateMember", { params: { ...w.p, memberId: w.memberId(alan) }, body: { teamId: w.teamId("Team Qwen") } });
  await refused(w.restore("edsger@example.org", llama, "team"), "writerRunning"); // the old team's area: still written
  await w.restore(w.emails.member, qwen, "team"); // the new team's: not yet
  await w.as(alan).call("stopMachine", { params: { machineId: id }, body: {} });
  w.stopped(id);
  await w.restore("edsger@example.org", llama, "team");
  await w.as(alan).call("restartMachine", { params: { machineId: id } });
  assert.deepEqual([w.b.machines.get(id)!.memberAreaKey, w.b.machines.get(id)!.teamAreaKey], [w.mine(alan), w.team("Team Qwen")]);
  await refused(w.restore(w.emails.member, qwen, "team"), "writerRunning");
});
