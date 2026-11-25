import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { finalSaveReserveSeconds, newId, signToken, verifyToken, type AgentClaims, type Key } from "@sbgpu/api";
import type { Db } from "./db.ts";
import { stmt } from "./db.ts";
import { loadAgentPublicKeys, loadAgentSigner, type AgentSigner } from "./signer.ts";
import { HEARTBEAT_LOST_MS, HEARTBEAT_WATCHDOG_BATCH, HEARTBEAT_WATCHDOG_SELECT, runHeartbeatWatchdog } from "./heartbeat.ts";
import { recordActive, recordLaunchIntent, recordProviderId, runVmWatchdog, type InstanceFacts, type JobEnv, type VmProvider } from "./vm.ts";
import { ORIGIN, T0, addMember, world, type World } from "./testing/world.ts";

const IP = "203.0.113.7";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SCRIPT = sha("#!/bin/sh\n# the VM-mode boot script\n");
const AGENT = sha("the agent");

class FakeVm implements VmProvider {
  facts = new Map<string, InstanceFacts>();
  terminated: string[] = [];
  async instanceFacts(id: string): Promise<InstanceFacts> {
    return this.facts.get(id) ?? "unavailable";
  }
  async terminate(id: string): Promise<void> {
    this.terminated.push(id);
    this.facts.set(id, { state: "absent", ipv4: null, exclusive: false });
  }
}

async function keyPair() {
  const k = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as { privateKey: Key; publicKey: Key };
  const priv = (await crypto.subtle.exportKey("jwk", k.privateKey)) as Record<string, unknown>;
  const pub = (await crypto.subtle.exportKey("jwk", k.publicKey)) as Record<string, unknown>;
  return { priv: { kty: priv.kty, crv: priv.crv, d: priv.d, x: priv.x }, pub: { kty: pub.kty, crv: pub.crv, x: pub.x }, publicKey: k.publicKey, privateKey: k.privateKey };
}
const KP = await keyPair();
const OTHER = await keyPair();
const PINS = JSON.stringify({ k1: KP.pub });
const SIGNER = (await loadAgentSigner(JSON.stringify(KP.priv), "k1", PINS))!;
const KEYS = (await loadAgentPublicKeys(PINS))!;

let w: World;
let vm: FakeVm;
let signer: AgentSigner | null;
let keys: ReadonlyMap<string, Key> | null;
let memberId: string;
let allocationId: string;
beforeEach(async () => {
  vm = new FakeVm();
  signer = SIGNER;
  keys = KEYS;
  w = await world({ vm, agentSigner: async () => signer, agentPublicKeys: async () => keys });
  memberId = await addMember(w, "m@example.com", "member", { allocation: 0 });
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await w.app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  const out = (await res.json()) as Record<string, unknown>;
  await Promise.all(w.pending.splice(0));
  return { status: res.status, out };
};

/** A machine launched, announced and enrolled through the real endpoints: its agent token. */
async function enrolled() {
  const machineId = newId("machine");
  const nonce = randomBytes(16).toString("base64url");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES (?, ?, ?, ?, 'shadeform', 'L4', 1, 'X', 'starting', 1, ?)`,
      machineId, w.projectId, allocationId, memberId, T0,
    ),
  ]);
  await recordLaunchIntent(w.db, { machineId, incarnation: 1, provider: "shadeform", nonceSha256: sha(nonce), bootScriptSha256: SCRIPT, agentSha256: AGENT, createdMs: T0 });
  const pid = `vm-${machineId.slice(-8)}`;
  await recordProviderId(w.db, machineId, 1, pid);
  await recordActive(w.db, machineId, 1, { providerMachineId: pid, ipv4: IP, firstActiveMs: w.clock.t });
  vm.facts.set(pid, { state: "active", ipv4: IP, exclusive: true });
  const a = await post("/v1/agent/announce", { machineId, nonce, bootScriptSha256: SCRIPT }, { "cf-connecting-ip": IP });
  assert.equal(a.status, 200);
  const e = await post("/v1/agent/enroll", {
    bootToken: a.out.bootToken, agentVersion: "1.0.0", agentSha256: AGENT, providerMachineId: pid, mode: "vm",
    gpu: null, hostname: "vm", gate: { v: 1, pass: true, fail: [] },
  });
  assert.equal(e.status, 200, JSON.stringify(e.out));
  return { machineId, pid, token: e.out.agentToken as string, enrollMs: w.clock.t };
}

const iso = (ms: number) => new Date(ms).toISOString();
const report = (over: Record<string, unknown> = {}) => ({
  incarnation: 1,
  uptimeS: 60,
  activity: { lastTerminalInputAt: null, lastJupyterActivityAt: null, gpuUtilPct: 12, gpuMemUsedMiB: 1024 },
  idleSince: null,
  save: { state: "idle", lastSavedAt: null, progress: null, error: null, snapshotId: null, dirtyBytes: 0 },
  ...over,
});
const beat = (token: string, body: unknown = report(), scheme = "Bearer") => post("/v1/agent/heartbeat", body, { authorization: `${scheme} ${token}` });
const hbRow = async (machineId: string) => (await w.db.all<Record<string, unknown>>(`SELECT * FROM machine_heartbeats WHERE machine_id = ?`, [machineId])).map((r) => ({ ...r }));
const launch = async (machineId: string) => ({ ...(await w.db.all<Record<string, unknown>>(`SELECT outcome, terminate_reason, next_ms, watchdog_version, heartbeat_due_ms FROM launches WHERE machine_id = ?`, [machineId]))[0] });
const agentToken = (c: Partial<AgentClaims> & { mch: string }, s: AgentSigner = SIGNER) => {
  const iat = Math.floor(w.clock.t / 1000);
  return signToken({ v: 1, kind: "agent", jti: randomBytes(16).toString("base64url"), iat, exp: iat + 3600, inc: 1, ...c } as AgentClaims, s.privateKey, s.kid);
};
const env = (o: Partial<JobEnv> = {}): JobEnv => ({ db: w.db, now: w.clock.t, vm, elapsedMs: () => 0, ...o });

// ---------------------------------------------------------------- authentication

test("agent auth: a good Bearer token is accepted; every other way in is the same 401, with nothing written", async () => {
  const l = await enrolled();
  w.clock.t += 30_000;
  const ok = await beat(l.token);
  assert.equal(ok.status, 200, JSON.stringify(ok.out));
  assert.equal((await hbRow(l.machineId)).length, 1);
  await w.db.batch([stmt(`DELETE FROM machine_heartbeats WHERE machine_id = ?`, l.machineId)]);
  const refused = async (r: { status: number; out: Record<string, unknown> }, why: string) => {
    assert.equal(r.status, 401, why);
    assert.deepEqual(r.out, { error: { code: "unauthenticated", message: "refused" } }, why);
    assert.deepEqual(await hbRow(l.machineId), [], why);
  };
  await refused(await post("/v1/agent/heartbeat", report()), "no header");
  await refused(await beat(l.token, report(), "Basic"), "another scheme");
  await refused(await beat(l.token, report(), "bearer"), "the scheme's case");
  await refused(await beat(l.token + "x"), "a damaged token");
  await refused(await beat(l.token.split(".").slice(0, 2).join(".") + "." + "A".repeat(86)), "a bad signature");
  const otherSigner = (await loadAgentSigner(JSON.stringify(OTHER.priv), "k1", JSON.stringify({ k1: OTHER.pub })))!;
  await refused(await beat(await agentToken({ mch: l.machineId }, otherSigner)), "signed by an unpinned key");
  const k2 = (await loadAgentSigner(JSON.stringify(KP.priv), "k2", JSON.stringify({ k2: KP.pub })))!;
  await refused(await beat(await agentToken({ mch: l.machineId }, k2)), "an unknown kid");
  await refused(await beat(await agentToken({ mch: l.machineId, inc: 2 }), report({ incarnation: 2 })), "another incarnation");
  await refused(await beat(await agentToken({ mch: newId("machine") })), "no such machine");
  // expired
  const t = w.clock.t;
  w.clock.t = t + 3600_000 + 1000;
  await refused(await beat(l.token), "expired");
  w.clock.t = t;
  // the machine leaving its states, or its launch no longer enrolled
  await w.db.batch([stmt(`UPDATE machines SET state = 'stopping' WHERE id = ?`, l.machineId)]);
  await refused(await beat(l.token), "machine stopping");
  await w.db.batch([stmt(`UPDATE machines SET state = 'saving' WHERE id = ?`, l.machineId)]);
  assert.equal((await beat(l.token)).status, 200); // (saving is a state its agent may act in)
  await w.db.batch([stmt(`DELETE FROM machine_heartbeats WHERE machine_id = ?`, l.machineId), stmt(`UPDATE machines SET state = 'running' WHERE id = ?`, l.machineId)]);
  await w.db.batch([stmt(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'deadline', next_ms = ? WHERE machine_id = ?`, w.clock.t, l.machineId)]);
  await refused(await beat(l.token), "the launch ending");
  // malformed pins: everything refused, with an alert
  await w.db.batch([stmt(`UPDATE launches SET outcome = 'enrolled', terminate_reason = NULL, next_ms = NULL WHERE machine_id = ?`, l.machineId)]);
  keys = null;
  await refused(await beat(l.token), "pins not ready");
  assert.deepEqual(w.alerts, ["agent auth: the pinned public keys aren't ready"]);
});

test("agent auth: a malformed pin map yields no keys", async () => {
  for (const bad of [undefined, "", "{", "[]", JSON.stringify({ k1: KP.pub, k2: "x" }), JSON.stringify({ "bad kid": KP.pub })]) assert.equal(await loadAgentPublicKeys(bad), null, String(bad));
  const two = await loadAgentPublicKeys(JSON.stringify({ k1: KP.pub, k2: OTHER.pub }));
  assert.deepEqual([...two!.keys()], ["k1", "k2"]);
});

// ---------------------------------------------------------------- the report

test("heartbeat: the report is kept per incarnation, upserted, with the save estimate", async () => {
  const l = await enrolled();
  w.clock.t += 30_000;
  const full = report({
    uptimeS: 90,
    activity: { lastTerminalInputAt: iso(w.clock.t - 1000), lastJupyterActivityAt: iso(l.enrollMs), gpuUtilPct: 100, gpuMemUsedMiB: 4 * 1024 * 1024 },
    idleSince: iso(w.clock.t + 30_000),
    save: { state: "saving", lastSavedAt: iso(l.enrollMs), progress: { bytesDone: 5, bytesTotal: 10 }, error: "x".repeat(200), snapshotId: newId("snapshot"), dirtyBytes: 20_000_000 },
  });
  assert.equal((await beat(l.token, full)).status, 200);
  const r = (await hbRow(l.machineId))[0]!;
  assert.deepEqual(
    [r.incarnation, r.last_ms, r.uptime_s, r.gpu_util_pct, r.gpu_mem_used_mib, r.save_state, r.save_bytes_done, r.save_bytes_total, r.dirty_bytes, r.idle_since_ms],
    [1, w.clock.t, 90, 100, 4 * 1024 * 1024, "saving", 5, 10, 20_000_000, w.clock.t + 30_000],
  );
  assert.equal((await w.db.all<{ s: number }>(`SELECT save_estimate_seconds AS s FROM machines WHERE id = ?`, [l.machineId]))[0]!.s, 61);
  w.clock.t += 30_000;
  assert.equal((await beat(l.token)).status, 200);
  const r2 = await hbRow(l.machineId);
  assert.deepEqual([r2.length, r2[0]!.last_ms, r2[0]!.save_state, r2[0]!.save_error], [1, w.clock.t, "idle", null]);
});

test("heartbeat: an enrolled machine whose enroll record is missing is refused (never a 500)", async () => {
  const l = await enrolled();
  await w.db.batch([stmt(`DELETE FROM gate_reports WHERE machine_id = ?`, l.machineId)]);
  const r = await beat(l.token);
  assert.deepEqual([r.status, r.out], [401, { error: { code: "unauthenticated", message: "refused" } }]);
  assert.deepEqual(await hbRow(l.machineId), []);
});

test("heartbeat: every malformed or out-of-bounds report is a 400, with nothing written", async () => {
  const l = await enrolled();
  w.clock.t += 30_000;
  const now = w.clock.t;
  const act = (o: Record<string, unknown>) => ({ activity: { lastTerminalInputAt: null, lastJupyterActivityAt: null, gpuUtilPct: null, gpuMemUsedMiB: null, ...o } });
  const save = (o: Record<string, unknown>) => ({ save: { state: "idle", lastSavedAt: null, progress: null, error: null, snapshotId: null, dirtyBytes: 0, ...o } });
  const bad: Record<string, unknown>[] = [
    { incarnation: 2 },
    { uptimeS: -1 }, { uptimeS: 10_000_001 }, { uptimeS: 1.5 },
    { extra: 1 },
    act({ gpuUtilPct: 101 }), act({ gpuMemUsedMiB: 4 * 1024 * 1024 + 1 }), act({ extra: 1 }),
    act({ lastTerminalInputAt: iso(now + 30_001) }), // (past the skew)
    act({ lastTerminalInputAt: iso(l.enrollMs - 1) }), // (before enroll)
    act({ lastTerminalInputAt: "2027-01-01" }), // (not canonical)
    act({ lastTerminalInputAt: iso(now).replace("Z", "+00:00") }), // (the same instant, another spelling)
    { idleSince: 5 },
    save({ state: "other" }), save({ dirtyBytes: -1 }), save({ extra: 1 }),
    save({ progress: { bytesDone: 11, bytesTotal: 10 } }), save({ progress: { bytesDone: 1 } }),
    save({ error: "" }), save({ error: "x".repeat(201) }), save({ error: "é".repeat(101) }), save({ error: "a\u0000b" }),
    save({ snapshotId: "nope" }),
  ];
  for (const over of bad) {
    const r = await beat(l.token, report(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.deepEqual(await hbRow(l.machineId), [], JSON.stringify(over));
  }
  const missing = report();
  delete (missing as Record<string, unknown>).save;
  assert.equal((await beat(l.token, missing)).status, 400);
  assert.equal((await beat(l.token, report(act({ lastTerminalInputAt: iso(now + 30_000) })))).status, 200); // (the skew's edge)
});

// ---------------------------------------------------------------- the refresh

test("refresh: a fresh token exactly when 15 minutes or less are left; none, with an alert, while the signer isn't ready", async () => {
  const l = await enrolled();
  const t0 = w.clock.t;
  const exp = Math.floor(t0 / 1000) + 3600;
  w.clock.t = (exp - 901) * 1000;
  const early = await beat(l.token);
  assert.deepEqual([early.status, early.out], [200, { commands: [] }]);
  w.clock.t = (exp - 900) * 1000;
  const r = await beat(l.token);
  assert.equal(r.status, 200);
  const v = await verifyToken(r.out.agentToken, new Map([["k1", KP.publicKey]]), "agent", exp - 900);
  assert.ok(v.ok);
  assert.deepEqual([v.claims.mch, v.claims.inc, v.claims.iat, v.claims.exp], [l.machineId, 1, exp - 900, exp - 900 + 3600]);
  assert.equal(r.out.agentTokenExpiresAt, iso((exp - 900 + 3600) * 1000));
  // the new token works; the old one too, until its own expiry
  assert.equal((await beat(r.out.agentToken as string)).status, 200);
  signer = null;
  const none = await beat(l.token);
  assert.deepEqual([none.status, none.out], [200, { commands: [] }]);
  assert.deepEqual(w.alerts, ["heartbeat: the agent signer isn't ready; no refresh"]);
});

// ---------------------------------------------------------------- the heartbeat watchdog

test("watchdog: silent for more than 120 s (exactly 120 s is alive), by the last heartbeat or, with none, by enroll; then the VM watchdog ends it", async () => {
  const a = await enrolled(); // (no heartbeat yet)
  const b = await enrolled();
  w.clock.t += 10_000;
  assert.equal((await beat(b.token)).status, 200);
  const hb = w.clock.t;
  // (b's machine is running once enrolled)
  w.clock.t = a.enrollMs + HEARTBEAT_LOST_MS;
  assert.equal(await runHeartbeatWatchdog(env()), 0);
  w.clock.t = a.enrollMs + HEARTBEAT_LOST_MS + 1;
  assert.equal(await runHeartbeatWatchdog(env()), 1);
  assert.deepEqual([(await launch(a.machineId)).outcome, (await launch(a.machineId)).terminate_reason], ["terminate", "heartbeat-lost"]);
  assert.equal((await launch(b.machineId)).outcome, "enrolled");
  w.clock.t = hb + HEARTBEAT_LOST_MS;
  assert.equal(await runHeartbeatWatchdog(env()), 0);
  w.clock.t = hb + HEARTBEAT_LOST_MS + 1;
  assert.equal(await runHeartbeatWatchdog(env()), 1);
  assert.equal((await launch(b.machineId)).terminate_reason, "heartbeat-lost");
  // the lost machines' agents are refused at once; the VM watchdog terminates them
  assert.equal((await beat(a.token)).status, 401);
  assert.equal(await runVmWatchdog(env()), 2);
  assert.deepEqual(vm.terminated.sort(), [a.pid, b.pid].sort());
  assert.equal(await runHeartbeatWatchdog(env()), 0); // (nothing left to mark)
});

test("watchdog race: a heartbeat landing after the stale read leaves the launch alone (with a row, and with none yet)", async () => {
  for (const withRow of [true, false]) {
    const l = await enrolled();
    if (withRow) {
      w.clock.t += 1000;
      assert.equal((await beat(l.token)).status, 200);
    }
    w.clock.t += HEARTBEAT_LOST_MS + 1;
    const before = await launch(l.machineId);
    // the fresh heartbeat lands between the watchdog's read and its batch
    const realBatch = w.db.batch;
    (w.db as { batch: Db["batch"] }).batch = async (stmts) => {
      (w.db as { batch: Db["batch"] }).batch = realBatch;
      assert.equal((await beat(l.token)).status, 200);
      return realBatch(stmts);
    };
    const n = await runHeartbeatWatchdog(env());
    if (withRow) assert.equal(n, 0); // (the first iteration is the only machine: nothing marked, nothing counted)
    (w.db as { batch: Db["batch"] }).batch = realBatch;
    assert.deepEqual(await launch(l.machineId), { ...before, heartbeat_due_ms: w.clock.t + HEARTBEAT_LOST_MS }, `withRow ${withRow}`); // (only moved on)
  }
});

test("watchdog race: the machine, its incarnation or the launch changing after the read leaves it alone; unchanged, it's marked", async () => {
  const changes: Array<[string, (m: string) => Promise<void>]> = [
    ["machine stopping", (m) => w.db.batch([stmt(`UPDATE machines SET state = 'stopping' WHERE id = ?`, m)])],
    ["another incarnation", (m) => w.db.batch([stmt(`UPDATE machines SET incarnation = 2 WHERE id = ?`, m)])],
    ["the launch claimed", (m) => w.db.batch([stmt(`UPDATE launches SET watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, m)])],
    ["a heartbeat moved the due time", (m) => w.db.batch([stmt(`UPDATE launches SET heartbeat_due_ms = heartbeat_due_ms + 1 WHERE machine_id = ?`, m)])],
  ];
  for (const [why, change] of changes) {
    const l = await enrolled();
    w.clock.t += 1000;
    assert.equal((await beat(l.token)).status, 200);
    w.clock.t += HEARTBEAT_LOST_MS + 1;
    const realBatch = w.db.batch;
    (w.db as { batch: Db["batch"] }).batch = async (stmts) => {
      (w.db as { batch: Db["batch"] }).batch = realBatch;
      await change(l.machineId);
      return realBatch(stmts);
    };
    await runHeartbeatWatchdog(env()); // (earlier iterations' machines may be marked: only this one matters)
    (w.db as { batch: Db["batch"] }).batch = realBatch;
    assert.notEqual((await launch(l.machineId)).terminate_reason, "heartbeat-lost", why);
  }
  // and a stale one left unchanged is marked
  const l = await enrolled();
  w.clock.t += HEARTBEAT_LOST_MS + 1;
  await runHeartbeatWatchdog(env());
  assert.equal((await launch(l.machineId)).terminate_reason, "heartbeat-lost");
});

test("watchdog: both classes merged by age under one bound, so neither starves the other; the scan examines only the bound", async () => {
  const noRow: string[] = [];
  const withRow: string[] = [];
  // ages interleave: a no-row machine enrolled, then a heartbeat from a row machine, alternately
  for (let i = 0; i < 15; i++) {
    noRow.push((await enrolled()).machineId);
    w.clock.t += 10;
    const r = await enrolled();
    assert.equal((await beat(r.token)).status, 200);
    withRow.push(r.machineId);
    w.clock.t += 10;
  }
  w.clock.t += HEARTBEAT_LOST_MS + 1;
  const picked = await w.db.all<{ machine_id: string }>(HEARTBEAT_WATCHDOG_SELECT, [w.clock.t, HEARTBEAT_WATCHDOG_BATCH]);
  assert.equal(picked.length, HEARTBEAT_WATCHDOG_BATCH);
  const ids = new Set(picked.map((p) => p.machine_id));
  assert.deepEqual([noRow.slice(0, 10).every((m) => ids.has(m)), withRow.slice(0, 10).every((m) => ids.has(m))], [true, true]);
  assert.equal(await runHeartbeatWatchdog(env()), 20);
  assert.equal(await runHeartbeatWatchdog(env()), 10);
  // the plan: a range search of the due index in its order, the machine by its key; never a
  // scan of a table or an index, never a sort
  const plan = (w.db.raw.prepare(`EXPLAIN QUERY PLAN ${HEARTBEAT_WATCHDOG_SELECT}`).all(w.clock.t, 20) as Array<{ detail: string }>).map((p) => p.detail);
  assert.ok(plan.some((d) => /^SEARCH v USING INDEX launches_heartbeat_due \(heartbeat_due_ms<\?\)$/.test(d)), JSON.stringify(plan));
  assert.ok(plan.some((d) => /^SEARCH m USING INDEX sqlite_autoindex_machines_1 \(id=\?\)$|^SEARCH m USING PRIMARY KEY/.test(d)), JSON.stringify(plan));
  assert.ok(plan.every((d) => !/\bSCAN\b|TEMP B-TREE/.test(d)), JSON.stringify(plan));
  // (and the index holds enrolled launches only: ended ones, which keep their due times, are never examined)
  const idx = w.db.raw.prepare(`SELECT sql FROM sqlite_master WHERE name = 'launches_heartbeat_due'`).get() as { sql: string };
  assert.match(idx.sql, / WHERE outcome = 'enrolled' AND mode = 'vm'$/);
});

test("heartbeat: crossed requests never regress the report, the save estimate or the due time; no loss until 120 s after the newest", async () => {
  const l = await enrolled();
  w.clock.t += 1000;
  const t0 = w.clock.t;
  const old = report({ uptimeS: 1, save: { state: "saving", lastSavedAt: null, progress: null, error: null, snapshotId: null, dirtyBytes: 50_000_000_000 } });
  const newer = report({ uptimeS: 31 });
  // A is sampled at t0 and held just before its batch; B, 30 s later, commits; then A commits
  const realBatch = w.db.batch;
  let b: { status: number } | null = null;
  (w.db as { batch: Db["batch"] }).batch = async (stmts) => {
    (w.db as { batch: Db["batch"] }).batch = realBatch;
    w.clock.t = t0 + 30_000;
    b = await beat(l.token, newer);
    return realBatch(stmts);
  };
  const a = await beat(l.token, old);
  (w.db as { batch: Db["batch"] }).batch = realBatch;
  assert.deepEqual([a.status, b!.status], [200, 200]);
  const r = (await hbRow(l.machineId))[0]!;
  assert.deepEqual([r.last_ms, r.uptime_s, r.save_state, r.dirty_bytes], [t0 + 30_000, 31, "idle", 0]);
  assert.equal((await w.db.all<{ s: number }>(`SELECT save_estimate_seconds AS s FROM machines WHERE id = ?`, [l.machineId]))[0]!.s, finalSaveReserveSeconds(0));
  assert.notEqual(finalSaveReserveSeconds(0), finalSaveReserveSeconds(50_000_000_000)); // (so the row above tells them apart)
  assert.equal((await launch(l.machineId)).heartbeat_due_ms, t0 + 30_000 + HEARTBEAT_LOST_MS);
  // 120 s after the older request: the newer is 90 s old, alive
  w.clock.t = t0 + HEARTBEAT_LOST_MS + 1;
  assert.equal(await runHeartbeatWatchdog(env()), 0);
  w.clock.t = t0 + 30_000 + HEARTBEAT_LOST_MS;
  assert.equal(await runHeartbeatWatchdog(env()), 0);
  w.clock.t += 1;
  assert.equal(await runHeartbeatWatchdog(env()), 1);
});

test("heartbeat: a report at the same instant as the stored one doesn't replace it (the first committed stays)", async () => {
  const l = await enrolled();
  w.clock.t += 1000;
  const estimate = async () => (await w.db.all<{ s: number }>(`SELECT save_estimate_seconds AS s FROM machines WHERE id = ?`, [l.machineId]))[0]!.s;
  assert.equal((await beat(l.token, report({ uptimeS: 7 }))).status, 200);
  const est = await estimate();
  const big = report({ uptimeS: 8, save: { state: "idle", lastSavedAt: null, progress: null, error: null, snapshotId: null, dirtyBytes: 50_000_000_000 } });
  assert.equal((await beat(l.token, big)).status, 200);
  assert.deepEqual([(await hbRow(l.machineId))[0]!.uptime_s, await estimate()], [7, est]);
  w.clock.t += 1;
  assert.equal((await beat(l.token, big)).status, 200);
  assert.deepEqual([(await hbRow(l.machineId))[0]!.uptime_s, await estimate()], [8, finalSaveReserveSeconds(50_000_000_000)]);
});

test("schema (0013): the due time only moves later; a report only gives way to a newer one; enrolled has a due time", async () => {
  const l = await enrolled();
  const due = (await launch(l.machineId)).heartbeat_due_ms as number;
  assert.equal(due, l.enrollMs + HEARTBEAT_LOST_MS);
  const setDue = (v: number | null) => w.db.batch([stmt(`UPDATE launches SET heartbeat_due_ms = ? WHERE machine_id = ?`, v, l.machineId)]);
  await assert.rejects(setDue(due - 1), /only moves later/);
  await assert.rejects(setDue(null), /only moves later/);
  await setDue(due);
  await setDue(due + 1);
  w.clock.t += 1000;
  assert.equal((await beat(l.token)).status, 200);
  const setLast = (d: number) => w.db.batch([stmt(`UPDATE machine_heartbeats SET last_ms = last_ms + ? WHERE machine_id = ?`, d, l.machineId)]);
  await assert.rejects(setLast(0), /only replaced by a newer one/);
  await assert.rejects(setLast(-1), /only replaced by a newer one/);
  await setLast(1);
  // an enrolled launch without a due time
  const m = await enrolled();
  await w.db.batch([stmt(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'deadline', next_ms = ? WHERE machine_id = ?`, w.clock.t, m.machineId)]);
  w.db.raw.exec(`DROP TRIGGER launches_heartbeat_due_later`);
  await w.db.batch([stmt(`UPDATE launches SET heartbeat_due_ms = NULL WHERE machine_id = ?`, m.machineId)]); // (allowed outside enrolled)
  await assert.rejects(w.db.batch([stmt(`UPDATE launches SET outcome = 'enrolled', terminate_reason = NULL, next_ms = NULL WHERE machine_id = ?`, m.machineId)]), /CHECK/);
});

test("schema (0013): heartbeat rows are bounded; the rebuild refuses existing launches", async () => {
  const l = await enrolled();
  const ins = (over: Record<string, unknown>) => {
    const v = { machine_id: l.machineId, incarnation: 1, last_ms: 0, uptime_s: 0, save_state: "idle", dirty_bytes: 0, ...over };
    const cols = Object.keys(v);
    return w.db.batch([{ sql: `INSERT INTO machine_heartbeats (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, params: Object.values(v) as never[] }]);
  };
  const NUL = String.fromCharCode(0);
  for (const bad of [
    { save_state: "other" }, { gpu_util_pct: 101 }, { uptime_s: 10_000_001 },
    { save_error: "" }, { save_error: "x".repeat(201) }, { save_error: "é".repeat(101) }, { save_error: "a" + NUL },
    { save_snapshot_id: "x".repeat(65) }, { save_snapshot_id: "s" + NUL },
    { save_bytes_done: 1 }, { save_bytes_done: 2, save_bytes_total: 1 },
    { machine_id: newId("machine") },
  ]) await assert.rejects(ins(bad), JSON.stringify(bad).slice(0, 60));
  await ins({ save_error: "x".repeat(200), save_bytes_done: 1, save_bytes_total: 1 });
  // the rebuild guard
  const { sqliteDb } = await import("./testing/sqlite.ts");
  assert.throws(
    () =>
      sqliteDb({
        upgrade: {
          at: "0013",
          seed(r) {
            r.exec("PRAGMA foreign_keys = OFF");
            r.prepare(`INSERT INTO vm_launches (machine_id, incarnation, provider, nonce_sha256, boot_script_sha256, agent_sha256, outcome, next_ms, created_ms)
                       VALUES ('mch_x', 1, 'hyperstack', ?, ?, ?, 'creating', 0, 0)`).run(SCRIPT, SCRIPT, AGENT);
            r.exec("PRAGMA foreign_keys = ON");
          },
        },
      }),
    /malformed JSON/,
  );
});

test("watchdog: a launch whose machine isn't running is deferred 120 s, not marked, so it leaves the batch's places", async () => {
  const idle: string[] = [];
  for (let i = 0; i < HEARTBEAT_WATCHDOG_BATCH; i++) idle.push((await enrolled()).machineId);
  await w.db.batch(idle.map((m) => stmt(`UPDATE machines SET state = 'saving' WHERE id = ?`, m)));
  w.clock.t += 10;
  const live = await enrolled();
  w.clock.t += HEARTBEAT_LOST_MS + 1;
  assert.equal(await runHeartbeatWatchdog(env()), 0); // (the batch: the 20 oldest, all deferred)
  for (const m of idle) assert.deepEqual([(await launch(m)).outcome, (await launch(m)).heartbeat_due_ms], ["enrolled", w.clock.t + HEARTBEAT_LOST_MS]);
  assert.equal(await runHeartbeatWatchdog(env()), 1);
  assert.equal((await launch(live.machineId)).terminate_reason, "heartbeat-lost");
  // deferred, then running again and still silent: marked at its new due time, not before
  await w.db.batch(idle.map((m) => stmt(`UPDATE machines SET state = 'running' WHERE id = ?`, m)));
  w.clock.t += HEARTBEAT_LOST_MS;
  assert.equal(await runHeartbeatWatchdog(env()), 0);
  w.clock.t += 1;
  assert.equal(await runHeartbeatWatchdog(env()), HEARTBEAT_WATCHDOG_BATCH);
});

test("watchdog race: the machine running again between the read and a deferral leaves the launch as it is", async () => {
  const l = await enrolled();
  await w.db.batch([stmt(`UPDATE machines SET state = 'saving' WHERE id = ?`, l.machineId)]);
  w.clock.t += HEARTBEAT_LOST_MS + 1;
  const before = await launch(l.machineId);
  const realBatch = w.db.batch;
  (w.db as { batch: Db["batch"] }).batch = async (stmts) => {
    (w.db as { batch: Db["batch"] }).batch = realBatch;
    await w.db.batch([stmt(`UPDATE machines SET state = 'running' WHERE id = ?`, l.machineId)]);
    return realBatch(stmts);
  };
  assert.equal(await runHeartbeatWatchdog(env()), 0);
  (w.db as { batch: Db["batch"] }).batch = realBatch;
  assert.deepEqual(await launch(l.machineId), before);
  assert.equal(await runHeartbeatWatchdog(env()), 1); // (then, running and silent, it's marked)
});
