import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { newId } from "@sbgpu/api";
import type { Db } from "./db.ts";
import { stmt } from "./db.ts";
import { ANNOUNCE_DEADLINE_MS, CREATE_DEADLINE_MS, abandonLaunch, recordActive, recordLaunchIntent, recordProviderId, runVmWatchdog, terminateAttempt, type InstanceFacts, type JobEnv, type VmProvider } from "./vm.ts";
import { sqliteDb } from "./testing/sqlite.ts";
import { ORIGIN, T0, addMember, world, type World } from "./testing/world.ts";

const IP = "203.0.113.7";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SCRIPT = sha("#!/bin/sh\n# the VM-mode boot script\n");
const AGENT = sha("the agent");

class FakeVm implements VmProvider {
  facts = new Map<string, InstanceFacts>();
  terminated: string[] = [];
  factsCalls = 0;
  /** How many terminate calls fail (throw) before they start working. */
  failTerminates = 0;
  async instanceFacts(id: string): Promise<InstanceFacts> {
    this.factsCalls++;
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
  await recordLaunchIntent(db, { machineId, incarnation: 1, provider: "shadeform", nonceSha256: sha(nonce), bootScriptSha256: SCRIPT, agentSha256: AGENT, createdMs: T0 });
  return { machineId, nonce };
}
const row = async (machineId: string) =>
  ({ ...(await w.db.all<Record<string, unknown>>(`SELECT outcome, provider_machine_id, ipv4, first_active_ms, next_ms, terminate_reason, announce_ms, watchdog_version FROM launches WHERE machine_id = ?`, [machineId]))[0]! });
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
  for (const bad of ["", "x".repeat(65), "has space", "tab\there", "line\n", "vm-\u00e9", "vm\u0000x"]) {
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

test("abandoning after the id write failed: the mark stores the known id, so a failed terminate is retried by the watchdog", async () => {
  const l = await intent();
  const down: Db = { all: w.db.all, run: async () => { throw new Error("db down"); }, batch: async () => { throw new Error("db down"); } };
  await assert.rejects(recordProviderId(down, l.machineId, 1, "vm-r")); // (the id write fails; the database then recovers)
  vm.failTerminates = 1;
  await abandonLaunch(env(), l.machineId, 1, "vm-r");
  assert.deepEqual(vm.terminated, ["vm-r"]); // (tried, and failed)
  const r = await row(l.machineId);
  assert.deepEqual([r.outcome, r.provider_machine_id, r.terminate_reason, r.next_ms], ["terminate", "vm-r", "create-failed", T0]);
  assert.equal(await runVmWatchdog(env()), 1);
  assert.deepEqual(vm.terminated, ["vm-r", "vm-r"]);
  assert.equal((await row(l.machineId)).outcome, "terminated");
  // a row that already has an id keeps its own; the caller's (different) id is still terminated now
  const k = await intent();
  await recordProviderId(w.db, k.machineId, 1, "vm-own");
  await abandonLaunch(env(), k.machineId, 1, "vm-other");
  assert.equal((await row(k.machineId)).provider_machine_id, "vm-own");
  assert.equal(vm.terminated.at(-1), "vm-other");
  // a malformed id is neither stored nor called
  const b = await intent();
  vm.terminated = [];
  await abandonLaunch(env(), b.machineId, 1, "has space");
  assert.deepEqual([(await row(b.machineId)).provider_machine_id, vm.terminated], [null, []]);
});

test("the watchdog never acts on a stale snapshot: the id write, the move to ACTIVE and an abandon each invalidate it", async () => {
  w.clock.t = T0 + CREATE_DEADLINE_MS; // (the create deadline: a creating row is due)
  const stale = async (machineId: string) => {
    const r = (await w.db.all<{ provider_machine_id: string | null; watchdog_version: number }>(`SELECT provider_machine_id, watchdog_version FROM launches WHERE machine_id = ?`, [machineId]))[0]!;
    return { machine_id: machineId, incarnation: 1, provider_machine_id: r.provider_machine_id, watchdog_version: r.watchdog_version };
  };
  // ACTIVE lands between the watchdog's read and its claim (late, but before any claim: accepted)
  const a = await intent();
  await recordProviderId(w.db, a.machineId, 1, "vm-a");
  const snapA = await stale(a.machineId);
  assert.equal(await recordActive(w.db, a.machineId, 1, { providerMachineId: "vm-a", ipv4: IP, firstActiveMs: w.clock.t }), "launched");
  assert.equal(await terminateAttempt(env(), snapA, "create-deadline"), false);
  const ra = await row(a.machineId);
  assert.deepEqual([ra.outcome, ra.terminate_reason, ra.next_ms], ["launched", null, w.clock.t + ANNOUNCE_DEADLINE_MS]);
  assert.deepEqual(vm.terminated, []);
  // the id lands between read and claim: the stale (id-less) claim fails, and the next run terminates by the id
  const b = await intent();
  const snapB = await stale(b.machineId);
  assert.equal(await recordProviderId(w.db, b.machineId, 1, "vm-b"), "recorded");
  assert.equal(await terminateAttempt(env(), snapB, "create-deadline"), false);
  assert.equal((await row(b.machineId)).outcome, "creating");
  // an abandon lands between read and claim
  const c = await intent();
  const snapC = await stale(c.machineId);
  await abandonLaunch(env(), c.machineId, 1, null);
  assert.equal(await terminateAttempt(env(), snapC, "create-deadline"), false);
  assert.equal((await row(c.machineId)).terminate_reason, "create-failed");
  // the fresh run: b by its id, c claimed (no id); a not due
  assert.equal(await runVmWatchdog(env()), 2);
  assert.deepEqual(vm.terminated, ["vm-b"]);
  assert.equal((await row(a.machineId)).outcome, "launched");
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
  const upd = (set: string, ...p: Array<string | number | null>) => w.db.batch([stmt(`UPDATE launches SET ${set} WHERE machine_id = ?`, ...p, l.machineId)]);
  await assert.rejects(upd(`ipv4 = ?, first_active_ms = ?`, IP, T0), /ACTIVE facts are fixed/); // (set only by the ACTIVE transition; creating has none: CHECK, in launches-schema)
  await assert.rejects(upd(`outcome = 'launched'`), /CHECK/); // (launched needs the id and both facts)
  await assert.rejects(upd(`outcome = 'launched', provider_machine_id = 'v', ipv4 = ?`, IP), /CHECK/); // (facts together)
  await assert.rejects(upd(`outcome = 'launched', ipv4 = ?, first_active_ms = ?`, IP, T0), /CHECK/); // (and the id)
  await assert.rejects(upd(`outcome = 'terminate', terminate_reason = 'create-failed', ipv4 = ?`, IP), /ACTIVE facts are fixed/); // (only the ACTIVE transition sets them)
  await upd(`outcome = 'terminate', terminate_reason = 'create-failed'`); // (a failure before ACTIVE: no id, no facts)
  await upd(`outcome = 'terminated', terminated_ms = ?, next_ms = NULL`, T0);
  await assert.rejects(upd(`provider = 'runpod'`), /provider is fixed/); // (fixed from the intent: refused before its CHECK)
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

// ---- 0012: the agent's pin, enroll's terminate reasons, gate reports, the enroll guard

test("schema (0012): a launch pins a well-formed agent hash; enroll's reasons are allowed", async () => {
  const l = await intent();
  assert.deepEqual({ ...(await w.db.all<{ agent_sha256: string }>(`SELECT agent_sha256 FROM launches WHERE machine_id = ?`, [l.machineId]))[0] }, { agent_sha256: AGENT });
  const upd = (set: string, ...p: Array<string | number | null>) => w.db.batch([stmt(`UPDATE launches SET ${set} WHERE machine_id = ?`, ...p, l.machineId)]);
  for (const bad of [null, "", AGENT.toUpperCase(), AGENT.slice(1), AGENT + "0", "g" + AGENT.slice(1)]) await assert.rejects(upd(`agent_sha256 = ?`, bad), JSON.stringify(bad));
  for (const reason of ["second-enroll", "gate-failed", "sign-failed"]) await upd(`outcome = 'terminate', terminate_reason = ?`, reason);
  await assert.rejects(upd(`terminate_reason = 'other'`), /CHECK/);
  // (the machine exists; only the pin is wrong)
  await assert.rejects(
    recordLaunchIntent(w.db, { machineId: l.machineId, incarnation: 2, provider: "shadeform", nonceSha256: AGENT, bootScriptSha256: SCRIPT, agentSha256: "x", createdMs: T0 }),
    /CHECK/,
  );
  await recordLaunchIntent(w.db, { machineId: l.machineId, incarnation: 2, provider: "shadeform", nonceSha256: AGENT, bootScriptSha256: SCRIPT, agentSha256: AGENT, createdMs: T0 });
});

test("schema (0012): gate reports are one canonical JSON array per launch, never changed; the enroll guard takes no row but ok = 1", async () => {
  const l = await intent();
  const report = (words: string, m = l.machineId) => w.db.batch([stmt(`INSERT INTO gate_reports (machine_id, incarnation, words, at_ms) VALUES (?, 1, ?, ?)`, m, words, T0)]);
  for (const bad of ["", "{}", "\"imds\"", "[", "x".repeat(2049)]) await assert.rejects(report(bad), JSON.stringify(bad.slice(0, 10)));
  await assert.rejects(report("[]", newId("machine")), /FOREIGN KEY/); // (only for a launch)
  // (the size cap: a JSON array of exactly 2048 characters is kept, one of 2049 refused)
  const of = (n: number) => `["${"a".repeat(n - 4)}"]`;
  assert.equal(of(2049).length, 2049);
  await assert.rejects(report(of(2049)), /CHECK/);
  await report(of(2048));
  await w.db.batch([stmt(`DELETE FROM gate_reports WHERE machine_id = ?`, l.machineId)]);
  await report(`["imds"]`);
  await assert.rejects(report("[]"), /UNIQUE|PRIMARY/); // (one per launch)
  await assert.rejects(w.db.batch([stmt(`UPDATE gate_reports SET words = '[]' WHERE machine_id = ?`, l.machineId)]), /never changed/);
  await assert.rejects(w.db.batch([stmt(`INSERT INTO enroll_guard (ok) VALUES (0)`)]), /CHECK/);
  // a batch whose guard fires is rolled back whole
  await assert.rejects(w.db.batch([stmt(`UPDATE launches SET watchdog_version = 7 WHERE machine_id = ?`, l.machineId), stmt(`INSERT INTO enroll_guard (ok) SELECT 0 WHERE 1`)]));
  assert.equal((await row(l.machineId)).watchdog_version, 0);
});

test("the 0012 rebuild refuses existing launches, before changing anything", () => {
  let raw: import("node:sqlite").DatabaseSync | null = null;
  assert.throws(
    () =>
      sqliteDb({
        upgrade: {
          at: "0012",
          seed(r) {
            raw = r;
            r.exec("PRAGMA foreign_keys = OFF");
            r.prepare(`INSERT INTO vm_launches (machine_id, incarnation, provider, nonce_sha256, boot_script_sha256, outcome, next_ms, created_ms)
                       VALUES ('mch_x', 1, 'hyperstack', ?, ?, 'creating', 0, 0)`).run(sha("n"), SCRIPT);
            r.exec("PRAGMA foreign_keys = ON");
          },
        },
      }),
    /malformed JSON/,
  );
  const cols = (raw as unknown as import("node:sqlite").DatabaseSync).prepare(`SELECT name FROM pragma_table_info('vm_launches') WHERE name = 'agent_sha256'`).all();
  assert.deepEqual(cols, []); // (the old table, untouched)
});

test("schema (0012): every bounded text counts stored bytes and holds no NUL", async () => {
  const l = await intent();
  const NUL = String.fromCharCode(0);
  const upd = (col: string, v: string) => w.db.batch([stmt(`UPDATE launches SET ${col} = ? WHERE machine_id = ? AND incarnation = 1`, v, l.machineId)]);
  // the hashes: exactly 64 bytes, no NUL, lowercase hex
  const badHashes = [
    AGENT + NUL + "x".repeat(100_000), // (64 hex, then a NUL and a long tail)
    AGENT.slice(0, 63) + NUL, // (exactly 64 bytes, with a NUL)
    AGENT.slice(0, 62) + NUL + "x", // (64 bytes: a NUL, then a non-hex byte)
    "ab" + NUL, // (a short one)
    AGENT.slice(0, 62) + "\u00e9", // (64 bytes, a multibyte character)
    AGENT.slice(0, 63) + "\u00e9", // (65 bytes)
    AGENT.slice(1), // (63 hex characters)
    AGENT + "0", // (65 hex characters)
  ];
  // (a launch's hashes are fixed from its intent, so each value is tried as a new intent: another incarnation)
  let inc = 10;
  const intentWith = (col: string, v: string) => {
    const vals: Record<string, string> = { nonce_sha256: AGENT, boot_script_sha256: AGENT, agent_sha256: AGENT, [col]: v };
    return w.db.batch([stmt(
      `INSERT INTO launches (machine_id, incarnation, mode, provider, nonce_sha256, boot_script_sha256, agent_sha256, outcome, next_ms, created_ms) VALUES (?, ?, 'vm', 'shadeform', ?, ?, ?, 'creating', ?, ?)`,
      l.machineId, inc++, vals.nonce_sha256!, vals.boot_script_sha256!, vals.agent_sha256!, T0, T0,
    )]);
  };
  for (const col of ["nonce_sha256", "boot_script_sha256", "agent_sha256"]) {
    for (const bad of badHashes) await assert.rejects(intentWith(col, bad), /CHECK/, `${col} ${JSON.stringify(bad.slice(0, 70))}`);
    await intentWith(col, AGENT);
  }
  // the provider id: 1 to 64 bytes of ASCII, no NUL
  await assert.rejects(upd("provider_machine_id", "vm" + NUL + "x".repeat(100)), /CHECK/);
  await assert.rejects(upd("provider_machine_id", "vm" + NUL), /CHECK/);
  await assert.rejects(upd("provider_machine_id", "\u00e9".repeat(32)), /CHECK/); // (64 bytes, not ASCII)
  await assert.rejects(upd("provider_machine_id", "v".repeat(65)), /CHECK/);
  await upd("provider_machine_id", "v".repeat(64));
  // the IPv4 (with the id, as the state matrix wants for a launched row)
  const active = (ip: string) => w.db.batch([stmt(`UPDATE launches SET outcome = 'launched', ipv4 = ?, first_active_ms = ? WHERE machine_id = ? AND incarnation = 1`, ip, T0, l.machineId)]);
  await assert.rejects(active(IP + NUL + "x".repeat(1000)), /CHECK/);
  await assert.rejects(active("203.0.113" + NUL), /CHECK/);
  await assert.rejects(active("203.0.113.\u00e9"), /CHECK/);
  await active(IP);
  // gate words: at most 2048 bytes, no NUL (a multibyte character counts its bytes)
  const report = (words: string) => w.db.batch([stmt(`INSERT INTO gate_reports (machine_id, incarnation, words, at_ms) VALUES (?, 1, ?, ?)`, l.machineId, words, T0)]);
  const bytes = (x: string) => new TextEncoder().encode(x).length;
  await assert.rejects(report("[]" + NUL + "x".repeat(100_000)), /CHECK/); // (a long tail)
  await assert.rejects(report("[]" + NUL), /CHECK/); // (a short one, inside the cap)
  const maxNul = `["${"a".repeat(2043)}"]` + NUL; // (2048 bytes exactly, the last a NUL)
  assert.equal(bytes(maxNul), 2048);
  await assert.rejects(report(maxNul), /CHECK/);
  const emoji = "\ud83d\ude00"; // (4 bytes, 2 UTF-16 units)
  const multi = (n4: number, pad: number) => `["${emoji.repeat(n4)}${"a".repeat(pad)}"]`;
  assert.deepEqual([bytes(multi(511, 0)), bytes(multi(511, 1))], [2048, 2049]);
  await assert.rejects(report(multi(511, 1)), /CHECK/); // (2049 bytes, 516 characters)
  await report(multi(511, 0)); // (2048 bytes: kept)
  await w.db.batch([stmt(`DELETE FROM gate_reports WHERE machine_id = ?`, l.machineId)]);
  // boot tokens: the same bounds
  const tok = (h: string, pid: string, nonce: string) =>
    w.db.batch([stmt(`INSERT INTO boot_tokens (token_sha256, machine_id, incarnation, mode, provider_machine_id, nonce_sha256, issued_ms, expires_ms) VALUES (?, ?, 1, 'vm', ?, ?, ?, ?)`, h, l.machineId, pid, nonce, T0, T0 + 1000)]);
  for (const bad of badHashes) {
    await assert.rejects(tok(bad, "v", AGENT), /CHECK/, `token ${JSON.stringify(bad.slice(0, 70))}`);
    await assert.rejects(tok(AGENT, "v", bad), /CHECK/, `nonce ${JSON.stringify(bad.slice(0, 70))}`);
  }
  await assert.rejects(tok(AGENT, "v" + NUL, AGENT), /CHECK/);
  await assert.rejects(tok(AGENT, "\u00e9".repeat(32), AGENT), /CHECK/);
  await tok(AGENT, "v".repeat(64), AGENT);
});
