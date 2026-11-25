import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { VM_GATE_WORDS, newId, verifyToken, type Key } from "@sbgpu/api";
import type { Db } from "./db.ts";
import { stmt } from "./db.ts";
import { loadAgentSigner, type AgentSigner } from "./signer.ts";
import { HEARTBEAT_SECONDS, IDLE_GPU_UTIL_PCT } from "./enroll.ts";
import { recordActive, recordLaunchIntent, recordProviderId, runVmWatchdog, type InstanceFacts, type JobEnv, type VmProvider } from "./vm.ts";
import { ORIGIN, T0, addMember, world, type World } from "./testing/world.ts";

const IP = "203.0.113.7";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SCRIPT = sha("#!/bin/sh\n# the VM-mode boot script\n");
const AGENT = sha("the agent");
const PID = "vm-1";

class FakeVm implements VmProvider {
  facts = new Map<string, InstanceFacts>();
  terminated: string[] = [];
  failTerminates = 0;
  /** Runs inside instanceFacts, before it answers (a race injected during the provider read). */
  during: (() => Promise<void>) | null = null;
  throwFacts = false;
  factsCalls = 0;
  async instanceFacts(id: string): Promise<InstanceFacts> {
    this.factsCalls++;
    if (this.during) {
      const d = this.during;
      this.during = null;
      await d();
    }
    if (this.throwFacts) throw new Error("provider down");
    return this.facts.get(id) ?? "unavailable";
  }
  async terminate(id: string): Promise<void> {
    this.terminated.push(id);
    if (this.failTerminates > 0) {
      this.failTerminates--;
      throw new Error("provider down");
    }
    this.facts.set(id, { state: "absent", ipv4: null, exclusive: false });
  }
}

// ---- the signer (generated per run; never a real key)

async function keyPair() {
  const k = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as { privateKey: Key; publicKey: Key };
  const priv = (await crypto.subtle.exportKey("jwk", k.privateKey)) as Record<string, unknown>;
  const pub = (await crypto.subtle.exportKey("jwk", k.publicKey)) as Record<string, unknown>;
  return { priv: { kty: priv.kty, crv: priv.crv, d: priv.d, x: priv.x }, pub: { kty: pub.kty, crv: pub.crv, x: pub.x }, publicKey: k.publicKey };
}
const KP = await keyPair();
const OTHER = await keyPair();
const signerText = { jwk: JSON.stringify(KP.priv), kid: "k1", pins: JSON.stringify({ k1: KP.pub }) };
const SIGNER = (await loadAgentSigner(signerText.jwk, signerText.kid, signerText.pins))!;

let w: World;
let vm: FakeVm;
let signer: AgentSigner | null;
let memberId: string;
let allocationId: string;
beforeEach(async () => {
  vm = new FakeVm();
  signer = SIGNER;
  w = await world({ vm, agentSigner: async () => signer });
  memberId = await addMember(w, "m@example.com", "member", { allocation: 0 });
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
});

/** A machine launched, ACTIVE and announced: its boot token, as the VM received it. */
async function issued(o: { ipv4?: string } = {}) {
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
  const pid = `${PID}-${machineId.slice(-6)}`;
  assert.equal(await recordProviderId(w.db, machineId, 1, pid), "recorded");
  assert.equal(await recordActive(w.db, machineId, 1, { providerMachineId: pid, ipv4: o.ipv4 ?? IP, firstActiveMs: T0 }), "launched");
  vm.facts.set(pid, { state: "active", ipv4: o.ipv4 ?? IP, exclusive: true });
  const res = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/announce`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": o.ipv4 ?? IP },
    body: JSON.stringify({ machineId, nonce, bootScriptSha256: SCRIPT }),
  }));
  assert.equal(res.status, 200);
  const { bootToken } = (await res.json()) as { bootToken: string };
  await Promise.all(w.pending.splice(0));
  return { machineId, pid, bootToken, nonce };
}

const body = (l: { bootToken: string; pid: string }, over: Record<string, unknown> = {}) => ({
  bootToken: l.bootToken,
  agentVersion: "1.0.0",
  agentSha256: AGENT,
  providerMachineId: l.pid,
  mode: "vm",
  gpu: { name: "NVIDIA L4", count: 1, memoryMiB: 23034 },
  hostname: "vm-host",
  gate: { v: 1, pass: true, fail: [] },
  ...over,
});

async function enroll(b: unknown) {
  const res = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const out = await res.json();
  await Promise.all(w.pending.splice(0));
  return { status: res.status, out: out as Record<string, unknown> };
}

async function state(machineId: string) {
  const one = async (sql: string) => ({ ...(await w.db.all<Record<string, unknown>>(sql, [machineId]))[0] });
  return {
    token: await one(`SELECT used_ms FROM boot_tokens WHERE machine_id = ?`),
    launch: await one(`SELECT outcome, terminate_reason, next_ms, watchdog_version FROM vm_launches WHERE machine_id = ?`),
    machine: await one(`SELECT state FROM machines WHERE id = ?`),
    gate: (await w.db.all<{ words: string }>(`SELECT words FROM gate_reports WHERE machine_id = ?`, [machineId])).map((r) => r.words),
  };
}

/** The invariant SEC asked for: a used token is never left on a launch that can still enroll. */
async function noUsedTokenOnIssued() {
  const bad = await w.db.all(`SELECT 1 FROM boot_tokens b JOIN vm_launches v USING (machine_id, incarnation) WHERE b.used_ms IS NOT NULL AND v.outcome = 'issued'`);
  assert.deepEqual(bad, []);
}

const refusedUnchanged = async (machineId: string, before: Awaited<ReturnType<typeof state>>, r: { status: number; out: Record<string, unknown> }) => {
  assert.equal(r.status, 403);
  assert.deepEqual(r.out, { error: { code: "forbidden", message: "refused" } });
  assert.deepEqual(await state(machineId), before);
};

// ---------------------------------------------------------------- the signer

test("signer readiness: only a closed Ed25519 JWK whose pair the deployment pins, by a well-formed kid", async () => {
  assert.ok(await loadAgentSigner(signerText.jwk, "k1", signerText.pins));
  const no = async (jwk: unknown, kid: unknown, pins: unknown, why: string) => assert.equal(await loadAgentSigner(jwk, kid, pins), null, why);
  await no(undefined, "k1", signerText.pins, "missing key");
  await no(signerText.jwk, undefined, signerText.pins, "missing kid");
  await no(signerText.jwk, "k1", undefined, "missing pins");
  await no("{", "k1", signerText.pins, "malformed");
  await no(JSON.stringify({ ...KP.priv, alg: "EdDSA" }), "k1", signerText.pins, "an extra key");
  await no(JSON.stringify({ kty: "OKP", crv: "Ed25519", x: KP.priv.x }), "k1", signerText.pins, "no private part");
  await no(JSON.stringify({ ...KP.priv, kty: "EC" }), "k1", signerText.pins, "kty");
  await no(JSON.stringify({ ...KP.priv, crv: "X25519" }), "k1", signerText.pins, "crv");
  await no(JSON.stringify({ ...KP.priv, d: (KP.priv.d as string).slice(1) }), "k1", signerText.pins, "d's length");
  await no(signerText.jwk, "k 1", JSON.stringify({ "k 1": KP.pub }), "a bad kid");
  await no(signerText.jwk, "k".repeat(65), JSON.stringify({ ["k".repeat(65)]: KP.pub }), "a long kid");
  await no(signerText.jwk, "k2", signerText.pins, "kid not pinned");
  await no(signerText.jwk, "k1", JSON.stringify({ k1: OTHER.pub }), "pinned public isn't this key's");
  await no(JSON.stringify({ ...KP.priv, x: OTHER.pub.x }), "k1", JSON.stringify({ k1: OTHER.pub }), "x claims the other key: the pair doesn't verify");
  await no(signerText.jwk, "k1", JSON.stringify({ k1: { ...KP.pub, use: "sig" } }), "a pinned key with an extra field");
  await no(signerText.jwk, "k1", JSON.stringify({ k1: KP.pub, "bad kid": OTHER.pub }), "a malformed kid among the pins");
  await no(signerText.jwk, "k1", JSON.stringify([KP.pub]), "pins not a map");
  // every pin is a closed public Ed25519 JWK, used or not
  await no(signerText.jwk, "k1", JSON.stringify({ k1: KP.pub, k2: "garbage" }), "an unused pin that isn't a key");
  await no(signerText.jwk, "k1", JSON.stringify({ k1: KP.pub, k2: { ...OTHER.pub, d: KP.priv.d } }), "an unused pin with a private part");
  await no(signerText.jwk, "k1", JSON.stringify({ k1: KP.pub, k2: { ...OTHER.pub, crv: "X25519" } }), "an unused pin of another curve");
  await no(signerText.jwk, "k1", JSON.stringify({ k1: KP.pub, k2: { ...OTHER.pub, x: "!" } }), "an unused pin with a malformed x");
  assert.ok(await loadAgentSigner(signerText.jwk, "k1", JSON.stringify({ k1: KP.pub, k2: OTHER.pub })));
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i === 0 ? "k1" : `k${i + 1}`, i === 0 ? KP.pub : OTHER.pub]));
  await no(signerText.jwk, "k1", JSON.stringify(many), "too many pins");
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i === 0 ? "k1" : `k${i + 1}`, i === 0 ? KP.pub : OTHER.pub]));
  assert.ok(await loadAgentSigner(signerText.jwk, "k1", JSON.stringify(eight)));
});

// ---------------------------------------------------------------- enrolled

test("enroll: one batch (token used, launch enrolled and final, machine running, the gate's words), then a verifiable agent token", async () => {
  const l = await issued();
  w.clock.t = T0 + 30_000;
  const r = await enroll(body(l));
  assert.equal(r.status, 200, JSON.stringify(r.out));
  const s = await state(l.machineId);
  assert.deepEqual(s, { token: { used_ms: T0 + 30_000 }, launch: { outcome: "enrolled", terminate_reason: null, next_ms: null, watchdog_version: 3 }, machine: { state: "running" }, gate: ["[]"] });
  const v = await verifyToken(r.out.agentToken, new Map([["k1", KP.publicKey]]), "agent", Math.floor((T0 + 31_000) / 1000));
  assert.ok(v.ok, JSON.stringify(v));
  assert.deepEqual([v.claims.mch, v.claims.inc, v.claims.exp - v.claims.iat], [l.machineId, 1, 3600]);
  assert.deepEqual(
    { ...r.out, agentToken: undefined },
    {
      machineId: l.machineId,
      agentToken: undefined,
      agentTokenExpiresAt: new Date((Math.floor((T0 + 30_000) / 1000) + 3600) * 1000).toISOString(),
      incarnation: 1,
      relayUrl: `wss://${new URL(ORIGIN).host}/api/relay/v1/peer?machine=${l.machineId}`,
      heartbeatSeconds: HEARTBEAT_SECONDS,
      idle: { minutes: 30, gpuUtilThresholdPct: IDLE_GPU_UTIL_PCT },
      maxSessionEndsAt: new Date(T0 + 30_000 + 8 * 60 * 60_000).toISOString(),
      setupScript: null,
      workspace: { restore: true },
    },
  );
  assert.deepEqual([w.alerts, vm.terminated], [[], []]);
  // the project's policy shapes the answer
  await w.db.batch([stmt(`UPDATE projects SET policy_json = ? WHERE id = ?`, JSON.stringify({ idleStopMinutes: 12, maxSessionMinutes: 60, setupScript: "pip install x" }), w.projectId)]);
  const l2 = await issued();
  const r2 = await enroll(body(l2));
  assert.deepEqual([r2.out.idle, r2.out.maxSessionEndsAt, r2.out.setupScript], [{ minutes: 12, gpuUtilThresholdPct: IDLE_GPU_UTIL_PCT }, new Date(w.clock.t + 60 * 60_000).toISOString(), "pip install x"]);
  // an eradication report, if sent in VM mode, may only be the empty passing one
  const l3 = await issued();
  assert.equal((await enroll(body(l3, { eradication: { ok: true, checks: [] } }))).status, 200);
});

// ---------------------------------------------------------------- refused: nothing changes

test("refused, nothing changes: the signer not ready (and the token then still works)", async () => {
  const l = await issued();
  const before = await state(l.machineId);
  signer = null;
  vm.facts.set(l.pid, { state: "active", ipv4: IP, exclusive: true });
  let calls = 0;
  vm.during = async () => {
    calls++;
  };
  await refusedUnchanged(l.machineId, before, await enroll(body(l)));
  assert.equal(calls, 0); // (refused before the provider read)
  assert.deepEqual(w.alerts, ["vm-enroll: the agent signer isn't ready"]);
  signer = SIGNER;
  vm.during = null;
  assert.equal((await enroll(body(l))).status, 200);
});

test("refused, nothing changes: every malformed shape, an unknown token, and claims that don't match the launch", async () => {
  const l = await issued();
  const before = await state(l.machineId);
  const shapes: Record<string, unknown>[] = [
    { mode: "container" },
    { extra: 1 },
    { gate: undefined },
    { gate: { v: 1, pass: true, fail: ["imds"] } },
    { gate: { v: 1, pass: false, fail: ["sudo", "imds"] } },
    { gate: { v: 2, pass: true, fail: [] } },
    { eradication: { ok: true, checks: [{ name: "x", ok: true }] } },
    { eradication: { ok: false, checks: [] } },
    { bootToken: l.bootToken.slice(1) },
    { agentSha256: AGENT.toUpperCase() },
    { agentVersion: "" },
    { agentVersion: "1 0" },
    { providerMachineId: "has space" },
    { providerMachineId: "vm-\u00e9" },
    { providerMachineId: "" },
    { hostname: "" },
    { hostname: "a b" },
    { gpu: { name: "L4", count: 0, memoryMiB: 1 } },
    { gpu: { name: "L4", count: 1, memoryMiB: 1, extra: 1 } },
    { gpu: [] },
    { agentSha256: Array.from({ length: 64 }, () => "a") }, // (not a string, though of the right length)
    { agentSha256: 64 },
  ];
  shapes.push({ providerMachineId: Array.from({ length: l.pid.length }, () => "v") });
  for (const over of shapes) {
    const b = body(l, over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete (b as Record<string, unknown>)[k];
    await refusedUnchanged(l.machineId, before, await enroll(b));
  }
  await refusedUnchanged(l.machineId, before, await enroll(body(l, { bootToken: randomBytes(32).toString("base64url") }))); // (an unknown token: never a termination)
  await refusedUnchanged(l.machineId, before, await enroll(body(l, { providerMachineId: "vm-other" })));
  await refusedUnchanged(l.machineId, before, await enroll(body(l, { agentSha256: sha("another agent") })));
  assert.deepEqual([w.alerts, vm.terminated], [[], []]);
  assert.equal((await enroll(body(l))).status, 200); // (the token still works)
});

test("refused, nothing changes: past the token's window, or the launch or machine no longer waiting", async () => {
  const l = await issued();
  const before = await state(l.machineId);
  w.clock.t = T0 + 120_000; // (expires_ms: the window is issued <= now < expires)
  vm.factsCalls = 0;
  await refusedUnchanged(l.machineId, before, await enroll(body(l)));
  assert.equal(vm.factsCalls, 0); // (refused before the provider is asked)
  w.clock.t = T0 + 119_999;
  // the machine no longer starting
  await w.db.batch([stmt(`UPDATE machines SET state = 'stopping' WHERE id = ?`, l.machineId)]);
  const b2 = await state(l.machineId);
  await refusedUnchanged(l.machineId, b2, await enroll(body(l)));
  assert.equal(vm.factsCalls, 0);
  await w.db.batch([stmt(`UPDATE machines SET state = 'starting' WHERE id = ?`, l.machineId)]);
  // the launch no longer issued (the watchdog marked it)
  await w.db.batch([stmt(`UPDATE vm_launches SET outcome = 'terminate', terminate_reason = 'token-expired' WHERE machine_id = ?`, l.machineId)]);
  const b3 = await state(l.machineId);
  await refusedUnchanged(l.machineId, b3, await enroll(body(l)));
  assert.equal(vm.factsCalls, 0);
  assert.deepEqual(w.alerts, []);
  // the token bound to another provider id than its launch's (never written so; refused all the same)
  const m = await issued();
  await w.db.batch([stmt(`UPDATE boot_tokens SET provider_machine_id = 'vm-elsewhere' WHERE machine_id = ?`, m.machineId)]);
  const b4 = await state(m.machineId);
  vm.factsCalls = 0;
  await refusedUnchanged(m.machineId, b4, await enroll(body(m)));
  assert.equal(vm.factsCalls, 0);
});

test("refused, token untouched: the provider unavailable (no answer, an error, past the deadline); then a retry within the window enrolls", async () => {
  const l = await issued();
  const before = await state(l.machineId);
  vm.facts.delete(l.pid); // ("unavailable")
  await refusedUnchanged(l.machineId, before, await enroll(body(l)));
  vm.facts.set(l.pid, { state: "active", ipv4: IP, exclusive: true });
  vm.throwFacts = true;
  await refusedUnchanged(l.machineId, before, await enroll(body(l)));
  vm.throwFacts = false;
  assert.deepEqual([w.alerts, vm.terminated], [[], []]);
  assert.equal((await enroll(body(l))).status, 200);
});

// ---------------------------------------------------------------- definitive failures

test("definitive: a second use of a real token marks the launch, alerts and terminates", async () => {
  const l = await issued();
  assert.equal((await enroll(body(l))).status, 200);
  const r = await enroll(body(l));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.launch.outcome, s.launch.terminate_reason], ["terminated", "second-enroll"]); // (terminated: the provider confirmed it absent)
  assert.deepEqual([w.alerts, vm.terminated], [["vm-enroll: second-enroll"], [l.pid]]);
});

test("definitive: a canonical failing gate uses the token, records its words, marks and terminates", async () => {
  const l = await issued();
  const words = ["imds", "sudo"];
  const r = await enroll(body(l, { gate: { v: 1, pass: false, fail: words } }));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.equal(typeof s.token.used_ms, "number");
  assert.deepEqual([s.launch.outcome, s.launch.terminate_reason, s.gate], ["terminated", "gate-failed", [JSON.stringify(words)]]);
  assert.deepEqual([w.alerts, vm.terminated], [["vm-enroll: gate-failed"], [l.pid]]);
  // every word fails it alike
  const l2 = await issued();
  assert.equal((await enroll(body(l2, { gate: { v: 1, pass: false, fail: [...VM_GATE_WORDS] } }))).status, 403);
  assert.equal((await state(l2.machineId)).launch.terminate_reason, "gate-failed");
  // and a later use of that token is a second use
  assert.equal((await enroll(body(l))).status, 403);
  await noUsedTokenOnIssued();
});

test("definitive: an authoritative provider answer that disagrees (not ACTIVE, absent, another IPv4, not exclusive)", async () => {
  for (const f of [
    { state: "other", ipv4: IP, exclusive: true },
    { state: "absent", ipv4: null, exclusive: false },
    { state: "active", ipv4: "203.0.113.8", exclusive: true },
    { state: "active", ipv4: IP, exclusive: false },
  ] as InstanceFacts[]) {
    const l = await issued();
    vm.facts.set(l.pid, f);
    vm.terminated = [];
    w.alerts.length = 0;
    const r = await enroll(body(l));
    assert.equal(r.status, 403, JSON.stringify(f));
    const s = await state(l.machineId);
    assert.equal(typeof s.token.used_ms, "number");
    assert.deepEqual([s.launch.terminate_reason, s.machine.state], ["provider-facts", "starting"], JSON.stringify(f));
    assert.deepEqual([w.alerts, vm.terminated], [["vm-enroll: provider-facts"], [l.pid]]);
  }
  await noUsedTokenOnIssued();
});

test("definitive: signing fails after the commit: marked sign-failed and terminated at once", async () => {
  const l = await issued();
  // (a signer that passed readiness but whose key then can't sign: a public key in its place)
  signer = { kid: "k1", privateKey: KP.publicKey };
  const r = await enroll(body(l));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.launch.outcome, s.launch.terminate_reason, s.machine.state, s.gate], ["terminated", "sign-failed", "running", ["[]"]]);
  assert.deepEqual([w.alerts, vm.terminated], [["vm-enroll: sign-failed"], [l.pid]]);
});

// ---------------------------------------------------------------- races during the provider read (H2)

test("race: the token expires during the provider read: refused, nothing committed", async () => {
  const l = await issued();
  const before = await state(l.machineId);
  vm.during = async () => {
    w.clock.t = T0 + 120_000;
  };
  await refusedUnchanged(l.machineId, before, await enroll(body(l)));
  assert.deepEqual(w.alerts, []);
});

test("race: the watchdog claims the launch during the read: refused, the batch rolled back whole", async () => {
  const l = await issued();
  vm.during = async () => {
    await w.db.batch([stmt(`UPDATE vm_launches SET watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, l.machineId)]);
  };
  const before = { ...(await state(l.machineId)) };
  const r = await enroll(body(l));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.token, s.launch.outcome, s.machine, s.gate], [before.token, "issued", { state: "starting" }, []]);
  assert.equal(s.launch.watchdog_version, (before.launch.watchdog_version as number) + 1);
  await noUsedTokenOnIssued();
});

test("race: the machine stops during the read: refused, rolled back", async () => {
  const l = await issued();
  vm.during = async () => {
    await w.db.batch([stmt(`UPDATE machines SET state = 'stopping' WHERE id = ?`, l.machineId)]);
  };
  const r = await enroll(body(l));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.token.used_ms, s.launch.outcome, s.gate], [null, "issued", []]);
});

test("race: two exchanges of one token: exactly one enrolls, the other is a second use", async () => {
  const l = await issued();
  // the other exchange commits while this one is in its provider read
  vm.during = async () => {
    const other = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(l)) }));
    assert.equal(other.status, 200);
  };
  const r = await enroll(body(l));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.launch.terminate_reason, s.gate], ["second-enroll", ["[]"]]);
  assert.deepEqual(w.alerts, ["vm-enroll: second-enroll"]);
});

// ---------------------------------------------------------------- seams (H3)

test("seam: the definitive batch can't be written: nothing marked, the token untouched; its expiry then ends the launch", async () => {
  const l = await issued();
  const before = await state(l.machineId);
  const realBatch = w.db.batch;
  (w.db as { batch: Db["batch"] }).batch = async () => {
    throw new Error("db down");
  };
  const r = await enroll(body(l, { gate: { v: 1, pass: false, fail: ["imds"] } }));
  (w.db as { batch: Db["batch"] }).batch = realBatch;
  assert.equal(r.status, 403);
  assert.deepEqual(await state(l.machineId), before);
  assert.deepEqual([w.alerts, vm.terminated], [["vm-enroll: gate-failed (not recorded)"], []]);
  // the watchdog ends it at the token's expiry
  w.clock.t = T0 + 120_000;
  const env: JobEnv = { db: w.db, now: w.clock.t, vm, elapsedMs: () => 0 };
  assert.equal(await runVmWatchdog(env), 1);
  assert.deepEqual([(await state(l.machineId)).launch.terminate_reason, vm.terminated], ["token-expired", [l.pid]]);
});

test("seam: the batch commits but the provider's terminate fails: the launch stays due, and the watchdog finishes it", async () => {
  const l = await issued();
  vm.failTerminates = 1;
  const r = await enroll(body(l, { gate: { v: 1, pass: false, fail: ["imds"] } }));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.launch.outcome, s.launch.terminate_reason, typeof s.token.used_ms], ["terminate", "gate-failed", "number"]);
  assert.ok((s.launch.next_ms as number) <= w.clock.t);
  await noUsedTokenOnIssued();
  const env: JobEnv = { db: w.db, now: w.clock.t + 60_000, vm, elapsedMs: () => 0 };
  assert.equal(await runVmWatchdog(env), 1);
  assert.equal((await state(l.machineId)).launch.outcome, "terminated");
  assert.deepEqual(vm.terminated, [l.pid, l.pid]);
});

test("seam: each statement of the enroll batch refused in turn rolls the whole batch back", async () => {
  for (const cut of ["UPDATE boot_tokens", "UPDATE vm_launches", "UPDATE machines", "INSERT INTO gate_reports", "INSERT INTO enroll_guard"]) {
    const l = await issued();
    const before = await state(l.machineId);
    const realBatch = w.db.batch;
    (w.db as { batch: Db["batch"] }).batch = async (stmts) => realBatch(stmts.map((s) => (s.sql.trimStart().startsWith(cut) ? { sql: `SELECT json('cut')`, params: [] } : s)));
    const r = await enroll(body(l));
    (w.db as { batch: Db["batch"] }).batch = realBatch;
    assert.equal(r.status, 403, cut);
    assert.deepEqual(await state(l.machineId), before, cut);
    await noUsedTokenOnIssued();
  }
});

test("race: the token is used by another path during the read (its launch untouched): the commit refuses it as a second use", async () => {
  const l = await issued();
  vm.during = async () => {
    await w.db.batch([stmt(`UPDATE boot_tokens SET used_ms = ? WHERE machine_id = ?`, w.clock.t, l.machineId)]);
  };
  const r = await enroll(body(l));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.launch.terminate_reason, s.machine.state, s.gate], ["second-enroll", "starting", []]);
  assert.deepEqual(w.alerts, ["vm-enroll: second-enroll"]);
});

test("race: the launch marked to terminate during the read without a claim (a second announce's mark, before its own attempt): refused, rolled back", async () => {
  const l = await issued();
  vm.during = async () => {
    // (exactly the announce's mark: outcome and reason, no version change)
    await w.db.batch([stmt(`UPDATE vm_launches SET outcome = 'terminate', terminate_reason = 'second-announce', next_ms = ? WHERE machine_id = ?`, w.clock.t, l.machineId)]);
  };
  const r = await enroll(body(l));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.token.used_ms, s.machine.state, s.gate, s.launch.outcome, s.launch.terminate_reason], [null, "starting", [], "terminate", "second-announce"]);
  await noUsedTokenOnIssued();
});

/** Runs `first` just before the next failure batch (one that records failing gate words) is written. */
function beforeFailureBatch(first: () => Promise<void>) {
  const realBatch = w.db.batch;
  (w.db as { batch: Db["batch"] }).batch = async (stmts) => {
    if (stmts.some((x) => x.sql.includes("INSERT INTO gate_reports") && x.params[2] !== "[]")) {
      (w.db as { batch: Db["batch"] }).batch = realBatch;
      await first();
    }
    return realBatch(stmts);
  };
}

test("race: a failing gate paused before its failure batch while a passing exchange enrolls: the mark still lands, and the enrolled machine is terminated", async () => {
  const l = await issued();
  beforeFailureBatch(async () => {
    const other = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(l)) }));
    assert.equal(other.status, 200);
  });
  const r = await enroll(body(l, { gate: { v: 1, pass: false, fail: ["imds"] } }));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.launch.outcome, s.launch.terminate_reason, s.gate], ["terminated", "gate-failed", ["[]"]]); // (the enroll's report kept; the mark held)
  assert.deepEqual([w.alerts, vm.terminated], [["vm-enroll: gate-failed"], [l.pid]]);
  await noUsedTokenOnIssued();
});

test("race: two failing gates for one token: both marks land on the same launch, the first report kept", async () => {
  const l = await issued();
  beforeFailureBatch(async () => {
    const other = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(l, { gate: { v: 1, pass: false, fail: ["sudo"] } })) }));
    assert.equal(other.status, 403);
  });
  const r = await enroll(body(l, { gate: { v: 1, pass: false, fail: ["imds"] } }));
  assert.equal(r.status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.launch.terminate_reason, s.gate, typeof s.token.used_ms], ["gate-failed", [JSON.stringify(["sudo"])], "number"]);
  assert.deepEqual(w.alerts, ["vm-enroll: gate-failed", "vm-enroll: gate-failed"]);
  await noUsedTokenOnIssued();
});
