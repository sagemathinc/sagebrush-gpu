import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { newId } from "@sbgpu/api";
import type { ProviderMachineStatus, LaunchSpec } from "@sbgpu/providers";
import { machineName, nameFields } from "@sbgpu/providers";
import { stmt } from "./db.ts";
import { recordContainerId, recordContainerIntent, type ContainerProvider } from "./container.ts";
import { SWEEP_BACKOFF_BASE_MS, SWEEP_BACKOFF_CAP_MS, SWEEP_END_BATCH, backoffMs, runContainerSweep, type SweepEnv } from "./sweep.ts";
import { T0, addMember, world, type World } from "./testing/world.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const RATE = { providerCostPerHour: 590_000, marginBps: 3000 };

/** A RunPod listing the pods it holds (by name), each running unless given another state. */
class FakeRunPod implements ContainerProvider {
  pods = new Map<string, { name: string; state: ProviderMachineStatus["state"] }>();
  terminated: string[] = [];
  /** Every terminate call, taken or not. */
  calls = 0;
  listFails = false;
  terminateFails = new Set<string>();
  /** Every terminate fails: "reject" (nothing happens) or "lost" (the pod is ended, then the reply is lost). */
  failAll: "reject" | "lost" | null = null;
  add(id: string, name: string, state: ProviderMachineStatus["state"] = "running") {
    this.pods.set(id, { name, state });
  }
  async launch(spec: LaunchSpec): Promise<{ providerMachineId: string }> {
    throw new Error(`no creates here (${spec.machineId})`);
  }
  async status(id: string): Promise<ProviderMachineStatus> {
    throw new Error(`no status reads here (${id})`);
  }
  async terminate(id: string): Promise<void> {
    this.calls++;
    if (this.failAll === "lost") this.pods.delete(id);
    if (this.failAll !== null) throw new Error("provider down");
    if (this.terminateFails.has(id)) throw new Error("provider down");
    this.terminated.push(id);
    this.pods.delete(id);
  }
  async listMachines(): Promise<ProviderMachineStatus[]> {
    if (this.listFails) throw new Error("list malformed");
    return [...this.pods].map(([id, p]) => ({ provider: "runpod", providerMachineId: id, ...nameFields(p.name), state: p.state }) as ProviderMachineStatus);
  }
}

let w: World;
let rp: FakeRunPod;
let alerts: string[];
let elapsed = 0;
let memberId: string;
let allocationId: string;
beforeEach(async () => {
  rp = new FakeRunPod();
  alerts = [];
  elapsed = 0;
  w = await world({});
  memberId = await addMember(w, "m@example.com", "member", { allocation: 0 });
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
});

const env = (): SweepEnv => ({
  installation: "test",
  db: w.db,
  clock: () => w.clock.t,
  provider: rp,
  expect: { image: "", launcher: [], bootEnv: "SBGPU_BOOT_TOKEN" },
  randomBytes: (n) => new Uint8Array(n),
  elapsedMs: () => elapsed,
  alert: (line) => alerts.push(line),
});

/** A machine with a container launch at incarnation 1: its intent, and its pod's id when given. */
async function launch(podId: string | null = null): Promise<string> {
  const machineId = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES (?, ?, ?, ?, ?, 'runpod', 'A40', 1, 'EU-SE-1', 'starting', 1, ?)`,
      `m:${w.projectId}:${memberId}`, machineId, w.projectId, allocationId, memberId, T0,
    ),
  ]);
  await recordContainerIntent(w.db, { machineId, incarnation: 1, agentSha256: sha("a"), credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(machineId) });
  if (podId !== null) assert.equal(await recordContainerId(w.db, machineId, 1, podId), "recorded");
  return machineId;
}
const mark = (m: string) =>
  w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'abort', next_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, [T0, m]);
const finish = async (m: string) => {
  await mark(m);
  await w.db.run(`UPDATE launches SET outcome = 'terminated', terminated_ms = ?, next_ms = NULL WHERE machine_id = ?`, [T0 + 1000, m]);
};
const name = (m: string, inc = 1, installation = "test") => machineName(installation, m, inc);

test("kept: a live launch's own pod, a pod of a launch with no id yet, and one the watchdog is ending; ended by id, each alerted: no launch, a terminated launch, a stale incarnation, a live launch's extra pod", async () => {
  const live = await launch("pod-live");
  rp.add("pod-live", name(live));
  const noId = await launch();
  rp.add("pod-noid", name(noId));
  const ending = await launch("pod-ending");
  await mark(ending);
  rp.add("pod-ending", name(ending));
  const none = newId("machine");
  rp.add("pod-none", name(none));
  const done = await launch("pod-done");
  await finish(done);
  rp.add("pod-done", name(done));
  rp.add("pod-stale", name(live, 2)); // (the live machine's incarnation 2 has no launch)
  rp.add("pod-extra", name(live));
  rp.add("pod-gone", name(none, 3), "terminated"); // (listed, but gone: nothing to do)
  assert.equal(await runContainerSweep(env()), 4);
  assert.deepEqual(rp.terminated.sort(), ["pod-done", "pod-extra", "pod-none", "pod-stale"]);
  assert.deepEqual(alerts.sort(), [
    `orphan pod pod-done (${done} incarnation 1): launch-terminated; ended`,
    `orphan pod pod-extra (${live} incarnation 1): not-the-launch-pod; ended`,
    `orphan pod pod-none (${none} incarnation 1): no-launch; ended`,
    `orphan pod pod-stale (${live} incarnation 2): no-launch; ended`,
  ].sort());
  // nothing else touched: the next run ends nothing
  alerts.length = 0;
  assert.equal(await runContainerSweep(env()), 0);
  assert.deepEqual(alerts, []);
});

test("another installation's pods are reported (one line a run) and never touched, whatever their launch rows say", async () => {
  const m = newId("machine");
  rp.add("pod-a", name(m, 1, "othr"));
  rp.add("pod-b", name(m, 2, "othr"));
  assert.equal(await runContainerSweep(env()), 0);
  assert.deepEqual([rp.terminated, alerts], [[], ["2 pod(s) of another installation; left as they are"]]);
});

test("a list that can't be read ends nothing and fails the run; a launch row that can't be read leaves that pod and fails the run after the others", async () => {
  const a = newId("machine");
  const b = newId("machine");
  rp.add("pod-a", name(a));
  rp.add("pod-b", name(b));
  rp.listFails = true;
  await assert.rejects(runContainerSweep(env()), /^Error: the pod list couldn't be read$/);
  assert.deepEqual(rp.terminated, []);
  rp.listFails = false;
  const all = w.db.all.bind(w.db);
  w.db.all = (async (sql: string, params?: unknown[]) => {
    if (/FROM launches WHERE machine_id = \? AND incarnation = \? AND mode = 'container'/.test(sql) && (params as unknown[])[0] === a) throw new Error("D1 down");
    return all(sql, params as never);
  }) as typeof w.db.all;
  try {
    await assert.rejects(runContainerSweep(env()), /^Error: pod-a: its launch couldn't be read$/);
  } finally {
    w.db.all = all;
  }
  assert.deepEqual(rp.terminated, ["pod-b"]);
});

test("a termination the provider doesn't take is reported after the others; it is tried again once its back-off has passed", async () => {
  const a = newId("machine");
  const b = newId("machine");
  rp.add("pod-a", name(a));
  rp.add("pod-b", name(b));
  rp.terminateFails.add("pod-a");
  await assert.rejects(runContainerSweep(env()), /^Error: pod-a: its termination wasn't taken$/);
  assert.deepEqual(rp.terminated, ["pod-b"]);
  rp.terminateFails.clear();
  // the next run within the back-off doesn't ask again: one count, not a failure
  w.clock.t += SWEEP_BACKOFF_BASE_MS - 1;
  alerts = [];
  assert.equal(await runContainerSweep(env()), 0);
  assert.equal(rp.calls, 2);
  assert.deepEqual(alerts, ["1 orphan pod(s) waiting to be tried again (back-off)"]);
  w.clock.t += 1;
  assert.equal(await runContainerSweep(env()), 1);
  assert.deepEqual(rp.terminated, ["pod-b", "pod-a"]);
});

test("back-off (0030): a new orphan is tried at once; each refused attempt doubles the wait, from the last attempt, up to the cap", async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 1000].map(backoffMs), [1, 2, 4, 8, 16, 32, 60, 60, 60].map((m) => m * 60_000));
  assert.equal(backoffMs(7), SWEEP_BACKOFF_CAP_MS);
  for (const n of [0, -1, 1.5, NaN]) assert.throws(() => backoffMs(n), RangeError, String(n));
  rp.add("pod-x", name(newId("machine")));
  rp.terminateFails.add("pod-x");
  const t0 = w.clock.t;
  const asked: number[] = [];
  // a run every minute for three hours: asked only at each back-off's end
  for (let minute = 0; minute <= 180; minute++) {
    w.clock.t = t0 + minute * 60_000;
    const before = rp.calls;
    await runContainerSweep(env()).catch(() => {});
    if (rp.calls > before) asked.push(minute);
  }
  assert.deepEqual(asked, [0, 1, 3, 7, 15, 31, 63, 123]);
  const row = await w.db.all<{ attempts: number; last_ms: number }>(`SELECT attempts, last_ms FROM sweep_attempts WHERE provider_machine_id = 'pod-x'`);
  assert.deepEqual(row.map((r) => ({ ...r })), [{ attempts: 8, last_ms: t0 + 123 * 60_000 }]);
  // another orphan seen meanwhile is tried at once, not behind the first one's back-off
  rp.add("pod-y", name(newId("machine")));
  const before = rp.calls;
  await runContainerSweep(env()).catch(() => {});
  assert.equal(rp.calls, before + 1);
  assert.deepEqual(rp.terminated, ["pod-y"]);
});

test("back-off (0030): the attempt is recorded before the call; a machine no longer an orphan is forgotten; an unreadable list forgets nothing", async () => {
  rp.add("pod-a", name(newId("machine")));
  rp.failAll = "lost"; // (ended, then the reply is lost)
  await assert.rejects(runContainerSweep(env()));
  assert.equal((await w.db.all(`SELECT 1 FROM sweep_attempts WHERE provider_machine_id = 'pod-a'`)).length, 1, "recorded though the call failed");
  rp.failAll = null;
  rp.add("pod-b", name(newId("machine")));
  rp.terminateFails.add("pod-b");
  await assert.rejects(runContainerSweep(env()));
  // pod-a is gone from the list: its row goes; pod-b's stays
  assert.deepEqual((await w.db.all<{ id: string }>(`SELECT provider_machine_id AS id FROM sweep_attempts ORDER BY id`)).map((r) => r.id), ["pod-b"]);
  rp.listFails = true;
  rp.pods.clear();
  await assert.rejects(runContainerSweep(env()), /couldn't be read/);
  assert.deepEqual((await w.db.all<{ id: string }>(`SELECT provider_machine_id AS id FROM sweep_attempts`)).map((r) => r.id), ["pod-b"]);
  // a kept machine (its launch's own pod) is no orphan: never recorded
  rp.listFails = false;
  const m = await launch("pod-own");
  rp.add("pod-own", name(m));
  await runContainerSweep(env());
  assert.deepEqual((await w.db.all<{ id: string }>(`SELECT provider_machine_id AS id FROM sweep_attempts`)).map((r) => r.id), []);
});

test("at most a batch of orphans ended a run; the rest wait for the next, and the run says so", async () => {
  for (let i = 0; i <= SWEEP_END_BATCH; i++) rp.add(`pod-${i}`, name(newId("machine")));
  await assert.rejects(runContainerSweep(env()), /^Error: more orphans than one run ends$/);
  assert.equal(rp.terminated.length, SWEEP_END_BATCH);
  assert.equal(await runContainerSweep(env()), 1);
});

test("the cap counts attempts, not confirmations: terminations that are rejected, or whose reply is lost after the pod ended, still stop at a batch a run", async () => {
  for (const mode of ["reject", "lost"] as const) {
    rp = new FakeRunPod();
    for (let i = 0; i < SWEEP_END_BATCH + 5; i++) rp.add(`pod-${mode}-${i}`, name(newId("machine")));
    rp.failAll = mode;
    await assert.rejects(runContainerSweep(env()), /more orphans than one run ends/, mode);
    assert.equal(rp.calls, SWEEP_END_BATCH, mode);
    assert.equal(rp.pods.size, mode === "lost" ? 5 : SWEEP_END_BATCH + 5, mode);
  }
});

test("no termination once the run's time budget is spent; the orphans left are reported for the next run", async () => {
  rp.add("pod-a", name(newId("machine")));
  elapsed = 60_000;
  await assert.rejects(runContainerSweep(env()), /^Error: the run's time was spent with orphans left$/);
  assert.equal(rp.calls, 0);
  elapsed = 59_999;
  assert.equal(await runContainerSweep(env()), 1);
});

test("the sweep needs its adapter and this installation", async () => {
  await assert.rejects(runContainerSweep({ ...env(), provider: null }), /no adapter or installation/);
  await assert.rejects(runContainerSweep({ ...env(), installation: null }), /no adapter or installation/);
  assert.equal(rp.terminated.length, 0);
});
