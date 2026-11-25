import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { newId } from "@sbgpu/api";
import { stmt } from "./db.ts";
import { openAccrual } from "./ledger.ts";
import { ANNOUNCE_DEADLINE_MS, ANNOUNCE_MAX_BODY_BYTES, BOOT_TOKEN_TTL_MS, PROVIDER_CALL_DEADLINE_MS, WATCHDOG_BATCH, WATCHDOG_BUDGET_MS, WATCHDOG_SELECT, canonicalIpv4, runVmWatchdog, terminateAttempt, withDeadline, type InstanceFacts, type JobEnv, type VmProvider } from "./vm.ts";
import { ORIGIN, T0, addMember, world, type World } from "./testing/world.ts";
import { BOOT_SCRIPT_VECTOR, bootScriptSha256, renderBootScript } from "@sbgpu/machine";
import type { HyperstackAdapter } from "@sbgpu/providers";

// (the Hyperstack adapter is a VmProvider: a compile-time check)
const _adapterFits: (a: HyperstackAdapter) => VmProvider = (a) => a;
void _adapterFits;

const IP = "203.0.113.7";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const SCRIPT = sha("#!/bin/sh\n# the VM-mode boot script\n");

/** A fake provider: facts per instance, terminate calls recorded, both controllable. */
class FakeVm implements VmProvider {
  facts = new Map<string, InstanceFacts>();
  terminated: string[] = [];
  factsCalls = 0;
  hang = false;
  terminateThrows = false;
  /** After a terminate, the instance reads as absent. */
  absentAfterTerminate = true;
  async instanceFacts(id: string): Promise<InstanceFacts> {
    this.factsCalls++;
    if (this.hang) return new Promise(() => {});
    return this.facts.get(id) ?? "unavailable";
  }
  async terminate(id: string): Promise<void> {
    this.terminated.push(id);
    if (this.terminateThrows) throw new Error("provider");
    if (this.absentAfterTerminate) this.facts.set(id, { state: "absent", ipv4: null, exclusive: false });
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

let pmid = 1000;
/** A machine with an open VM launch; returns what the launcher knows. */
async function launch(o: { firstActiveMs?: number; ipv4?: string } = {}) {
  const machineId = newId("machine");
  const providerMachineId = String(++pmid);
  const nonce = randomBytes(16).toString("base64url");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, provider_machine_id, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES (?, ?, ?, ?, 'hyperstack', ?, 'L4', 1, 'CANADA-1', 'starting', 1, ?)`,
      machineId, w.projectId, allocationId, memberId, providerMachineId, T0,
    ),
    stmt(
      `INSERT INTO vm_launches (machine_id, incarnation, provider, provider_machine_id, nonce_sha256, boot_script_sha256, agent_sha256, ipv4, first_active_ms, next_ms, created_ms, outcome)
       VALUES (?, 1, 'hyperstack', ?, ?, ?, ?, ?, ?, ?, ?, 'launched')`,
      machineId, providerMachineId, sha(nonce), SCRIPT, sha("agent"), o.ipv4 ?? IP, o.firstActiveMs ?? T0, (o.firstActiveMs ?? T0) + ANNOUNCE_DEADLINE_MS, T0,
    ),
  ]);
  vm.facts.set(providerMachineId, { state: "active", ipv4: o.ipv4 ?? IP, exclusive: true });
  return { machineId, providerMachineId, nonce };
}

async function announce(body: unknown, headers: Record<string, string> = { "cf-connecting-ip": IP }) {
  const res = await w.app.fetch(new Request(`${ORIGIN}/v1/agent/announce`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  await Promise.all(w.pending.splice(0));
  return { res, json: (await res.json()) as Record<string, unknown> };
}
const bodyOf = (l: Awaited<ReturnType<typeof launch>>, extra: Record<string, unknown> = {}) => ({ machineId: l.machineId, nonce: l.nonce, bootScriptSha256: SCRIPT, ...extra });
const launchRow = async (machineId: string) =>
  (await w.db.all<{ outcome: string; terminate_reason: string | null; announce_ms: number | null; watchdog_version: number; terminated_ms: number | null }>(
    `SELECT outcome, terminate_reason, announce_ms, watchdog_version, terminated_ms FROM vm_launches WHERE machine_id = ?`, [machineId]))[0]!;
const REFUSED = { error: { code: "forbidden", message: "refused" } };

test("announce: the launcher gets a single-use token for 120 s; only its hash is kept, bound to the launch", async () => {
  const l = await launch();
  w.clock.t = T0 + 30_000;
  const r = await announce(bodyOf(l));
  assert.equal(r.res.status, 200);
  assert.equal(r.res.headers.get("cache-control"), "no-store");
  assert.equal(r.res.headers.get("location"), null);
  const token = r.json.bootToken as string;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.expiresAt, new Date(T0 + 30_000 + BOOT_TOKEN_TTL_MS).toISOString());
  const rows = await w.db.all<Record<string, unknown>>(`SELECT * FROM boot_tokens`);
  assert.deepEqual(rows.map((x) => ({ ...x })), [{
    token_sha256: sha(token), machine_id: l.machineId, incarnation: 1, provider_machine_id: l.providerMachineId, nonce_sha256: sha(l.nonce),
    issued_ms: T0 + 30_000, expires_ms: T0 + 30_000 + BOOT_TOKEN_TTL_MS, used_ms: null,
  }]);
  assert.ok(!JSON.stringify(await w.db.all(`SELECT * FROM vm_launches`)).includes(l.nonce));
  assert.deepEqual({ ...(await launchRow(l.machineId)) }, { outcome: "issued", terminate_reason: null, announce_ms: T0 + 30_000, watchdog_version: 0, terminated_ms: null });
  assert.deepEqual(vm.terminated, []);
});

test("announce: a wrong nonce, boot script, IP or machine is the fixed 403, and nothing changes", async () => {
  const l = await launch();
  const before = { ...(await launchRow(l.machineId)) };
  for (const [what, body, headers] of [
    ["nonce", bodyOf(l, { nonce: randomBytes(16).toString("base64url") }), undefined],
    ["boot script", bodyOf(l, { bootScriptSha256: sha("another script") }), undefined],
    ["another IP", bodyOf(l), { "cf-connecting-ip": "203.0.113.8" }],
    ["no IP", bodyOf(l), {}],
    ["two IPs joined", bodyOf(l), { "cf-connecting-ip": `${IP}, 198.51.100.1` }],
    ["a non-canonical IP", bodyOf(l), { "cf-connecting-ip": "203.0.113.07" }],
    ["an IPv6 IP", bodyOf(l), { "cf-connecting-ip": "::ffff:203.0.113.7" }],
    ["a client's own header only", bodyOf(l), { "x-forwarded-for": IP, "x-real-ip": IP }],
    ["an unknown machine", bodyOf(l, { machineId: newId("machine") }), undefined],
  ] as const) {
    const r = await announce(body, headers ?? { "cf-connecting-ip": IP });
    assert.equal(r.res.status, 403, what);
    assert.deepEqual(r.json, REFUSED, what);
    assert.deepEqual({ ...(await launchRow(l.machineId)) }, before, what);
  }
  assert.deepEqual(await w.db.all(`SELECT * FROM boot_tokens`), []);
  assert.deepEqual(vm.terminated, []);
  assert.equal(vm.factsCalls, 0); // (nothing reaches the provider before authentication)
  // and the right announce still works afterwards
  assert.equal((await announce(bodyOf(l))).res.status, 200);
});

test("announce: not exactly the shape is a 400, nothing changes", async () => {
  const l = await launch();
  for (const body of [
    { machineId: l.machineId, nonce: l.nonce },
    { ...bodyOf(l), extra: 1 },
    bodyOf(l, { nonce: l.nonce + "x" }),
    bodyOf(l, { bootScriptSha256: SCRIPT.toUpperCase() }),
    bodyOf(l, { machineId: "mch_nope" }),
    bodyOf(l, { nonce: 5 }),
  ]) {
    const r = await announce(body);
    assert.equal(r.res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await launchRow(l.machineId)).outcome, "launched");
});

test("announce: after authentication, wrong provider facts, the provider unavailable or the deadline terminate (one attempt)", async () => {
  for (const [what, setup, reason] of [
    ["not active", (l: Awaited<ReturnType<typeof launch>>) => vm.facts.set(l.providerMachineId, { state: "other", ipv4: IP, exclusive: true }), "provider-facts"],
    ["not exclusive", (l: Awaited<ReturnType<typeof launch>>) => vm.facts.set(l.providerMachineId, { state: "active", ipv4: IP, exclusive: false }), "provider-facts"],
    ["another IPv4 now", (l: Awaited<ReturnType<typeof launch>>) => vm.facts.set(l.providerMachineId, { state: "active", ipv4: "198.51.100.9", exclusive: true }), "provider-facts"],
    ["unavailable", (l: Awaited<ReturnType<typeof launch>>) => vm.facts.set(l.providerMachineId, "unavailable"), "provider-unavailable"],
  ] as const) {
    const l = await launch();
    setup(l);
    const r = await announce(bodyOf(l));
    assert.deepEqual([r.res.status, r.json], [403, REFUSED], what);
    const row = await launchRow(l.machineId);
    // (terminated at once: the fake confirms the instance absent after the terminate)
    assert.deepEqual([row.outcome, row.terminate_reason, row.announce_ms !== null], ["terminated", reason, true], what);
    assert.ok(vm.terminated.includes(l.providerMachineId), what);
    // the attempt is used up: even a good second one terminates
    vm.facts.set(l.providerMachineId, { state: "active", ipv4: IP, exclusive: true });
    assert.equal((await announce(bodyOf(l))).res.status, 403, what);
  }
  // the deadline: 10 minutes from the first ACTIVE report, exactly
  const late = await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS });
  const r = await announce(bodyOf(late));
  assert.equal(r.res.status, 403);
  assert.equal((await launchRow(late.machineId)).terminate_reason, "deadline");
  const inTime = await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS + 1 });
  assert.equal((await announce(bodyOf(inTime))).res.status, 200);
  assert.equal(await w.db.all(`SELECT 1 FROM boot_tokens WHERE machine_id = ?`, [late.machineId]).then((x) => x.length), 0);
});

test("announce: a provider that never answers is unavailable after its deadline", async () => {
  const l = await launch();
  vm.hang = true;
  const t0 = Date.now();
  const r = await announce(bodyOf(l));
  assert.equal(r.res.status, 403);
  assert.ok(Date.now() - t0 >= PROVIDER_CALL_DEADLINE_MS - 50);
  assert.equal((await launchRow(l.machineId)).terminate_reason, "provider-unavailable");
});

test("announce: a second announce, right or racing, terminates; one token at most", async () => {
  const l = await launch();
  assert.equal((await announce(bodyOf(l))).res.status, 200);
  w.clock.t += 1000;
  const calls = vm.factsCalls;
  const again = await announce(bodyOf(l));
  assert.deepEqual([again.res.status, again.json], [403, REFUSED]);
  assert.equal(vm.factsCalls, calls + 1); // (only the termination's own read: the second announce never reaches the facts check)
  const row = await launchRow(l.machineId);
  assert.deepEqual([row.outcome, row.terminate_reason], ["terminated", "second-announce"]);
  assert.ok(vm.terminated.includes(l.providerMachineId));
  // racing valid announces: exactly one gets a token; the machine is then terminated
  const m = await launch();
  const all = await Promise.all([1, 2, 3].map(() => announce(bodyOf(m))));
  assert.deepEqual(all.map((x) => x.res.status).sort(), [200, 403, 403]);
  assert.equal((await w.db.all(`SELECT 1 FROM boot_tokens WHERE machine_id = ?`, [m.machineId])).length, 1);
  assert.equal((await launchRow(m.machineId)).terminate_reason, "second-announce");
});

test("announce: no VM provider wired: refused after authentication, and the launch terminated", async () => {
  const bare = await world();
  const ww = w;
  w = bare;
  const mId = await addMember(w, "x@example.com", "member");
  memberId = mId;
  allocationId = (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [mId]))[0]!.id;
  const l = await launch();
  const r = await announce(bodyOf(l));
  assert.equal(r.res.status, 403);
  assert.equal((await launchRow(l.machineId)).terminate_reason, "provider-unavailable");
  w = ww;
});

// ---- the watchdog

const env = (o: Partial<JobEnv> = {}): JobEnv => ({ db: w.db, now: w.clock.t, vm, elapsedMs: () => 0, ...o });

test("watchdog: ends launches past the deadline, marked ones, and unused tokens; confirmation marks them terminated", async () => {
  const stuck = await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS });
  const fresh = await launch();
  const issued = await launch();
  assert.equal((await announce(bodyOf(issued))).res.status, 200);
  w.clock.t = T0 + BOOT_TOKEN_TTL_MS; // (the issued token expires unused)
  assert.equal(await runVmWatchdog(env()), 2);
  for (const [l, reason] of [[stuck, "watchdog-deadline"], [issued, "token-expired"]] as const) {
    const row = await launchRow(l.machineId);
    assert.deepEqual([row.outcome, row.terminate_reason, row.terminated_ms], ["terminated", reason, w.clock.t]);
  }
  assert.equal((await launchRow(fresh.machineId)).outcome, "launched");
  // terminated rows aren't eligible again
  vm.terminated = [];
  assert.equal(await runVmWatchdog(env()), 0);
  assert.deepEqual(vm.terminated, []);
});

test("watchdog: unconfirmed rows stay eligible; a throwing or hanging provider is retried next run", async () => {
  const l = await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS });
  vm.terminateThrows = true;
  vm.absentAfterTerminate = false;
  await runVmWatchdog(env());
  assert.equal((await launchRow(l.machineId)).outcome, "terminate");
  vm.terminateThrows = false;
  vm.absentAfterTerminate = true;
  w.clock.t += 60_000;
  await runVmWatchdog(env());
  assert.equal((await launchRow(l.machineId)).outcome, "terminated");
});

test("watchdog: at most a batch per run, longest-unattempted first, so persistent failures don't starve the rest", async () => {
  const n = WATCHDOG_BATCH + 5;
  const ls = [];
  for (let i = 0; i < n; i++) ls.push(await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS }));
  // the provider never confirms: every row stays eligible
  vm.absentAfterTerminate = false;
  const attempts = new Map<string, number>();
  for (let run = 0; run < 4; run++) {
    w.clock.t += 60_000;
    vm.terminated = [];
    assert.equal(await runVmWatchdog(env()), WATCHDOG_BATCH);
    for (const p of vm.terminated) attempts.set(p, (attempts.get(p) ?? 0) + 1);
  }
  // 4 runs x 20 = 80 attempts over 25 rows: every row attempted 3 or 4 times
  assert.equal(attempts.size, n);
  assert.ok([...attempts.values()].every((a) => a === 3 || a === 4), JSON.stringify([...attempts.values()]));
  assert.ok(ls.length === n);
});

test("watchdog: the run's budget: no claim past it, and unreached rows keep their place", async () => {
  const ls = [];
  for (let i = 0; i < 5; i++) ls.push(await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS }));
  let calls = 0;
  const attempted = await runVmWatchdog(env({ elapsedMs: () => (calls++ < 2 ? 0 : WATCHDOG_BUDGET_MS) }));
  assert.equal(attempted, 2);
  const versions = await w.db.all<{ v: number; ms: number | null }>(`SELECT watchdog_version AS v, next_ms AS ms FROM vm_launches ORDER BY v DESC`);
  assert.deepEqual(versions.map((x) => x.v), [1, 1, 0, 0, 0]);
  // (the unreached rows keep their place: still due at their deadline)
  assert.deepEqual(versions.slice(2).map((x) => x.ms), [T0, T0, T0]);
});

test("watchdog: a row's claim is won once; an overlapping run with the same view skips it", async () => {
  const l = await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS });
  vm.absentAfterTerminate = false;
  const row = { machine_id: l.machineId, incarnation: 1, provider_machine_id: l.providerMachineId, watchdog_version: 0 };
  assert.equal(await terminateAttempt(env(), row, "watchdog-deadline"), true);
  // (the same view, the same millisecond: the version moved, so this claim loses and calls nothing)
  vm.terminated = [];
  assert.equal(await terminateAttempt(env(), row, "watchdog-deadline"), false);
  assert.deepEqual(vm.terminated, []);
  assert.equal((await launchRow(l.machineId)).watchdog_version, 1);
});

test("canonical IPv4 only", () => {
  for (const ok of ["0.0.0.0", "203.0.113.7", "255.255.255.255", "10.0.0.1"]) assert.equal(canonicalIpv4(ok), ok);
  for (const bad of [null, "", "256.0.0.1", "01.2.3.4", "1.2.3", "1.2.3.4.5", "1.2.3.4 ", " 1.2.3.4", "1.2.3.4,5.6.7.8", "::1", "1.2.3.x"]) assert.equal(canonicalIpv4(bad), null, String(bad));
});

test("schema: one token per launch, at most 120 s; reasons exactly for terminating launches", async () => {
  const l = await launch();
  const ins = (h: string, issued: number, expires: number) =>
    w.db.batch([stmt(`INSERT INTO boot_tokens (token_sha256, machine_id, incarnation, provider_machine_id, nonce_sha256, issued_ms, expires_ms) VALUES (?, ?, 1, ?, ?, ?, ?)`, h, l.machineId, l.providerMachineId, sha("n"), issued, expires)]);
  await assert.rejects(ins(sha("a"), T0, T0 + 120_001), /CHECK/);
  await assert.rejects(ins(sha("a"), T0, T0), /CHECK/);
  await ins(sha("a"), T0, T0 + 120_000);
  await assert.rejects(ins(sha("b"), T0, T0 + 1), /UNIQUE/);
  await assert.rejects(w.db.batch([stmt(`UPDATE vm_launches SET outcome = 'terminate' WHERE machine_id = ?`, l.machineId)]), /CHECK/);
  await assert.rejects(w.db.batch([stmt(`UPDATE vm_launches SET terminate_reason = 'second-announce' WHERE machine_id = ?`, l.machineId)]), /CHECK/);
  await assert.rejects(w.db.batch([stmt(`UPDATE vm_launches SET outcome = 'issued' WHERE machine_id = ?`, l.machineId)]), /CHECK/);
  await assert.rejects(w.db.batch([stmt(`UPDATE vm_launches SET boot_script_sha256 = ? WHERE machine_id = ?`, SCRIPT.toUpperCase(), l.machineId)]), /CHECK/);
});

test("announce: a launch of an older incarnation, or an IP that's a prefix of the launch's, is refused untouched", async () => {
  const l = await launch();
  await w.db.batch([stmt(`UPDATE machines SET incarnation = 2 WHERE id = ?`, l.machineId)]);
  assert.equal((await announce(bodyOf(l))).res.status, 403);
  assert.equal((await launchRow(l.machineId)).outcome, "launched");
  const p = await launch({ ipv4: "203.0.113.70" });
  assert.equal((await announce(bodyOf(p), { "cf-connecting-ip": "203.0.113.7" })).res.status, 403);
  assert.equal((await launchRow(p.machineId)).outcome, "launched");
  assert.equal((await announce(bodyOf(p), { "cf-connecting-ip": "203.0.113.70" })).res.status, 200);
});

test("announce: a valid second announce after enroll terminates too", async () => {
  const l = await launch();
  assert.equal((await announce(bodyOf(l))).res.status, 200);
  await w.db.batch([stmt(`UPDATE vm_launches SET outcome = 'enrolled', next_ms = NULL WHERE machine_id = ?`, l.machineId)]); // (as enroll will)
  w.clock.t += 1000;
  assert.equal((await announce(bodyOf(l))).res.status, 403);
  const row = await launchRow(l.machineId);
  assert.deepEqual([row.outcome, row.terminate_reason], ["terminated", "second-announce"]);
});

test("watchdog: confirmation closes the machine's open accrual at that time", async () => {
  const l = await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS });
  await w.db.batch(openAccrual(l.machineId, { incarnation: 1, provider: "hyperstack", providerCostPerHour: 1_000_000, marginBps: 3000, startMs: T0 - ANNOUNCE_DEADLINE_MS }));
  w.clock.t = T0 + 30_000;
  await runVmWatchdog(env());
  const a = await w.db.all<{ end_ms: number | null }>(`SELECT end_ms FROM machine_accruals WHERE machine_id = ?`, [l.machineId]);
  assert.deepEqual(a.map((x) => x.end_ms), [T0 + 30_000]);
  assert.equal(WATCHDOG_BATCH, 20);
});

test("announce: the boot script's hash is the shared vector's (the same bytes on all three sides)", async () => {
  // what the start path records: the hash of the exact rendered script (gpu-wide definition in @sbgpu/machine)
  const hash = await bootScriptSha256(renderBootScript(BOOT_SCRIPT_VECTOR.values));
  assert.equal(hash, BOOT_SCRIPT_VECTOR.sha256);
  const l = await launch();
  await w.db.batch([stmt(`UPDATE vm_launches SET boot_script_sha256 = ? WHERE machine_id = ?`, hash, l.machineId)]);
  assert.equal((await announce(bodyOf(l, { bootScriptSha256: SCRIPT }))).res.status, 403); // (another script's hash)
  assert.equal((await announce(bodyOf(l, { bootScriptSha256: BOOT_SCRIPT_VECTOR.sha256 }))).res.status, 200);
});

test("watchdog: its search is a range on the partial index in its own order: no scan of history or not-yet-due rows, no sort", async () => {
  // a large final history, many active launches not yet due, a few due
  const stmts = [];
  const due: string[] = [];
  for (let i = 0; i < 4000; i++) {
    const machineId = newId("machine");
    const kind = i < 2000 ? "terminated" : i < 2400 ? "enrolled" : i < 3995 ? "fresh" : "due";
    stmts.push(stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, provider_machine_id, gpu_type, gpu_count, data_center, state, incarnation, created_ms)
       VALUES (?, ?, ?, ?, 'hyperstack', ?, 'L4', 1, 'CANADA-1', 'starting', 1, ?)`,
      machineId, w.projectId, allocationId, memberId, String(100000 + i), T0,
    ));
    const firstActive = kind === "due" ? T0 - ANNOUNCE_DEADLINE_MS : T0;
    const [outcome, reason, terminated, next] =
      kind === "terminated" ? ["terminated", "watchdog-deadline", T0, null] :
      kind === "enrolled" ? ["enrolled", null, null, null] :
      ["launched", null, null, firstActive + ANNOUNCE_DEADLINE_MS];
    stmts.push(stmt(
      `INSERT INTO vm_launches (machine_id, incarnation, provider, provider_machine_id, nonce_sha256, boot_script_sha256, agent_sha256, ipv4, first_active_ms, announce_ms, outcome, terminate_reason, terminated_ms, next_ms, created_ms)
       VALUES (?, 1, 'hyperstack', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      machineId, String(100000 + i), sha(machineId), SCRIPT, sha("agent"), IP, firstActive, kind === "enrolled" ? T0 : null, outcome, reason, terminated, next, T0,
    ));
    if (kind === "due") due.push(String(100000 + i));
  }
  await w.db.batch(stmts);
  const plan = w.db.raw.prepare(`EXPLAIN QUERY PLAN ${WATCHDOG_SELECT}`).all(w.clock.t, w.clock.t, WATCHDOG_BATCH) as Array<{ detail: string }>;
  const details = plan.map((p) => p.detail);
  // the launches: a SEARCH with the index's range, never a SCAN; nothing sorted
  assert.ok(details.some((d) => /^SEARCH v USING (COVERING )?INDEX vm_launches_next \(next_ms>\? AND next_ms<\?\)$/.test(d) || /^SEARCH v USING (COVERING )?INDEX vm_launches_next \(next_ms<\?\)$/.test(d)), JSON.stringify(details));
  assert.ok(!details.some((d) => /^SCAN v\b/.test(d)), JSON.stringify(details));
  assert.ok(!details.some((d) => /TEMP B-TREE/.test(d)), JSON.stringify(details));
  // and a run attempts exactly the due ones
  for (const p of due) vm.facts.set(p, { state: "active", ipv4: IP, exclusive: true });
  assert.equal(await runVmWatchdog(env()), due.length);
  assert.deepEqual(vm.terminated.sort(), due.sort());
  // just before the fresh ones fall due: still nothing of theirs; at their deadline: the batch
  vm.terminated = [];
  w.clock.t = T0 + ANNOUNCE_DEADLINE_MS - 1;
  assert.equal(await runVmWatchdog(env()), 0);
  w.clock.t = T0 + ANNOUNCE_DEADLINE_MS;
  assert.equal(await runVmWatchdog(env()), WATCHDOG_BATCH);
});

test("schema: next_ms is set exactly while a launch isn't final", async () => {
  const l = await launch();
  await assert.rejects(w.db.batch([stmt(`UPDATE vm_launches SET next_ms = NULL WHERE machine_id = ?`, l.machineId)]), /CHECK/);
  await assert.rejects(w.db.batch([stmt(`UPDATE vm_launches SET outcome = 'enrolled', announce_ms = ? WHERE machine_id = ?`, T0, l.machineId)]), /CHECK/);
  await w.db.batch([stmt(`UPDATE vm_launches SET outcome = 'enrolled', announce_ms = ?, next_ms = NULL WHERE machine_id = ?`, T0, l.machineId)]);
});

test("announce: the body is at most 1 KiB, refused before anything happens", async () => {
  const l = await launch();
  const padded = (bytes: number) => {
    const base = JSON.stringify(bodyOf(l));
    return "{" + " ".repeat(bytes - base.length) + base.slice(1); // (valid JSON, exactly `bytes` bytes)
  };
  const post = (raw: string, headers: Record<string, string> = {}) =>
    w.app.fetch(new Request(`${ORIGIN}/v1/agent/announce`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers }, body: raw }));
  assert.equal(padded(ANNOUNCE_MAX_BODY_BYTES + 1).length, 1025);
  for (const [what, res] of [
    ["1025 bytes", await post(padded(ANNOUNCE_MAX_BODY_BYTES + 1))],
    ["a declared 1025", await post(padded(ANNOUNCE_MAX_BODY_BYTES), { "content-length": "1025" }).catch(() => null)],
  ] as const) {
    if (res === null) continue; // (the platform may refuse a lying length itself)
    assert.equal(res.status, 400, what);
  }
  // streamed, with no length declared: counted as it arrives
  const streamed = (raw: string) => {
    const bytes = new TextEncoder().encode(raw);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 100) c.enqueue(bytes.slice(i, i + 100));
        c.close();
      },
    });
    return w.app.fetch(new Request(`${ORIGIN}/v1/agent/announce`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": IP }, body, duplex: "half" } as RequestInit));
  };
  assert.equal((await streamed(padded(ANNOUNCE_MAX_BODY_BYTES + 1))).status, 400);
  // nothing happened for any of them
  assert.equal(vm.factsCalls, 0);
  assert.equal((await launchRow(l.machineId)).outcome, "launched");
  assert.deepEqual(await w.db.all(`SELECT 1 FROM boot_tokens`), []);
  // exactly 1024, streamed: accepted
  assert.equal((await streamed(padded(ANNOUNCE_MAX_BODY_BYTES))).status, 200);
  assert.equal(ANNOUNCE_MAX_BODY_BYTES, 1024);
});

test("provider deadline: a late answer is refused even if the timer was held back; a synchronous throw is caught", async () => {
  // (the answer arrives after one yield and a busy event loop past the deadline: the timer can't fire in time)
  const late = await withDeadline(async () => {
    await Promise.resolve();
    const until = performance.now() + 300;
    while (performance.now() < until) {}
    return "active" as const;
  }, "unavailable" as const, 200);
  assert.equal(late, "unavailable");
  const inTime = await withDeadline(async () => "active" as const, "unavailable" as const, 200);
  assert.equal(inTime, "active");
  const thrown = await withDeadline((() => { throw new Error("sync"); }) as unknown as () => Promise<string>, "unavailable");
  assert.equal(thrown, "unavailable");
});

test("announce: a provider answering after a blocked event loop past 5 s is unavailable (terminated, 403)", async () => {
  const l = await launch();
  const slow: VmProvider = {
    instanceFacts: async () => {
      await Promise.resolve();
      const until = performance.now() + PROVIDER_CALL_DEADLINE_MS + 100;
      while (performance.now() < until) {}
      return { state: "active", ipv4: IP, exclusive: true };
    },
    terminate: async () => {},
  };
  w.deps.vm = slow;
  const r = await announce(bodyOf(l));
  assert.deepEqual([r.res.status, r.json], [403, REFUSED]);
  assert.equal((await launchRow(l.machineId)).terminate_reason, "provider-unavailable");
});

test("watchdog: an 'absent' that arrives after a blocked event loop past the deadline doesn't confirm", async () => {
  const l = await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS });
  const late: VmProvider = {
    instanceFacts: async () => {
      await Promise.resolve();
      const until = performance.now() + PROVIDER_CALL_DEADLINE_MS + 100;
      while (performance.now() < until) {}
      return { state: "absent", ipv4: null, exclusive: false };
    },
    terminate: async () => {},
  };
  assert.equal(await runVmWatchdog(env({ vm: late })), 1);
  assert.equal((await launchRow(l.machineId)).outcome, "terminate"); // (still eligible: not confirmed)
  // in time, it confirms
  w.clock.t += 60_000;
  await runVmWatchdog(env());
  assert.equal((await launchRow(l.machineId)).outcome, "terminated");
});

test("watchdog: rows that keep failing don't starve a row that fell due later (an attempt moves a row back)", async () => {
  vm.absentAfterTerminate = false;
  for (let i = 0; i < WATCHDOG_BATCH; i++) await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS }); // (due at T0, failing forever)
  const later = await launch({ firstActiveMs: T0 - ANNOUNCE_DEADLINE_MS + 1000 }); // (due at T0 + 1 s)
  w.clock.t = T0 + 2000;
  await runVmWatchdog(env()); // (the 20 due first)
  assert.ok(!vm.terminated.includes(later.providerMachineId));
  vm.terminated = [];
  w.clock.t = T0 + 62_000;
  await runVmWatchdog(env()); // (the 20 went behind it: it's attempted now)
  assert.ok(vm.terminated.includes(later.providerMachineId));
});
