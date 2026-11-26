import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { newId } from "@sbgpu/api";
import { ProviderError, type LaunchSpec, type ProviderMachineStatus } from "@sbgpu/providers";
import { stmt } from "./db.ts";
import {
  CONNECT_WINDOW_MS,
  CONTAINER_WATCHDOG_SELECT,
  abandonContainer,
  launchContainer,
  observeContainer,
  recordContainerId,
  recordContainerIntent,
  recordFirstRunning,
  runContainerWatchdog,
  terminateContainerAttempt,
  type ContainerEnv,
  type ContainerLaunch,
  type ContainerProvider,
} from "./container.ts";
import { CREATE_DEADLINE_MS, WATCHDOG_BATCH, runVmWatchdog } from "./vm.ts";
import { T0, addMember, world, type World } from "./testing/world.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const AGENT = sha("the agent");
const IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";
const LAUNCHER = ["/opt/sbgpu/launcher", "--boot"];
const BOOT_ENV = "SBGPU_BOOT_TOKEN";
const RATE = { providerCostPerHour: 590_000, marginBps: 3000 };

/** A RunPod for control's tests: pods by id, with the failures a create can have. */
class FakeRunPod implements ContainerProvider {
  pods = new Map<string, ProviderMachineStatus>();
  n = 0;
  /** What the next create does. */
  mode: "ok" | "lost" | "definitive" | "rejected" | "renamed" | "duplicate" = "ok";
  specs: LaunchSpec[] = [];
  terminated: string[] = [];
  /** Called at each terminate, before it takes effect (to see what the database held then). */
  onTerminate: ((id: string) => void) | null = null;
  failTerminates = 0;
  /** What the next terminates do instead: throw, never answer, or answer without ending the pod. */
  terminateFaults: Array<"throw" | "hang" | "early"> = [];
  listFails = false;
  statusFails = false;
  /** A hook run during a status read (to move the clock while the read is in flight). */
  duringStatus: (() => void) | null = null;
  override: Partial<ProviderMachineStatus> = {};

  pod(machineId: string, state: ProviderMachineStatus["state"] = "provisioning"): string {
    const id = `pod${++this.n}`;
    this.pods.set(id, {
      provider: "runpod",
      providerMachineId: id,
      machineId: machineId as ProviderMachineStatus["machineId"],
      state,
      rawStatus: state,
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
    this.specs.push(spec);
    switch (this.mode) {
      case "ok":
        return { providerMachineId: this.pod(spec.machineId) };
      case "lost":
        this.pod(spec.machineId);
        throw new ProviderError("runpod", "outcome_unknown", "no response");
      case "duplicate":
        this.pod(spec.machineId);
        this.pod(spec.machineId);
        throw new ProviderError("runpod", "outcome_unknown", "2 pods carry the machine");
      case "definitive":
        throw new ProviderError("runpod", "no_capacity", "no instances available");
      case "rejected":
      case "renamed": {
        // (renamed: the pod doesn't carry the machine's name, so no list finds it by the name)
        const id = this.pod(this.mode === "renamed" ? "renamed" : spec.machineId);
        throw new ProviderError("runpod", "spec_mismatch", "drift", null, null, id);
      }
    }
  }
  async status(id: string): Promise<ProviderMachineStatus> {
    this.duringStatus?.();
    if (this.statusFails) throw new Error("down");
    const p = this.pods.get(id);
    if (!p) return { ...this.blank(id), state: "terminated" };
    return { ...p, ...this.override };
  }
  blank(id: string): ProviderMachineStatus {
    return { provider: "runpod", providerMachineId: id, machineId: null, state: "terminated", rawStatus: "", gpuType: null, gpuCount: 0, dataCenter: null, image: "", diskGb: 0, volumeGb: 0, exposedPorts: [], command: [], envNames: [], unexpectedSettings: [], providerCostPerHour: null, observedAt: new Date(T0).toISOString() } as ProviderMachineStatus;
  }
  async terminate(id: string): Promise<void> {
    this.onTerminate?.(id);
    this.terminated.push(id);
    const fault = this.terminateFaults.shift();
    if (fault === "throw") throw new Error("provider down");
    if (fault === "hang") return new Promise<void>(() => {});
    if (fault === "early") return;
    if (this.failTerminates > 0) {
      this.failTerminates--;
      throw new Error("provider down");
    }
    this.pods.delete(id);
  }
  async listMachines(): Promise<ProviderMachineStatus[]> {
    if (this.listFails) throw new ProviderError("runpod", "unknown", "list malformed");
    return [...this.pods.values()];
  }
  run(id: string) {
    const p = this.pods.get(id)!;
    this.pods.set(id, { ...p, state: "running", rawStatus: "RUNNING" });
  }
}

let w: World;
let rp: FakeRunPod;
let memberId: string;
let allocationId: string;
let rnd = 0;
beforeEach(async () => {
  rp = new FakeRunPod();
  w = await world({});
  memberId = await addMember(w, "m@example.com", "member", { allocation: 0 });
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
});

function env(provider: ContainerProvider | null = rp, elapsed = 0): ContainerEnv {
  return {
    db: w.db,
    clock: () => w.clock.t,
    provider,
    expect: { image: IMAGE, launcher: LAUNCHER, bootEnv: BOOT_ENV },
    randomBytes: (n) => {
      rnd++;
      return Uint8Array.from({ length: n }, (_, i) => (rnd * 37 + i * 11) & 255);
    },
    elapsedMs: () => elapsed,
  };
}

async function machine(): Promise<string> {
  const machineId = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES (?, ?, ?, ?, 'runpod', 'A40', 1, 'EU-SE-1', 'starting', 1, ?)`,
      machineId, w.projectId, allocationId, memberId, T0,
    ),
  ]);
  return machineId;
}

function req(machineId: string, over: Partial<ContainerLaunch> = {}): ContainerLaunch {
  return {
    machineId,
    incarnation: 1,
    agentSha256: AGENT,
    credentialKind: "ours",
    rate: RATE,
    spec: { machineId, gpuType: "A40", gpuCount: 1, dataCenter: "EU-SE-1", image: IMAGE, diskGb: 20, launcher: LAUNCHER, maxProviderCostPerHour: 1_000_000 },
    ...over,
  };
}

interface L {
  outcome: string;
  provider_machine_id: string | null;
  first_running_ms: number | null;
  next_ms: number | null;
  terminate_reason: string | null;
  watchdog_version: number;
}
const launch = async (m: string) => (await w.db.all<L>(`SELECT * FROM launches WHERE machine_id = ? AND incarnation = 1`, [m]))[0]!;
interface Tok {
  token_sha256: string;
  provider_machine_id: string | null;
  issued_ms: number | null;
  expires_ms: number | null;
  used_ms: number | null;
}
const token = async (m: string) => (await w.db.all<Tok>(`SELECT * FROM boot_tokens WHERE machine_id = ? AND incarnation = 1`, [m]))[0]!;
const accruals = (m: string) =>
  w.db.all<{ provider: string; provider_cost_per_hour: number; margin_bps: number; start_ms: number; end_ms: number | null }>(`SELECT * FROM machine_accruals WHERE machine_id = ?`, [m]);

/** Records, at each provider terminate, whether this machine's token was already revoked in the database. */
function watchRevocation(m: string): boolean[] {
  const seen: boolean[] = [];
  rp.onTerminate = () => {
    const r = w.db.raw.prepare(`SELECT used_ms FROM boot_tokens WHERE machine_id = ?`).get(m) as { used_ms: number | null } | undefined;
    seen.push(r !== undefined && r.used_ms !== null);
  };
  return seen;
}

// ================================================================ the intent

test("intent: the launch (creating, due at the create deadline), its pinned rate and a pending token, before any create", async () => {
  const m = await machine();
  assert.equal(await launchContainer(env(), req(m)), "created");
  const spec = rp.specs[0]!;
  // the token reached the create only as the pod's env value; the database keeps only its hash
  assert.equal((await token(m)).token_sha256, sha(spec.bootToken));
  assert.match(spec.bootToken, /^[A-Za-z0-9_-]{43}$/);
  const l = await launch(m);
  assert.equal(l.outcome, "creating");
  assert.equal(l.next_ms, T0 + CREATE_DEADLINE_MS);
  assert.deepEqual((await w.db.all(`SELECT provider_cost_per_hour, margin_bps FROM launch_rates WHERE machine_id = ?`, [m])).map((r) => ({ ...(r as object) })), [{ provider_cost_per_hour: 590_000, margin_bps: 3000 }]);
});

test("intent: all or nothing, and no create without it", async () => {
  const m = await machine();
  // a rate the schema refuses: no launch, no rate, no token, and the provider never called
  assert.equal(await launchContainer(env(), req(m, { rate: { providerCostPerHour: -1, marginBps: 0 } })), "not-started");
  assert.equal(rp.specs.length, 0);
  for (const t of ["launches", "launch_rates", "boot_tokens"]) assert.deepEqual(await w.db.all(`SELECT 1 FROM ${t} WHERE machine_id = ?`, [m]), [], t);
  // a token hash already taken: nothing of the intent either
  const m2 = await machine();
  await recordContainerIntent(w.db, { machineId: m2, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha("x") });
  const m3 = await machine();
  await assert.rejects(recordContainerIntent(w.db, { machineId: m3, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha("x") }));
  for (const t of ["launches", "launch_rates", "boot_tokens"]) assert.deepEqual(await w.db.all(`SELECT 1 FROM ${t} WHERE machine_id = ?`, [m3]), [], t);
  // a second intent for the same launch: refused before any create
  assert.equal(await launchContainer(env(), req(m2)), "not-started");
  assert.equal(rp.specs.length, 0);
});

// ================================================================ the id batch

test("id batch: the id on the launch and its token, and the accrual from the pinned rate at the intent", async () => {
  w.clock.t = T0 + 12_345;
  const m = await machine();
  assert.equal(await launchContainer(env(), req(m)), "created");
  const l = await launch(m);
  assert.equal(l.outcome, "creating");
  assert.equal(l.provider_machine_id, "pod1");
  assert.equal((await token(m)).provider_machine_id, "pod1");
  assert.equal((await token(m)).issued_ms, null, "still pending: no window before first running");
  assert.deepEqual(
    (await accruals(m)).map((a) => [a.provider, a.provider_cost_per_hour, a.margin_bps, a.start_ms, a.end_ms]),
    [["runpod", 590_000, 3000, T0 + 12_345, null]],
  );
  assert.deepEqual((await w.db.all(`SELECT billed_through_ms FROM machines WHERE id = ?`, [m])).map((r) => ({ ...(r as object) })), [{ billed_through_ms: T0 }]);
});

test("id batch: a replay records nothing more (exactly one interval); another id, or a launch past creating, is refused with nothing written", async () => {
  const m = await machine();
  assert.equal(await launchContainer(env(), req(m)), "created");
  assert.equal(await recordContainerId(w.db, m, 1, "pod1"), "recorded");
  assert.equal(await recordContainerId(w.db, m, 1, "pod1"), "recorded");
  assert.equal((await accruals(m)).length, 1);
  const before = await launch(m);
  assert.equal(await recordContainerId(w.db, m, 1, "pod9"), "refused");
  assert.deepEqual(await launch(m), before);
  assert.equal((await token(m)).provider_machine_id, "pod1");
  // past creating: refused, and no accrual opened for a launch that never got an id
  const m2 = await machine();
  await recordContainerIntent(w.db, { machineId: m2, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(m2) });
  await w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'abort' WHERE machine_id = ?`, [m2]);
  assert.equal(await recordContainerId(w.db, m2, 1, "pod7"), "refused");
  assert.equal((await accruals(m2)).length, 0);
  assert.equal(await recordContainerId(w.db, m2, 1, "bad id"), "refused");
  // a launch already holding an id (its token not yet): another id doesn't replace it
  const m4 = await machine();
  await recordContainerIntent(w.db, { machineId: m4, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(m4) });
  await w.db.run(`UPDATE launches SET provider_machine_id = 'podA' WHERE machine_id = ?`, [m4]);
  assert.equal(await recordContainerId(w.db, m4, 1, "podB"), "refused");
  assert.equal((await launch(m4)).provider_machine_id, "podA");
  assert.equal((await token(m4)).provider_machine_id, null);
  assert.equal((await accruals(m4)).length, 0);
});

test("id batch: any part failing rolls the whole batch back (the id, the token's id, the accrual)", async () => {
  // the accrual refused (the machine already billed past the intent): nothing of the batch stays
  const m = await machine();
  await recordContainerIntent(w.db, { machineId: m, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(m) });
  await w.db.run(`UPDATE machines SET billed_through_ms = ? WHERE id = ?`, [T0 + 60_000, m]);
  assert.equal(await recordContainerId(w.db, m, 1, "pod1"), "refused");
  assert.equal((await launch(m)).provider_machine_id, null);
  assert.equal((await token(m)).provider_machine_id, null);
  assert.equal((await accruals(m)).length, 0);
  // the token already revoked: the guard after its write fails the batch, the launch keeps no id
  const m2 = await machine();
  await recordContainerIntent(w.db, { machineId: m2, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(m2) });
  await w.db.run(`UPDATE boot_tokens SET used_ms = ? WHERE machine_id = ?`, [T0, m2]);
  assert.equal(await recordContainerId(w.db, m2, 1, "pod2"), "refused");
  assert.equal((await launch(m2)).provider_machine_id, null);
  assert.equal((await accruals(m2)).length, 0);
  // an accrual already open for the incarnation (from anywhere): the id isn't recorded either
  const m3 = await machine();
  await recordContainerIntent(w.db, { machineId: m3, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(m3) });
  await w.db.run(`INSERT INTO machine_accruals (machine_id, incarnation, provider, provider_cost_per_hour, margin_bps, start_ms) VALUES (?, 1, 'runpod', ?, ?, ?)`, [m3, RATE.providerCostPerHour, RATE.marginBps, T0]);
  assert.equal(await recordContainerId(w.db, m3, 1, "pod3"), "refused");
  assert.equal((await launch(m3)).provider_machine_id, null);
});

// ================================================================ the schema's rate rules (0015)

test("0015: a container launch accrues exactly its rate from its intent; it moves only with a rate; a rate is fixed", async () => {
  const m = await machine();
  await recordContainerIntent(w.db, { machineId: m, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(m) });
  const acc = (over: Record<string, number | string>) => {
    const v = { provider: "runpod", provider_cost_per_hour: RATE.providerCostPerHour, margin_bps: RATE.marginBps, start_ms: T0, ...over };
    return w.db.run(`INSERT INTO machine_accruals (machine_id, incarnation, provider, provider_cost_per_hour, margin_bps, start_ms) VALUES (?, 1, ?, ?, ?, ?)`, [m, v.provider, v.provider_cost_per_hour, v.margin_bps, v.start_ms]);
  };
  for (const [why, over] of [
    ["another provider", { provider: "shadeform" }],
    ["another cost", { provider_cost_per_hour: RATE.providerCostPerHour + 1 }],
    ["another margin", { margin_bps: 0 }],
    ["another start", { start_ms: T0 + 60_000 }],
  ] as const) {
    await assert.rejects(acc(over), /accrues exactly at its rate/, why);
  }
  await acc({});
  // a rate is never changed or deleted, and belongs only to a creating launch
  await assert.rejects(w.db.run(`UPDATE launch_rates SET margin_bps = 0 WHERE machine_id = ?`, [m]), /rate is fixed/);
  await assert.rejects(w.db.run(`DELETE FROM launch_rates WHERE machine_id = ?`, [m]), /rate is kept/);
  const m2 = await machine();
  await assert.rejects(w.db.run(`INSERT INTO launch_rates (machine_id, incarnation, provider_cost_per_hour, margin_bps) VALUES (?, 1, 1, 0)`, [m2]), /creating launch/);
  // a container launch without a rate (written around the intent): it takes no id and doesn't leave creating, and accrues nothing
  await w.db.run(
    `INSERT INTO launches (machine_id, incarnation, mode, provider, agent_sha256, credential_kind, outcome, next_ms, created_ms) VALUES (?, 1, 'container', 'runpod', ?, 'ours', 'creating', ?, ?)`,
    [m2, AGENT, T0, T0],
  );
  await assert.rejects(w.db.run(`UPDATE launches SET provider_machine_id = 'podx' WHERE machine_id = ?`, [m2]), /moves only with its rate/);
  await assert.rejects(w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'abort' WHERE machine_id = ?`, [m2]), /moves only with its rate/);
  await assert.rejects(
    w.db.run(`INSERT INTO machine_accruals (machine_id, incarnation, provider, provider_cost_per_hour, margin_bps, start_ms) VALUES (?, 1, 'runpod', 1, 0, ?)`, [m2, T0]),
    /accrues exactly at its rate/,
  );
  // a launch past creating gets no rate
  const m5 = await machine();
  await w.db.run(
    `INSERT INTO launches (machine_id, incarnation, mode, provider, agent_sha256, credential_kind, outcome, terminate_reason, next_ms, created_ms) VALUES (?, 1, 'container', 'runpod', ?, 'ours', 'terminate', 'abort', ?, ?)`,
    [m5, AGENT, T0, T0],
  );
  await assert.rejects(w.db.run(`INSERT INTO launch_rates (machine_id, incarnation, provider_cost_per_hour, margin_bps) VALUES (?, 1, 1, 0)`, [m5]), /creating launch/);
  const m3 = await machine();
  await recordContainerIntent(w.db, { machineId: m3, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(m3) });
  await assert.rejects(
    w.db.run(`INSERT INTO launch_rates (machine_id, incarnation, provider_cost_per_hour, margin_bps) VALUES (?, 1, 1, 0)`, [m3]),
    /UNIQUE|PRIMARY KEY/,
  );
});

// ================================================================ recovery after a lost reply

test("lost reply: at the create deadline the watchdog finds the pod by name, opens its accrual at the OLD rate from the intent, revokes, then ends it", async () => {
  const m = await machine();
  rp.mode = "lost";
  assert.equal(await launchContainer(env(), req(m)), "unknown");
  assert.equal((await launch(m)).provider_machine_id, null);
  assert.equal((await accruals(m)).length, 0, "nothing billed before the pod is found");
  // the catalog and the margins change meanwhile: the launch keeps its pinned rate
  await w.db.run(`UPDATE orgs SET margin_bps = 100 WHERE id = ?`, [w.orgId]);
  await w.db.run(`UPDATE projects SET margin_bps_override = 7 WHERE id = ?`, [w.projectId]);
  w.clock.t = T0 + CREATE_DEADLINE_MS - 1;
  assert.equal(await runContainerWatchdog(env()), 0, "not due before the deadline");
  w.clock.t = T0 + CREATE_DEADLINE_MS;
  // (an earlier pod with the name, already terminated, is no live pod of this launch)
  const old = rp.pod(m, "terminated");
  const revoked = watchRevocation(m);
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.ok(!rp.terminated.includes(old));
  assert.deepEqual(revoked, [true], "the token was revoked before the provider was called");
  const l = await launch(m);
  assert.equal(l.provider_machine_id, "pod1");
  assert.equal(l.outcome, "terminated");
  assert.equal(l.terminate_reason, "create-deadline");
  const a = await accruals(m);
  assert.deepEqual(a.map((x) => [x.provider_cost_per_hour, x.margin_bps, x.start_ms, x.end_ms]), [[590_000, 3000, T0, T0 + CREATE_DEADLINE_MS]]);
});

test("a definitive create failure: abandoned with the token revoked, and zero accruals, ever", async () => {
  const m = await machine();
  rp.mode = "definitive";
  assert.equal(await launchContainer(env(), req(m)), "abandoned");
  assert.equal((await launch(m)).outcome, "terminated", "a fresh list showed no pod: confirmed");
  assert.notEqual((await token(m)).used_ms, null);
  assert.equal((await accruals(m)).length, 0);
  assert.equal((await w.db.all(`SELECT 1 FROM launch_rates WHERE machine_id = ?`, [m])).length, 1, "the rate record stays");
  // the list unreadable: not confirmed; the watchdog confirms it later, still with no accrual
  const m2 = await machine();
  rp.listFails = true;
  assert.equal(await launchContainer(env(), req(m2)), "abandoned");
  assert.equal((await launch(m2)).outcome, "terminate");
  rp.listFails = false;
  w.clock.t += 1;
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.equal((await launch(m2)).outcome, "terminated");
  assert.equal((await accruals(m2)).length, 0);
});

test("an accrual the ledger refuses for good: the pod waits for it 30 minutes from the intent (watchdog retries), then is ended by its id", async () => {
  const m = await machine();
  // (the machine already billed past this launch's intent: the ledger refuses its accrual)
  await w.db.run(`UPDATE machines SET billed_through_ms = ? WHERE id = ?`, [T0 + 60_000, m]);
  const revoked = watchRevocation(m);
  assert.equal(await launchContainer(env(), req(m)), "abandoned");
  assert.deepEqual(rp.terminated, [], "not ended before its accrual is open");
  assert.deepEqual([(await launch(m)).outcome, (await launch(m)).next_ms], ["terminate", T0], "due again at once");
  assert.notEqual((await token(m)).used_ms, null, "the token is revoked meanwhile");
  w.clock.t = T0 + 30 * 60_000 - 1;
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.deepEqual(rp.terminated, []);
  assert.equal((await launch(m)).outcome, "terminate");
  w.clock.t = T0 + 30 * 60_000;
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.deepEqual(rp.terminated, ["pod1"]);
  assert.deepEqual(revoked, [true]);
  assert.equal((await launch(m)).outcome, "terminated", "no pod listed after it was ended");
  assert.equal((await accruals(m)).length, 0);
});

test("a pod the adapter refused (it doesn't match the spec): ended by the id held, token revoked first, and billed while it existed", async () => {
  const m = await machine();
  rp.mode = "rejected";
  const revoked = watchRevocation(m);
  assert.equal(await launchContainer(env(), req(m)), "abandoned");
  assert.deepEqual(rp.terminated, ["pod1"]);
  assert.deepEqual(revoked, [true]);
  assert.equal((await launch(m)).outcome, "terminated");
  assert.equal((await accruals(m)).length, 1);
  // and with the list unreadable, the held pod is still ended (absence not confirmed: the row stays due)
  const m2 = await machine();
  rp.listFails = true;
  assert.equal(await launchContainer(env(), req(m2)), "abandoned");
  assert.deepEqual(rp.terminated, ["pod1", "pod2"]);
  assert.equal((await launch(m2)).outcome, "terminate");
});

/** The world's database, but the next `writes` batches opening an accrual, and the next `reads` reads of the accruals, fail. */
function flakyAccruals(writes: number, reads = 0): ContainerEnv["db"] {
  const db = w.db;
  return {
    all: (sql, params) => (/FROM machine_accruals/.test(sql) && reads-- > 0 ? Promise.reject(new Error("read lost")) : db.all(sql, params)),
    run: (sql, params) => db.run(sql, params),
    batch: (ss) => (ss.some((x) => /^INSERT INTO machine_accruals/.test(x.sql.trim())) && writes-- > 0 ? Promise.reject(new Error("write lost")) : db.batch(ss)),
  };
}

test("a held pod whose accrual write fails once: not ended, the launch stays due, and the next attempt bills it from the intent, then ends it", async () => {
  for (const reads of [0, 1]) {
    const t0 = w.clock.t;
    const m = await machine();
    rp.mode = "rejected";
    rp.terminated = [];
    const e = { ...env(), db: flakyAccruals(1, reads) };
    assert.equal(await launchContainer(e, req(m)), "abandoned");
    const id = [...rp.pods.keys()].at(-1)!;
    // (with the read of the accruals failing too, it is still "not open")
    assert.deepEqual(rp.terminated, [], `held pod ended before its accrual was open (reads failing: ${reads})`);
    assert.deepEqual([(await launch(m)).outcome, (await launch(m)).next_ms], ["terminate", w.clock.t]);
    assert.notEqual((await token(m)).used_ms, null);
    assert.equal((await accruals(m)).length, 0);
    w.clock.t += 60_000;
    assert.equal(await runContainerWatchdog(e), 1);
    const a = await accruals(m);
    assert.equal(a.length, 1, `terminal launch lost its durable accrual: outcome=${(await launch(m)).outcome}, accruals=${a.length}, remainingPods=${rp.pods.size}`);
    assert.deepEqual(a.map((x) => [x.provider_cost_per_hour, x.margin_bps, x.start_ms, x.end_ms]), [[590_000, 3000, t0, w.clock.t]]);
    assert.deepEqual(rp.terminated, [id]);
    assert.equal((await launch(m)).outcome, "terminated");
  }
});

test("an accrual write failing once with the list unreadable: the held pod stays up; with a pod the list doesn't show by the name, that pod is ended now", async () => {
  const m = await machine();
  rp.mode = "rejected";
  rp.listFails = true;
  const e = { ...env(), db: flakyAccruals(1) };
  assert.equal(await launchContainer(e, req(m)), "abandoned");
  assert.deepEqual(rp.terminated, [], "a list that wasn't read doesn't show the pod can't be found again");
  rp.listFails = false;
  w.clock.t += 60_000;
  assert.equal(await runContainerWatchdog(e), 1);
  assert.deepEqual(rp.terminated, ["pod1"]);
  assert.deepEqual((await accruals(m)).map((x) => x.start_ms), [T0]);
  assert.equal((await launch(m)).outcome, "terminated");
  // the provider renamed the pod: no list will find it again, so it is ended at once, unbilled
  const m2 = await machine();
  rp.mode = "renamed";
  rp.terminated = [];
  assert.equal(await launchContainer({ ...env(), db: flakyAccruals(1) }, req(m2)), "abandoned");
  assert.deepEqual(rp.terminated, ["pod2"]);
  assert.equal((await launch(m2)).outcome, "terminate");
  assert.equal((await accruals(m2)).length, 0);
});

const cleanupIds = async (m: string) => (await w.db.all<{ provider_machine_id: string }>(`SELECT provider_machine_id FROM launch_cleanup WHERE machine_id = ?`, [m])).map((c) => c.provider_machine_id);

test("a renamed held pod whose terminate throws, never answers, or answers before the pod is gone: its id is kept, and a restarted watchdog retries that id until it reads terminated", async () => {
  for (const fault of ["throw", "hang", "early"] as const) {
    const m = await machine();
    rp.mode = "renamed";
    rp.terminated = [];
    rp.terminateFaults = [fault];
    assert.equal(await launchContainer({ ...env(), db: flakyAccruals(1) }, req(m)), "abandoned");
    const id = [...rp.pods.keys()].at(-1)!;
    assert.deepEqual(rp.terminated, [id], fault);
    assert.ok(rp.pods.has(id), `${fault}: the pod is still up`);
    assert.deepEqual(await cleanupIds(m), [id], `${fault}: the held id is durable before it is confirmed gone`);
    assert.equal((await launch(m)).outcome, "terminate");
    // a fresh watchdog (a restart: nothing held in memory), a list that never shows the pod by the name
    w.clock.t += 60_000;
    assert.equal(await runContainerWatchdog(env()), 1);
    assert.deepEqual(rp.terminated, [id, id], `${fault}: retried by its id`);
    assert.ok(!rp.pods.has(id));
    assert.deepEqual(await cleanupIds(m), [], `${fault}: forgotten once read terminated`);
    assert.equal((await launch(m)).outcome, "terminated");
    assert.deepEqual((await accruals(m)).map((a) => a.end_ms === null), [false], `${fault}: billed from the intent, closed`);
  }
});

/** The world's database, but the next `n` batches writing a cleanup id fail (the claim's, or a handoff's). */
function flakyCleanup(n: number): ContainerEnv["db"] {
  const db = w.db;
  return {
    all: (sql, params) => db.all(sql, params),
    run: (sql, params) => db.run(sql, params),
    batch: (ss) => (ss.some((x) => x.sql.includes("INSERT INTO launch_cleanup")) && n-- > 0 ? Promise.reject(new Error("write lost")) : db.batch(ss)),
  };
}

test("a claim that fails once while a renamed pod is held: tried again at once; the token revoked, the pod ended by its id, billed, terminated", async () => {
  const m = await machine();
  rp.mode = "renamed";
  rp.terminated = [];
  assert.equal(await launchContainer({ ...env(), db: flakyCleanup(1) }, req(m)), "abandoned");
  assert.notEqual((await token(m)).used_ms, null);
  assert.deepEqual(rp.terminated, ["pod1"]);
  assert.equal(rp.pods.size, 0);
  assert.equal((await launch(m)).outcome, "terminated");
  assert.deepEqual((await accruals(m)).map((a) => a.start_ms), [T0]);
  assert.deepEqual(await cleanupIds(m), []);
});

test("every claim failing while a renamed pod is held: its id handed over alone, the pod kept up; a restarted watchdog ends it by id, and terminates the launch only once it reads gone", async () => {
  const m = await machine();
  rp.mode = "renamed";
  rp.terminated = [];
  assert.equal(await launchContainer({ ...env(), db: flakyCleanup(2) }, req(m)), "abandoned");
  assert.deepEqual(await cleanupIds(m), ["pod1"], "the held id is durable though no claim was won");
  assert.deepEqual(rp.terminated, [], "not ended unrecorded while its id could be kept");
  assert.equal((await launch(m)).outcome, "creating");
  // a restarted watchdog (nothing in memory) at the create deadline; the first terminate answers before the pod is gone
  w.clock.t = T0 + CREATE_DEADLINE_MS;
  rp.terminateFaults = ["early"];
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.deepEqual(rp.terminated, ["pod1"]);
  assert.ok(rp.pods.has("pod1"));
  assert.equal((await launch(m)).outcome, "terminate", "not terminated while the held pod is live");
  assert.notEqual((await token(m)).used_ms, null);
  w.clock.t += 60_000;
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.equal(rp.pods.size, 0);
  assert.deepEqual(await cleanupIds(m), []);
  assert.equal((await launch(m)).outcome, "terminated");
  assert.deepEqual((await accruals(m)).map((a) => [a.start_ms, a.end_ms !== null]), [[T0, true]]);
  // and with nothing writable at all, the held pod is ended here (no record could keep it), the launch left due
  const m2 = await machine();
  rp.terminated = [];
  assert.equal(await launchContainer({ ...env(), db: flakyCleanup(Infinity) }, req(m2)), "abandoned");
  assert.deepEqual(rp.terminated, ["pod2"]);
  assert.equal(rp.pods.size, 0);
  assert.deepEqual(await cleanupIds(m2), []);
  assert.equal((await launch(m2)).outcome, "creating");
});

test("a held id other than the recorded one: kept until its own status reads terminated; the launch isn't terminated before", async () => {
  const m = await machine();
  assert.equal(await launchContainer(env(), req(m)), "created");
  const stray = rp.pod("renamed");
  const l = await launch(m);
  // (the recorded pod's terminate works; the stray's answers before the pod is gone, `early` times)
  let early = 1;
  rp.onTerminate = (id) => {
    if (id === stray && early-- > 0) rp.terminateFaults.unshift("early");
  };
  // written with the claim, before any provider call (no adapter: nothing else happens)
  assert.equal(await terminateContainerAttempt(env(null), { ...l, machine_id: m, incarnation: 1, created_ms: T0 }, "abort", [stray, "pod1", "bad id"]), true);
  assert.deepEqual(await cleanupIds(m), [stray], "the recorded id and an invalid one are no cleanup ids");
  // a held id a second time: kept once, the claim still won
  const l2 = await launch(m);
  assert.equal(await terminateContainerAttempt(env(), { ...l2, machine_id: m, incarnation: 1, created_ms: T0 }, "abort", [stray]), true);
  assert.deepEqual(await cleanupIds(m), [stray]);
  assert.ok(rp.pods.has(stray) && !rp.pods.has("pod1"));
  assert.equal((await launch(m)).outcome, "terminate", "the recorded pod is gone, the stray isn't");
  // a status answering terminated for another id proves nothing about this one
  early = 1;
  rp.override = { providerMachineId: "pod9", state: "terminated" };
  w.clock.t += 1;
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.deepEqual(await cleanupIds(m), [stray]);
  assert.equal((await launch(m)).outcome, "terminate");
  rp.override = {};
  w.clock.t += 1;
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.deepEqual(await cleanupIds(m), []);
  assert.equal((await launch(m)).outcome, "terminated");
  // the schema: no terminated launch with cleanup left, no cleanup for a terminated launch, ids fixed
  const m2 = await machine();
  await recordContainerIntent(w.db, { machineId: m2, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(m2) });
  await w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'abort' WHERE machine_id = ?`, [m2]);
  await w.db.run(`INSERT INTO launch_cleanup (machine_id, incarnation, provider_machine_id) VALUES (?, 1, 'podZ')`, [m2]);
  await assert.rejects(w.db.run(`UPDATE launch_cleanup SET provider_machine_id = 'podY' WHERE machine_id = ?`, [m2]), /cleanup id is fixed/);
  await assert.rejects(w.db.run(`INSERT INTO launch_cleanup (machine_id, incarnation, provider_machine_id) VALUES (?, 1, 'pod Y')`, [m2]), /CHECK/);
  await assert.rejects(w.db.run(`UPDATE launches SET outcome = 'terminated', terminated_ms = ?, next_ms = NULL WHERE machine_id = ?`, [T0, m2]), /pods left to end/);
  await w.db.run(`DELETE FROM launch_cleanup WHERE machine_id = ?`, [m2]);
  await w.db.run(`UPDATE launches SET outcome = 'terminated', terminated_ms = ?, next_ms = NULL WHERE machine_id = ?`, [T0, m2]);
  await assert.rejects(w.db.run(`INSERT INTO launch_cleanup (machine_id, incarnation, provider_machine_id) VALUES (?, 1, 'podZ')`, [m2]), /not yet terminated/);
  await assert.rejects(w.db.run(`INSERT INTO launch_cleanup (machine_id, incarnation, provider_machine_id) VALUES (?, 1, 'podZ')`, [newId("machine")]), /not yet terminated/);
});

test("two pods with the name: both ended (token revoked first), one accrual from the pinned rate, terminated once none is listed", async () => {
  const m = await machine();
  rp.mode = "duplicate";
  assert.equal(await launchContainer(env(), req(m)), "unknown");
  w.clock.t = T0 + CREATE_DEADLINE_MS;
  const revoked = watchRevocation(m);
  // one terminate fails: a pod is still listed, so the launch isn't terminated yet
  rp.failTerminates = 1;
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.equal((await launch(m)).outcome, "terminate");
  assert.equal((await accruals(m))[0]!.end_ms, null);
  w.clock.t += 60_000;
  rp.terminated = [];
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.deepEqual(rp.terminated.sort(), ["pod1"]);
  assert.ok(revoked.length === 3 && revoked.every(Boolean));
  const l = await launch(m);
  assert.equal(l.terminate_reason, "duplicate-name");
  assert.equal(l.outcome, "terminated");
  assert.equal(l.provider_machine_id, null, "no single id to record");
  assert.equal((await accruals(m)).length, 1);
});

// ================================================================ first running

test("first running: a verified read, timed by control after the read; the launch issued, the token's window and the connect deadline", async () => {
  const m = await machine();
  await launchContainer(env(), req(m));
  rp.run("pod1");
  rp.duringStatus = () => {
    w.clock.t = T0 + 5000; // (the read takes time: first running is the time after it)
  };
  w.clock.t = T0 + 1000;
  assert.equal(await observeContainer(env(), m, 1), "running");
  const l = await launch(m);
  assert.equal(l.outcome, "issued");
  assert.equal(l.first_running_ms, T0 + 5000);
  assert.equal(l.next_ms, T0 + 5000 + 120_000);
  const t = await token(m);
  assert.deepEqual([t.issued_ms, t.expires_ms, t.used_ms], [T0 + 5000, T0 + 5000 + 120_000, null]);
});

test("first running only moves earlier: an older sample committing after a newer one wins; a later one changes nothing", async () => {
  const m = await machine();
  await launchContainer(env(), req(m));
  assert.equal(await recordFirstRunning(w.db, m, 1, "pod1", T0 + 9000), "recorded");
  assert.equal(await recordFirstRunning(w.db, m, 1, "pod1", T0 + 4000), "recorded");
  let l = await launch(m);
  assert.deepEqual([l.first_running_ms, l.next_ms], [T0 + 4000, T0 + 4000 + 120_000]);
  assert.deepEqual([(await token(m)).issued_ms, (await token(m)).expires_ms], [T0 + 4000, T0 + 124_000]);
  for (const t of [T0 + 4000, T0 + 7000]) assert.equal(await recordFirstRunning(w.db, m, 1, "pod1", t), "kept");
  l = await launch(m);
  assert.equal(l.first_running_ms, T0 + 4000);
  assert.equal((await token(m)).issued_ms, T0 + 4000);
});

test("first running: another provider id, a revoked token, or a launch past issued changes nothing", async () => {
  const m = await machine();
  await launchContainer(env(), req(m));
  assert.equal(await recordFirstRunning(w.db, m, 1, "pod9", T0 + 1), "kept");
  assert.equal((await launch(m)).outcome, "creating");
  await w.db.run(`UPDATE boot_tokens SET used_ms = ? WHERE machine_id = ?`, [T0, m]);
  assert.equal(await recordFirstRunning(w.db, m, 1, "pod1", T0 + 1), "kept");
  const l = await launch(m);
  assert.deepEqual([l.outcome, l.first_running_ms], ["creating", null], "the launch didn't move without its token's window");
});

test("observation: a read answering for another pod, drift, or an exited pod ends the launch (token revoked first)", async () => {
  for (const [why, setup, reason] of [
    ["another pod's answer", () => (rp.override = { providerMachineId: "pod-other" }), "provider-facts"],
    ["another machine's name", () => (rp.override = { machineId: null }), "provider-facts"],
    ["another image", () => (rp.override = { state: "running", image: "evil:latest" }), "provider-facts"],
    ["another entrypoint", () => (rp.override = { state: "running", command: ["sh"] }), "provider-facts"],
    ["an extra env name", () => (rp.override = { state: "running", envNames: [BOOT_ENV, "X"] }), "provider-facts"],
    ["an exposed port", () => (rp.override = { state: "running", exposedPorts: ["22/tcp"] }), "provider-facts"],
    ["an unexpected setting", () => (rp.override = { state: "running", unexpectedSettings: ["ssh:proxy"] }), "provider-facts"],
    ["exited", () => (rp.override = { state: "terminated" }), "pod-exited"],
    ["failed", () => (rp.override = { state: "failed" }), "pod-exited"],
  ] as const) {
    rp.override = {};
    const m = await machine();
    await launchContainer(env(), req(m));
    setup();
    const revoked = watchRevocation(m);
    assert.equal(await observeContainer(env(), m, 1), "ended", why);
    const l = await launch(m);
    assert.equal(l.terminate_reason, reason, why);
    assert.equal(l.first_running_ms, null, why);
    assert.ok(revoked.length > 0 && revoked.every(Boolean), why);
  }
  // still provisioning, or the read unavailable: nothing changes
  rp.override = {};
  const m = await machine();
  await launchContainer(env(), req(m));
  assert.equal(await observeContainer(env(), m, 1), "pending");
  rp.statusFails = true;
  assert.equal(await observeContainer(env(), m, 1), "unavailable");
  assert.equal((await launch(m)).outcome, "creating");
});

// ================================================================ the connect watchdog

test("connect watchdog: not enrolled 120 s after first running: revoked, then ended; terminated and the accrual closed only once the pod is gone", async () => {
  const m = await machine();
  await launchContainer(env(), req(m));
  rp.run("pod1");
  w.clock.t = T0 + 30_000;
  await observeContainer(env(), m, 1);
  w.clock.t = T0 + 30_000 + 120_000 - 1;
  assert.equal(await runContainerWatchdog(env()), 0);
  w.clock.t = T0 + 30_000 + 120_000;
  assert.equal(CONNECT_WINDOW_MS, 120_000);
  rp.failTerminates = 1;
  const revoked = watchRevocation(m);
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.deepEqual(revoked, [true]);
  let l = await launch(m);
  assert.deepEqual([l.outcome, l.terminate_reason], ["terminate", "connect-deadline"], "the provider failed: not confirmed");
  assert.equal((await accruals(m))[0]!.end_ms, null);
  w.clock.t += 60_000;
  assert.equal(await runContainerWatchdog(env()), 1);
  l = await launch(m);
  assert.equal(l.outcome, "terminated");
  assert.equal((await accruals(m))[0]!.end_ms, w.clock.t);
});

test("create deadline: a pod never seen running is ended at 10 minutes", async () => {
  const m = await machine();
  await launchContainer(env(), req(m));
  w.clock.t = T0 + CREATE_DEADLINE_MS;
  assert.equal(await runContainerWatchdog(env()), 1);
  const l = await launch(m);
  assert.deepEqual([l.outcome, l.terminate_reason], ["terminated", "create-deadline"]);
});

test("a claim is won once: two attempts from the same version call the provider once", async () => {
  const m = await machine();
  await launchContainer(env(), req(m));
  const l = await launch(m);
  const r = { machine_id: m, incarnation: 1, provider_machine_id: "pod1", watchdog_version: l.watchdog_version, outcome: "creating", created_ms: T0 };
  const [a, b] = await Promise.all([terminateContainerAttempt(env(), r, "abort"), terminateContainerAttempt(env(), r, "abort")]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.deepEqual(rp.terminated, ["pod1"]);
  // an enrolled or terminated launch isn't claimed here
  const done = await launch(m);
  assert.equal(await terminateContainerAttempt(env(), { ...r, watchdog_version: done.watchdog_version }, "abort"), false);
  await abandonContainer(env(), m, 1, "create-failed");
  assert.deepEqual(rp.terminated, ["pod1"]);
});

test("the watchdogs keep to their mode; the container search is a range scan of the due index, nothing sorted", async () => {
  const m = await machine();
  await launchContainer(env(), req(m));
  w.clock.t = T0 + CREATE_DEADLINE_MS;
  // the VM watchdog never touches a container launch
  assert.equal(await runVmWatchdog({ db: w.db, now: w.clock.t, vm: null, elapsedMs: () => 0 }), 0);
  assert.equal((await launch(m)).outcome, "creating");
  const plan = (w.db.raw.prepare(`EXPLAIN QUERY PLAN ${CONTAINER_WATCHDOG_SELECT}`).all(w.clock.t, WATCHDOG_BATCH) as Array<{ detail: string }>).map((p) => p.detail);
  assert.ok(plan.some((d) => /^SEARCH v USING (COVERING )?INDEX launches_next \(next_ms<\?\)$|^SEARCH v USING (COVERING )?INDEX launches_next \(next_ms>\? AND next_ms<\?\)$/.test(d)), JSON.stringify(plan));
  assert.ok(plan.every((d) => !/\bSCAN\b|TEMP B-TREE/.test(d)), JSON.stringify(plan));
  // the budget: no claim once it's spent
  assert.equal(await runContainerWatchdog(env(rp, 60_000)), 0);
  assert.equal(await runContainerWatchdog(env()), 1);
  // and the container watchdog never touches a VM launch, due or not
  const v = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES (?, ?, ?, ?, 'shadeform', 'L4', 1, 'X', 'starting', 1, ?)`,
      v, w.projectId, allocationId, memberId, T0,
    ),
    stmt(
      `INSERT INTO launches (machine_id, incarnation, mode, provider, nonce_sha256, boot_script_sha256, agent_sha256, outcome, terminate_reason, next_ms, created_ms)
       VALUES (?, 1, 'vm', 'shadeform', ?, ?, ?, 'terminate', 'abort', ?, ?)`,
      v, AGENT, AGENT, AGENT, T0, T0,
    ),
  ]);
  const before = (await w.db.all(`SELECT * FROM launches WHERE machine_id = ?`, [v])).map((r) => ({ ...(r as object) }));
  assert.equal(await runContainerWatchdog(env()), 0);
  // a full batch of VM launches due earlier takes none of the container watchdog's places
  for (let i = 0; i < WATCHDOG_BATCH; i++) {
    const x = newId("machine");
    await w.db.batch([
      stmt(
        `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms) VALUES (?, ?, ?, ?, 'shadeform', 'L4', 1, 'X', 'starting', 1, ?)`,
        x, w.projectId, allocationId, memberId, T0,
      ),
      stmt(
        `INSERT INTO launches (machine_id, incarnation, mode, provider, nonce_sha256, boot_script_sha256, agent_sha256, outcome, terminate_reason, next_ms, created_ms) VALUES (?, 1, 'vm', 'shadeform', ?, ?, ?, 'terminate', 'abort', ?, ?)`,
        x, AGENT, AGENT, AGENT, T0, T0,
      ),
    ]);
  }
  const c = await machine();
  await launchContainer(env(), req(c));
  w.clock.t = T0 + 2 * CREATE_DEADLINE_MS;
  assert.equal(await runContainerWatchdog(env()), 1);
  assert.equal((await launch(c)).terminate_reason, "create-deadline");
  assert.deepEqual((await w.db.all(`SELECT * FROM launches WHERE machine_id = ?`, [v])).map((r) => ({ ...(r as object) })), before);
});
