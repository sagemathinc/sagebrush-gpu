// The GPU billing ledger (0022 and stripe-ledger.ts), rows from design d2, d3, d3.1 and d3.2: one Customer
// per person, credit only from checkout or a pending PaymentIntent, refunds per refund, one reversal per
// charge, a dispute won restored once, the balance's sign, the plan's statuses, and the two writers' scopes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import {
  LEDGER_TABLES, PLAN_TABLES, balanceOf, creditCheckout, creditPending, isFrozen, latestPlan, planPermitsStart, planStateHash,
  recordCustomer, recordDisputeWon, recordPlanState, recordRefunds, recordReversal, scopedDb, type EventRef, type PlanStatus, type Who,
} from "./stripe-ledger.ts";

const T = 1_800_000_000_000;
const ISS = "https://api.workos.com/user_management/client_test";
const A: Who = { iss: ISS, sub: "user_A" };
const B: Who = { iss: ISS, sub: "user_B" };
let db: TestDb;
let n = 0;
const ev = (type = "checkout.session.completed"): EventRef => ({ eventId: `evt_${++n}x`, type, nowMs: T });

function person(w: Who, i: number) {
  db.raw.prepare(`INSERT INTO users (id, email, name, created_ms) VALUES (?, ?, NULL, ?)`).run(`usr_${i}`, `p${i}@example.com`, T);
  db.raw.prepare(`INSERT INTO identities (iss, sub, user_id, email, email_ticket, created_ms) VALUES (?, ?, ?, NULL, 0, ?)`).run(w.iss, w.sub, `usr_${i}`, T);
}
const rows = (kind?: string) =>
  db.raw.prepare(`SELECT kind, stripe_key, amount, gross, fee, via FROM balance_entries ${kind ? "WHERE kind = ?" : ""} ORDER BY seq`).all(...(kind ? [kind] : [])).map((r) => ({ ...r }));

beforeEach(async () => {
  db = sqliteDb();
  person(A, 1);
  person(B, 2);
  await recordCustomer(db, A, "cus_A", T);
  await recordCustomer(db, B, "cus_B", T);
});

test("N3: one Customer per person; the first is kept; a Customer can't move to another person", async () => {
  assert.equal(await recordCustomer(db, A, "cus_A", T), "cus_A", "the same Customer again");
  await assert.rejects(recordCustomer(db, A, "cus_A2", T), /another Customer/, "a second Customer for A is refused");
  await assert.rejects(recordCustomer(db, A, "cus_B", T), /another person/, "cus_B stays B's");
  // two concurrent first top-ups: one row
  person({ iss: ISS, sub: "user_C" }, 3);
  const C: Who = { iss: ISS, sub: "user_C" };
  // (Stripe's idempotency key, derived from the person, gives both the same Customer)
  const [x, y] = await Promise.all([recordCustomer(db, C, "cus_C1", T), recordCustomer(db, C, "cus_C1", T)]);
  assert.equal(x, y);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS k FROM stripe_customers WHERE sub = 'user_C'`).get()!.k, 1);
  // cus_B already belongs to B: C can't take it
  person({ iss: ISS, sub: "user_D" }, 4);
  await assert.rejects(recordCustomer(db, { iss: ISS, sub: "user_D" }, "cus_B", T), /another person/);
});

test("T1: the net is credited once; never gross; the receipt fields are the row", async () => {
  const e = ev();
  assert.equal(await creditCheckout(db, e, { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 20_000_000, feeMicros: 880_000 }), "written");
  assert.deepEqual(rows(), [{ kind: "topup", stripe_key: "pi_1", amount: 19_120_000, gross: 20_000_000, fee: 880_000, via: "checkout" }]);
  assert.equal(await balanceOf(db, A), 19_120_000);
  assert.equal(await creditCheckout(db, e, { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 20_000_000, feeMicros: 880_000 }), "replay", "the same event");
  assert.equal(await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 20_000_000, feeMicros: 880_000 }), "nothing", "another event, same PaymentIntent");
  assert.equal(await balanceOf(db, A), 19_120_000);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS k FROM stripe_events`).get()!.k, 2);
  await assert.rejects(creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_2", grossMicros: 1_000, feeMicros: 1_000 }), /less than/);
  await assert.rejects(creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_2", grossMicros: 0, feeMicros: 0 }), RangeError);
  await assert.rejects(creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_2", grossMicros: 1.5, feeMicros: 0 }), RangeError);
  await assert.rejects(creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "ch_2", grossMicros: 5, feeMicros: 0 }), /paymentIntent/);
  assert.equal(await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_0fee", grossMicros: 5, feeMicros: 0 }), "written", "a known zero fee");
});

test("an unknown Customer writes nothing (the person comes only from stripe_customers)", async () => {
  assert.equal(await creditCheckout(db, ev(), { customerId: "cus_nobody", paymentIntent: "pi_1", grossMicros: 10_000_000, feeMicros: 1 }), "nothing");
  assert.deepEqual(rows(), []);
});

test("d3.2: fee absent at checkout gives a marker, then one credit, by either later path; no marker, no credit", async () => {
  assert.equal(await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_p", grossMicros: 10_000_000, feeMicros: null }), "written");
  assert.equal(await balanceOf(db, A), 0, "a marker is no credit");
  assert.equal(await creditPending(db, ev("charge.updated"), { customerId: "cus_A", paymentIntent: "pi_p", grossMicros: 10_000_000, feeMicros: 590_000, via: "charge" }), "written");
  assert.equal(await creditPending(db, ev(), { customerId: "cus_A", paymentIntent: "pi_p", grossMicros: 10_000_000, feeMicros: 590_000, via: "refetch" }), "nothing", "both paths: still one");
  assert.equal(await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_p", grossMicros: 10_000_000, feeMicros: 590_000 }), "nothing", "and the checkout path too");
  assert.equal(await balanceOf(db, A), 9_410_000);
  // no marker
  assert.equal(await creditPending(db, ev("charge.updated"), { customerId: "cus_A", paymentIntent: "pi_q", grossMicros: 10_000_000, feeMicros: 1, via: "charge" }), "nothing");
  // B's marker doesn't let A be credited
  await creditCheckout(db, ev(), { customerId: "cus_B", paymentIntent: "pi_b", grossMicros: 10_000_000, feeMicros: null });
  assert.equal(await creditPending(db, ev(), { customerId: "cus_A", paymentIntent: "pi_b", grossMicros: 10_000_000, feeMicros: 1, via: "charge" }), "nothing");
  assert.equal(await balanceOf(db, A), 9_410_000);
  // the database refuses a later credit without the marker, whoever writes it
  assert.throws(() => db.raw.prepare(`INSERT INTO balance_entries (iss, sub, kind, stripe_key, amount, gross, fee, via, created_ms) VALUES (?, ?, 'topup', 'pi_z', 9, 10, 1, 'charge', ?)`).run(ISS, "user_A", T), /pending marker/);
  await assert.rejects(creditPending(db, ev(), { customerId: "cus_A", paymentIntent: "pi_p", grossMicros: 10, feeMicros: 1, via: "checkout" as "charge" }), RangeError);
});

test("T2: one debit per refund id; two partials are two; a replay adds nothing", async () => {
  await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 50_000_000, feeMicros: 1_750_000 });
  const e = ev("charge.refunded");
  assert.equal(await recordRefunds(db, e, { customerId: "cus_A", refunds: [{ id: "re_1", amountMicros: 10_000_000 }] }), "written");
  assert.equal(await recordRefunds(db, ev("charge.refunded"), { customerId: "cus_A", refunds: [{ id: "re_1", amountMicros: 10_000_000 }, { id: "re_2", amountMicros: 5_000_000 }] }), "written");
  assert.equal(await recordRefunds(db, e, { customerId: "cus_A", refunds: [{ id: "re_3", amountMicros: 1 }] }), "replay", "a replayed event writes nothing, whatever it carries");
  assert.deepEqual(rows("refund").map((r) => [r.stripe_key, r.amount]), [["re_1", -10_000_000], ["re_2", -5_000_000]]);
  assert.equal(await balanceOf(db, A), 48_250_000 - 15_000_000);
  await assert.rejects(recordRefunds(db, ev(), { customerId: "cus_A", refunds: [{ id: "re_4", amountMicros: 0 }] }), RangeError);
});

test("T3, T4: one reversal per charge, of exactly the net; a later signal has no amount; frozen; won restores once, freeze stays", async () => {
  await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 20_000_000, feeMicros: 880_000 });
  assert.equal(await isFrozen(db, A), false);
  await recordReversal(db, ev("radar.early_fraud_warning.created"), { customerId: "cus_A", chargeId: "ch_1", netMicros: 19_120_000, reason: "early fraud warning" });
  await recordReversal(db, ev("charge.dispute.created"), { customerId: "cus_A", chargeId: "ch_1", netMicros: 19_120_000, reason: "dispute" });
  assert.deepEqual(rows("reversal").map((r) => r.amount), [-19_120_000], "one reversal, the net");
  assert.equal(rows("signal").length, 1, "the second signal is a status row");
  assert.equal(rows("signal")[0]!.amount, 0);
  assert.equal(await balanceOf(db, A), 0);
  assert.equal(await isFrozen(db, A), true);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS k FROM account_freezes`).get()!.k, 1, "frozen once");
  const won = ev("charge.dispute.closed");
  assert.equal(await recordDisputeWon(db, won, { customerId: "cus_A", chargeId: "ch_1" }), "written");
  assert.equal(await recordDisputeWon(db, ev("charge.dispute.closed"), { customerId: "cus_A", chargeId: "ch_1" }), "nothing");
  assert.deepEqual(rows("restore").map((r) => r.amount), [19_120_000]);
  assert.equal(await balanceOf(db, A), 19_120_000);
  assert.equal(await isFrozen(db, A), true, "the freeze stays until a human lifts it");
  assert.equal(await recordDisputeWon(db, ev(), { customerId: "cus_A", chargeId: "ch_none" }), "nothing", "no reversal, nothing to restore");
  assert.equal(await recordDisputeWon(db, ev(), { customerId: "cus_B", chargeId: "ch_1" }), "nothing", "another person's charge");
});

test("T4: a dispute after spending takes the balance below zero", async () => {
  await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 10_000_000, feeMicros: 590_000 });
  await recordRefunds(db, ev(), { customerId: "cus_A", refunds: [{ id: "re_1", amountMicros: 4_000_000 }] });
  await recordReversal(db, ev("charge.dispute.created"), { customerId: "cus_A", chargeId: "ch_1", netMicros: 9_410_000, reason: "dispute" });
  assert.equal(await balanceOf(db, A), 9_410_000 - 4_000_000 - 9_410_000);
  assert.ok((await balanceOf(db, A)) < 0);
});

test("the database refuses the rows' wrong shapes", () => {
  const ins = (kind: string, key: string, amount: number, extra = "NULL, NULL, NULL") =>
    () => db.raw.prepare(`INSERT INTO balance_entries (iss, sub, kind, stripe_key, amount, gross, fee, via, created_ms) VALUES (?, ?, ?, ?, ?, ${extra}, ?)`).run(ISS, "user_A", kind, key, amount, T);
  assert.throws(ins("topup", "pi_1", 10, "10, 0, NULL"), /CHECK/, "a topup needs its path");
  assert.throws(ins("topup", "pi_1", 10, "10, 1, 'checkout'"), /CHECK/, "amount = gross - fee");
  assert.throws(ins("topup", "pi_1", 0, "1, 1, 'checkout'"), /CHECK/, "fee < gross");
  assert.throws(ins("topup", "ch_1", 9, "10, 1, 'checkout'"), /CHECK/);
  assert.throws(ins("pending", "pi_1", 1), /CHECK/);
  assert.throws(ins("refund", "re_1", 1), /CHECK/);
  assert.throws(ins("refund", "pi_1", -1), /CHECK/);
  assert.throws(ins("refund", "re_0", 0), /CHECK/, "a refund is never zero");
  assert.throws(ins("reversal", "ch_1", 1), /CHECK/);
  assert.throws(ins("restore", "ch_1", 1), /equal its charge/, "a restore needs its reversal");
  ins("reversal", "ch_9", -100)();
  assert.throws(ins("restore", "ch_9", 99), /equal its charge/, "a restore is exactly its reversal");
  ins("restore", "ch_9", 100)();
  assert.throws(ins("signal", "evt_1", 1), /CHECK/);
  assert.throws(ins("refund", "re_1", -1, "5, NULL, NULL"), /CHECK/, "only a topup has gross");
  assert.throws(ins("credit", "re_1", -1), /CHECK/);
  ins("refund", "re_1", -1)();
  ins("refund", "re_1", -1)();
  assert.deepEqual(rows("refund").map((r) => r.amount), [-1], "the same row again is dropped");
  assert.throws(ins("refund", "re_1", -2), /never replaced/, "the same refund with another amount is refused");
  assert.throws(ins("reversal", "ch_0", 0), /CHECK/, "a reversal is never zero");
  assert.throws(ins("restore", "ch_0", 0), /CHECK|equal its charge/, "nor a restore");
});

test("append-only: no table of 0022 can be updated or deleted", async () => {
  await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 10, feeMicros: 1 });
  await recordReversal(db, ev(), { customerId: "cus_A", chargeId: "ch_1", netMicros: 9, reason: "dispute" });
  await recordPlanState(db, ev("customer.subscription.created"), { customerId: "cus_A", subscriptionId: "sub_1", fetchedMs: T, status: "active", currentPeriodEndMs: T + 1, cancelAtPeriodEnd: false });
  for (const t of ["stripe_customers", "stripe_events", "balance_entries", "account_freezes", "gpu_plans"]) {
    assert.throws(() => db.raw.exec(`UPDATE ${t} SET created_ms = created_ms`.replace("created_ms = created_ms", t === "stripe_events" ? "received_ms = received_ms" : t === "gpu_plans" ? "fetched_ms = fetched_ms" : "created_ms = created_ms")), /never updated/, t);
    assert.throws(() => db.raw.exec(`DELETE FROM ${t}`), /never deleted/, t);
  }
});

test("an unfreeze is a human's: an automatic row can only freeze", () => {
  assert.throws(() => db.raw.prepare(`INSERT INTO account_freezes (iss, sub, frozen, reason, by_user, created_ms) VALUES (?, 'user_A', 0, 'auto', NULL, ?)`).run(ISS, T), /CHECK/);
  db.raw.prepare(`INSERT INTO account_freezes (iss, sub, frozen, reason, by_user, created_ms) VALUES (?, 'user_A', 1, 'dispute', NULL, ?)`).run(ISS, T);
  db.raw.prepare(`INSERT INTO account_freezes (iss, sub, frozen, reason, by_user, created_ms) VALUES (?, 'user_A', 0, 'reviewed', 'usr_2', ?)`).run(ISS, T);
  return isFrozen(db, A).then((f) => assert.equal(f, false));
});

const plan = (o: Partial<{ status: "active" | "past_due" | "canceled" | "trialing" | "incomplete" | "incomplete_expired" | "unpaid" | "paused"; end: number; cap: boolean; sub: string }> = {}) => ({
  customerId: "cus_A", subscriptionId: o.sub ?? "sub_1", fetchedMs: T, status: o.status ?? "active", currentPeriodEndMs: o.end ?? T + 30 * 86_400_000, cancelAtPeriodEnd: o.cap ?? false,
} as const);

test("H2: appended only on a change; a replay or a late event adds nothing; a delete then a late update stays cancelled", async () => {
  assert.equal(await recordPlanState(db, ev("customer.subscription.created"), plan()), "written");
  assert.equal(await recordPlanState(db, ev("customer.subscription.updated"), plan()), "nothing", "the same state");
  const del = ev("customer.subscription.deleted");
  assert.equal(await recordPlanState(db, del, plan({ status: "canceled" })), "written");
  assert.equal(await recordPlanState(db, del, plan({ status: "canceled" })), "replay");
  // a late subscription.updated(active): the writer re-fetches, and Stripe says canceled
  assert.equal(await recordPlanState(db, ev("customer.subscription.updated"), plan({ status: "canceled" })), "nothing");
  assert.equal((await latestPlan(db, A))!.status, "canceled");
  // A -> B -> A transitions are each recorded (the hash is compared with the latest row only)
  await recordPlanState(db, null, plan({ sub: "sub_2", status: "active" }));
  await recordPlanState(db, null, plan({ sub: "sub_2", status: "past_due" }));
  assert.equal(await recordPlanState(db, null, plan({ sub: "sub_2", status: "active" })), "written", "the daily re-fetch catches a lost event");
  assert.equal(db.raw.prepare(`SELECT COUNT(*) AS k FROM gpu_plans WHERE subscription_id = 'sub_2'`).get()!.k, 3);
  assert.equal(await recordPlanState(db, null, { ...plan({ sub: "sub_3" }), customerId: "cus_nobody" }), "nothing", "an unknown Customer");
});

test("tests4's note: the idempotency hash covers the compared fields only", async () => {
  const s = { status: "active" as const, currentPeriodEndMs: T, cancelAtPeriodEnd: false };
  assert.equal(await planStateHash(s), await planStateHash({ ...s }));
  assert.notEqual(await planStateHash(s), await planStateHash({ ...s, status: "past_due" }));
  assert.notEqual(await planStateHash(s), await planStateHash({ ...s, currentPeriodEndMs: T + 1 }));
  assert.notEqual(await planStateHash(s), await planStateHash({ ...s, cancelAtPeriodEnd: true }));
  assert.equal(await recordPlanState(db, null, { ...plan(), fetchedMs: T }), "written");
  assert.equal(await recordPlanState(db, null, { ...plan(), fetchedMs: T + 5_000 }), "nothing", "a later fetch of the same state");
});

test("H2: which statuses permit a start, past_due's grace, cancel_at_period_end at exactly the period end", () => {
  const end = T + 1000;
  const s = (status: PlanStatus, cap = false) => ({ status, currentPeriodEndMs: end, cancelAtPeriodEnd: cap });
  assert.equal(planPermitsStart(null, T), false, "no plan row");
  assert.equal(planPermitsStart(s("active"), T), true);
  assert.equal(planPermitsStart(s("active"), end + 5), true, "active past the period end (Stripe renews)");
  assert.equal(planPermitsStart(s("trialing"), T), true);
  assert.equal(planPermitsStart(s("past_due"), end - 1), true, "grace until the period end");
  assert.equal(planPermitsStart(s("past_due"), end), false, "then refused");
  for (const st of ["incomplete", "incomplete_expired", "unpaid", "canceled", "paused"] as const) assert.equal(planPermitsStart(s(st), T), false, st);
  assert.equal(planPermitsStart(s("active", true), end - 1), true);
  assert.equal(planPermitsStart(s("active", true), end), false, "cancel_at_period_end refuses from that instant");
});

test("d3: each writer through its own scope: the ledger can't name gpu_plans, the plan writer can't name the balance", async () => {
  const l = scopedDb(db, LEDGER_TABLES), p = scopedDb(db, PLAN_TABLES);
  await assert.rejects(l.all(`SELECT * FROM gpu_plans`), /gpu_plans/);
  await assert.rejects(l.run(`INSERT INTO gpu_plans DEFAULT VALUES`), /gpu_plans/);
  await assert.rejects(p.all(`SELECT * FROM balance_entries`), /balance_entries/);
  await assert.rejects(p.batch([{ sql: `UPDATE account_freezes SET frozen = 0`, params: [] }]), /account_freezes/);
  await assert.rejects(p.all(`SELECT 1 FROM stripe_customers c JOIN credit_events e ON 1`), /credit_events/);
  await assert.rejects(l.all(`SELECT * FROM credit_events`), /credit_events/, "nor the org credit");
  assert.ok(!LEDGER_TABLES.includes("gpu_plans") && !PLAN_TABLES.includes("balance_entries") && !PLAN_TABLES.includes("account_freezes"));
  assert.deepEqual((await p.all<{ k: number }>(`SELECT COUNT(*) AS k FROM gpu_plans`))[0]!.k, 0, "its own tables work");
});

test("an invalid Stripe id or status is refused before any SQL", async () => {
  await assert.rejects(recordPlanState(db, null, { ...plan(), status: "bogus" as "active" }), RangeError);
  await assert.rejects(recordPlanState(db, null, { ...plan(), subscriptionId: "si_1" }), /subscription/);
  await assert.rejects(recordRefunds(db, ev(), { customerId: "cus_A", refunds: [{ id: "pi_1", amountMicros: 1 }] }), /refund/);
  await assert.rejects(recordReversal(db, ev(), { customerId: "cus_A", chargeId: "pi_1", netMicros: 1, reason: "dispute" }), /charge/);
  await assert.rejects(recordReversal(db, ev(), { customerId: "cus_A", chargeId: "ch_1", netMicros: 1, reason: "other" as "dispute" }), RangeError);
  await assert.rejects(creditCheckout(db, { eventId: "ev_1", type: "x", nowMs: T }, { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 2, feeMicros: 1 }), /event/);
  assert.deepEqual(rows(), []);
});

// tests6's rows (TESTS on this PR): the triggers' person scoping, and append-only against REPLACE
test("the triggers are per person: another person's marker or reversal doesn't let a raw insert through", async () => {
  await creditCheckout(db, ev(), { customerId: "cus_B", paymentIntent: "pi_b", grossMicros: 10_000_000, feeMicros: null });
  assert.throws(() => db.raw.prepare(`INSERT INTO balance_entries (iss, sub, kind, stripe_key, amount, gross, fee, via, created_ms) VALUES (?, ?, 'topup', 'pi_b', 9, 10, 1, 'charge', ?)`).run(ISS, "user_A", T), /pending marker/, "B's marker, A's credit");
  await creditCheckout(db, ev(), { customerId: "cus_B", paymentIntent: "pi_r", grossMicros: 10, feeMicros: 1 });
  await recordReversal(db, ev(), { customerId: "cus_B", chargeId: "ch_r", netMicros: 9, reason: "dispute" });
  assert.throws(() => db.raw.prepare(`INSERT INTO balance_entries (iss, sub, kind, stripe_key, amount, created_ms) VALUES (?, ?, 'restore', 'ch_r', 9, ?)`).run(ISS, "user_A", T), /equal its charge/, "B's reversal, A's restore");
});

test("append-only holds against INSERT OR REPLACE too: no row is replaced, no Customer moves", async () => {
  await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 10_000_000, feeMicros: 1 });
  const before = rows();
  try { db.raw.exec(`INSERT OR REPLACE INTO balance_entries (iss, sub, kind, stripe_key, amount, gross, fee, via, created_ms) VALUES ('${ISS}', 'user_A', 'topup', 'pi_1', 999999999, 1000000000, 1, 'checkout', ${T})`); } catch { /* refused is fine */ }
  assert.deepEqual(rows(), before, "the topup row is unchanged");
  assert.equal(await balanceOf(db, A), 9_999_999);
  await recordReversal(db, ev(), { customerId: "cus_A", chargeId: "ch_1", netMicros: 9_999_999, reason: "dispute" });
  await recordPlanState(db, null, { customerId: "cus_A", subscriptionId: "sub_1", fetchedMs: T, status: "active", currentPeriodEndMs: T + 1, cancelAtPeriodEnd: false });
  for (const [table, cols, vals] of [
    ["stripe_events", "event_id, type, received_ms", `'${(db.raw.prepare("SELECT event_id FROM stripe_events LIMIT 1").get() as { event_id: string }).event_id}', 'x', 0`],
    ["account_freezes", "seq, iss, sub, frozen, reason, by_user, created_ms", `1, '${ISS}', 'user_A', 0, 'x', 'usr_2', 0`],
    ["gpu_plans", "seq, iss, sub, subscription_id, status, current_period_end_ms, cancel_at_period_end, state_sha256, fetched_ms", `1, '${ISS}', 'user_A', 'sub_9', 'active', 0, 0, '${"0".repeat(64)}', 0`],
  ] as const) {
    const snap = () => db.raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map((r) => ({ ...r }));
    const was = snap();
    try { db.raw.exec(`REPLACE INTO ${table} (${cols}) VALUES (${vals})`); } catch { /* refused is fine */ }
    assert.deepEqual(snap(), was, `${table}: no row replaced`);
  }
  try { db.raw.exec(`REPLACE INTO stripe_customers (iss, sub, customer_id, created_ms) VALUES ('${ISS}', 'user_B', 'cus_A', ${T})`); } catch { /* refused is fine */ }
  assert.deepEqual(db.raw.prepare("SELECT sub FROM stripe_customers WHERE customer_id = 'cus_A'").all().map((r) => ({ ...r })), [{ sub: "user_A" }], "cus_A stays A's");
});

// SEC's rows (astra4b on this PR): the order of a reversal and its top-up, one owner per subscription, and
// what a second write to a kept key does.
test("a reversal before its top-up: the two still sum to zero, and a later signal adds nothing", async () => {
  await recordReversal(db, ev("charge.dispute.created"), { customerId: "cus_A", chargeId: "ch_1", netMicros: 9_999_999, reason: "dispute" });
  assert.equal(await balanceOf(db, A), -9_999_999);
  await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 10_000_000, feeMicros: 1 });
  assert.equal(await balanceOf(db, A), 0);
  await recordReversal(db, ev("radar.early_fraud_warning.created"), { customerId: "cus_A", chargeId: "ch_1", netMicros: 9_999_999, reason: "early fraud warning" });
  assert.equal(await balanceOf(db, A), 0);
  assert.equal(rows("signal").length, 1);
  assert.equal(await isFrozen(db, A), true);
  await assert.rejects(recordReversal(db, ev(), { customerId: "cus_A", chargeId: "ch_2", netMicros: 0, reason: "dispute" }), RangeError, "never a zero reversal");
  await assert.rejects(recordReversal(db, ev(), { customerId: "cus_A", chargeId: "ch_1", netMicros: 5, reason: "dispute" }), /never replaced/, "a second reversal of another amount is refused");
  assert.equal(await balanceOf(db, A), 0);
});

test("a subscription belongs to one person: another Customer can't take it or be permitted by it", async () => {
  await recordPlanState(db, null, plan({ status: "active" }));
  await assert.rejects(recordPlanState(db, null, { ...plan({ status: "past_due" }), customerId: "cus_B" }), /one person/);
  assert.equal((await latestPlan(db, A))!.status, "active");
  assert.equal(await latestPlan(db, B), null);
  assert.throws(() => db.raw.prepare(`INSERT INTO gpu_plans (iss, sub, subscription_id, status, current_period_end_ms, cancel_at_period_end, state_sha256, fetched_ms) VALUES (?, 'user_B', 'sub_1', 'active', 0, 0, ?, 0)`).run(ISS, "1".repeat(64)), /one person/);
});

test("a kept key: the same row again is dropped, a different one refused, through every conflict clause", () => {
  db.raw.prepare(`INSERT INTO stripe_events (event_id, type, received_ms) VALUES ('evt_k', 'charge.updated', 0)`).run();
  for (const verb of ["INSERT", "INSERT OR IGNORE", "INSERT OR REPLACE", "REPLACE"]) {
    db.raw.exec(`${verb} INTO stripe_events (event_id, type, received_ms) VALUES ('evt_k', 'charge.updated', 5)`);
    assert.throws(() => db.raw.exec(`${verb} INTO stripe_events (event_id, type, received_ms) VALUES ('evt_k', 'charge.refunded', 5)`), /never reused/, verb);
    assert.throws(() => db.raw.exec(`${verb} INTO stripe_customers (iss, sub, customer_id, created_ms) VALUES ('${ISS}', 'user_B', 'cus_A', 0)`), /another person/, verb);
    assert.throws(() => db.raw.exec(`${verb} INTO stripe_customers (iss, sub, customer_id, created_ms) VALUES ('${ISS}', 'user_A', 'cus_Z', 0)`), /another Customer/, verb);
  }
  assert.deepEqual(db.raw.prepare(`SELECT type, received_ms FROM stripe_events WHERE event_id = 'evt_k'`).all().map((r) => ({ ...r })), [{ type: "charge.updated", received_ms: 0 }]);
  assert.deepEqual(db.raw.prepare(`SELECT sub, customer_id FROM stripe_customers ORDER BY sub`).all().map((r) => ({ ...r })), [{ sub: "user_A", customer_id: "cus_A" }, { sub: "user_B", customer_id: "cus_B" }]);
});

test("REPLACE can't rewrite a kept row, even an identical one or by its seq", () => {
  db.raw.exec(`REPLACE INTO stripe_customers (iss, sub, customer_id, created_ms) VALUES ('${ISS}', 'user_A', 'cus_A', 12345)`);
  assert.equal((db.raw.prepare(`SELECT created_ms FROM stripe_customers WHERE customer_id = 'cus_A'`).get() as { created_ms: number }).created_ms, T, "the first row's time stays");
  db.raw.prepare(`INSERT INTO balance_entries (iss, sub, kind, stripe_key, amount, created_ms) VALUES (?, 'user_A', 'refund', 're_s', -5, ?)`).run(ISS, T);
  const seq = (db.raw.prepare(`SELECT seq FROM balance_entries WHERE stripe_key = 're_s'`).get() as { seq: number }).seq;
  assert.throws(() => db.raw.exec(`REPLACE INTO balance_entries (seq, iss, sub, kind, stripe_key, amount, created_ms) VALUES (${seq}, '${ISS}', 'user_A', 'refund', 're_t', -1, 0)`), /never replaced/);
  assert.deepEqual(rows("refund").map((r) => [r.stripe_key, r.amount]), [["re_s", -5]]);
});

test("exact money: a person's balance stays a safe integer at both ends; the SUM is never read past it", async () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const raw = (sub: string, kind: string, key: string, amount: number, extra = "NULL, NULL, NULL") =>
    () => db.raw.prepare(`INSERT INTO balance_entries (iss, sub, kind, stripe_key, amount, gross, fee, via, created_ms) VALUES (?, ?, ?, ?, ?, ${extra}, ?)`).run(ISS, sub, kind, key, amount, T);
  // up to the bound, then refused by one micro-USD
  await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_big", grossMicros: MAX, feeMicros: 1 });
  raw("user_A", "topup", "pi_one", 1, "1, 0, 'checkout'")();
  assert.equal(await balanceOf(db, A), MAX);
  assert.throws(raw("user_A", "topup", "pi_two", 1, "1, 0, 'checkout'"), /2\^53/);
  await assert.rejects(creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_three", grossMicros: 2, feeMicros: 1 }), /2\^53/);
  assert.equal(await balanceOf(db, A), MAX, "the refused rows left nothing");
  // the negative bound
  raw("user_B", "refund", "re_n1", -MAX)();
  assert.equal(await balanceOf(db, B), -MAX);
  assert.throws(raw("user_B", "refund", "re_n2", -1), /2\^53/);
  // balanceOf refuses a sum it can't hold exactly, whatever the database says (a stub Db)
  for (const b of [2 ** 53, -(2 ** 53 + 2), "12", 1.5, null]) {
    const stub = { all: async () => [{ b }], run: async () => ({ changes: 0 }), batch: async () => [] } as unknown as TestDb;
    await assert.rejects(balanceOf(stub, A), RangeError, String(b));
  }
  // a replay at the bound is still just a replay
  raw("user_B", "refund", "re_n1", -MAX)();
  assert.equal(await balanceOf(db, B), -MAX);
});

test("exact money: no float parsing or rounding in the money modules", async () => {
  const { readFileSync } = await import("node:fs");
  // (the modules money flows through; the webhook verifier reads only a timestamp and ids)
  for (const f of ["stripe-ledger.ts"]) {
    const code = readFileSync(new URL(`./${f}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of [/parseFloat/, /parseInt/, /toFixed/, /toPrecision/, /\bNumber\(/, /Math\.(round|floor|ceil|trunc)/, /\*\s*100\b/, /\b1e\d/, /\/\s*100\b/]) {
      assert.doesNotMatch(code, bad, `${f}: ${bad}`);
    }
  }
});

