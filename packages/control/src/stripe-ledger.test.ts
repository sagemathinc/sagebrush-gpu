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
  assert.equal(await recordCustomer(db, A, "cus_A2", T), "cus_A", "a second Customer for A keeps the first");
  assert.equal(await recordCustomer(db, A, "cus_B", T), "cus_A", "A keeps its own, and cus_B stays B's");
  // two concurrent first top-ups: one row
  person({ iss: ISS, sub: "user_C" }, 3);
  const C: Who = { iss: ISS, sub: "user_C" };
  const [x, y] = await Promise.all([recordCustomer(db, C, "cus_C1", T), recordCustomer(db, C, "cus_C2", T)]);
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
  await recordReversal(db, ev("radar.early_fraud_warning.created"), { customerId: "cus_A", chargeId: "ch_1", paymentIntent: "pi_1", reason: "early fraud warning" });
  await recordReversal(db, ev("charge.dispute.created"), { customerId: "cus_A", chargeId: "ch_1", paymentIntent: "pi_1", reason: "dispute" });
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
  await recordReversal(db, ev("charge.dispute.created"), { customerId: "cus_A", chargeId: "ch_1", paymentIntent: "pi_1", reason: "dispute" });
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
  assert.throws(ins("refund", "re_1", -2), /UNIQUE/);
});

test("append-only: no table of 0022 can be updated or deleted", async () => {
  await creditCheckout(db, ev(), { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 10, feeMicros: 1 });
  await recordReversal(db, ev(), { customerId: "cus_A", chargeId: "ch_1", paymentIntent: "pi_1", reason: "dispute" });
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
  await assert.rejects(recordReversal(db, ev(), { customerId: "cus_A", chargeId: "pi_1", paymentIntent: "pi_1", reason: "dispute" }), /charge/);
  await assert.rejects(recordReversal(db, ev(), { customerId: "cus_A", chargeId: "ch_1", paymentIntent: "pi_1", reason: "other" as "dispute" }), RangeError);
  await assert.rejects(creditCheckout(db, { eventId: "ev_1", type: "x", nowMs: T }, { customerId: "cus_A", paymentIntent: "pi_1", grossMicros: 2, feeMicros: 1 }), /event/);
  assert.deepEqual(rows(), []);
});
