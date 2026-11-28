// Starting a machine (start-admission r3, SEC and LIMITS clear): admitStart, the cleanup helpers,
// the stale-start job and 0019's triggers. Mock-only: nothing calls a provider.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_POLICY, minuteCharge, newId, requiredToStart, reserveSeconds, type Offer } from "@sbgpu/api";
import { stmt, type Db, type SqlValue, type Stmt } from "./db.ts";
import { closeAccrual, openAccrual } from "./ledger.ts";
import { MIGRATIONS_DIR } from "./testing/sqlite.ts";
import { SCHEDULED_JOBS, staleStarts } from "./jobs.ts";
import { T0, addMember, signIn, world, type World } from "./testing/world.ts";
import {
  exactUnspent,
  money,
  type MoneyRow,
  HARD_STOP_PERIODS,
  OFFER_FRESH_MS,
  START_INTENT_GRACE_MS,
  STALE_START_BATCH,
  abandonStart,
  abandonStartStmts,
  admitStart,
  failStaleStarts,
  failStartStmts,
  hourlyPrice,
  memberAreaKey,
  teamAreaKey,
  type StartRequest,
} from "./start.ts";

const COST = 1_000_000; // $1 an hour, the provider's
const MARGIN = 3000; // the seed org's
let w: World;
beforeEach(async () => {
  w = await world();
});

/** A signed-in member of the seed project with `amount` on their allocation: their user and member ids. */
async function member(amount: number, email = `m${Math.random().toString(36).slice(2, 8)}@example.com`) {
  const memberId = await addMember(w, email, "member", { allocation: amount });
  await signIn(w, email);
  const userId = (await w.db.all<{ id: string }>(`SELECT id FROM users WHERE email = ?`, [email]))[0]!.id;
  return { memberId, userId };
}

const offer = (over: Partial<Offer> = {}): Offer => ({
  provider: "runpod", gpuType: "L4", gpuCount: 1, dataCenter: "EU-SE-1", country: "SE", providerCostPerHour: COST, stock: "high", observedAt: new Date(T0).toISOString(), ...over,
});
const req = (userId: string, over: Partial<StartRequest> = {}): StartRequest => ({
  userId, projectId: w.projectId, payer: "member", gpuType: "L4", gpuCount: 1, listed: { offer: offer(), listedAtMs: w.clock.t }, ...over,
});

/** What one more machine at `rate` needs, with `running` commitments, now (T0 is a minute boundary). */
function need(running: { providerCostPerHour: number; marginBps: number }[] = [], rate = { providerCostPerHour: COST, marginBps: MARGIN }, unbilledSeconds = 0) {
  return requiredToStart({
    unspent: 0, newMachine: rate, running, unbilledSeconds, minStartMinutes: DEFAULT_POLICY.minStartMinutes,
    ...HARD_STOP_PERIODS, reserveSeconds: reserveSeconds(10, 0),
  });
}
const ONE = () => need();
const TWO = () => need([{ providerCostPerHour: COST, marginBps: MARGIN }]);

const machines = (db: Db = w.db) => db.all<Record<string, SqlValue>>(`SELECT id, state, incarnation, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, member_area_key, team_area_key, admitted_cost_per_hour, admitted_margin_bps FROM machines ORDER BY created_ms, id`);
const version = async (allocationId: string) => (await w.db.all<{ v: number }>(`SELECT start_version AS v FROM allocations WHERE id = ?`, [allocationId]))[0]!.v;
const allocOf = async (memberId: string) => (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [memberId]))[0]!.id;
const state = async () => JSON.stringify([await machines(), await w.db.all(`SELECT id, start_version FROM allocations ORDER BY id`)]);

/** A container launch intent for the machine at incarnation 1, as the start path records it (0014, 0015). */
const intent = (machineId: string, o: { provider?: string; rate?: number; margin?: number } = {}) =>
  w.db.batch([
    stmt(
      `INSERT INTO launches (machine_id, incarnation, mode, provider, agent_sha256, credential_kind, account_kind, outcome, next_ms, created_ms)
       VALUES (?, 1, 'container', ?, ?, 'ours', 'platform', 'creating', ?, ?)`,
      machineId, o.provider ?? "runpod", "a".repeat(64), w.clock.t, w.clock.t,
    ),
    stmt(`INSERT INTO launch_rates (machine_id, incarnation, provider_cost_per_hour, margin_bps) VALUES (?, 1, ?, ?)`, machineId, o.rate ?? COST, o.margin ?? MARGIN),
  ]);

// ---------------------------------------------------------------- admitted

test("admit: the row in starting with its keys, facts and admitted rate; the version steps; the launch facts and rate are the offer's", async () => {
  const m = await member(ONE());
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.equal(a.ok, true, JSON.stringify(a));
  if (!a.ok) return;
  const alloc = await allocOf(m.memberId);
  assert.deepEqual((await machines()).map((x) => ({ ...x })), [{
    id: a.machineId, state: "starting", incarnation: 1, allocation_id: alloc, member_id: m.memberId, provider: "runpod", gpu_type: "L4", gpu_count: 1, data_center: "EU-SE-1",
    member_area_key: memberAreaKey(w.projectId, m.memberId), team_area_key: null, admitted_cost_per_hour: COST, admitted_margin_bps: MARGIN,
  }]);
  assert.equal(await version(alloc), 1);
  assert.deepEqual(a.launch, { provider: "runpod", gpuType: "L4", gpuCount: 1, dataCenter: "EU-SE-1", maxProviderCostPerHour: COST });
  assert.deepEqual(a.rate, { providerCostPerHour: COST, marginBps: MARGIN });
  assert.deepEqual([a.incarnation, a.allocationId, a.credentialKind, a.accountKind, a.teamAreaKey], [1, alloc, "ours", "platform", null]);
  // the quote ceiling never becomes the launch's ceiling
  const m2 = await member(ONE());
  const b = await admitStart(w.db, w.clock.t, req(m2.userId, { quoteMaxPerHour: 1_999_999 }));
  assert.equal(b.ok && b.launch.maxProviderCostPerHour, COST);
});

test("admit: the margin is control's (the project's override, else the org's), and the rate pinned with it", async () => {
  await w.db.batch([stmt(`UPDATE projects SET margin_bps_override = 1000 WHERE id = ?`, w.projectId)]);
  const m = await member(need([], { providerCostPerHour: COST, marginBps: 1000 }));
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.equal(a.ok && a.rate.marginBps, 1000);
  assert.equal((await machines())[0]!.admitted_margin_bps, 1000);
});

test("admit: a team payer uses the team's allocation, and both area keys are pinned", async () => {
  const m = await member(0);
  const team = newId("team");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'T', ?)`, team, w.projectId, T0),
    stmt(`UPDATE members SET team_id = ? WHERE id = ?`, team, m.memberId),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, ?, ?)`, newId("allocation"), w.projectId, team, ONE(), T0),
  ]);
  refused(await admitStart(w.db, w.clock.t, req(m.userId)), "allocationTooLow", "the member's own is empty");
  const a = await admitStart(w.db, w.clock.t, req(m.userId, { payer: "team" }));
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual([(await machines())[0]!.member_area_key, (await machines())[0]!.team_area_key], [memberAreaKey(w.projectId, m.memberId), teamAreaKey(w.projectId, team)]);
});

// ---------------------------------------------------------------- refusals, in order, with nothing written

function refused(a: Awaited<ReturnType<typeof admitStart>>, why: string, label = why) {
  assert.equal(a.ok, false, label);
  if (!a.ok) assert.equal(a.why, why, label);
}

test("refusals: the request's shape before anything is read (a restart, a member, a price, a malformed field)", async () => {
  const m = await member(ONE());
  // (a database that fails any read: nothing may be read)
  const none: Db = { all: async () => assert.fail("read"), run: async () => assert.fail("write"), batch: async () => assert.fail("write") };
  refused(await admitStart(none, w.clock.t, { ...req(m.userId), machineId: newId("machine") } as StartRequest), "restartNotSupported");
  for (const extra of [{ memberId: m.memberId }, { providerCostPerHour: 1 }, { incarnation: 2 }]) {
    refused(await admitStart(none, w.clock.t, { ...req(m.userId), ...extra } as StartRequest), "badRequest", JSON.stringify(extra));
  }
  for (const over of [{ payer: "other" }, { gpuType: "" }, { gpuCount: 0 }, { gpuCount: 1.5 }, { quoteMaxPerHour: -1 }, { listed: null }, { listed: { offer: offer(), listedAtMs: -1 } }] as Partial<StartRequest>[]) {
    refused(await admitStart(none, w.clock.t, req(m.userId, over)), "badRequest", JSON.stringify(over));
  }
});

test("refusals: the offer (H3): stale, from the future, another GPU type or count, a bad provider, data center or cost", async () => {
  const m = await member(ONE());
  const none: Db = { all: async () => assert.fail("read"), run: async () => assert.fail("write"), batch: async () => assert.fail("write") };
  const at = (listedAtMs: number, o: Partial<Offer> = {}) => req(m.userId, { listed: { offer: offer(o), listedAtMs } });
  refused(await admitStart(none, w.clock.t, at(w.clock.t - OFFER_FRESH_MS - 1)), "staleOffer", "60001 ms");
  refused(await admitStart(none, w.clock.t, at(w.clock.t + 1)), "staleOffer", "ahead of control's clock");
  for (const o of [{ gpuType: "A100" }, { gpuCount: 2 }, { provider: "vast" as const }, { provider: "aws" as never }, { dataCenter: "" }, { dataCenter: "EU SE" }, { providerCostPerHour: -1 }, { providerCostPerHour: 1_000_000_001 }, { providerCostPerHour: 0.5 }]) {
    refused(await admitStart(none, w.clock.t, at(w.clock.t, o)), "offerMismatch", JSON.stringify(o));
  }
  // exactly 60000 ms old passes
  assert.equal((await admitStart(w.db, w.clock.t, at(w.clock.t - OFFER_FRESH_MS))).ok, true);
});

test("refusals: who (H2) and when: the user's own active member only; the project's dates; no team; byok", async () => {
  const s0 = await state();
  // a user who isn't an active member of the project: nothing they name changes that
  refused(await admitStart(w.db, w.clock.t, req(newId("user"))), "notMember");
  const removed = await member(ONE());
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, removed.memberId)]);
  let moneyReads = 0;
  const counting: Db = { ...w.db, all: async <T,>(sql: string, p?: SqlValue[]) => { if (sql.includes("'alloc' AS kind")) moneyReads++; return w.db.all<T>(sql, p); } };
  refused(await admitStart(counting, w.clock.t, req(removed.userId)), "notMember", "removed");
  assert.equal(moneyReads, 0, "a removed member's money is never read");
  // member A can only ever start as A: B's allocation is untouched, A's is the one charged
  const a = await member(0);
  const b = await member(ONE());
  refused(await admitStart(w.db, w.clock.t, req(a.userId)), "allocationTooLow", "A's own allocation, never B's");
  assert.equal(await version(await allocOf(b.memberId)), 0);
  refused(await admitStart(w.db, w.clock.t, req(b.userId, { payer: "team" })), "noTeam");
  refused(await admitStart(w.db, T0 - 1, req(b.userId, { listed: { offer: offer(), listedAtMs: T0 - 1 } })), "projectNotStarted");
  refused(await admitStart(w.db, T0 + 86_400_000, req(b.userId, { listed: { offer: offer(), listedAtMs: T0 + 86_400_000 } })), "projectEnded");
  void s0;
  assert.equal((await machines()).length, 0, "nothing written");
  assert.deepEqual((await w.db.all<{ v: number }>(`SELECT DISTINCT start_version AS v FROM allocations`)).map((x) => x.v), [0]);
  // byok
  const byok = newId("org");
  const bp = newId("project");
  await w.db.batch([
    stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'B', 'byok', 0, ?)`, byok, T0),
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P', ?, ?, 0, ?)`, bp, byok, T0, T0 + 86_400_000, T0),
  ]);
  await addMember(w, "byok@example.com", "member", { projectId: bp, allocation: 0 });
  await signIn(w, "byok@example.com");
  const u = (await w.db.all<{ id: string }>(`SELECT id FROM users WHERE email = 'byok@example.com'`))[0]!.id;
  refused(await admitStart(w.db, w.clock.t, req(u, { projectId: bp })), "byokNotYetAvailable");
  assert.equal((await machines()).length, 0);
});

test("refusals: the price cap at its boundaries: the policy's maximum and the quote's, all in, full minutes at the resolved margin", async () => {
  const max = DEFAULT_POLICY.maxPricePerHour;
  // the largest cost whose all-in price is within the policy's maximum
  let lo = 0, hi = 2_000_000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (hourlyPrice(mid, MARGIN) <= max) lo = mid;
    else hi = mid - 1;
  }
  assert.ok(hourlyPrice(lo, MARGIN) <= max && hourlyPrice(lo + 1, MARGIN) > max);
  const m = await member(10 * need([], { providerCostPerHour: lo + 1, marginBps: MARGIN }));
  const at = (cost: number, quote?: number) => req(m.userId, { listed: { offer: offer({ providerCostPerHour: cost }), listedAtMs: w.clock.t }, ...(quote !== undefined ? { quoteMaxPerHour: quote } : {}) });
  refused(await admitStart(w.db, w.clock.t, at(lo + 1)), "overPolicyPrice");
  assert.equal((await machines()).length, 0);
  const price = hourlyPrice(COST, MARGIN);
  refused(await admitStart(w.db, w.clock.t, at(COST, price - 1)), "overQuote");
  assert.equal((await admitStart(w.db, w.clock.t, at(COST, price))).ok, true, "the quote exactly");
  assert.equal((await admitStart(w.db, w.clock.t, at(lo))).ok, true, "the policy's maximum exactly");
  // (full minutes: the price is the minute's entry times 60, not the hourly figure)
  assert.equal(hourlyPrice(31, 3000) / 60, 1);
});

// ---------------------------------------------------------------- money (H1)

test("money: the canStartWithin boundary; then a second admission sees the first as a pending liability (sequential)", async () => {
  const short = await member(ONE() - 1);
  refused(await admitStart(w.db, w.clock.t, req(short.userId)), "allocationTooLow", "one micro-dollar short");
  const m = await member(ONE());
  assert.equal((await admitStart(w.db, w.clock.t, req(m.userId))).ok, true, "exactly enough");
  // the money covers one: A is admitted (and pauses before its intent); B, a fresh read, is refused
  const s = await state();
  refused(await admitStart(w.db, w.clock.t, req(m.userId)), "allocationTooLow", "B after A");
  assert.equal(await state(), s);
  // with money for two, the second passes; a third doesn't
  const two = await member(TWO());
  assert.equal((await admitStart(w.db, w.clock.t, req(two.userId))).ok, true);
  assert.equal((await admitStart(w.db, w.clock.t, req(two.userId))).ok, true);
  refused(await admitStart(w.db, w.clock.t, req(two.userId)), "allocationTooLow", "the third");
});

test("money: LIMITS's probe figures, with our 60 s safety period too: 13000000 admits one and refuses the second; 26000000 admits two", async () => {
  await w.db.batch([stmt(`UPDATE orgs SET margin_bps = 0 WHERE id = ?`, w.orgId), stmt(`UPDATE projects SET final_save_reserve_minutes = 1, policy_json = ? WHERE id = ?`, JSON.stringify({ minStartMinutes: 10, maxPricePerHour: 100_000_000 }), w.projectId)]);
  const at = (userId: string) => req(userId, { listed: { offer: offer({ providerCostPerHour: 60_000_000 }), listedAtMs: w.clock.t } });
  // (min 10 min + check 60 s + safety 60 s + reserve 60 s = 13 minutes at $1 a minute; the probe had no safety period, so 12000000 there)
  assert.equal(requiredToStart({ unspent: 0, newMachine: { providerCostPerHour: 60_000_000, marginBps: 0 }, running: [], unbilledSeconds: 0, minStartMinutes: 10, ...HARD_STOP_PERIODS, reserveSeconds: 60 }), 13_000_000);
  const one = await member(13_000_000);
  assert.equal((await admitStart(w.db, w.clock.t, at(one.userId))).ok, true);
  refused(await admitStart(w.db, w.clock.t, at(one.userId)), "allocationTooLow", "A paused, B fresh");
  const two = await member(26_000_000);
  assert.equal((await admitStart(w.db, w.clock.t, at(two.userId))).ok, true);
  assert.equal((await admitStart(w.db, w.clock.t, at(two.userId))).ok, true);
});

test("money: a pending start is counted once: its liability hands over to its accrual, never both", async () => {
  const m = await member(TWO());
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.ok(a.ok);
  if (!a.ok) return;
  // its accrual opens (the container id batch): it is counted through its interval now, at the same rate
  await w.db.batch(openAccrual(a.machineId, { incarnation: 1, provider: "runpod", providerCostPerHour: COST, marginBps: MARGIN, startMs: w.clock.t }));
  assert.equal((await admitStart(w.db, w.clock.t, req(m.userId))).ok, true, "the second fits: the first isn't counted twice");
  refused(await admitStart(w.db, w.clock.t, req(m.userId)), "allocationTooLow", "both counted");
});

test("money: abandon, fail and the stale cleanup each return the money; each touches only starting at that incarnation", async () => {
  for (const end of ["abandon", "abandonStmts", "fail", "stale"] as const) {
    const m = await member(ONE());
    const a = await admitStart(w.db, w.clock.t, req(m.userId));
    assert.ok(a.ok, end);
    if (!a.ok) continue;
    refused(await admitStart(w.db, w.clock.t, req(m.userId)), "allocationTooLow", `${end}: held`);
    if (end === "abandon") assert.equal(await abandonStart(w.db, a.machineId, 1), true);
    if (end === "abandonStmts") await w.db.batch(abandonStartStmts(a.machineId, 1));
    if (end === "fail") await w.db.batch(failStartStmts(a.machineId, 1));
    if (end === "stale") {
      const t = w.clock.t;
      const stateOf = async () => (await w.db.all<{ state: string }>(`SELECT state FROM machines WHERE id = ?`, [a.machineId]))[0]!.state;
      await w.db.batch([stmt(`UPDATE machines SET state = 'failed' WHERE state = 'starting' AND id <> ?`, a.machineId)]); // (the earlier rounds' re-admissions)
      assert.equal(await failStaleStarts(w.db, t + START_INTENT_GRACE_MS - 1), 0, "119999 ms: kept");
      assert.equal(await stateOf(), "starting");
      assert.equal(await failStaleStarts(w.db, t + START_INTENT_GRACE_MS), 1, "120000 ms: failed");
    }
    assert.equal((await w.db.all<{ state: string }>(`SELECT state FROM machines WHERE id = ?`, [a.machineId]))[0]!.state, "failed", end);
    assert.equal((await admitStart(w.db, w.clock.t, req(m.userId))).ok, true, `${end}: released`);
  }
  // each leaves a machine that moved on, or another incarnation, alone
  const m = await member(ONE());
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.equal(await abandonStart(w.db, a.machineId, 2), false, "another incarnation");
  await w.db.batch([stmt(`UPDATE machines SET state = 'running' WHERE id = ?`, a.machineId)]);
  assert.equal(await abandonStart(w.db, a.machineId, 1), false, "running");
  await w.db.batch(failStartStmts(a.machineId, 1));
  await failStaleStarts(w.db, w.clock.t + 10 * START_INTENT_GRACE_MS); // (the stale job too)
  assert.equal((await w.db.all<{ state: string }>(`SELECT state FROM machines WHERE id = ?`, [a.machineId]))[0]!.state, "running");
  // a cleanup in a batch that fails is rolled back with it
  const m2 = await member(ONE());
  const b = await admitStart(w.db, w.clock.t, req(m2.userId));
  assert.ok(b.ok);
  if (!b.ok) return;
  await assert.rejects(w.db.batch([...failStartStmts(b.machineId, 1), stmt(`INSERT INTO no_such_table (x) VALUES (1)`)]));
  assert.equal((await w.db.all<{ state: string }>(`SELECT state FROM machines WHERE id = ?`, [b.machineId]))[0]!.state, "starting");
});

test("money: the hard stop refuses first (budgetExhausted), over the commitments", async () => {
  const m = await member(ONE());
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.ok(a.ok);
  if (!a.ok) return;
  await w.db.batch(openAccrual(a.machineId, { incarnation: 1, provider: "runpod", providerCostPerHour: COST, marginBps: MARGIN, startMs: w.clock.t }));
  // two hours later, unbilled: the running machine's commitments exceed what's left
  w.clock.t += 2 * 3_600_000;
  refused(await admitStart(w.db, w.clock.t, req(m.userId)), "hardStop");
});

test("money: an untrusted figure refuses (fail closed)", async () => {
  const m = await member(ONE());
  for (const over of [{ amount: 1.5 }, { start_version: 1.5 }, { start_version: -1 }, { spent: "x" }, { spent: null }]) {
    const odd: Db = { ...w.db, all: async <T,>(sql: string, p?: SqlValue[]) => (sql.includes("'alloc' AS kind") ? ([{ kind: "alloc", allocation_id: "a", amount: 10 * ONE(), start_version: 0, spent: 0, ...over }] as T[]) : w.db.all<T>(sql, p)) };
    refused(await admitStart(odd, w.clock.t, req(m.userId)), "hardStop", JSON.stringify(over));
  }
});

/** A machine of the member's allocation, not admitted (made as the ledger tests make them), in `state`. */
async function legacyMachine(memberId: string, state = "stopped", incarnation = 1) {
  const id = newId("machine");
  await w.db.batch([stmt(
    `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms) VALUES (?, ?, ?, ?, ?, 'runpod', 'L4', 1, 'X', ?, ?, ?)`,
    memberAreaKey(w.projectId, memberId), id, w.projectId, await allocOf(memberId), memberId, state, incarnation, T0,
  )]);
  return id;
}

test("money: the ledger's entries and a stopped machine's unbilled charge are spent", async () => {
  // an entry of X on the allocation: X more is needed
  const X = 123_456;
  for (const [extra, ok] of [[X, true], [X - 1, false]] as const) {
    const m = await member(ONE() + extra);
    await w.db.batch([stmt(
      `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, created_ms) VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 0, ?, 0, ?, ?)`,
      newId("ledgerEntry"), w.orgId, w.projectId, await allocOf(m.memberId), T0, X, X, T0,
    )]);
    const a = await admitStart(w.db, w.clock.t, req(m.userId));
    assert.equal(a.ok, ok, `entries, extra ${extra}`);
  }
  // a machine that ran 5 minutes and stopped, not yet billed: its charge is spent too
  const pending = 5 * minuteCharge({ providerCostPerHour: COST, marginBps: MARGIN }, 60);
  for (const [extra, ok] of [[pending, true], [pending - 1, false]] as const) {
    const m = await member(ONE() + extra);
    const id = await legacyMachine(m.memberId);
    await w.db.batch([...openAccrual(id, { incarnation: 1, provider: "runpod", providerCostPerHour: COST, marginBps: MARGIN, startMs: T0 - 600_000 }), ...closeAccrual(id, 1, T0 - 300_000)]);
    assert.equal((await admitStart(w.db, w.clock.t, req(m.userId))).ok, ok, `pending, extra ${extra}`);
  }
});

test("money: an accruing machine counts at the highest rate among its unbilled intervals, from its oldest unbilled minute", async () => {
  // incarnation 1 at twice the rate for a minute, then incarnation 2 at the rate, still open: unbilled since T0 - 2 min
  const hi = { providerCostPerHour: 2 * COST, marginBps: MARGIN };
  const amount = need([hi], { providerCostPerHour: COST, marginBps: MARGIN }, 120);
  for (const [a, ok] of [[amount, true], [amount - 1, false]] as const) {
    const m = await member(a);
    const id = await legacyMachine(m.memberId, "running", 2);
    await w.db.batch([
      ...openAccrual(id, { incarnation: 1, provider: "runpod", providerCostPerHour: 2 * COST, marginBps: MARGIN, startMs: T0 - 120_000 }),
      ...closeAccrual(id, 1, T0 - 60_000),
      ...openAccrual(id, { incarnation: 2, provider: "runpod", providerCostPerHour: COST, marginBps: MARGIN, startMs: T0 - 60_000 }),
    ]);
    assert.equal((await admitStart(w.db, w.clock.t, req(m.userId))).ok, ok, `amount ${a}`);
  }
});

// ---------------------------------------------------------------- the race: the CAS

test("race: two admissions reading the same state; one commits, the other is busy with nothing written; its retry re-reads the money", async () => {
  const m = await member(ONE());
  let first = true;
  // (b reads right after a's read and before a's write)
  const real = w.db;
  let b: Promise<Awaited<ReturnType<typeof admitStart>>> | null = null;
  const racing: Db = {
    ...real,
    async all<T>(sql: string, p?: SqlValue[]) {
      const out = await real.all<T>(sql, p);
      if (first && sql.includes("'alloc' AS kind")) {
        first = false;
        b = admitStart(real, w.clock.t, req(m.userId));
        await b;
      }
      return out;
    },
  };
  // b ran to the end inside a's read: b committed; a then loses the CAS
  const a = await admitStart(racing, w.clock.t, req(m.userId));
  const rb = await b!;
  assert.equal(rb.ok, true);
  refused(a, "busy");
  assert.equal((await machines()).length, 1);
  refused(await admitStart(w.db, w.clock.t, req(m.userId)), "allocationTooLow", "the retry counts the winner");
});

test("race: 12 admissions over two database handles commit no more than the money covers", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "sbgpu-start-")), "d1.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  const handle = (r: DatabaseSync): Db => ({
    all: async <T,>(sql: string, p: SqlValue[] = []) => r.prepare(sql).all(...p) as T[],
    run: async (sql: string, p: SqlValue[] = []) => ({ changes: Number(r.prepare(sql).run(...p).changes) }),
    batch: async (stmts: Stmt[]) => {
      r.exec("BEGIN IMMEDIATE");
      try {
        const out = stmts.map((s) => ({ changes: Number(r.prepare(s.sql).run(...s.params).changes) }));
        r.exec("COMMIT");
        return out;
      } catch (e) {
        r.exec("ROLLBACK");
        throw e;
      }
    },
  });
  // (the seed: an org, a project, a member with money for exactly three)
  const [org, prj, usr, mbr] = [newId("org"), newId("project"), newId("user"), newId("member")];
  raw.exec("BEGIN");
  raw.prepare(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'O', 'resold', ?, ?)`).run(org, MARGIN, T0);
  const three = need([{ providerCostPerHour: COST, marginBps: MARGIN }, { providerCostPerHour: COST, marginBps: MARGIN }]);
  raw.prepare(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P', ?, ?, 0, ?)`).run(prj, org, T0, T0 + 86_400_000, T0);
  raw.prepare(`UPDATE projects SET budget = ? WHERE id = ?`).run(three, prj);
  raw.prepare(`INSERT INTO users (id, email, created_ms) VALUES (?, 'u@example.com', ?)`).run(usr, T0);
  raw.prepare(`INSERT INTO members (id, project_id, user_id, email, role, status, created_ms) VALUES (?, ?, ?, 'u@example.com', 'member', 'active', ?)`).run(mbr, prj, usr, T0);
  raw.prepare(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', ?, ?, ?)`).run(newId("allocation"), prj, mbr, three, T0);
  raw.exec("COMMIT");
  const other = new DatabaseSync(file);
  other.exec("PRAGMA busy_timeout = 5000");
  const [ha, hb] = [handle(raw), handle(other)];
  const r = { userId: usr, projectId: prj, payer: "member" as const, gpuType: "L4", gpuCount: 1, listed: { offer: offer(), listedAtMs: T0 } };
  let ok = 0;
  for (let round = 0; round < 4; round++) {
    const got = await Promise.all(Array.from({ length: 12 }, (_, i) => admitStart(i % 2 ? hb : ha, T0, r)));
    ok += got.filter((x) => x.ok).length;
    for (const x of got) if (!x.ok) assert.ok(x.why === "busy" || x.why === "allocationTooLow", x.why);
  }
  assert.equal(ok, 3);
  assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM machines`).get() as { n: number }).n, 3);
  raw.close();
  other.close();
});

// ---------------------------------------------------------------- the restore claim

const claim = (areaKey: string, memberId: string) =>
  w.db.batch([stmt(`INSERT INTO area_restores (op_id, area_key, actor_member_id, target_snapshot_id, jti, state, lease_ms, created_ms) VALUES (?, ?, ?, ?, ?, 'claimed', 120000, ?)`, "o".repeat(22), areaKey, memberId, newId("snapshot"), "j".repeat(22), T0)]);

test("restore: a live claim on the member's key, or the team's, refuses with nothing written; one landing mid-way aborts the write", async () => {
  const m = await member(ONE());
  await claim(memberAreaKey(w.projectId, m.memberId), m.memberId);
  const s = await state();
  refused(await admitStart(w.db, w.clock.t, req(m.userId)), "restoreInProgress");
  assert.equal(await state(), s);
  // the team's key
  const n = await member(0);
  const team = newId("team");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'T2', ?)`, team, w.projectId, T0),
    stmt(`UPDATE members SET team_id = ? WHERE id = ?`, team, n.memberId),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, ?, ?)`, newId("allocation"), w.projectId, team, ONE(), T0),
    stmt(`UPDATE area_restores SET state = 'done'`),
  ]);
  await w.db.batch([stmt(`INSERT INTO area_restores (op_id, area_key, actor_member_id, target_snapshot_id, jti, state, lease_ms, created_ms) VALUES (?, ?, ?, ?, ?, 'claimed', 120000, ?)`, "p".repeat(22), teamAreaKey(w.projectId, team), n.memberId, newId("snapshot"), "k".repeat(22), T0)]);
  refused(await admitStart(w.db, w.clock.t, req(n.userId, { payer: "team" })), "restoreInProgress", "team key");
  refused(await admitStart(w.db, w.clock.t, req(n.userId, { payer: "member" })), "allocationTooLow", "(the member's own: empty)");
  // a claim landing between the read and the write
  const q = await member(ONE());
  const real = w.db;
  const mid: Db = {
    ...real,
    async all<T>(sql: string, p?: SqlValue[]) {
      const out = await real.all<T>(sql, p);
      if (sql.includes("'alloc' AS kind")) await real.batch([stmt(`INSERT INTO area_restores (op_id, area_key, actor_member_id, target_snapshot_id, jti, state, lease_ms, created_ms) VALUES (?, ?, ?, ?, ?, 'claimed', 120000, ?)`, "q".repeat(22), memberAreaKey(w.projectId, q.memberId), q.memberId, newId("snapshot"), "l".repeat(22), T0)]);
      return out;
    },
  };
  refused(await admitStart(mid, w.clock.t, req(q.userId)), "restoreInProgress", "mid-way");
  assert.equal(await version(await allocOf(q.memberId)), 0, "the CAS rolled back with it");
});

/** `db`, with `change` run once right after admission's money read (between its decision and its write). */
function midway(change: () => Promise<unknown>): Db {
  const real = w.db;
  let done = false;
  return {
    ...real,
    async all<T>(sql: string, p?: SqlValue[]) {
      const out = await real.all<T>(sql, p);
      if (!done && sql.includes("'alloc' AS kind")) {
        done = true;
        await change();
      }
      return out;
    },
  };
}

test("H1: any decision input changed between the read and the write: busy, nothing written; the retry decides on what is current", async () => {
  const cases: Array<[string, (m: { memberId: string; userId: string }) => Promise<unknown>, string, number?]> = [
    ["the allocation lowered to 0", async (m) => w.db.batch([stmt(`UPDATE allocations SET amount = 0 WHERE holder_id = ?`, m.memberId)]), "allocationTooLow"],
    ["the allocation raised", async (m) => w.db.batch([stmt(`UPDATE allocations SET amount = amount + 1 WHERE holder_id = ?`, m.memberId)]), "ok"],
    ["an adjustment charged", async (m) => w.db.batch([stmt(
      `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, created_ms) VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 0, 1, 0, 1, ?)`,
      newId("ledgerEntry"), w.orgId, w.projectId, await allocOf(m.memberId), T0, T0,
    )]), "allocationTooLow"],
    ["the policy's price cap lowered", async () => w.db.batch([stmt(`UPDATE projects SET policy_json = ? WHERE id = ?`, JSON.stringify({ maxPricePerHour: 1 }), w.projectId)]), "overPolicyPrice"],
    ["the project's margin override set", async () => w.db.batch([stmt(`UPDATE projects SET margin_bps_override = 9000 WHERE id = ?`, w.projectId)]), "allocationTooLow"],
    ["the org's margin raised", async () => w.db.batch([stmt(`UPDATE orgs SET margin_bps = 9000 WHERE id = ?`, w.orgId)]), "allocationTooLow"],
    ["the project's end moved to the next millisecond", async () => w.db.batch([stmt(`UPDATE projects SET ends_ms = ? WHERE id = ?`, w.clock.t + 1, w.projectId)]), "projectEnded", 1],
    ["the final-save reserve raised", async () => w.db.batch([stmt(`UPDATE projects SET final_save_reserve_minutes = 60 WHERE id = ?`, w.projectId)]), "allocationTooLow"],
    ["the project's start moved later", async () => w.db.batch([stmt(`UPDATE projects SET starts_ms = ? WHERE id = ?`, w.clock.t + 1, w.projectId)]), "projectNotStarted"],
  ];
  for (const [why, change, retry, later = 0] of cases) {
    w = await world();
    const m = await member(ONE());
    const alloc = await allocOf(m.memberId);
    refused(await admitStart(midway(() => change(m)), w.clock.t, req(m.userId)), "busy", why);
    assert.equal((await machines()).length, 0, `${why}: nothing written`);
    assert.equal(await version(alloc), 0, `${why}: the version unchanged`);
    const at = w.clock.t + later;
    const again = await admitStart(w.db, at, req(m.userId, { listed: { offer: offer(), listedAtMs: at } }));
    if (retry === "ok") assert.equal(again.ok, true, `${why}: the retry`);
    else refused(again, retry, `${why}: the retry`);
  }
  // a team's allocation changed under a team-paid start
  w = await world();
  const m = await member(0);
  const team = newId("team");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'T', ?)`, team, w.projectId, T0),
    stmt(`UPDATE members SET team_id = ? WHERE id = ?`, team, m.memberId),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, ?, ?)`, newId("allocation"), w.projectId, team, ONE(), T0),
  ]);
  refused(await admitStart(midway(() => w.db.batch([stmt(`UPDATE allocations SET amount = 0 WHERE holder_id = ?`, team)])), w.clock.t, req(m.userId, { payer: "team" })), "busy", "the team's allocation lowered");
  assert.equal((await machines()).length, 0);
});

test("H1: a running machine's final-save estimate raised between the read and the write (a heartbeat): busy, nothing written; lowered, still admitted", async () => {
  for (const [why, estimate, first] of [["raised", 6000, "busy"], ["lowered", 0, "ok"]] as const) {
    w = await world();
    // (one running machine on the allocation, its accrual open, its estimate 600 s; just enough money for one more start)
    const running = { providerCostPerHour: COST, marginBps: MARGIN };
    const amount = requiredToStart({ unspent: 0, newMachine: running, running: [running], unbilledSeconds: 0, minStartMinutes: DEFAULT_POLICY.minStartMinutes, ...HARD_STOP_PERIODS, reserveSeconds: reserveSeconds(10, 600) });
    const m = await member(amount);
    const id = await legacyMachine(m.memberId, "running");
    await w.db.batch([...openAccrual(id, { incarnation: 1, provider: "runpod", providerCostPerHour: COST, marginBps: MARGIN, startMs: w.clock.t }), stmt(`UPDATE machines SET save_estimate_seconds = 600 WHERE id = ?`, id)]);
    const alloc = await allocOf(m.memberId);
    const a = await admitStart(midway(() => w.db.batch([stmt(`UPDATE machines SET save_estimate_seconds = ? WHERE id = ?`, estimate, id)])), w.clock.t, req(m.userId));
    if (first === "busy") {
      refused(a, "busy", why);
      assert.equal((await machines()).filter((x) => x.state === "starting").length, 0, `${why}: nothing written`);
      assert.equal(await version(alloc), 0, `${why}: the version unchanged`);
      const again = await admitStart(w.db, w.clock.t, req(m.userId));
      assert.equal(again.ok, false, `${why}: the retry, at the larger reserve, refuses`);
    } else {
      assert.equal(a.ok, true, `${why}: ${JSON.stringify(a)}`);
      assert.equal(await version(alloc), 1);
    }
  }
});

test("H1 control: the ledger's own billing between the read and the write doesn't refuse (it only moves money already counted)", async () => {
  const m = await member(TWO());
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.ok(a.ok);
  if (!a.ok) return;
  await w.db.batch(openAccrual(a.machineId, { incarnation: 1, provider: "runpod", providerCostPerHour: COST, marginBps: MARGIN, startMs: w.clock.t }));
  w.clock.t += 120_000;
  const bill = async () => w.db.batch([stmt(
    `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, machine_id, provider, period_start_ms, seconds, provider_cost_per_hour, margin_bps, provider_cost, margin, total, created_ms)
     VALUES (?, ?, ?, ?, 'compute', ?, 'runpod', ?, 60, ?, ?, ?, ?, ?, ?)`,
    newId("ledgerEntry"), w.orgId, w.projectId, await allocOf(m.memberId), a.machineId, T0, COST, MARGIN,
    Math.floor((COST * 60 * 2 + 3600) / 7200), Math.floor((Math.floor((COST * 60 * 2 + 3600) / 7200) * MARGIN * 2 + 10000) / 20000),
    Math.floor((COST * 60 * 2 + 3600) / 7200) + Math.floor((Math.floor((COST * 60 * 2 + 3600) / 7200) * MARGIN * 2 + 10000) / 20000), w.clock.t,
  )]);
  const b = await admitStart(midway(bill), w.clock.t, req(m.userId, { listed: { offer: offer({ providerCostPerHour: 1 }), listedAtMs: w.clock.t } }));
  assert.equal(b.ok, true, JSON.stringify(b));
});

test("membership: a team change between the read and the write writes nothing", async () => {
  const m = await member(ONE());
  const team = newId("team");
  await w.db.batch([stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'T3', ?)`, team, w.projectId, T0), stmt(`UPDATE members SET team_id = ? WHERE id = ?`, team, m.memberId)]);
  const real = w.db;
  const mid: Db = {
    ...real,
    async all<T>(sql: string, p?: SqlValue[]) {
      const out = await real.all<T>(sql, p);
      if (sql.includes("'alloc' AS kind")) await real.batch([stmt(`UPDATE members SET team_id = NULL WHERE id = ?`, m.memberId)]);
      return out;
    },
  };
  refused(await admitStart(mid, w.clock.t, req(m.userId)), "notMember");
  assert.equal((await machines()).length, 0);
});

test("membership: a member removed between the read and the write writes nothing", async () => {
  const m = await member(ONE());
  const real = w.db;
  const mid: Db = {
    ...real,
    async all<T>(sql: string, p?: SqlValue[]) {
      const out = await real.all<T>(sql, p);
      if (sql.includes("'alloc' AS kind")) await real.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, m.memberId)]);
      return out;
    },
  };
  refused(await admitStart(mid, w.clock.t, req(m.userId)), "notMember");
  assert.equal((await machines()).length, 0);
});

// ---------------------------------------------------------------- the scheduled stale-starts job

test("stale starts (scheduled): through the cron's own entry, at 119999 ms nothing moves and the start is still counted; at 120000 it fails and the money is released", async () => {
  assert.ok(SCHEDULED_JOBS.includes(staleStarts));
  const m = await member(ONE());
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.ok(a.ok);
  if (!a.ok) return;
  const env = (now: number) => ({ db: w.db, now, vm: null, elapsedMs: () => 0 });
  assert.equal(await staleStarts.run(env(T0 + START_INTENT_GRACE_MS - 1)), 0);
  refused(await admitStart(w.db, w.clock.t, req(m.userId)), "allocationTooLow", "still counted");
  assert.equal(await staleStarts.run(env(T0 + START_INTENT_GRACE_MS)), 1);
  assert.equal((await w.db.all<{ state: string }>(`SELECT state FROM machines WHERE id = ?`, [a.machineId]))[0]!.state, "failed");
  assert.equal((await admitStart(w.db, w.clock.t, req(m.userId))).ok, true, "released");
});

test("stale starts (scheduled): at most 100 a run, oldest first; the rest the next run", async () => {
  assert.equal(STALE_START_BATCH, 100);
  const m = await member(0);
  const alloc = await allocOf(m.memberId);
  const ids: string[] = [];
  for (let i = 0; i <= 100; i++) {
    const id = newId("machine");
    ids.push(id);
    await w.db.batch([stmt(
      `INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms, member_area_key, admitted_cost_per_hour, admitted_margin_bps)
       VALUES (?, ?, ?, ?, 'runpod', 'L4', 1, 'X', 'starting', 1, ?, ?, ?, ?)`,
      id, w.projectId, alloc, m.memberId, T0 + (100 - i), memberAreaKey(w.projectId, m.memberId), COST, MARGIN,
    )]);
  }
  const env = { db: w.db, now: T0 + 100 + START_INTENT_GRACE_MS, vm: null, elapsedMs: () => 0 };
  assert.equal(await staleStarts.run(env), 100);
  assert.equal((await w.db.all<{ state: string }>(`SELECT state FROM machines WHERE id = ?`, [ids[0]!]))[0]!.state, "starting", "the newest waits");
  assert.equal(await staleStarts.run(env), 1);
  assert.equal(await staleStarts.run(env), 0);
});

// ---------------------------------------------------------------- H4: the intent against the stale cleanup

test("H4: intent first, then the cleanup: the cleanup changes nothing and the machine stays counted", async () => {
  const m = await member(ONE());
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.ok(a.ok);
  if (!a.ok) return;
  await intent(a.machineId);
  assert.equal(await failStaleStarts(w.db, w.clock.t + 10 * START_INTENT_GRACE_MS), 0);
  assert.equal((await w.db.all<{ state: string }>(`SELECT state FROM machines WHERE id = ?`, [a.machineId]))[0]!.state, "starting");
  refused(await admitStart(w.db, w.clock.t, req(m.userId)), "allocationTooLow", "still counted");
});

test("H4: the cleanup first, then the intent: the intent's batch writes nothing (launch, rate, token)", async () => {
  const m = await member(ONE());
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.equal(await failStaleStarts(w.db, w.clock.t + START_INTENT_GRACE_MS), 1);
  await assert.rejects(intent(a.machineId), /only while its machine is starting at that incarnation/);
  for (const t of ["launches", "launch_rates", "boot_tokens"]) assert.deepEqual(await w.db.all(`SELECT 1 FROM ${t} WHERE machine_id = ?`, [a.machineId]), [], t);
});

test("H4 controls: the intent trigger by state and incarnation; the rate and provider triggers; the admitted rate is fixed", async () => {
  const m = await member(TWO());
  const a = await admitStart(w.db, w.clock.t, req(m.userId));
  assert.ok(a.ok);
  if (!a.ok) return;
  for (const s of ["running", "failed", "stopped"]) {
    await w.db.batch([stmt(`UPDATE machines SET state = ? WHERE id = ?`, s, a.machineId)]);
    await assert.rejects(intent(a.machineId), /only while its machine is starting/, s);
  }
  await w.db.batch([stmt(`UPDATE machines SET state = 'starting', incarnation = 2 WHERE id = ?`, a.machineId)]);
  await assert.rejects(intent(a.machineId), /only while its machine is starting/, "another incarnation");
  await w.db.batch([stmt(`UPDATE machines SET incarnation = 1 WHERE id = ?`, a.machineId)]);
  await assert.rejects(intent(a.machineId, { rate: COST + 1 }), /admitted rate/);
  await assert.rejects(intent(a.machineId, { margin: MARGIN - 1 }), /admitted rate/);
  await assert.rejects(
    w.db.batch([stmt(
      `INSERT INTO launches (machine_id, incarnation, mode, provider, nonce_sha256, boot_script_sha256, agent_sha256, account_kind, outcome, next_ms, created_ms)
       VALUES (?, 1, 'vm', 'shadeform', ?, ?, ?, 'platform', 'creating', ?, ?)`,
      a.machineId, "b".repeat(64), "c".repeat(64), "a".repeat(64), w.clock.t, w.clock.t,
    )]),
    /admitted provider/,
  );
  await intent(a.machineId); // (starting, at its incarnation, its rate and provider: accepted)
  for (const set of [`admitted_cost_per_hour = admitted_cost_per_hour + 1`, `admitted_margin_bps = 0`, `admitted_cost_per_hour = NULL, admitted_margin_bps = NULL`]) {
    await assert.rejects(w.db.batch([stmt(`UPDATE machines SET ${set} WHERE id = ?`, a.machineId)]), /admitted rate is fixed/, set);
  }
  // (a machine admitted by no one, as the older tests make them, is untouched by these triggers)
  const legacy = newId("machine");
  const alloc = await allocOf(m.memberId);
  await w.db.batch([stmt(`INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms) VALUES (?, ?, ?, ?, ?, 'runpod', 'L4', 1, 'X', 'running', 1, ?)`, memberAreaKey(w.projectId, m.memberId), legacy, w.projectId, alloc, m.memberId, T0)]);
  await intent(legacy, { rate: 7 });
});

test("schema: the start version only steps up by 1; the admitted rate is both or neither, in its bounds", async () => {
  const m = await member(ONE());
  const alloc = await allocOf(m.memberId);
  const upd = (set: string) => w.db.batch([stmt(`UPDATE allocations SET ${set} WHERE id = ?`, alloc)]);
  await assert.rejects(upd(`start_version = start_version + 2`), /only steps up by 1/);
  await assert.rejects(upd(`start_version = -1`), /only steps up by 1|CHECK/);
  await upd(`start_version = start_version + 1`);
  await assert.rejects(upd(`start_version = start_version - 1`), /only steps up by 1/);
  const ins = (cost: SqlValue, margin: SqlValue) =>
    w.db.batch([stmt(`INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, created_ms, admitted_cost_per_hour, admitted_margin_bps) VALUES (?, ?, ?, ?, 'runpod', 'L4', 1, 'X', 'stopped', ?, ?, ?)`, newId("machine"), w.projectId, alloc, m.memberId, T0, cost, margin)]);
  for (const [c, mg] of [[1, null], [null, 1], [-1, 0], [1_000_000_001, 0], [1, -1], [1, 1_000_001]] as const) await assert.rejects(ins(c, mg), /CHECK/, `${c} ${mg}`);
  await ins(1_000_000_000, 1_000_000);
  await ins(null, null);
});

// ---- exact money (Codex audit G01 P1): the allocation's unspent figure in BigInt, refused rather than rounded

const MAX = Number.MAX_SAFE_INTEGER;

test("G01 P1: unspent is exact near 2^53; a float difference would be off by one", () => {
  assert.equal(exactUnspent(MAX, -2, [2]), MAX, "MAX - (-2) - 2: a float gives MAX - 1");
  assert.notEqual(MAX - -2 - 2, MAX, "(the float this replaces)");
  assert.equal(exactUnspent(MAX, 0, []), MAX);
  assert.equal(exactUnspent(0, MAX, []), -MAX);
  assert.equal(exactUnspent(MAX, -1, [1]), MAX);
  assert.equal(exactUnspent(1, 0, [MAX]), -(MAX - 1));
  for (const [a, s, p] of [[MAX, -1, []], [0, MAX, [1]], [MAX, -MAX, []]] as const) {
    assert.throws(() => exactUnspent(a, s, p), /unspent/, `${a} ${s} ${p}: outside the safe range, refused`);
  }
  for (const bad of [0.5, MAX + 1, Number.NaN, Infinity]) assert.throws(() => exactUnspent(bad, 0, []), /safe integer/);
  assert.throws(() => exactUnspent(1, 0, [0.5]), /safe integer/);
  // near-boundary sweep against a BigInt reference: exact, or refused (never a rounded value)
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed);
  for (let i = 0; i < 5000; i++) {
    const a = MAX - (rnd() % 64);
    const s = (rnd() % 64) - 32;
    const ps = Array.from({ length: rnd() % 4 }, () => rnd() % 64);
    const want = BigInt(a) - BigInt(s) - ps.reduce((x, y) => x + BigInt(y), 0n);
    if (want > BigInt(MAX) || want < -BigInt(MAX)) assert.throws(() => exactUnspent(a, s, ps), /unspent/);
    else assert.equal(BigInt(exactUnspent(a, s, ps)), want, `${a} ${s} ${ps}`);
  }
});

test("G01 P1: the admission's money reads use the exact figure (an allocation of 2^53 - 1, an adjustment of -2, a stopped machine owing 2)", () => {
  const base = { allocation_id: "alc_1", machine_id: null, billed_through_ms: null, incarnation: null, provider: null, provider_cost_per_hour: null, margin_bps: null, start_ms: null, end_ms: null, save_estimate_seconds: null };
  const alloc: MoneyRow = { ...base, kind: "alloc", amount: MAX, start_version: 0, spent: -2, adjusted: -2 };
  // one whole minute at 120 micro-USD an hour: 2 micro-USD owed, not yet billed
  const interval: MoneyRow = { ...base, kind: "interval", amount: null, start_version: null, spent: null, adjusted: null, machine_id: "mch_1", billed_through_ms: T0, incarnation: 1, provider: "runpod", provider_cost_per_hour: 120, margin_bps: 0, start_ms: T0, end_ms: T0 + 60_000, save_estimate_seconds: 0 };
  const m = money([alloc, interval], T0 + 120_000)!;
  assert.equal(m.unspent, MAX);
  assert.throws(() => money([{ ...alloc, spent: -3 }], T0), /unspent/, "past the safe range: refused, so the start is refused");
});
