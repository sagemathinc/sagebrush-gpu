import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { newId } from "@sbgpu/api";
import type { ProviderMachineStatus, LaunchSpec } from "@sbgpu/providers";
import { machineName, nameFields } from "@sbgpu/providers";
import { stmt } from "./db.ts";
import { recordContainerId, recordContainerIntent, recordFirstRunning, runContainerWatchdog, type ContainerEnv, type ContainerProvider } from "./container.ts";
import { HEARTBEAT_LOST_MS } from "./heartbeat.ts";
import { HARD_STOP_PERIODS, runContainerHardStop } from "./hard-stop.ts";
import { containerHardStop, SCHEDULED_JOBS } from "./jobs.ts";
import { accrueAll, findHardStops } from "./ledger.ts";
import type { JobEnv } from "./vm.ts";
import { T0, addMember, world, type World } from "./testing/world.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const AGENT = sha("the agent");
const IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";
const LAUNCHER = ["/opt/sbgpu/launcher", "--boot"];
const BOOT_ENV = "SBGPU_BOOT_TOKEN";
const RATE = { providerCostPerHour: 590_000, marginBps: 3000 };
const LIFE_MS = 8 * 3600_000;
const MIN = 60_000;

/** A RunPod holding running pods; terminate removes one, and a missing pod reads terminated. */
class FakeRunPod implements ContainerProvider {
  pods = new Set<string>();
  owner = new Map<string, string>();
  terminated: string[] = [];
  onTerminate?: () => Promise<void>;
  async launch(spec: LaunchSpec): Promise<{ providerMachineId: string }> {
    throw new Error(`no creates here (${spec.machineId})`);
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
    await this.onTerminate?.();
    this.terminated.push(id);
    this.pods.delete(id);
  }
  async listMachines(): Promise<ProviderMachineStatus[]> {
    return [];
  }
}

let w: World;
let rp: FakeRunPod;
beforeEach(async () => {
  rp = new FakeRunPod();
  w = await world({});
});

const jenv = (): JobEnv => ({ db: w.db, now: w.clock.t, vm: null, elapsedMs: () => 0 });
const cenv = (): ContainerEnv => ({
  installation: "test",
  db: w.db,
  clock: () => w.clock.t,
  provider: rp,
  expect: { image: IMAGE, launcher: LAUNCHER, bootEnv: BOOT_ENV },
  randomBytes: (n) => new Uint8Array(n),
  elapsedMs: () => 0,
});

let members = 0;
/**
 * A member with an allocation of `amount`, and a container launch of theirs taken to `upTo`: its
 * intent, id and accrual (from T0) ("creating" stops there), first running at T0 + 1000, and, for
 * "enrolled", the writes container enroll makes at T0 + 2000 (the machine running).
 */
async function container(amount: number, upTo: "creating" | "issued" | "enrolled" = "enrolled") {
  const memberId = await addMember(w, `m${++members}@example.com`, "member", { allocation: amount });
  const allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
  const machineId = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES (?, ?, ?, ?, ?, 'runpod', 'A40', 1, 'EU-SE-1', 'starting', 1, ?)`,
      `m:${w.projectId}:${memberId}`, machineId, w.projectId, allocationId, memberId, T0,
    ),
  ]);
  await recordContainerIntent(w.db, { machineId, incarnation: 1, agentSha256: AGENT, credentialKind: "ours", rate: RATE, createdMs: T0, tokenSha256: sha(machineId) });
  const pid = `pod-${machineId.slice(-6)}`;
  rp.pods.add(pid);
  rp.owner.set(pid, machineId);
  assert.equal(await recordContainerId(w.db, machineId, 1, pid), "recorded");
  if (upTo === "creating") return { machineId, pid, allocationId };
  assert.equal(await recordFirstRunning(w.db, machineId, 1, pid, T0 + 1000), "recorded");
  if (upTo === "enrolled") {
    const at = T0 + 2000;
    await w.db.batch([
      stmt(`UPDATE boot_tokens SET used_ms = ? WHERE machine_id = ?`, at, machineId),
      stmt(
        `UPDATE launches SET outcome = 'enrolled', next_ms = NULL, heartbeat_due_ms = ?, max_end_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`,
        at + HEARTBEAT_LOST_MS, at + LIFE_MS, machineId,
      ),
      stmt(`UPDATE machines SET state = 'running' WHERE id = ?`, machineId),
    ]);
  }
  return { machineId, pid, allocationId };
}

const launch = async (m: string) => (await w.db.all<{ outcome: string; terminate_reason: string | null; next_ms: number | null }>(`SELECT outcome, terminate_reason, next_ms FROM launches WHERE machine_id = ?`, [m]))[0]!;
const machineState = async (m: string) => (await w.db.all<{ state: string }>(`SELECT state FROM machines WHERE id = ?`, [m]))[0]!.state;
const entries = async (m: string) => (await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ledger_entries WHERE machine_id = ?`, [m]))[0]!.n;
const RICH = 500_000_000; // (half the test project's budget)

test("accrue, find, mark: an allocation that's used up has its container marked hard-stop (machine stopping), then revoked and ended; a funded one runs on", async () => {
  const poor = await container(0);
  const rich = await container(RICH);
  w.clock.t = T0 + 5 * MIN + 1000;
  assert.equal(await runContainerHardStop(jenv()), 1);
  // the ledger billed both machines' closed minutes in the same run
  assert.ok((await entries(poor.machineId)) > 0 && (await entries(rich.machineId)) > 0);
  const l = await launch(poor.machineId);
  assert.deepEqual([l.outcome, l.terminate_reason, l.next_ms, await machineState(poor.machineId)], ["terminate", "hard-stop", w.clock.t, "stopping"]);
  assert.deepEqual([(await launch(rich.machineId)).outcome, await machineState(rich.machineId)], ["enrolled", "running"]);
  // the container watchdog ends it, revoked first
  const seen: [boolean, string][] = [];
  rp.onTerminate = async () => {
    const t = (await w.db.all<{ used_ms: number | null }>(`SELECT used_ms FROM boot_tokens WHERE machine_id = ?`, [poor.machineId]))[0]!;
    seen.push([t.used_ms !== null, await machineState(poor.machineId)]);
  };
  assert.equal(await runContainerWatchdog(cenv()), 1);
  assert.deepEqual([rp.terminated, seen], [[poor.pid], [[true, "stopping"]]]);
  assert.deepEqual([(await launch(poor.machineId)).outcome, await machineState(poor.machineId)], ["terminated", "stopped"]);
  // the next run: nothing more to mark
  w.clock.t += MIN;
  assert.equal(await runContainerHardStop(jenv()), 0);
  assert.equal((await launch(rich.machineId)).outcome, "enrolled");
});

test("the periods are admission's (check 60 s, safety 60 s): money between the 0 s and 60 s thresholds stops; between 60 s and 120 s it runs on", async () => {
  assert.deepEqual({ ...HARD_STOP_PERIODS }, { checkIntervalSeconds: 60, safetySeconds: 60 });
  const stopped = await container(0);
  const kept = await container(0);
  w.clock.t = T0 + 5 * MIN + 1000;
  await accrueAll(w.db, w.clock.t);
  // each allocation's thresholds, with no money, for periods of 0, 60 and 120 s
  const thresholds = async (s: number) =>
    new Map((await findHardStops(w.db, w.clock.t, { checkIntervalSeconds: s, safetySeconds: s })).map((h) => [h.allocationId, { unspent: h.unspent!, threshold: h.threshold! }]));
  const [t0, t60, t120] = [await thresholds(0), await thresholds(60), await thresholds(120)];
  const amount = (a: string, lo: Map<string, { unspent: number; threshold: number }>, hi: Map<string, { unspent: number; threshold: number }>) => {
    const low = lo.get(a)!.threshold;
    const high = hi.get(a)!.threshold;
    assert.ok(low < high, "the thresholds differ by the periods");
    return Math.floor((low + high) / 2) - lo.get(a)!.unspent; // (unspent with this amount lands between them)
  };
  await w.db.run(`UPDATE allocations SET amount = ? WHERE id = ?`, [amount(stopped.allocationId, t0, t60), stopped.allocationId]);
  await w.db.run(`UPDATE allocations SET amount = ? WHERE id = ?`, [amount(kept.allocationId, t60, t120), kept.allocationId]);
  assert.equal(await runContainerHardStop(jenv()), 1);
  assert.equal((await launch(stopped.machineId)).terminate_reason, "hard-stop");
  assert.equal((await launch(kept.machineId)).outcome, "enrolled");
});

test("a pod accruing before enroll (creating with its accrual open, or issued) is marked too (its machine stays starting, for the start path); a launch another mark ended first, or one changed after the read, is left as it is", async () => {
  const creating = await container(0, "creating");
  assert.equal((await launch(creating.machineId)).outcome, "creating");
  const issued = await container(0, "issued");
  // heartbeat-lost first
  const lost = await container(0);
  await w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'heartbeat-lost', next_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, [T0, lost.machineId]);
  // changed between the read and the mark: ended by another mark; and an issued pod that enrolls
  // (still live, at a newer version: a lost race too, marked at the next run)
  const raced = await container(0);
  const enrolling = await container(0, "issued");
  const batch = w.db.batch.bind(w.db);
  let done = false;
  let enrolled = false;
  w.db.batch = async (ss) => {
    if (!done && ss.some((s) => /terminate_reason = 'hard-stop'/.test(s.sql) && s.params.includes(raced.machineId))) {
      done = true;
      await w.db.run(`UPDATE launches SET outcome = 'terminate', terminate_reason = 'max-session', next_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`, [T0, raced.machineId]);
    }
    if (!enrolled && ss.some((s) => /terminate_reason = 'hard-stop'/.test(s.sql) && s.params.includes(enrolling.machineId))) {
      enrolled = true;
      await batch([
        stmt(`UPDATE boot_tokens SET used_ms = ? WHERE machine_id = ?`, T0 + 2000, enrolling.machineId),
        stmt(
          `UPDATE launches SET outcome = 'enrolled', next_ms = NULL, heartbeat_due_ms = ?, max_end_ms = ?, watchdog_version = watchdog_version + 1 WHERE machine_id = ?`,
          T0 + 2000 + HEARTBEAT_LOST_MS, T0 + 2000 + LIFE_MS, enrolling.machineId,
        ),
        stmt(`UPDATE machines SET state = 'running' WHERE id = ?`, enrolling.machineId),
      ]);
    }
    return batch(ss);
  };
  w.clock.t = T0 + 5 * MIN + 1000;
  try {
    assert.equal(await runContainerHardStop(jenv()), 2);
  } finally {
    w.db.batch = batch;
  }
  assert.ok(done && enrolled);
  assert.deepEqual([(await launch(enrolling.machineId)).outcome, await machineState(enrolling.machineId)], ["enrolled", "running"]);
  assert.equal(await runContainerHardStop(jenv()), 1, "the next run marks the newly enrolled launch");
  assert.equal((await launch(enrolling.machineId)).terminate_reason, "hard-stop");
  assert.deepEqual([(await launch(creating.machineId)).terminate_reason, await machineState(creating.machineId)], ["hard-stop", "starting"]);
  assert.deepEqual([(await launch(issued.machineId)).terminate_reason, await machineState(issued.machineId)], ["hard-stop", "starting"]);
  assert.equal((await launch(lost.machineId)).terminate_reason, "heartbeat-lost");
  assert.deepEqual([(await launch(raced.machineId)).terminate_reason, await machineState(raced.machineId)], ["max-session", "running"], "the failed mark moved nothing");
});

test("accrue before find: the stop's read of the allocation's spending already sees this run's billing", async () => {
  const poor = await container(0);
  const all = w.db.all.bind(w.db);
  const billedAtStopRead: number[] = [];
  w.db.all = (async (sql: string, params?: unknown[]) => {
    if (/SUM\(total\) AS spent FROM ledger_entries/.test(sql)) {
      billedAtStopRead.push((await all<{ n: number }>(`SELECT COUNT(*) AS n FROM ledger_entries WHERE machine_id = ?`, [poor.machineId]))[0]!.n);
    }
    return all(sql, params as never);
  }) as typeof w.db.all;
  w.clock.t = T0 + 5 * MIN + 1000;
  try {
    assert.equal(await runContainerHardStop(jenv()), 1);
  } finally {
    w.db.all = all;
  }
  assert.equal(billedAtStopRead.length, 1);
  assert.ok(billedAtStopRead[0]! > 0, "the minutes were billed before the stop read the spending");
  assert.equal(billedAtStopRead[0], await entries(poor.machineId), "and none after");
});

test("an accrual that fails still lets the hard stop run, then fails the job by name", async () => {
  const poor = await container(0);
  const other = await container(RICH);
  const batch = w.db.batch.bind(w.db);
  w.db.batch = async (ss) => {
    if (ss.some((s) => /INSERT INTO ledger_entries/.test(s.sql) && s.params.includes(other.machineId))) throw new Error("D1 down");
    return batch(ss);
  };
  w.clock.t = T0 + 5 * MIN + 1000;
  try {
    await assert.rejects(runContainerHardStop(jenv()), /the accrual failed for 1 machine/);
  } finally {
    w.db.batch = batch;
  }
  assert.deepEqual([(await launch(poor.machineId)).terminate_reason, await machineState(poor.machineId)], ["hard-stop", "stopping"]);
  assert.equal(await entries(other.machineId), 0);
});

test("an accrual that throws outright still lets the hard stop run, then fails the job", async () => {
  const poor = await container(0);
  // the accrual's own read of the unbilled machines fails (findHardStops' read after it doesn't)
  const all = w.db.all.bind(w.db);
  let thrown = 0;
  w.db.all = (async (sql: string, params?: unknown[]) => {
    if (thrown === 0 && /FROM machine_accruals/.test(sql)) {
      thrown++;
      throw new Error("D1 down");
    }
    return all(sql, params as never);
  }) as typeof w.db.all;
  w.clock.t = T0 + 5 * MIN + 1000;
  try {
    await assert.rejects(runContainerHardStop(jenv()), /^Error: the accrual failed$/);
  } finally {
    w.db.all = all;
  }
  assert.equal(thrown, 1);
  assert.deepEqual([(await launch(poor.machineId)).terminate_reason, await machineState(poor.machineId)], ["hard-stop", "stopping"]);
  assert.equal(await entries(poor.machineId), 0);
});

test("a mark batch that fails with the launch still live at its version is a stop not made: the others are marked, then the job fails naming it; so is one whose re-read fails", async () => {
  for (const readFails of [false, true]) {
    const failing = await container(0);
    const other = await container(0);
    const batch = w.db.batch.bind(w.db);
    const all = w.db.all.bind(w.db);
    let failedMark = false;
    w.db.batch = async (ss) => {
      if (ss.some((s) => /terminate_reason = 'hard-stop'/.test(s.sql) && s.params.includes(failing.machineId))) {
        failedMark = true;
        throw new Error("D1 down");
      }
      return batch(ss);
    };
    // (the re-read after the failed mark fails too)
    w.db.all = (async (sql: string, params?: unknown[]) => {
      if (readFails && failedMark && /SELECT 1 AS one FROM launches/.test(sql)) throw new Error("D1 still down");
      return all(sql, params as never);
    }) as typeof w.db.all;
    w.clock.t += 5 * MIN + 1000;
    try {
      await assert.rejects(runContainerHardStop(jenv()), /^Error: 1 hard stop\(s\) not marked \(D1 down\)$/, `readFails ${readFails}`);
    } finally {
      w.db.batch = batch;
      w.db.all = all;
    }
    assert.deepEqual([(await launch(failing.machineId)).outcome, await machineState(failing.machineId)], ["enrolled", "running"]);
    assert.equal((await launch(other.machineId)).terminate_reason, "hard-stop");
    // (written off for the next case: its stop is made now)
    assert.equal(await runContainerHardStop(jenv()), 1);
  }
});

test("the hard stop is scheduled", () => {
  assert.ok(SCHEDULED_JOBS.includes(containerHardStop));
  assert.equal(containerHardStop.run, runContainerHardStop);
});
