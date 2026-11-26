// Restore's exclusion (0015; the snapshot contract r3.1, section 4): the machines' pinned area
// keys, and area_restores. These rows pin every check and trigger, and run the contract's two
// conditional batches as reference statements (the claim's writer guard, 4.1; the start's claim
// guard, 4.2) against them, for the races of section 5. The batches themselves are control's
// code; the statements here are the shapes r3.1 gives them.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { memberAreaKey, newId, teamAreaKey } from "@sbgpu/api";
import { stmt, type SqlValue, type Stmt } from "./db.ts";
import { T0, addMember, world, type World } from "./testing/world.ts";

const NUL = String.fromCharCode(0);
const LIVE = `('starting', 'running', 'saving', 'stopping')`;
// (the batch's all-or-nothing guard on the statement just before, as enroll's)
const TOOK: Stmt = { sql: `INSERT INTO enroll_guard (ok) SELECT 0 WHERE changes() <> 1`, params: [] };

let w: World;
let memberId: string;
let allocationId: string;
let teamA: string;
let teamB: string;
let n = 0;
const op = () => `op${String(++n).padStart(20, "0")}`; // 22 base64url characters
const jti = () => `jt${String(++n).padStart(20, "0")}`;

beforeEach(async () => {
  w = await world();
  memberId = await addMember(w, "m@example.com", "member", { allocation: 0 });
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
  teamA = newId("team");
  teamB = newId("team");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'A', ?)`, teamA, w.projectId, T0),
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'B', ?)`, teamB, w.projectId, T0),
    stmt(`UPDATE members SET team_id = ? WHERE id = ?`, teamA, memberId),
  ]);
});

const mine = () => memberAreaKey(w.projectId, memberId);
const teamKey = (t: string) => teamAreaKey(w.projectId, t);

async function machine(state: string, keys: { member?: string | null; team?: string | null } = {}) {
  const id = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms, member_area_key, team_area_key)
       VALUES (?, ?, ?, ?, 'runpod', 'L4', 1, 'X', ?, 1, ?, ?, ?)`,
      id, w.projectId, allocationId, memberId, state, T0, keys.member === undefined ? mine() : keys.member, keys.team === undefined ? teamKey(teamA) : keys.team,
    ),
  ]);
  return id;
}
const setMachine = (id: string, set: string, ...p: SqlValue[]) => w.db.batch([stmt(`UPDATE machines SET ${set} WHERE id = ?`, ...p, id)]);
const keysOf = async (id: string) => ({ ...(await w.db.all<{ m: string | null; t: string | null }>(`SELECT member_area_key AS m, team_area_key AS t FROM machines WHERE id = ?`, [id]))[0]! });

const claimRow = (over: Record<string, SqlValue> = {}) => ({
  op_id: op(), area_key: mine(), actor_member_id: memberId, target_snapshot_id: newId("snapshot"), jti: jti(), state: "claimed", lease_ms: 120_000, created_ms: T0, ...over,
});
const insert = (v: Record<string, SqlValue>) => {
  const cols = Object.keys(v);
  return w.db.batch([{ sql: `INSERT INTO area_restores (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: Object.values(v) }]);
};
const setRestore = (opId: string, set: string, ...p: SqlValue[]) => w.db.batch([stmt(`UPDATE area_restores SET ${set} WHERE op_id = ?`, ...p, opId)]);
const restore = async (opId: string) => (await w.db.all<Record<string, SqlValue>>(`SELECT * FROM area_restores WHERE op_id = ?`, [opId]))[0]!;
const liveClaims = async () => (await w.db.all<{ n: number }>(`SELECT count(*) AS n FROM area_restores WHERE state = 'claimed'`))[0]!.n;

/** 4.1 step 3: the claim, only while no machine writes the area; then its changes() = 1 guard. */
function claim(areaKey: string, opId = op(), createdMs = T0) {
  return w.db.batch([
    stmt(
      `INSERT INTO area_restores (op_id, area_key, actor_member_id, target_snapshot_id, jti, state, lease_ms, created_ms)
       SELECT ?, ?, ?, ?, ?, 'claimed', 120000, ?
       WHERE NOT EXISTS (SELECT 1 FROM machines WHERE state IN ${LIVE} AND (member_area_key = ? OR team_area_key = ?))`,
      opId, areaKey, memberId, newId("snapshot"), jti(), createdMs, areaKey, areaKey,
    ),
    TOOK,
  ]);
}

/** 4.2: a start from a final state pins the keys in the statement that moves into starting, only with no live claim on them. */
function start(id: string, member: string, team: string | null) {
  return w.db.batch([
    stmt(
      `UPDATE machines SET state = 'starting', incarnation = incarnation + 1, member_area_key = ?, team_area_key = ?
       WHERE id = ? AND state IN ('stopped', 'failed')
         AND NOT EXISTS (SELECT 1 FROM area_restores WHERE state = 'claimed' AND area_key IN (?, ?))`,
      member, team, id, member, team,
    ),
    TOOK,
  ]);
}

// ---------------------------------------------------------------- the machines' area keys

test("area keys: exactly m:<prj>:<mbr> and t:<prj>:<team>, as bytes; a team key needs a member key", async () => {
  const good = await machine("stopped");
  assert.deepEqual(await keysOf(good), { m: mine(), t: teamKey(teamA) });
  await machine("stopped", { member: null, team: null }); // (a machine from before 0015, or never started)
  await machine("stopped", { team: null });
  const prj = w.projectId;
  const bad: Array<[string | null, string | null]> = [
    [`t:${prj}:${memberId}`, null], // a member key with the team kind
    [`m:${prj}:${teamA}`, null],
    [`m:${prj}:${memberId}x`, null],
    [`m:${prj}:${memberId.toUpperCase()}`, null],
    [`m:${prj}:${memberId.slice(0, -1)}i`, null], // (i is not Crockford)
    [`m:${prj}:${memberId}${NUL}`, null], // (GLOB stops at a NUL; the byte length doesn't)
    [`m:${prj}:${memberId}${NUL}x`, null],
    [`m:${prj}${NUL}${memberId}`, null],
    [`m:${memberId}:${prj}`, null],
    [mine(), `m:${prj}:${memberId}`],
    [mine(), `t:${prj}:${memberId}`],
    [mine(), `t:${prj}:${teamA}${NUL}`],
    [mine(), `t:${prj}:${teamA}x`],
    [null, teamKey(teamA)], // a team key alone
  ];
  for (const [m, t] of bad) await assert.rejects(machine("stopped", { member: m, team: t }), /CHECK/, `${m} ${t}`);
});

test("area keys change only while the machine is final, or in the statement that moves it into starting (N1)", async () => {
  for (const state of ["starting", "running", "saving", "stopping"]) {
    const id = await machine(state);
    await assert.rejects(setMachine(id, `member_area_key = NULL`), /area keys change only through a final state/, state);
    await assert.rejects(setMachine(id, `team_area_key = ?`, teamKey(teamB)), /area keys change only through a final state/, state);
    await assert.rejects(setMachine(id, `team_area_key = NULL`), /area keys change only through a final state/, state);
    // a restart of a live machine can't re-pin, even with the move into starting
    await assert.rejects(setMachine(id, `state = 'starting', team_area_key = ?`, teamKey(teamB)), /area keys change only through a final state/, state);
    await setMachine(id, `team_area_key = ?`, teamKey(teamA)); // (the same value: no change)
    await setMachine(id, `state = ?`, state); // (other columns are free)
    assert.deepEqual(await keysOf(id), { m: mine(), t: teamKey(teamA) });
  }
  for (const state of ["stopped", "failed", "deleted"]) {
    const id = await machine(state);
    await setMachine(id, `team_area_key = ?`, teamKey(teamB));
    assert.deepEqual(await keysOf(id), { m: mine(), t: teamKey(teamB) }, state);
  }
  const id = await machine("stopped");
  await start(id, mine(), teamKey(teamB)); // re-pinned with the move into starting
  assert.deepEqual(await keysOf(id), { m: mine(), t: teamKey(teamB) });
});

// ---------------------------------------------------------------- area_restores

test("area_restores: a claim starts bare (claimed, no head, no token), with the 120 s lease; every id to its shape", async () => {
  await insert(claimRow());
  await assert.rejects(insert(claimRow({ area_key: teamKey(teamB), state: "done" })), /starts as a bare claim/);
  await assert.rejects(insert(claimRow({ area_key: teamKey(teamB), expected_head: newId("snapshot") })), /starts as a bare claim/);
  await assert.rejects(insert(claimRow({ area_key: teamKey(teamB), state: "other" })), /CHECK|bare claim/);
  await assert.rejects(insert(claimRow({ area_key: teamKey(teamB), token_exp_ms: T0 + 1 })), /CHECK/); // (a token needs a head)
  for (const [col, v] of [
    ["lease_ms", 119_999],
    ["lease_ms", 120_001],
    ["op_id", "short"],
    ["op_id", "a".repeat(21) + "+"],
    ["op_id", "a".repeat(21) + NUL],
    ["jti", "a".repeat(23)],
    ["jti", "a".repeat(21) + NUL],
    ["area_key", `x:${w.projectId}:${memberId}`],
    ["area_key", mine() + NUL],
    ["target_snapshot_id", newId("machine")],
    ["target_snapshot_id", newId("snapshot") + NUL],
    ["created_ms", -1],
  ] as Array<[string, SqlValue]>) {
    await assert.rejects(insert(claimRow({ area_key: teamKey(teamB), [col]: v })), /CHECK/, `${col}=${String(v)}`);
  }
  await assert.rejects(insert(claimRow({ area_key: teamKey(teamB), actor_member_id: newId("member") })), /FOREIGN KEY/);
});

test("area_restores: one live claim per area; an ended claim frees it; a jti is one operation's", async () => {
  const a = claimRow();
  await insert(a);
  await assert.rejects(insert(claimRow()), /UNIQUE/); // the same area, live
  await insert(claimRow({ area_key: teamKey(teamA) })); // another area
  await assert.rejects(insert(claimRow({ area_key: teamKey(teamB), jti: a.jti })), /UNIQUE/);
  for (const end of ["done", "failed", "expired"]) {
    const live = (await w.db.all<{ op_id: string }>(`SELECT op_id FROM area_restores WHERE area_key = ? AND state = 'claimed'`, [mine()]))[0]!.op_id;
    await setRestore(live, `state = ?`, end);
    await insert(claimRow()); // the area is free again
  }
});

test("area_restores: claimed, then done, failed or expired, one way; rows are kept", async () => {
  for (const end of ["done", "failed", "expired"]) {
    const r = claimRow({ area_key: teamKey(teamB) });
    await insert(r);
    await setRestore(r.op_id, `state = 'claimed'`); // (no change)
    await setRestore(r.op_id, `state = ?`, end);
    for (const next of ["claimed", "done", "failed", "expired"]) {
      if (next === end) continue;
      await assert.rejects(setRestore(r.op_id, `state = ?`, next), /only ends, once/, `${end} -> ${next}`);
    }
    await assert.rejects(w.db.batch([stmt(`DELETE FROM area_restores WHERE op_id = ?`, r.op_id)]), /kept/);
  }
});

test("area_restores: what the operation is stays fixed", async () => {
  const r = claimRow();
  await insert(r);
  for (const [col, v] of [
    ["op_id", op()],
    ["area_key", teamKey(teamA)],
    ["actor_member_id", await addMember(w, "x@example.com")],
    ["target_snapshot_id", newId("snapshot")],
    ["jti", jti()],
    ["created_ms", T0 + 1],
  ] as Array<[string, SqlValue]>) {
    await assert.rejects(setRestore(r.op_id, `${col} = ?`, v), /identity is fixed/, col);
  }
  await assert.rejects(setRestore(r.op_id, `lease_ms = 60000`), /identity is fixed|CHECK/);
  await setRestore(r.op_id, `area_key = ?, jti = ?`, r.area_key, r.jti); // (the same values)
});

test("area_restores: the head is read once, after the claim; the token is minted once, after the head, within the lease less the skew (N2)", async () => {
  const head = newId("snapshot");
  const r = claimRow();
  await insert(r);
  await assert.rejects(setRestore(r.op_id, `token_exp_ms = ?`, T0 + 60_000), /CHECK/); // (no head yet)
  await setRestore(r.op_id, `expected_head = ?`, head);
  await assert.rejects(setRestore(r.op_id, `expected_head = ?`, newId("snapshot")), /set once, while claimed/);
  await assert.rejects(setRestore(r.op_id, `expected_head = NULL`), /set once, while claimed/);
  for (const exp of [T0, T0 - 1, T0 + 90_001, T0 + 120_000]) {
    await assert.rejects(setRestore(r.op_id, `token_exp_ms = ?`, exp), /CHECK/, String(exp));
  }
  await setRestore(r.op_id, `token_exp_ms = ?`, T0 + 90_000); // exp + 30 s = the lease's end
  await assert.rejects(setRestore(r.op_id, `token_exp_ms = ?`, T0 + 60_000), /minted once, while claimed/);
  await assert.rejects(setRestore(r.op_id, `token_exp_ms = NULL`), /minted once, while claimed/);
  assert.deepEqual([(await restore(r.op_id)).expected_head, (await restore(r.op_id)).token_exp_ms], [head, T0 + 90_000]);

  // after the claim ends, neither is set
  const s = claimRow({ area_key: teamKey(teamA) });
  await insert(s);
  await setRestore(s.op_id, `state = 'failed'`);
  await assert.rejects(setRestore(s.op_id, `expected_head = ?`, head), /set once, while claimed/);
  const t = claimRow({ area_key: teamKey(teamB) });
  await insert(t);
  await setRestore(t.op_id, `expected_head = ?`, head);
  await setRestore(t.op_id, `state = 'expired'`);
  await assert.rejects(setRestore(t.op_id, `token_exp_ms = ?`, T0 + 1), /minted once, while claimed/);
});

// ---------------------------------------------------------------- the races (section 5)

test("start before claim: a machine pinned into starting makes the claim's guard refuse, for each live state and either key", async () => {
  for (const state of ["starting", "running", "saving", "stopping"]) {
    const id = await machine(state);
    await assert.rejects(claim(mine()), /CHECK/, `member area, ${state}`);
    await assert.rejects(claim(teamKey(teamA)), /CHECK/, `team area, ${state}`);
    await claim(teamKey(teamB)); // an area it doesn't write
    await w.db.batch([stmt(`UPDATE area_restores SET state = 'done' WHERE state = 'claimed'`)]);
    await setMachine(id, `state = 'deleted'`);
  }
  assert.equal(await liveClaims(), 0);
  for (const state of ["stopped", "failed", "deleted"]) await machine(state); // final machines write nothing
  await claim(mine());
  assert.equal(await liveClaims(), 1);
});

test("claim before start: start and restart are refused until the claim ends, whichever key it names", async () => {
  const id = await machine("stopped");
  const opId = op();
  await claim(teamKey(teamA), opId);
  await assert.rejects(start(id, mine(), teamKey(teamA)), /CHECK/);
  assert.deepEqual((await w.db.all(`SELECT state, incarnation FROM machines WHERE id = ?`, [id])).map((r) => ({ ...(r as object) })), [{ state: "stopped", incarnation: 1 }]);
  await start(id, mine(), null); // without that team, it may start
  await setMachine(id, `state = 'stopped'`);
  await setRestore(opId, `state = 'done'`);
  await start(id, mine(), teamKey(teamA));
  assert.deepEqual(await keysOf(id), { m: mine(), t: teamKey(teamA) });

  const other = await machine("stopped", { team: null });
  const second = op();
  await claim(memberAreaKey(w.projectId, await addMember(w, "y@example.com")), op()); // someone else's area
  await start(other, mine(), null);
  await setMachine(other, `state = 'stopped'`);
  await setMachine(id, `state = 'stopped'`);
  await claim(mine(), second);
  await assert.rejects(start(other, mine(), null), /CHECK/);
  await assert.rejects(start(id, mine(), teamKey(teamB)), /CHECK/);
});

test("two sessions at once: one claim wins, the other is refused by the partial unique index; nothing half-written", async () => {
  await claim(mine());
  await assert.rejects(claim(mine()), /UNIQUE/);
  assert.equal(await liveClaims(), 1);
});

test("no time-based release (C2): a claimed row past its lease still blocks a claim and a start, until it is ended", async () => {
  const opId = op();
  await claim(mine(), opId, T0 - 24 * 3600_000);
  const id = await machine("stopped", { team: null });
  await assert.rejects(claim(mine()), /UNIQUE/);
  await assert.rejects(start(id, mine(), null), /CHECK/);
  await setRestore(opId, `state = 'expired'`);
  await start(id, mine(), null);
});

test("team move and removal while running (C1): the machine stays a writer of its pinned areas until it stops", async () => {
  const id = await machine("running");
  // the member moves to team B, then is removed; the running machine's keys don't follow
  await w.db.batch([stmt(`UPDATE members SET team_id = ? WHERE id = ?`, teamB, memberId)]);
  await assert.rejects(claim(teamKey(teamA)), /CHECK/);
  await claim(teamKey(teamB)); // the new team's area isn't written by that machine
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, memberId)]);
  await assert.rejects(claim(mine()), /CHECK/);
  await assert.rejects(claim(teamKey(teamA)), /CHECK/);
  await setMachine(id, `state = 'stopped'`);
  await claim(teamKey(teamA));
  await claim(mine());
  assert.equal(await liveClaims(), 3);
});
