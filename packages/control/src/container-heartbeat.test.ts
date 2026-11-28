import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { newId, signToken, type AgentClaims, type Key } from "@sbgpu/api";
import type { ProviderMachineStatus, LaunchSpec } from "@sbgpu/providers";
import { machineName, nameFields } from "@sbgpu/providers";
import { stmt } from "./db.ts";
import { CONNECT_WINDOW_MS, CONTAINER_LIFETIME_SELECT, launchContainer, runContainerLifetime, recordContainerId, recordContainerIntent, recordFirstRunning, runContainerWatchdog, type ContainerEnv, type ContainerProvider } from "./container.ts";
import { ERADICATION_CHECKS } from "./enroll.ts";
import { HEARTBEAT_LOST_MS, HEARTBEAT_WATCHDOG_BATCH, HEARTBEAT_WATCHDOG_SELECT, runHeartbeatWatchdog } from "./heartbeat.ts";
import { containerLifetime } from "./jobs.ts";
import { loadAgentPublicKeys, loadAgentSigner } from "./signer.ts";
import { WATCHDOG_BATCH, type JobEnv } from "./vm.ts";
import { ORIGIN, T0, addMember, world, type World } from "./testing/world.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const AGENT = sha("the agent");
const IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";
const LAUNCHER = ["/opt/sbgpu/launcher", "--boot"];
const BOOT_ENV = "SBGPU_BOOT_TOKEN";
const RATE = { providerCostPerHour: 590_000, marginBps: 3000 };
const LIFE_MS = 8 * 3600_000;

/** A RunPod holding running pods, each showing the launch's shape; terminate removes one, and a missing pod reads terminated. */
class FakeRunPod implements ContainerProvider {
  pods = new Set<string>();
  owner = new Map<string, string>();
  terminated: string[] = [];
  /** Each create's boot token (the pod's env), by pod. */
  tokens = new Map<string, string>();
  n = 0;
  async launch(spec: LaunchSpec): Promise<{ providerMachineId: string }> {
    const id = `pod${++this.n}`;
    this.pods.add(id);
    this.owner.set(id, spec.machineId);
    this.tokens.set(id, spec.bootToken);
    return { providerMachineId: id };
  }
  async status(id: string): Promise<ProviderMachineStatus> {
    if (!this.pods.has(id)) return { provider: "runpod", providerMachineId: id, machineId: null, parsedName: null, state: "terminated" } as ProviderMachineStatus;
    return {
      provider: "runpod", providerMachineId: id, ...nameFields(machineName("test", this.owner.get(id)!, 1)), state: "running", rawStatus: "RUNNING",
      gpuType: "A40", gpuCount: 1, dataCenter: "EU-SE-1", image: IMAGE, diskGb: 20, volumeGb: 0, exposedPorts: [], command: [...LAUNCHER], envNames: [BOOT_ENV],
      unexpectedSettings: [], providerCostPerHour: RATE.providerCostPerHour, observedAt: new Date(T0).toISOString(),
    } as ProviderMachineStatus;
  }
  async terminate(id: string): Promise<void> {
    this.terminated.push(id);
    this.pods.delete(id);
  }
  async listMachines(): Promise<ProviderMachineStatus[]> {
    return [];
  }
}

async function keyPair() {
  const k = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as { privateKey: Key; publicKey: Key };
  const priv = (await crypto.subtle.exportKey("jwk", k.privateKey)) as Record<string, unknown>;
  const pub = (await crypto.subtle.exportKey("jwk", k.publicKey)) as Record<string, unknown>;
  return { priv: { kty: priv.kty, crv: priv.crv, d: priv.d, x: priv.x }, pub: { kty: pub.kty, crv: pub.crv, x: pub.x } };
}
const KP = await keyPair();
const PINS = JSON.stringify({ k1: KP.pub });
const SIGNER = (await loadAgentSigner(JSON.stringify(KP.priv), "k1", PINS))!;
const KEYS = (await loadAgentPublicKeys(PINS))!;

let w: World;
let rp: FakeRunPod;
let memberId: string;
let allocationId: string;
beforeEach(async () => {
  rp = new FakeRunPod();
  w = await world({ agentSigner: async () => SIGNER, agentPublicKeys: async () => KEYS, container: { provider: rp, expect: { image: IMAGE, launcher: LAUNCHER, bootEnv: BOOT_ENV } } });
  memberId = await addMember(w, "m@example.com", "member", { allocation: 0 });
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
});

const cenv = (): ContainerEnv => ({
  installation: "test",
  db: w.db,
  clock: () => w.clock.t,
  provider: rp,
  expect: { image: IMAGE, launcher: LAUNCHER, bootEnv: BOOT_ENV },
  randomBytes: (n) => randomBytes(n),
  elapsedMs: () => 0,
});
const jenv = (): JobEnv => ({ db: w.db, now: w.clock.t, vm: null, elapsedMs: () => 0 });

/**
 * A container launch taken as far as `upTo`: its intent, id and accrual (#73's batches), first
 * running at T0 + 1000, and, for "enrolled", the writes container enroll makes at `enrollAt` (T0 + 2000 unless given; the
 * token used, the launch enrolled with its first heartbeat due and its lifetime, the machine
 * running). "revoked": the token used by a termination claim instead, never enrolled.
 */
async function container(upTo: "issued" | "enrolled" | "revoked" = "enrolled", enrollAt = T0 + 2000) {
  const machineId = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, ?, 'runpod', 'A40', 1, 'EU-SE-1', 'starting', 1, ?)`,
      machineId, w.projectId, allocationId, memberId, T0,
    ),
  ]);
  await recordContainerIntent(w.db, { machineId, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(machineId) });
  const pid = `pod-${machineId.slice(-6)}`;
  rp.pods.add(pid);
  assert.equal(await recordContainerId(w.db, machineId, 1, pid), "recorded");
  assert.equal(await recordFirstRunning(w.db, machineId, 1, pid, T0 + 1000), "recorded");
  if (upTo === "enrolled") {
    const at = enrollAt;
    await w.db.batch([
      stmt(`UPDATE boot_tokens SET used_ms = ? WHERE machine_id = ?`, at, machineId),
      stmt(
        `UPDATE launches SET outcome = 'enrolled', next_ms = NULL, heartbeat_due_ms = ?, max_end_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`,
        at + HEARTBEAT_LOST_MS, at + LIFE_MS, machineId,
      ),
      stmt(`UPDATE machines SET state = 'running' WHERE id = ?`, machineId),
    ]);
  } else if (upTo === "revoked") {
    await w.db.batch([
      stmt(`UPDATE boot_tokens SET used_ms = ? WHERE machine_id = ?`, T0 + 2000, machineId),
      stmt(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'abort', next_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, T0 + 2000, machineId),
    ]);
  }
  return { machineId, pid };
}

const agentToken = (mch: string) => {
  const iat = Math.floor(w.clock.t / 1000);
  return signToken({ v: 1, kind: "agent", jti: randomBytes(16).toString("base64url"), iat, exp: iat + 3600, mch, inc: 1 } as AgentClaims, SIGNER.privateKey, SIGNER.kid);
};
const iso = (ms: number) => new Date(ms).toISOString();
const report = (over: Record<string, unknown> = {}) => ({
  incarnation: 1,
  uptimeS: 60,
  activity: { lastTerminalInputAt: null, lastJupyterActivityAt: null, gpuUtilPct: 12, gpuMemUsedMiB: 1024 },
  idleSince: null,
  save: { state: "idle", lastSavedAt: null, progress: null, error: null, snapshotId: null, dirtyBytes: 0 },
  ...over,
});
async function beat(mch: string, body: unknown = report()) {
  const res = await w.app.fetch(
    new Request(`${ORIGIN}/v1/agent/heartbeat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await agentToken(mch)}` }, body: JSON.stringify(body) }),
  );
  await Promise.all(w.pending.splice(0));
  return res.status;
}
const launch = async (m: string) => ({ ...(await w.db.all<Record<string, unknown>>(`SELECT outcome, terminate_reason, next_ms, heartbeat_due_ms FROM launches WHERE machine_id = ?`, [m]))[0] });
const hbRows = async (m: string) => (await w.db.all<{ last_ms: number }>(`SELECT last_ms FROM machine_heartbeats WHERE machine_id = ?`, [m])).map((r) => r.last_ms);

// ================================================================ the handler

test("an enrolled container's heartbeat is kept and moves its due time on, as a VM's does", async () => {
  const c = await container();
  w.clock.t = T0 + 30_000;
  assert.equal(await beat(c.machineId), 200);
  assert.deepEqual(await hbRows(c.machineId), [T0 + 30_000]);
  assert.equal((await launch(c.machineId)).heartbeat_due_ms, T0 + 30_000 + HEARTBEAT_LOST_MS);
});

test("a container that never enrolled is refused (401) with nothing written: its window open, or its token revoked by a termination", async () => {
  for (const upTo of ["issued", "revoked"] as const) {
    const c = await container(upTo);
    w.clock.t = T0 + 30_000;
    const before = await launch(c.machineId);
    assert.equal(await beat(c.machineId), 401, upTo);
    assert.deepEqual(await hbRows(c.machineId), [], upTo);
    assert.deepEqual(await launch(c.machineId), before, upTo);
  }
  assert.ok(CONNECT_WINDOW_MS > 0);
});

test("the enroll time (the token's use) bounds a container report's times from below", async () => {
  const c = await container();
  w.clock.t = T0 + 30_000;
  assert.equal(await beat(c.machineId, report({ idleSince: iso(T0 + 1999) })), 400);
  assert.equal(await beat(c.machineId, report({ idleSince: iso(T0 + 2000) })), 200);
});

// ================================================================ the watchdog

test("a container silent past its due time is marked heartbeat-lost, then revoked and ended by the container watchdog", async () => {
  const c = await container();
  w.clock.t = T0 + 2000 + HEARTBEAT_LOST_MS;
  assert.equal(await runHeartbeatWatchdog(jenv()), 0, "not lost at exactly its due time");
  w.clock.t += 1;
  assert.equal(await runHeartbeatWatchdog(jenv()), 1);
  assert.deepEqual([(await launch(c.machineId)).outcome, (await launch(c.machineId)).terminate_reason, (await launch(c.machineId)).next_ms], ["terminate", "heartbeat-lost", w.clock.t]);
  assert.equal(await machineState(c.machineId), "stopping", "the machine leaves running in the mark's own batch");
  const revokedFirst = watchRevocation(c.machineId);
  assert.equal(await runContainerWatchdog(cenv()), 1);
  assert.deepEqual(rp.terminated, [c.pid]);
  assert.deepEqual(revokedFirst, [[true, "stopping"]]);
  assert.equal((await launch(c.machineId)).outcome, "terminated");
  assert.equal(await machineState(c.machineId), "stopped", "stopped once the pod is confirmed gone");
  const acc = (await w.db.all<{ end_ms: number | null }>(`SELECT end_ms FROM machine_accruals WHERE machine_id = ?`, [c.machineId]))[0]!;
  assert.equal(acc.end_ms, w.clock.t, "the accrual closed when the pod was confirmed gone");
});

const machineState = async (m: string) => (await w.db.all<{ state: string }>(`SELECT state FROM machines WHERE id = ?`, [m]))[0]!.state;

/** Records, at each provider terminate, whether the machine's token was used and its machine's state, as committed. */
function watchRevocation(m: string): [boolean, string][] {
  const seen: [boolean, string][] = [];
  const terminate = rp.terminate.bind(rp);
  rp.terminate = async (id) => {
    const t = (await w.db.all<{ used_ms: number | null }>(`SELECT used_ms FROM boot_tokens WHERE machine_id = ?`, [m]))[0]!;
    seen.push([t.used_ms !== null, await machineState(m)]);
    return terminate(id);
  };
  return seen;
}

test("revocation in the claim: a running or saving machine whose launch was marked without moving it leaves for stopping before the provider; stopped once gone", async () => {
  for (const from of ["running", "saving"]) {
    rp = new FakeRunPod();
    const c = await container();
    await w.db.run(`UPDATE machines SET state = ? WHERE id = ?`, [from, c.machineId]);
    // (a mark that left the machine as it was, as a stop path landing later might)
    await w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'abort', next_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, [w.clock.t, c.machineId]);
    const seen = watchRevocation(c.machineId);
    assert.equal(await runContainerWatchdog(cenv()), 1, from);
    assert.deepEqual(seen, [[true, "stopping"]], from);
    assert.deepEqual([(await launch(c.machineId)).outcome, await machineState(c.machineId)], ["terminated", "stopped"], from);
  }
});

test("revocation leaves a starting machine for the start path (no workspace or page tokens yet), a machine at another incarnation, and a VM's", async () => {
  // a pod never enrolled: ended at its connect deadline; the machine stays starting throughout
  const s = await container("issued");
  w.clock.t = T0 + 1000 + CONNECT_WINDOW_MS + 1;
  const seen = watchRevocation(s.machineId);
  assert.equal(await runContainerWatchdog(cenv()), 1);
  assert.deepEqual(seen, [[true, "starting"]]);
  // (starting until the pod is confirmed gone; then the terminated batch fails it, releasing its liability)
  assert.deepEqual([(await launch(s.machineId)).outcome, await machineState(s.machineId)], ["terminated", "failed"]);
  // the machine moved on to another incarnation: the old launch's end leaves it running
  const o = await container();
  await w.db.run(`UPDATE machines SET incarnation = 2 WHERE id = ?`, [o.machineId]);
  await w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'abort', next_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, [w.clock.t, o.machineId]);
  assert.equal(await runContainerWatchdog(cenv()), 1);
  assert.deepEqual([(await launch(o.machineId)).outcome, await machineState(o.machineId)], ["terminated", "running"]);
  // the same, with the newer incarnation already stopping: the old launch's end doesn't make it stopped
  const p = await container();
  await w.db.run(`UPDATE machines SET incarnation = 2, state = 'stopping' WHERE id = ?`, [p.machineId]);
  await w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'abort', next_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, [w.clock.t, p.machineId]);
  assert.equal(await runContainerWatchdog(cenv()), 1);
  assert.deepEqual([(await launch(p.machineId)).outcome, await machineState(p.machineId)], ["terminated", "stopping"]);
});

test("a heartbeat landing first keeps the container; a machine not running is deferred, not marked", async () => {
  const c = await container();
  w.clock.t = T0 + 2000 + HEARTBEAT_LOST_MS - 1;
  assert.equal(await beat(c.machineId), 200);
  w.clock.t = T0 + 2000 + HEARTBEAT_LOST_MS + 1;
  assert.equal(await runHeartbeatWatchdog(jenv()), 0);
  assert.equal((await launch(c.machineId)).outcome, "enrolled");
  // the machine saving (not running): its due time moves 120 s on
  const d = await container();
  await w.db.run(`UPDATE machines SET state = 'saving' WHERE id = ?`, [d.machineId]);
  w.clock.t = T0 + 2000 + HEARTBEAT_LOST_MS + 10;
  await runHeartbeatWatchdog(jenv());
  assert.deepEqual([(await launch(d.machineId)).outcome, (await launch(d.machineId)).heartbeat_due_ms], ["enrolled", w.clock.t + HEARTBEAT_LOST_MS]);
});

test("the watchdog's search takes VM and container launches alike, in due order", async () => {
  const a = await container();
  const b = await container();
  w.clock.t = T0 + 2000 + HEARTBEAT_LOST_MS + 1;
  const picked = (await w.db.all<{ machine_id: string }>(HEARTBEAT_WATCHDOG_SELECT, [w.clock.t, HEARTBEAT_WATCHDOG_BATCH])).map((r) => r.machine_id);
  assert.deepEqual(new Set(picked), new Set([a.machineId, b.machineId]));
});

test("end to end: launched, enrolled through the endpoint, then heartbeating with the agent token enroll returned", async () => {
  const machineId = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, ?, 'runpod', 'A40', 1, 'EU-SE-1', 'starting', 1, ?)`,
      machineId, w.projectId, allocationId, memberId, T0,
    ),
  ]);
  const spec = { machineId, gpuType: "A40", gpuCount: 1, dataCenter: "EU-SE-1", image: IMAGE, diskGb: 20, launcher: LAUNCHER, maxProviderCostPerHour: 1_000_000 };
  assert.equal(await launchContainer(cenv(), { machineId, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, spec }), "created");
  w.clock.t = T0 + 5000;
  const res = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bootToken: rp.tokens.get("pod1"), agentVersion: "0.1.0", agentSha256: AGENT, providerMachineId: "pod1", mode: "container",
      eradication: { ok: true, checks: ERADICATION_CHECKS.map((name) => ({ name, ok: true })) }, gpu: null, hostname: "pod1",
    }),
  }));
  const out = (await res.json()) as { agentToken: string };
  await Promise.all(w.pending.splice(0));
  assert.equal(res.status, 200, JSON.stringify(out));
  w.clock.t = T0 + 35_000;
  const hb = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/heartbeat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${out.agentToken}` }, body: JSON.stringify(report()) }));
  assert.equal(hb.status, 200);
  assert.deepEqual(await hbRows(machineId), [T0 + 35_000]);
  assert.equal((await launch(machineId)).heartbeat_due_ms, T0 + 35_000 + HEARTBEAT_LOST_MS);
});

// ---------------------------------------------------------------- the hard lifetime

test("lifetime, through the scheduled job: an enrolled container at its max_end_ms (not a millisecond before) is marked max-session with its machine stopping, then revoked and ended", async () => {
  const c = await container();
  const end = T0 + 2000 + LIFE_MS;
  assert.equal((await w.db.all<{ max_end_ms: number }>(`SELECT max_end_ms FROM launches WHERE machine_id = ?`, [c.machineId]))[0]!.max_end_ms, end);
  w.clock.t = end - 1;
  assert.equal(await containerLifetime.run(jenv()), 0);
  assert.deepEqual([(await launch(c.machineId)).outcome, await machineState(c.machineId)], ["enrolled", "running"]);
  w.clock.t = end;
  assert.equal(await containerLifetime.run(jenv()), 1);
  const l = await launch(c.machineId);
  assert.deepEqual([l.outcome, l.terminate_reason, l.next_ms, await machineState(c.machineId)], ["terminate", "max-session", end, "stopping"]);
  // its agent is refused at once
  assert.equal(await beat(c.machineId), 401);
  const seen = watchRevocation(c.machineId);
  assert.equal(await runContainerWatchdog(cenv()), 1);
  assert.deepEqual([rp.terminated, seen], [[c.pid], [[true, "stopping"]]]);
  assert.deepEqual([(await launch(c.machineId)).outcome, await machineState(c.machineId)], ["terminated", "stopped"]);
  const acc = (await w.db.all<{ end_ms: number | null }>(`SELECT end_ms FROM machine_accruals WHERE machine_id = ?`, [c.machineId]))[0]!;
  assert.equal(acc.end_ms, end, "the accrual closed when the pod was confirmed gone");
  assert.equal(await containerLifetime.run(jenv()), 0, "nothing left to mark");
});

test("lifetime: a launch another mark ended first, or one changed after the read, is left as it is; a launch not yet enrolled has no lifetime", async () => {
  const end = T0 + 2000 + LIFE_MS;
  // heartbeat-lost came first
  const a = await container();
  w.clock.t = T0 + 2000 + HEARTBEAT_LOST_MS + 1;
  assert.equal(await runHeartbeatWatchdog(jenv()), 1);
  // changed between the lifetime job's read and its mark (a heartbeat-lost mark lands then)
  w.clock.t = T0;
  const b = await container();
  const batch = w.db.batch.bind(w.db);
  let raced = false;
  w.db.batch = async (ss) => {
    if (!raced && ss.some((s) => /terminate_reason = 'max-session'/.test(s.sql))) {
      raced = true;
      await w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'heartbeat-lost', next_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, [end, b.machineId]);
    }
    return batch(ss);
  };
  // never enrolled: issued, past the lifetime it would have had
  const i = await container("issued");
  w.clock.t = end + 5000;
  try {
    assert.equal(await runContainerLifetime(jenv()), 0);
  } finally {
    w.db.batch = batch;
  }
  assert.ok(raced);
  assert.equal((await launch(a.machineId)).terminate_reason, "heartbeat-lost");
  assert.deepEqual([(await launch(b.machineId)).terminate_reason, await machineState(b.machineId)], ["heartbeat-lost", "running"], "the failed mark moved nothing");
  assert.deepEqual([(await launch(i.machineId)).outcome, await machineState(i.machineId)], ["issued", "starting"]);
});

test("lifetime: at most a batch a run, earliest lifetime first; the search is a range scan of the lifetime index, nothing sorted", async () => {
  const ids: string[] = [];
  for (let k = 0; k <= WATCHDOG_BATCH; k++) ids.push((await container("enrolled", T0 + 2000 + (WATCHDOG_BATCH - k) * 1000)).machineId); // (later fixtures end earlier)
  w.clock.t = T0 + WATCHDOG_BATCH * 1000 + 2000 + LIFE_MS;
  assert.equal(await runContainerLifetime(jenv()), WATCHDOG_BATCH);
  assert.equal((await launch(ids[0]!)).outcome, "enrolled", "the latest lifetime waits for the next run");
  for (const m of ids.slice(1)) assert.equal((await launch(m)).terminate_reason, "max-session");
  assert.equal(await runContainerLifetime(jenv()), 1);
  const plan = (w.db.raw.prepare(`EXPLAIN QUERY PLAN ${CONTAINER_LIFETIME_SELECT}`).all(w.clock.t, WATCHDOG_BATCH) as Array<{ detail: string }>).map((p) => p.detail);
  assert.ok(plan.some((d) => /^SEARCH launches USING (COVERING )?INDEX launches_container_lifetime \(max_end_ms<\?\)$/.test(d)), JSON.stringify(plan));
  assert.ok(plan.every((d) => !/\bSCAN\b|TEMP B-TREE/.test(d)), JSON.stringify(plan));
});
