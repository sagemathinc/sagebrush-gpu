import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESTORE_CLOCK_SKEW_MS,
  RESTORE_LEASE_MS,
  RESTORE_STATES,
  RESTORE_TOKEN_MAX_TTL_MS,
  SNAPSHOT_AREAS,
  SNAPSHOT_KINDS,
  SNAPSHOT_NAME_MAX,
  SNAPSHOT_REFUSALS,
  isAreaKey,
  isSnapshotArea,
  isSnapshotKind,
  isSnapshotName,
  memberAreaKey,
  parseNameSnapshotRequest,
  parseRestoreSnapshotRequest,
  parseSaveMachineRequest,
  restoreTokenExpMs,
  snapshotRefusalBody,
  teamAreaKey,
} from "./snapshots.ts";
import { ERROR_STATUS, isApiErrorBody } from "./errors.ts";
import { newId } from "./ids.ts";

const NUL = String.fromCharCode(0);

test("kinds, areas and restore states are the contract's, closed", () => {
  assert.deepEqual([...SNAPSHOT_KINDS], ["periodic", "manual", "final", "restore"]);
  assert.deepEqual([...SNAPSHOT_AREAS], ["member", "team"]);
  assert.deepEqual([...RESTORE_STATES], ["claimed", "done", "failed", "expired"]);
  for (const k of SNAPSHOT_KINDS) assert.equal(isSnapshotKind(k), true, k);
  for (const bad of ["Manual", "named", "", null, undefined, 1, ["manual"]]) assert.equal(isSnapshotKind(bad), false, String(bad));
  for (const a of SNAPSHOT_AREAS) assert.equal(isSnapshotArea(a), true, a);
  for (const bad of ["project-data", "Member", "mine", "", null, undefined, {}]) assert.equal(isSnapshotArea(bad), false, String(bad));
});

test("a name: 1 to 64 printable characters, trimmed", () => {
  assert.equal(SNAPSHOT_NAME_MAX, 64);
  for (const ok of ["x", "before I break it", "épreuve", "a".repeat(64), "😀".repeat(64), "a b", "x y", "5"]) {
    assert.equal(isSnapshotName(ok), true, ok);
  }
  for (const bad of [
    "",
    " ",
    " x",
    "x ",
    "x\n",
    "\tx",
    "a".repeat(65),
    "😀".repeat(65),
    "a\u0000b",
    "a\u0007b",
    "a\u007fb",
    "a\u0085b", // (a C1 control)
    "a b",
    "a b",
    "a\ud800b", // (a lone surrogate)
    " x",
    null,
    undefined,
    5,
    ["x"],
  ]) {
    assert.equal(isSnapshotName(bad), false, JSON.stringify(bad));
  }
});

test("the name route's body: exactly { area, name }, name valid or null", () => {
  assert.deepEqual(parseNameSnapshotRequest({ area: "member", name: "keep" }), { area: "member", name: "keep" });
  assert.deepEqual(parseNameSnapshotRequest({ area: "team", name: null }), { area: "team", name: null });
  for (const bad of [
    { area: "member" },
    { name: "x" },
    { area: "member", name: "x", extra: 1 },
    { area: "project-data", name: "x" },
    { area: "member", name: "" },
    { area: "member", name: " x" },
    { area: "member", name: undefined },
    { area: "member", name: 5 },
    [],
    null,
    "member",
    Object.assign(Object.create({ inherited: 1 }), { area: "member", name: "x" }),
  ]) {
    assert.equal(parseNameSnapshotRequest(bad), null, JSON.stringify(bad));
  }
});

test("the restore route's body: exactly { area }", () => {
  assert.deepEqual(parseRestoreSnapshotRequest({ area: "member" }), { area: "member" });
  assert.deepEqual(parseRestoreSnapshotRequest({ area: "team" }), { area: "team" });
  for (const bad of [{}, { area: "team", snapshotId: newId("snapshot") }, { area: "x" }, { area: null }, null, [], "team"]) {
    assert.equal(parseRestoreSnapshotRequest(bad), null, JSON.stringify(bad));
  }
});

test("the save route's body: {} or { name } with a valid name", () => {
  assert.deepEqual(parseSaveMachineRequest({}), {});
  assert.deepEqual(parseSaveMachineRequest({ name: "before the big run" }), { name: "before the big run" });
  for (const bad of [{ name: null }, { name: "" }, { name: "x " }, { name: "x", area: "member" }, { other: 1 }, null, [], "x"]) {
    assert.equal(parseSaveMachineRequest(bad), null, JSON.stringify(bad));
  }
});

test("area keys: m:<prj>:<mbr> and t:<prj>:<team>, from well-formed ids only", () => {
  const p = newId("project");
  const m = newId("member");
  const t = newId("team");
  assert.equal(memberAreaKey(p, m), `m:${p}:${m}`);
  assert.equal(teamAreaKey(p, t), `t:${p}:${t}`);
  assert.equal(memberAreaKey(p, m).length, 51);
  assert.equal(teamAreaKey(p, t).length, 52);
  assert.throws(() => memberAreaKey(p, t), RangeError);
  assert.throws(() => memberAreaKey(m, m), RangeError);
  assert.throws(() => teamAreaKey(p, m), RangeError);
  assert.throws(() => teamAreaKey(t, t), RangeError);
  assert.equal(isAreaKey(memberAreaKey(p, m)), true);
  assert.equal(isAreaKey(teamAreaKey(p, t)), true);
  for (const bad of [`t:${p}:${m}`, `m:${p}:${t}`, `m:${m}:${p}`, `m:${p}:${m}:x`, `m:${p}`, `x:${p}:${m}`, `m:${p}:${m}${NUL}`, `M:${p}:${m}`, "", null, 5]) {
    assert.equal(isAreaKey(bad), false, String(bad));
  }
});

test("restore timing: a 120 s lease, tokens of at most 60 s, exp + the 30 s skew never past the lease (N2)", () => {
  assert.deepEqual([RESTORE_LEASE_MS, RESTORE_TOKEN_MAX_TTL_MS, RESTORE_CLOCK_SKEW_MS], [120_000, 60_000, 30_000]);
  const c = 1_000_000;
  assert.equal(restoreTokenExpMs(c, c), c + 60_000); // minted at once: the 60 s cap
  assert.equal(restoreTokenExpMs(c + 30_000, c), c + 90_000); // the lease's end less the skew, exactly
  assert.equal(restoreTokenExpMs(c + 30_001, c), c + 90_000);
  assert.equal(restoreTokenExpMs(c + 89_999, c), c + 90_000);
  assert.equal(restoreTokenExpMs(c + 90_000, c), null); // nothing left to mint
  assert.equal(restoreTokenExpMs(c + 200_000, c), null);
  for (let now = c; now < c + 90_000; now += 7_919) {
    const exp = restoreTokenExpMs(now, c)!;
    assert.ok(exp > now && exp - now <= RESTORE_TOKEN_MAX_TTL_MS && exp + RESTORE_CLOCK_SKEW_MS <= c + RESTORE_LEASE_MS, String(now));
  }
  assert.equal(restoreTokenExpMs(Number.NaN, c), null);
  assert.equal(restoreTokenExpMs(c + 0.5, c), null); // (whole ms only)
  assert.equal(restoreTokenExpMs(c, 1.5), null);
});

test("refusals: fixed words, valid error bodies, the contract's codes", () => {
  const codes = Object.fromEntries(Object.entries(SNAPSHOT_REFUSALS).map(([k, v]) => [k, v.code]));
  assert.deepEqual(codes, {
    badRequest: "badRequest",
    badName: "badRequest",
    notFound: "notFound",
    nameTaken: "conflict",
    tooManyNamed: "quotaExceeded",
    restoreInProgress: "conflict",
    writerRunning: "invalidState",
    startDuringRestore: "invalidState",
    headMoved: "conflict",
  });
  assert.equal(SNAPSHOT_REFUSALS.restoreInProgress.message, "A restore of this workspace is already in progress.");
  assert.equal(SNAPSHOT_REFUSALS.writerRunning.message, "Stop the machine that's using this workspace first.");
  assert.equal(SNAPSHOT_REFUSALS.startDuringRestore.message, "A restore of this workspace is in progress. Try again in a moment.");
  assert.ok(Object.isFrozen(SNAPSHOT_REFUSALS));
  for (const r of Object.keys(SNAPSHOT_REFUSALS) as Array<keyof typeof SNAPSHOT_REFUSALS>) {
    const body = snapshotRefusalBody(r);
    assert.equal(isApiErrorBody(body), true, r);
    assert.deepEqual(body, { error: { code: SNAPSHOT_REFUSALS[r].code, message: SNAPSHOT_REFUSALS[r].message } });
    assert.ok(ERROR_STATUS[body.error.code] >= 400, r);
  }
});
