import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { newId } from "@sbgpu/api";
import type { Db } from "./db.ts";
import { stmt } from "./db.ts";
import { ANNOUNCE_DEADLINE_MS, CREATE_DEADLINE_MS, abandonLaunch, recordActive, recordLaunchIntent, recordProviderId, runVmWatchdog, type InstanceFacts, type JobEnv, type VmProvider } from "./vm.ts";
import { sqliteDb } from "./testing/sqlite.ts";
import { ORIGIN, T0, addMember, world, type World } from "./testing/world.ts";

const IP = "203.0.113.7";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SCRIPT = sha("#!/bin/sh\n# the VM-mode boot script\n");

class FakeVm implements VmProvider {
  facts = new Map<string, InstanceFacts>();
  terminated: string[] = [];
  factsCalls = 0;
  async instanceFacts(id: string): Promise<InstanceFacts> {
    this.factsCalls++;
    return this.facts.get(id) ?? "unavailable";
  }
  async terminate(id: string): Promise<void> {
    this.terminated.push(id);
    this.facts.set(id, { state: "absent", ipv4: null, exclusive: false });
  }
}

let w: World;
let vm: FakeVm;
let memberId: string;
let allocationId: string;
beforeEach(async () => {
  vm = new FakeVm();
  w = await world({ vm });
  memberId = await addMember(w, "m@example.com", "member", { allocation: 0 });
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
});

/** A machine and its launch intent (written before any create), at T0. */
async function intent(db: Db = w.db) {
  const machineId = newId("machine");
  const nonce = randomBytes(16).toString("base64url");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES (?, ?, ?, ?, 'shadeform', 'L4', 1, 'X', 'starting', 1, ?)`,
      machineId, w.projectId, allocationId, memberId, T0,
    ),
  ]);
  await recordLaunchIntent(db, { machineId, incarnation: 1, provider: "shadeform", nonceSha256: sha(nonce), bootScriptSha256: SCRIPT, createdMs: T0 });
  return { machineId, nonce };
}
const row = async (machineId: string) =>
  ({ ...(await w.db.all<Record<string, unknown>>(`SELECT outcome, provider_machine_id, ipv4, first_active_ms, next_ms, terminate_reason, announce_ms, watchdog_version FROM vm_launches WHERE machine_id = ?`, [machineId]))[0]! });
const env = (o: Partial<JobEnv> = {}): JobEnv => ({ db: w.db, now: w.clock.t, vm, elapsedMs: () => 0, ...o });
async function announce(machineId: string, nonce: string) {
  const res = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/announce`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": IP },
    body: JSON.stringify({ machineId, nonce, bootScriptSha256: SCRIPT }),
  }));
  await Promise.all(w.pending.splice(0));
  return res.status;
}

test("the intent: creating, no id, no ACTIVE facts, due at the create deadline; an announce for it changes nothing", async () => {
  const l = await intent();
  assert.deepEqual(await row(l.machineId), {
    outcome: "creating", provider_machine_id: null, ipv4: null, first_active_ms: null, next_ms: T0 + CREATE_DEADLINE_MS,
    terminate_reason: null, announce_ms: null, watchdog_version: 0,
  });
  assert.equal(CREATE_DEADLINE_MS, 10 * 60_000);
  const before = await row(l.machineId);
  assert.equal(await announce(l.machineId, l.nonce), 403);
  assert.deepEqual(await row(l.machineId), before);
  assert.equal(vm.factsCalls, 0);
  // (and the same launch, once ACTIVE, can announce)
  assert.equal(await recordActive(w.db, l.machineId, 1, { providerMachineId: "vm-1", ipv4: IP, firstActiveMs: T0 + 60_000 }), "launched");
  vm.facts.set("vm-1", { state: "active", ipv4: IP, exclusive: true });
  assert.equal(await announce(l.machineId, l.nonce), 200);
});

test("the provider id: idempotent for the same id, refused for another, or past creating, or malformed", async () => {
  const l = await intent();
  assert.equal(await recordProviderId(w.db, l.machineId, 1, "vm-7"), "recorded");
  assert.equal(await recordProviderId(w.db, l.machineId, 1, "vm-7"), "recorded");
  assert.equal(await recordProviderId(w.db, l.machineId, 1, "vm-8"), "refused");
  assert.equal((await row(l.machineId)).provider_machine_id, "vm-7");
  assert.equal(await recordProviderId(w.db, l.machineId, 1, "x".repeat(64)), "refused"); // (a different id, though well formed)
  // malformed ids, on a launch with no id yet (so only the format refuses them)
  const f = await intent();
  for (const bad of ["", "x".repeat(65), "has space", "tab\there", "line\n"]) {
    assert.equal(await recordProviderId(w.db, f.machineId, 1, bad), "refused", JSON.stringify(bad));
    assert.equal(await recordActive(w.db, f.machineId, 1, { providerMachineId: bad, ipv4: IP, firstActiveMs: T0 }), "refused", JSON.stringify(bad));
  }
  assert.equal((await row(f.machineId)).provider_machine_id, null);
  assert.equal(await recordProviderId(w.db, f.machineId, 1, "x".repeat(64)), "recorded");
  assert.equal(await recordProviderId(w.db, newId("machine"), 1, "vm-7"), "refused"); // (no such launch)
  assert.equal(await recordActive(w.db, l.machineId, 1, { providerMachineId: "vm-7", ipv4: IP, firstActiveMs: T0 }), "launched");
  assert.equal(await recordProviderId(w.db, l.machineId, 1, "vm-7"), "refused"); // (past creating)
});

test("the move to ACTIVE: the id and both ACTIVE facts in one statement, the announce deadline from first ACTIVE", async () => {
  const a = await intent();
  await recordProviderId(w.db, a.machineId, 1, "vm-a");
  assert.equal(await recordActive(w.db, a.machineId, 1, { providerMachineId: "vm-other", ipv4: IP, firstActiveMs: T0 }), "refused");
  for (const bad of ["203.0.113.07", "::1", "", "203.0.113.7 "]) {
    assert.equal(await recordActive(w.db, a.machineId, 1, { providerMachineId: "vm-a", ipv4: bad, firstActiveMs: T0 }), "refused", bad);
  }
  assert.equal(await recordActive(w.db, a.machineId, 1, { providerMachineId: "vm-a", ipv4: IP, firstActiveMs: -1 }), "refused");
  assert.equal((await row(a.machineId)).outcome, "creating");
  assert.equal(await recordActive(w.db, a.machineId, 1, { providerMachineId: "vm-a", ipv4: IP, firstActiveMs: T0 + 5000 }), "launched");
  const r = await row(a.machineId);
  assert.deepEqual([r.outcome, r.provider_machine_id, r.ipv4, r.first_active_ms, r.next_ms], ["launched", "vm-a", IP, T0 + 5000, T0 + 5000 + ANNOUNCE_DEADLINE_MS]);
  assert.equal(await recordActive(w.db, a.machineId, 1, { providerMachineId: "vm-a", ipv4: IP, firstActiveMs: T0 + 6000 }), "refused"); // (once)
  // with no id recorded yet (the id write was lost), ACTIVE sets it
  const b = await intent();
  assert.equal(await recordActive(w.db, b.machineId, 1, { providerMachineId: "vm-b", ipv4: IP, firstActiveMs: T0 }), "launched");
  assert.equal((await row(b.machineId)).provider_machine_id, "vm-b");
});

test("abandoning with the id in hand: terminated at once even when the database can't take the id; the intent stays the watchdog's", async () => {
  const l = await intent();
  // the database refuses every write now (the id write fails, and so does the abandon's mark)
  const down: Db = { all: w.db.all, run: async () => { throw new Error("db down"); }, batch: async () => { throw new Error("db down"); } };
  await assert.rejects(recordProviderId(down, l.machineId, 1, "vm-9"));
  await abandonLaunch(env({ db: down }), l.machineId, 1, "vm-9");
  assert.deepEqual(vm.terminated, ["vm-9"]); // (with the id still in memory)
  const r = await row(l.machineId);
  assert.deepEqual([r.outcome, r.provider_machine_id, r.next_ms], ["creating", null, T0 + CREATE_DEADLINE_MS]); // (still eligible at its deadline)
  // with the database up, an abandon marks it to terminate now, and terminates
  const m = await intent();
  await recordProviderId(w.db, m.machineId, 1, "vm-10");
  await abandonLaunch(env(), m.machineId, 1, "vm-10");
  const rm = await row(m.machineId);
  assert.deepEqual([rm.outcome, rm.terminate_reason, rm.next_ms], ["terminate", "create-failed", T0]);
  assert.ok(vm.terminated.includes("vm-10"));
  await runVmWatchdog(env());
  assert.equal((await row(m.machineId)).outcome, "terminated");
  // no id at all: nothing to call, the row marked all the same
  const n = await intent();
  vm.terminated = [];
  await abandonLaunch(env(), n.machineId, 1, null);
  assert.deepEqual(vm.terminated, []);
  assert.equal((await row(n.machineId)).outcome, "terminate");
});

test("the watchdog: a creating launch past its create deadline is terminated by its id; without an id it's claimed and stays eligible", async () => {
  const withId = await intent();
  await recordProviderId(w.db, withId.machineId, 1, "vm-w");
  vm.facts.set("vm-w", { state: "other", ipv4: null, exclusive: false });
  const noId = await intent();
  w.clock.t = T0 + CREATE_DEADLINE_MS - 1;
  assert.equal(await runVmWatchdog(env()), 0); // (not before the deadline)
  w.clock.t = T0 + CREATE_DEADLINE_MS;
  assert.equal(await runVmWatchdog(env()), 2);
  const a = await row(withId.machineId);
  assert.deepEqual([a.outcome, a.terminate_reason], ["terminated", "create-deadline"]);
  assert.deepEqual(vm.terminated, ["vm-w"]);
  const b = await row(noId.machineId);
  // (claimed: it moved back and its reason is set; no provider call, since there's no id to call with)
  assert.deepEqual([b.outcome, b.terminate_reason, b.next_ms, b.watchdog_version], ["terminate", "create-deadline", T0 + CREATE_DEADLINE_MS, 1]);
  w.clock.t += 60_000;
  vm.terminated = [];
  assert.equal(await runVmWatchdog(env()), 1);
  assert.deepEqual(vm.terminated, []);
  assert.equal((await row(noId.machineId)).outcome, "terminate"); // (still eligible: not confirmed)
});

test("schema: the state matrix", async () => {
  const l = await intent();
  const upd = (set: string, ...p: Array<string | number | null>) => w.db.batch([stmt(`UPDATE vm_launches SET ${set} WHERE machine_id = ?`, ...p, l.machineId)]);
  await assert.rejects(upd(`ipv4 = ?, first_active_ms = ?`, IP, T0), /CHECK/); // (creating has no ACTIVE facts)
  await assert.rejects(upd(`outcome = 'launched'`), /CHECK/); // (launched needs the id and both facts)
  await assert.rejects(upd(`outcome = 'launched', provider_machine_id = 'v', ipv4 = ?`, IP), /CHECK/); // (facts together)
  await assert.rejects(upd(`outcome = 'launched', ipv4 = ?, first_active_ms = ?`, IP, T0), /CHECK/); // (and the id)
  await assert.rejects(upd(`outcome = 'terminate', terminate_reason = 'create-failed', ipv4 = ?`, IP), /CHECK/); // (facts together, whatever the outcome)
  await upd(`outcome = 'terminate', terminate_reason = 'create-failed'`); // (a failure before ACTIVE: no id, no facts)
  await upd(`outcome = 'terminated', terminated_ms = ?, next_ms = NULL`, T0);
  await assert.rejects(upd(`provider = 'runpod'`), /CHECK/);
});

test("the migration refuses to rebuild over existing launches, before changing anything", () => {
  let raw: import("node:sqlite").DatabaseSync | null = null;
  assert.throws(
    () =>
      sqliteDb({
        upgrade: {
          at: "0010",
          seed(r) {
            raw = r;
            r.exec("PRAGMA foreign_keys = OFF");
            r.prepare(`INSERT INTO vm_launches (machine_id, incarnation, provider, provider_machine_id, nonce_sha256, boot_script_sha256, ipv4, first_active_ms, next_ms, created_ms)
                       VALUES ('mch_x', 1, 'hyperstack', 'vm', ?, ?, ?, 0, 0, 0)`).run(sha("n"), SCRIPT, IP);
            r.exec("PRAGMA foreign_keys = ON");
          },
        },
      }),
    /malformed JSON/,
  );
  const cols = (raw as unknown as import("node:sqlite").DatabaseSync).prepare(`SELECT name, "notnull" AS nn FROM pragma_table_info('vm_launches') WHERE name = 'provider_machine_id'`).all() as Array<{ nn: number }>;
  assert.deepEqual(cols.map((c) => c.nn), [1]); // (the old table, untouched)
});
