import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DEFAULT_POLICY, isId, newId, verifyToken, type Key } from "@sbgpu/api";
import { ProviderError, type LaunchSpec, type ProviderMachineStatus } from "@sbgpu/providers";
import { machineName, nameFields } from "@sbgpu/providers";
/** A pod name as control builds it here (installation "test", incarnation 1); anything else is kept as given (a name that is not ours). */
const podName = (machineId: string) => (isId("machine", machineId) ? machineName("test", machineId, 1) : machineId);

import { stmt } from "./db.ts";
import { CONNECT_WINDOW_MS, launchContainer, type ContainerEnv, type ContainerProvider } from "./container.ts";
import { ERADICATION_CHECKS, HEARTBEAT_SECONDS } from "./enroll.ts";
import { HEARTBEAT_LOST_MS } from "./heartbeat.ts";
import { loadAgentSigner, type AgentSigner } from "./signer.ts";
import { ORIGIN, T0, addMember, world, type World } from "./testing/world.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const AGENT = sha("the agent");
const IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";
const LAUNCHER = ["/opt/sbgpu/launcher", "--boot"];
const BOOT_ENV = "SBGPU_BOOT_TOKEN";
const RATE = { providerCostPerHour: 590_000, marginBps: 3000 };

/** A RunPod for enroll's tests: pods by id, running on demand, with failures to inject. */
class FakeRunPod implements ContainerProvider {
  pods = new Map<string, ProviderMachineStatus>();
  n = 0;
  terminated: string[] = [];
  statusFails = false;
  statusCalls = 0;
  override: Partial<ProviderMachineStatus> = {};
  /** Runs inside status, before it answers (a race injected during the provider read). */
  during: (() => Promise<void>) | null = null;
  pod(machineId: string): string {
    const id = `pod${++this.n}`;
    this.pods.set(id, {
      provider: "runpod",
      providerMachineId: id,
      ...nameFields(podName(machineId)),
      state: "provisioning",
      rawStatus: "CREATED",
      gpuType: "A40",
      gpuCount: 1,
      dataCenter: "EU-SE-1",
      image: IMAGE,
      diskGb: 20,
      volumeGb: 0,
      exposedPorts: [],
      command: [...LAUNCHER],
      envNames: [BOOT_ENV],
      unexpectedSettings: [],
      providerCostPerHour: RATE.providerCostPerHour,
      observedAt: new Date(T0).toISOString(),
    } as ProviderMachineStatus);
    return id;
  }
  async launch(spec: LaunchSpec): Promise<{ providerMachineId: string }> {
    return { providerMachineId: this.pod(spec.machineId) };
  }
  async status(id: string): Promise<ProviderMachineStatus> {
    this.statusCalls++;
    if (this.during) {
      const d = this.during;
      this.during = null;
      await d();
    }
    if (this.statusFails) throw new ProviderError("runpod", "transient", "down");
    const p = this.pods.get(id);
    if (!p) return { provider: "runpod", providerMachineId: id, machineId: null, parsedName: null, state: "terminated" } as ProviderMachineStatus;
    return { ...p, ...this.override };
  }
  async terminate(id: string): Promise<void> {
    this.terminated.push(id);
    this.pods.delete(id);
  }
  async listMachines(): Promise<ProviderMachineStatus[]> {
    return [...this.pods.values()];
  }
  run(id: string) {
    const p = this.pods.get(id)!;
    this.pods.set(id, { ...p, state: "running", rawStatus: "RUNNING" });
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
const SIGNER = (await loadAgentSigner(JSON.stringify(KP.priv), "k1", JSON.stringify({ k1: KP.pub })))!;

let w: World;
let rp: FakeRunPod;
let signer: AgentSigner | null;
let wired: boolean;
let memberId: string;
let rnd = 0;
let allocationId: string;
beforeEach(async () => {
  rp = new FakeRunPod();
  signer = SIGNER;
  wired = true;
  const container = { provider: rp, expect: { image: IMAGE, launcher: LAUNCHER, bootEnv: BOOT_ENV } };
  w = await world({ agentSigner: async () => signer });
  // (wired per test: a test may unwire it)
  Object.defineProperty(w.deps, "container", { get: () => (wired ? container : null) });
  memberId = await addMember(w, "m@example.com", "member", { allocation: 0 });
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
});

function env(): ContainerEnv {
  return {
    installation: "test",
    db: w.db,
    clock: () => w.clock.t,
    provider: rp,
    expect: { image: IMAGE, launcher: LAUNCHER, bootEnv: BOOT_ENV },
    randomBytes: (n) => {
      rnd++;
      return Uint8Array.from({ length: n }, (_, i) => (rnd * 37 + i * 11) & 255);
    },
    elapsedMs: () => 0,
  };
}

/** A container launched (its id recorded, its token pending): the token, as the pod's env holds it. */
async function launched(o: { running?: boolean } = {}) {
  const machineId = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, ?, 'runpod', 'A40', 1, 'EU-SE-1', 'starting', 1, ?)`,
      machineId, w.projectId, allocationId, memberId, T0,
    ),
  ]);
  const before = rp.n;
  assert.equal(
    await launchContainer(env(), {
      machineId,
      incarnation: 1,
      agentSha256: AGENT,
      credentialKind: "ours",
      rate: RATE,
      spec: { machineId, gpuType: "A40", gpuCount: 1, dataCenter: "EU-SE-1", image: IMAGE, diskGb: 20, launcher: LAUNCHER, maxProviderCostPerHour: 1_000_000 },
    }),
    "created",
  );
  const pid = `pod${before + 1}`;
  if (o.running !== false) rp.run(pid);
  const token = (await w.db.all<{ token_sha256: string }>(`SELECT token_sha256 FROM boot_tokens WHERE machine_id = ?`, [machineId]))[0]!;
  return { machineId, pid, tokenSha256: token.token_sha256 };
}

/** The pod's own token: found by its hash among the creates' tokens (the fake keeps none, so it's re-derived). */
const tokens = new Map<string, string>();
const realLaunch = FakeRunPod.prototype.launch;
FakeRunPod.prototype.launch = async function (this: FakeRunPod, spec: LaunchSpec) {
  tokens.set(sha(spec.bootToken), spec.bootToken);
  return realLaunch.call(this, spec);
};

const passing = () => ({ ok: true, checks: ERADICATION_CHECKS.map((name) => ({ name, ok: true })) });

function body(l: { pid: string; tokenSha256: string }, over: Record<string, unknown> = {}) {
  return {
    bootToken: tokens.get(l.tokenSha256)!,
    agentVersion: "0.1.0",
    agentSha256: AGENT,
    providerMachineId: l.pid,
    mode: "container",
    eradication: passing(),
    gpu: { name: "NVIDIA A40", count: 1, memoryMiB: 46068 },
    hostname: "a1b2c3d4e5f6",
    ...over,
  };
}

async function enroll(b: unknown) {
  const res = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const out = (await res.json()) as Record<string, unknown>;
  await Promise.all(w.pending.splice(0));
  return { status: res.status, out };
}

async function state(machineId: string) {
  const one = async (sql: string) => ({ ...(await w.db.all<Record<string, unknown>>(sql, [machineId]))[0] });
  return {
    token: await one(`SELECT used_ms, issued_ms, expires_ms FROM boot_tokens WHERE machine_id = ?`),
    launch: await one(`SELECT outcome, terminate_reason, next_ms, heartbeat_due_ms, max_end_ms, first_running_ms FROM launches WHERE machine_id = ?`),
    machine: await one(`SELECT state FROM machines WHERE id = ?`),
  };
}

/** Nothing changed: the token unused, the launch where it was, the pod up. */
async function untouched(l: { machineId: string; pid: string }, outcome: string, why: string) {
  const s = await state(l.machineId);
  assert.deepEqual([s.token.used_ms, s.launch.outcome, s.machine.state, rp.terminated], [null, outcome, "starting", []], why);
}

// ================================================================ enrolled

test("enrolled: a pending token gets its window from enroll's own read; one batch; the agent token signed for the machine", async () => {
  const l = await launched();
  assert.equal((await state(l.machineId)).token.issued_ms, null, "pending before enroll");
  w.clock.t = T0 + 5000;
  const r = await enroll(body(l));
  assert.equal(r.status, 200, JSON.stringify(r.out));
  const s = await state(l.machineId);
  assert.deepEqual(
    [s.token.used_ms, s.token.issued_ms, s.token.expires_ms, s.launch.first_running_ms],
    [T0 + 5000, T0 + 5000, T0 + 5000 + CONNECT_WINDOW_MS, T0 + 5000],
  );
  // the hard lifetime: the project's maximum session from enroll (the default policy here)
  const life = DEFAULT_POLICY.maxSessionMinutes * 60_000;
  assert.ok(life > 0);
  assert.deepEqual(
    [s.launch.outcome, s.launch.next_ms, s.launch.heartbeat_due_ms, s.launch.max_end_ms, s.machine.state],
    ["enrolled", null, T0 + 5000 + HEARTBEAT_LOST_MS, T0 + 5000 + life, "running"],
  );
  assert.deepEqual([r.out.machineId, r.out.incarnation, r.out.heartbeatSeconds, r.out.maxSessionEndsAt], [l.machineId, 1, HEARTBEAT_SECONDS, new Date(T0 + 5000 + life).toISOString()]);
  const v = await verifyToken(r.out.agentToken as string, new Map([["k1", KP.publicKey]]), "agent", Math.floor((T0 + 6000) / 1000));
  assert.ok(v.ok && v.claims.mch === l.machineId && v.claims.inc === 1 && v.claims.kind === "agent", JSON.stringify(v));
  assert.deepEqual(rp.terminated, []);
});

test("enrolled: a window already open (the launch loop saw the pod first) is kept, not moved later; its last millisecond still enrolls", async () => {
  const l = await launched();
  // the launch loop's observation, at T0 + 1000
  w.clock.t = T0 + 1000;
  const { observeContainer } = await import("./container.ts");
  assert.equal(await observeContainer(env(), l.machineId, 1), "running");
  w.clock.t = T0 + 1000 + CONNECT_WINDOW_MS - 1;
  assert.equal((await enroll(body(l))).status, 200);
  assert.deepEqual([(await state(l.machineId)).token.issued_ms, (await state(l.machineId)).launch.first_running_ms], [T0 + 1000, T0 + 1000]);
});

// ================================================================ refused: nothing changes

test("refused, nothing changed: the window over, the pod not running yet, the provider unavailable, no adapter wired, no signer", async () => {
  {
    const l = await launched();
    w.clock.t = T0 + 1000;
    const { observeContainer } = await import("./container.ts");
    await observeContainer(env(), l.machineId, 1);
    w.clock.t = T0 + 1000 + CONNECT_WINDOW_MS;
    assert.equal((await enroll(body(l))).status, 403);
    await untouched(l, "issued", "the window's end");
  }
  {
    const l = await launched({ running: false });
    assert.equal((await enroll(body(l))).status, 403);
    await untouched(l, "creating", "not running yet");
    assert.equal((await state(l.machineId)).token.issued_ms, null, "still pending");
  }
  {
    const l = await launched();
    rp.statusFails = true;
    assert.equal((await enroll(body(l))).status, 403);
    rp.statusFails = false;
    await untouched(l, "creating", "provider down");
  }
  {
    const l = await launched();
    wired = false;
    const calls = rp.statusCalls;
    assert.equal((await enroll(body(l))).status, 403);
    wired = true;
    assert.equal(rp.statusCalls, calls, "no provider call");
    await untouched(l, "creating", "no adapter");
  }
  {
    const l = await launched();
    signer = null;
    assert.equal((await enroll(body(l))).status, 403);
    signer = SIGNER;
    await untouched(l, "creating", "no signer");
    assert.ok(w.alerts.includes("vm-enroll: the agent signer isn't ready"));
  }
});

test("refused, nothing changed: a window already open, but enroll's own read finds the provider unavailable or the pod not running", async () => {
  const { observeContainer } = await import("./container.ts");
  for (const fault of ["unavailable", "not running"] as const) {
    w.clock.t = T0;
    const l = await launched();
    // the launch loop opened the window at T0 + 1000: the launch is issued, its token in its window
    w.clock.t = T0 + 1000;
    assert.equal(await observeContainer(env(), l.machineId, 1), "running");
    w.clock.t = T0 + 2000;
    if (fault === "unavailable") rp.statusFails = true;
    else rp.override = { state: "provisioning" };
    assert.equal((await enroll(body(l))).status, 403, fault);
    rp.statusFails = false;
    rp.override = {};
    // (no enroll from the earlier facts: the read at enroll must itself show the pod running)
    await untouched(l, "issued", fault);
    assert.equal(await observeContainer(env(), l.machineId, 1), "running");
    assert.equal((await enroll(body(l))).status, 200, `${fault}: then enrolls once the read shows it running`);
  }
});

test("refused, nothing changed: an unknown token, another pod's id, another agent, a machine not starting", async () => {
  const l = await launched();
  const calls = rp.statusCalls;
  assert.equal((await enroll(body(l, { bootToken: "A".repeat(43) }))).status, 403);
  assert.equal((await enroll(body(l, { providerMachineId: "pod99" }))).status, 403);
  assert.equal((await enroll(body(l, { providerMachineId: `${l.pid}x` }))).status, 403);
  assert.equal((await enroll(body(l, { agentSha256: sha("another agent") }))).status, 403);
  assert.equal(rp.statusCalls, calls, "refused before any provider call");
  await untouched(l, "creating", "claims");
  await w.db.run(`UPDATE machines SET state = 'stopped' WHERE id = ?`, [l.machineId]);
  assert.equal((await enroll(body(l))).status, 403);
  assert.equal((await state(l.machineId)).token.used_ms, null);
});

test("refused, nothing changed: every request outside the container shape", async () => {
  const l = await launched();
  const bad: Array<[string, Record<string, unknown>]> = [
    ["no pod id", { providerMachineId: undefined }],
    ["a null pod id", { providerMachineId: null }],
    ["a long pod id", { providerMachineId: "p".repeat(65) }],
    ["a gate report", { gate: { pass: true, fail: [] } }],
    ["an extra field", { extra: 1 }],
    ["no report", { eradication: undefined }],
    ["a report with no checks", { eradication: { ok: true, checks: [] } }],
    ["two checks", { eradication: { ok: true, checks: [{ name: "env", ok: true }, { name: "processes", ok: true }] } }],
    ["a fourth check", { eradication: { ok: true, checks: [...passing().checks, { name: "more", ok: true }] } }],
    ["checks out of order", { eradication: { ok: true, checks: [{ name: "processes", ok: true }, { name: "env", ok: true }, { name: "files", ok: true }] } }],
    ["a renamed check", { eradication: { ok: true, checks: [{ name: "env", ok: true }, { name: "procs", ok: true }, { name: "files", ok: true }] } }],
    ["a check's ok not boolean", { eradication: { ok: true, checks: [{ name: "env", ok: 1 }, { name: "processes", ok: true }, { name: "files", ok: true }] } }],
    ["a check with more fields", { eradication: { ok: true, checks: [{ name: "env", ok: true, why: "x" }, { name: "processes", ok: true }, { name: "files", ok: true }] } }],
    ["the report's ok not boolean", { eradication: { ok: "yes", checks: passing().checks } }],
    ["a report with more fields", { eradication: { ...passing(), extra: 1 } }],
    ["a report as a list", { eradication: [] }],
    ["a bad hostname", { hostname: "a b" }],
    ["a bad agent version", { agentVersion: "" }],
    ["a bad gpu", { gpu: { name: "A40", count: 0, memoryMiB: 1 } }],
    ["the vm mode", { mode: "vm" }],
    ["a bad token", { bootToken: "short" }],
  ];
  const calls = rp.statusCalls;
  for (const [why, over] of bad) {
    const b: Record<string, unknown> = body(l, over);
    for (const k of Object.keys(over)) if (over[k] === undefined) delete b[k];
    assert.equal((await enroll(b)).status, 403, why);
  }
  assert.equal(rp.statusCalls, calls);
  await untouched(l, "creating", "shapes");
  // and the well-formed request still enrolls
  assert.equal((await enroll(body(l))).status, 200);
});

// ================================================================ definitive: the token used, the launch ended

test("definitive: an eradication report that doesn't pass uses the token, marks the launch to terminate, then ends the pod", async () => {
  const failing = [
    { ok: false, checks: [{ name: "env", ok: false }, { name: "processes", ok: true }, { name: "files", ok: true }] },
    { ok: true, checks: [{ name: "env", ok: true }, { name: "processes", ok: true }, { name: "files", ok: false }] },
    { ok: false, checks: passing().checks },
  ];
  for (const eradication of failing) {
    const l = await launched();
    rp.terminated = [];
    w.alerts.length = 0;
    const calls = rp.statusCalls;
    assert.equal((await enroll(body(l, { eradication }))).status, 403);
    assert.equal(rp.statusCalls, calls + 1, "the termination's own confirmation only: no read before the failure");
    const s = await state(l.machineId);
    assert.equal(typeof s.token.used_ms, "number");
    assert.deepEqual([s.launch.outcome, s.launch.terminate_reason, s.machine.state], ["terminated", "eradication-failed", "starting"], JSON.stringify(eradication));
    assert.deepEqual([w.alerts, rp.terminated], [["container-enroll: eradication-failed"], [l.pid]]);
  }
});

test("definitive: a fresh read that disagrees ends the launch (token revoked first); the request is refused", async () => {
  for (const over of [{ image: "other/image:1" }, { envNames: [BOOT_ENV, "RUNPOD_API_KEY"] }, { exposedPorts: ["22/tcp"] }, { state: "failed" as const }]) {
    const l = await launched();
    rp.terminated = [];
    rp.override = over;
    assert.equal((await enroll(body(l))).status, 403, JSON.stringify(over));
    rp.override = {};
    const s = await state(l.machineId);
    assert.equal(typeof s.token.used_ms, "number");
    assert.ok(["terminate", "terminated"].includes(s.launch.outcome as string));
    assert.ok(["provider-facts", "pod-exited"].includes(s.launch.terminate_reason as string), JSON.stringify(over));
    assert.equal(s.machine.state, "starting");
  }
});

test("definitive: a second use of the token, after its enroll, ends the enrolled launch", async () => {
  const l = await launched();
  assert.equal((await enroll(body(l))).status, 200);
  w.alerts.length = 0;
  assert.equal((await enroll(body(l))).status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.launch.outcome, s.launch.terminate_reason], ["terminated", "second-enroll"]);
  assert.deepEqual([w.alerts, rp.terminated], [["container-enroll: second-enroll"], [l.pid]]);
});

test("definitive: two holders racing: the token used meanwhile, during the read or just before the commit, is a second use", async () => {
  {
    const l = await launched();
    // during this request's provider read, another holder uses the token
    rp.during = async () => {
      await w.db.run(`UPDATE boot_tokens SET used_ms = ? WHERE machine_id = ?`, [T0, l.machineId]);
    };
    assert.equal((await enroll(body(l))).status, 403);
    const s = await state(l.machineId);
    assert.deepEqual([s.launch.outcome, s.launch.terminate_reason], ["terminated", "second-enroll"]);
  }
  {
    const l = await launched();
    // just before this request's commit (its batch then changes no token row, and fails whole)
    const batch = w.db.batch.bind(w.db);
    w.db.batch = async (ss) => {
      if (ss.some((s) => /SET outcome = 'enrolled'/.test(s.sql))) await w.db.run(`UPDATE boot_tokens SET used_ms = ? WHERE machine_id = ?`, [T0, l.machineId]);
      return batch(ss);
    };
    try {
      assert.equal((await enroll(body(l))).status, 403);
    } finally {
      w.db.batch = batch;
    }
    const s = await state(l.machineId);
    assert.deepEqual([s.launch.outcome, s.launch.terminate_reason, s.machine.state], ["terminated", "second-enroll", "starting"]);
  }
});

test("definitive: signing fails after the commit: marked sign-failed and ended", async () => {
  const l = await launched();
  signer = { kid: "k1", privateKey: KP.publicKey };
  assert.equal((await enroll(body(l))).status, 403);
  const s = await state(l.machineId);
  assert.deepEqual([s.launch.outcome, s.launch.terminate_reason], ["terminated", "sign-failed"]);
  assert.deepEqual([w.alerts.at(-1), rp.terminated], ["container-enroll: sign-failed", [l.pid]]);
});

test("a failure that can't be recorded changes nothing and says so", async () => {
  const l = await launched();
  const batch = w.db.batch.bind(w.db);
  w.db.batch = async (ss) => {
    if (ss.some((s) => /SET outcome = 'terminate'/.test(s.sql))) throw new Error("write lost");
    return batch(ss);
  };
  try {
    assert.equal((await enroll(body(l, { eradication: { ok: false, checks: passing().checks } }))).status, 403);
  } finally {
    w.db.batch = batch;
  }
  await untouched(l, "creating", "not recorded");
  assert.deepEqual(w.alerts, ["container-enroll: eradication-failed (not recorded)"]);
});

test("VM enroll is unchanged: a VM-mode body never reaches the container path", async () => {
  const l = await launched();
  const calls = rp.statusCalls;
  const r = await enroll({ ...body(l), mode: "vm", providerMachineId: undefined, gate: { pass: true, fail: [] } });
  assert.equal(r.status, 403);
  assert.equal(rp.statusCalls, calls);
  await untouched(l, "creating", "vm body");
});
