// Organization payments (0027 and org-payments.ts), rows from design d4 §2, d4.1, d4.3 D4, d4.5 and the
// conditions list (A3, I6, P2, SEC on d4.3): one Customer per org and apart from a person's, the credit
// always the balance transactions' net less course fees, each balance transaction once, the credit event
// only with its backing row (same org, same amount, once), the batch order, and nothing replaced.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import { stmt } from "./db.ts";
import { recordCustomer, LEDGER_TABLES, scopedDb, type EventRef } from "./stripe-ledger.ts";
import { ORG_TABLES, creditOrgPayment, markOrgPending, recordOrgCustomer, type PaymentTxn } from "./org-payments.ts";

const T = 1_800_000_000_000;
const ISS = "https://api.workos.com/user_management/client_test";
const ORG_A = `org_${"a".repeat(20)}`;
const ORG_B = `org_${"b".repeat(20)}`;
const MAX = Number.MAX_SAFE_INTEGER;
const $ = (d: number) => d * 1_000_000;

let db: TestDb;
let n = 0;
const ev = (type = "invoice.paid"): EventRef => ({ eventId: `evt_${++n}o`, type, nowMs: T });
const org = (id: string, total = 0) =>
  db.raw.prepare(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms, unassigned_credit, total_credit) VALUES (?, 'Course', 'resold', 0, ?, ?, ?)`).run(id, T, total, total);
const balances = (id: string) => ({ ...(db.raw.prepare(`SELECT unassigned_credit AS unassigned, total_credit AS total FROM orgs WHERE id = ?`).get(id) as object) });
const k = (sql: string, ...a: Array<string | number>) => (db.raw.prepare(sql).get(...a) as { k: number }).k;
const credits = () => db.raw.prepare(`SELECT org_id, amount, reference FROM credit_events WHERE kind = 'credit' ORDER BY created_ms, id`).all().map((r) => ({ ...r }));
const txn = (i: string, amount: number, fee: number): PaymentTxn => ({ id: `txn_${i}`, amountMicros: amount, feeMicros: fee });
/** total = unassigned + the projects' budgets (0006), as d4.5's identity (no refund hold yet) */
const identity = (id: string) => {
  const b = balances(id) as { unassigned: number; total: number };
  const budgets = k(`SELECT COALESCE(SUM(budget), 0) AS k FROM projects WHERE org_id = ?`, id);
  assert.equal(b.total, b.unassigned + budgets, "total = unassigned + budgets");
};

beforeEach(async () => {
  db = sqliteDb();
  org(ORG_A);
  org(ORG_B);
  await recordOrgCustomer(db, ORG_A, "cus_OrgA", T);
  await recordOrgCustomer(db, ORG_B, "cus_OrgB", T);
});

test("A3: one Customer per org; the first is kept; a Customer can't move, and a person's and an org's are apart", async () => {
  assert.equal(await recordOrgCustomer(db, ORG_A, "cus_OrgA", T), "cus_OrgA", "the same again");
  await assert.rejects(recordOrgCustomer(db, ORG_A, "cus_OrgA2", T), /another Customer/);
  await assert.rejects(recordOrgCustomer(db, ORG_B, "cus_OrgA", T), /another organization/);
  db.raw.prepare(`INSERT INTO users (id, email, name, created_ms) VALUES ('usr_1', 'p@example.com', NULL, ?)`).run(T);
  db.raw.prepare(`INSERT INTO identities (iss, sub, user_id, email, email_ticket, created_ms) VALUES (?, 'user_P', 'usr_1', NULL, 0, ?)`).run(ISS, T);
  await assert.rejects(recordCustomer(db, { iss: ISS, sub: "user_P" }, "cus_OrgA", T), /organization's, not a person's/);
  await recordCustomer(db, { iss: ISS, sub: "user_P" }, "cus_Person", T);
  const C = `org_${"c".repeat(20)}`;
  org(C);
  await assert.rejects(recordOrgCustomer(db, C, "cus_Person", T), /person's, not an organization's/);
  assert.throws(() => db.raw.exec(`INSERT OR REPLACE INTO stripe_org_customers (org_id, customer_id, created_ms) VALUES ('${ORG_A}', 'cus_Other', 0)`), /another Customer/, "REPLACE is refused");
  assert.throws(() => db.raw.exec(`UPDATE stripe_org_customers SET customer_id = 'cus_X'`), /never updated/);
  assert.throws(() => db.raw.exec(`DELETE FROM stripe_org_customers`), /never deleted/);
});

test("card: the org is credited the net (amount less Stripe's fee), once; balances and the credit event in one batch", async () => {
  const p = { customerId: "cus_OrgA", kind: "card" as const, stripeKey: "pi_1", txns: [txn("1", $(1000), $(29.3))], courseFeeMicros: 0, via: "event" as const };
  const e = ev("checkout.session.completed");
  assert.equal(await creditOrgPayment(db, e, p), "written");
  assert.deepEqual(balances(ORG_A), { unassigned: $(970.7), total: $(970.7) });
  assert.deepEqual(credits(), [{ org_id: ORG_A, amount: $(970.7), reference: "stripe:pi_1" }]);
  identity(ORG_A);
  assert.equal(await creditOrgPayment(db, e, p), "replay");
  assert.equal(await creditOrgPayment(db, ev("checkout.session.completed"), p), "nothing", "another event for the same PaymentIntent");
  assert.deepEqual(balances(ORG_A), { unassigned: $(970.7), total: $(970.7) });
  assert.equal(credits().length, 1);
  assert.deepEqual(balances(ORG_B), { unassigned: 0, total: 0 });
});

test("invoice (d4.1): credit = the payments' net less the course-fee lines; the fee is recorded, never credited", async () => {
  // $5,000 course fee + $20,000 deposit, paid by ACH with a $5 fee
  const p = { customerId: "cus_OrgA", kind: "invoice" as const, stripeKey: "in_1", txns: [txn("ach", $(25_000), $(5))], courseFeeMicros: $(5_000), via: "event" as const };
  assert.equal(await creditOrgPayment(db, ev(), p), "written");
  assert.deepEqual(balances(ORG_A), { unassigned: $(19_995), total: $(19_995) });
  const rows = db.raw.prepare(`SELECT kind, gross, fee, credit FROM org_payments ORDER BY seq`).all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { kind: "fee", gross: $(5_000), fee: null, credit: 0 },
    { kind: "invoice_credit", gross: $(20_000), fee: $(5), credit: $(19_995) },
  ]);
  identity(ORG_A);
  // two payments on one invoice: summed
  const two = { ...p, stripeKey: "in_2", txns: [txn("w1", $(3_000), 0), txn("w2", $(2_000), $(15))], courseFeeMicros: 0 };
  assert.equal(await creditOrgPayment(db, ev(), two), "written");
  assert.deepEqual(balances(ORG_A), { unassigned: $(19_995) + $(4_985), total: $(19_995) + $(4_985) });
});

test("nothing to credit is refused and writes nothing: fees at or above what was paid, no transactions, odd inputs", async () => {
  const base = { customerId: "cus_OrgA", kind: "invoice" as const, stripeKey: "in_1", courseFeeMicros: $(5_000), via: "event" as const };
  for (const [why, txns] of [
    ["only the course fee", [txn("1", $(5_000), 0)]],
    ["fees eat the deposit", [txn("1", $(5_010), $(10))]],
    ["no transactions", []],
    ["a fee above its amount, even with enough left to credit", [txn("1", $(6_000), $(6_001)), txn("2", $(10_000), 0)]],
    ["the same txn twice", [txn("1", $(6_000), 0), txn("1", $(6_000), 0)]],
    ["a fraction", [txn("1", 6_000_000_000.5, 0)]],
  ] as const) {
    await assert.rejects(creditOrgPayment(db, ev(), { ...base, txns }), RangeError, why);
  }
  await assert.rejects(creditOrgPayment(db, ev(), { ...base, kind: "card", stripeKey: "pi_1", txns: [txn("1", $(10), 0)] }), /no course fee/);
  await assert.rejects(creditOrgPayment(db, ev(), { ...base, stripeKey: "pi_1", txns: [txn("1", $(10_000), 0)] }), /invoice id/, "the key's kind matches");
  assert.equal(k(`SELECT COUNT(*) AS k FROM org_payments`), 0);
  assert.equal(k(`SELECT COUNT(*) AS k FROM stripe_events`), 0);
  assert.deepEqual(balances(ORG_A), { unassigned: 0, total: 0 });
});

test("I6: a balance transaction funds one credit, once, across invoices; the second credit is refused whole", async () => {
  const p = { customerId: "cus_OrgA", kind: "invoice" as const, stripeKey: "in_1", txns: [txn("x", $(10_000), $(5))], courseFeeMicros: 0, via: "event" as const };
  await creditOrgPayment(db, ev(), p);
  await assert.rejects(creditOrgPayment(db, ev(), { ...p, stripeKey: "in_2" }), /one credit, once/);
  await assert.rejects(creditOrgPayment(db, ev(), { ...p, customerId: "cus_OrgB", stripeKey: "in_3" }), /one credit, once/, "nor for another org");
  assert.deepEqual(balances(ORG_A), { unassigned: $(9_995), total: $(9_995) });
  assert.deepEqual(balances(ORG_B), { unassigned: 0, total: 0 });
  assert.equal(k(`SELECT COUNT(*) AS k FROM org_payments`), 1);
});

test("an unknown Customer, or a person's, credits nothing", async () => {
  const p = { customerId: "cus_Nobody", kind: "card" as const, stripeKey: "pi_1", txns: [txn("1", $(100), $(3))], courseFeeMicros: 0, via: "event" as const };
  assert.equal(await creditOrgPayment(db, ev(), p), "nothing");
  assert.equal(k(`SELECT COUNT(*) AS k FROM org_payments`), 0);
  assert.equal(k(`SELECT COUNT(*) AS k FROM org_payment_txns`), 0);
  assert.equal(credits().length, 0);
});

test("pending (d3 T1, d4.1): the marker credits nothing; the later credit needs it, and is once", async () => {
  assert.equal(await markOrgPending(db, ev(), { customerId: "cus_OrgA", stripeKey: "in_1" }), "written");
  assert.deepEqual(balances(ORG_A), { unassigned: 0, total: 0 });
  const later = { customerId: "cus_OrgA", kind: "invoice" as const, stripeKey: "in_1", txns: [txn("1", $(1_000), $(5))], courseFeeMicros: 0, via: "later" as const };
  assert.equal(await creditOrgPayment(db, ev("charge.updated"), later), "written");
  assert.equal(await creditOrgPayment(db, ev("invoice.paid"), { ...later, via: "event" }), "nothing", "the event's own path after: still once");
  assert.deepEqual(balances(ORG_A), { unassigned: $(995), total: $(995) });
  await assert.rejects(creditOrgPayment(db, ev(), { ...later, stripeKey: "in_9", txns: [txn("9", $(1_000), 0)] }), /pending marker/, "no marker, no later credit");
});

test("P2 and D4: a stripe: credit event needs its org payment, for the same org and amount; manual: is refused; any case is reserved", async () => {
  await creditOrgPayment(db, ev(), { customerId: "cus_OrgA", kind: "card", stripeKey: "pi_1", txns: [txn("1", $(1), 0)], courseFeeMicros: 0, via: "event" });
  const raw = (id: string, orgId: string, amount: number, ref: string) =>
    db.raw.prepare(`INSERT INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES (?, ?, 'credit', ?, ?, ?)`).run(id, orgId, amount, ref, T);
  assert.throws(() => raw("cre_x1", ORG_A, $(500_000), "stripe:pi_9"), /needs its org payment/, "no backing row");
  assert.throws(() => raw("cre_x2", ORG_B, $(1), "stripe:pi_1"), /once|needs its org payment/, "another org");
  for (const r of ["manual:1", "Manual:1", "STRIPE:pi_1", "Stripe:pi_1"]) assert.throws(() => raw(`cre_${r.length}${r[0]}`, ORG_A, $(1), r), /needs its org payment|manual/, r);
  assert.throws(() => raw("cre_x3", ORG_A, $(1), "stripe:pi_1"), /credits once/, "a second credit for one object");
  // a backing row with no credit event yet: another org, another amount and manual: are each refused; then the right one passes
  db.raw.prepare(`INSERT INTO org_payment_txns (txn_id, org_id, stripe_key, amount, fee, created_ms) VALUES ('txn_6', ?, 'pi_6', 600, 0, ?)`).run(ORG_A, T);
  db.raw.prepare(`INSERT INTO org_payments (org_id, kind, stripe_key, gross, fee, credit, via, created_ms) VALUES (?, 'card_credit', 'pi_6', 600, 0, 600, 'event', ?)`).run(ORG_A, T);
  assert.throws(() => raw("cre_z1", ORG_B, 600, "stripe:pi_6"), /needs its org payment/, "the right amount for another org");
  assert.throws(() => raw("cre_z2", ORG_A, 601, "stripe:pi_6"), /needs its org payment/, "the right org, another amount");
  assert.throws(() => raw("cre_z3", ORG_A, 600, "manual:pi_6"), /needs its org payment|manual/, "manual: even with a matching row");
  raw("cre_z4", ORG_A, 600, "stripe:pi_6");
  // an operator's free-text reference still works (the existing audited path)
  raw("cre_op", ORG_A, $(7), "PO 12345");
  // the batch order: a credit event before its org payment, in one batch, is refused and nothing is written
  const before = k(`SELECT COUNT(*) AS k FROM org_payments`);
  await assert.rejects(db.batch([
    stmt(`INSERT INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES ('cre_y', ?, 'credit', 5, 'stripe:pi_5', ?)`, ORG_A, T),
    stmt(`INSERT INTO org_payment_txns (txn_id, org_id, stripe_key, amount, fee, created_ms) VALUES ('txn_5', ?, 'pi_5', 5, 0, ?)`, ORG_A, T),
    stmt(`INSERT INTO org_payments (org_id, kind, stripe_key, gross, fee, credit, via, created_ms) VALUES (?, 'card_credit', 'pi_5', 5, 0, 5, 'event', ?)`, ORG_A, T),
  ]), /needs its org payment/);
  assert.equal(k(`SELECT COUNT(*) AS k FROM org_payments`), before);
});

test("SEC on d4.3: credit events are never updated, deleted or replaced, by id or by reference", async () => {
  await creditOrgPayment(db, ev(), { customerId: "cus_OrgA", kind: "card", stripeKey: "pi_1", txns: [txn("1", $(1), 0)], courseFeeMicros: 0, via: "event" });
  const id = (db.raw.prepare(`SELECT id FROM credit_events`).get() as { id: string }).id;
  assert.throws(() => db.raw.exec(`UPDATE credit_events SET amount = amount + 1`), /never updated/);
  assert.throws(() => db.raw.exec(`DELETE FROM credit_events`), /never deleted/);
  assert.throws(() => db.raw.prepare(`INSERT OR REPLACE INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES (?, ?, 'credit', 1, 'PO 1', ?)`).run(id, ORG_A, T), /never replaced/, "by id");
  assert.throws(() => db.raw.prepare(`INSERT OR REPLACE INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES ('cre_new', ?, 'credit', ?, 'stripe:pi_1', ?)`).run(ORG_A, $(1), T), /credits once/, "by reference");
  assert.equal(credits().length, 1);
});

test("org payments and their transactions: a raw credit must be exactly its transactions' net less its fee; nothing replaced, updated or deleted", () => {
  const ins = (kind: string, key: string, gross: number | null, fee: number | null, credit: number, via: string | null) =>
    db.raw.prepare(`INSERT INTO org_payments (org_id, kind, stripe_key, gross, fee, credit, via, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(ORG_A, kind, key, gross, fee, credit, via, T);
  assert.throws(() => ins("card_credit", "pi_7", 100, 3, 97, "event"), /exactly its balance transactions/, "no transactions");
  db.raw.prepare(`INSERT INTO org_payment_txns (txn_id, org_id, stripe_key, amount, fee, created_ms) VALUES ('txn_7', ?, 'pi_7', 100, 3, ?)`).run(ORG_A, T);
  assert.throws(() => ins("card_credit", "pi_7", 101, 3, 98, "event"), /exactly its balance transactions/, "more than the transactions");
  assert.throws(() => ins("card_credit", "pi_7", 100, 2, 98, "event"), /exactly its balance transactions/, "a smaller fee");
  assert.throws(() => ins("card_credit", "pi_7", 99, 2, 97, "event"), /exactly its balance transactions/, "the net right but the fee not Stripe's");
  ins("card_credit", "pi_7", 100, 3, 97, "event");
  assert.throws(() => ins("card_credit", "pi_7", 100, 3, 96, "event"), /CHECK|never replaced/);
  assert.throws(() => db.raw.prepare(`INSERT OR REPLACE INTO org_payments (seq, org_id, kind, stripe_key, gross, fee, credit, via, created_ms) VALUES (1, ?, 'pending', 'pi_8', NULL, NULL, 0, NULL, ?)`).run(ORG_A, T), /never replaced/);
  assert.throws(() => db.raw.prepare(`INSERT OR REPLACE INTO org_payment_txns (txn_id, org_id, stripe_key, amount, fee, created_ms) VALUES ('txn_7', ?, 'pi_7', 1000, 0, ?)`).run(ORG_A, T), /once/);
  // the course fee must come before its invoice's credit
  db.raw.prepare(`INSERT INTO org_payment_txns (txn_id, org_id, stripe_key, amount, fee, created_ms) VALUES ('txn_9', ?, 'in_9', 100, 0, ?)`).run(ORG_A, T);
  ins("invoice_credit", "in_9", 100, 0, 100, "event");
  assert.throws(() => ins("fee", "in_9", 50, null, 0, null), /comes before its credit/);
  for (const t of ["org_payments", "org_payment_txns"]) {
    assert.throws(() => db.raw.exec(`UPDATE ${t} SET created_ms = 0`), /never updated/, t);
    assert.throws(() => db.raw.exec(`DELETE FROM ${t}`), /never deleted/, t);
  }
});

test("exact money: an org's total credit past 2^53 - 1 is refused, and nothing of the batch is written", async () => {
  db.raw.prepare(`UPDATE orgs SET unassigned_credit = ?, total_credit = ? WHERE id = ?`).run(MAX - 10, MAX - 10, ORG_A);
  await assert.rejects(creditOrgPayment(db, ev(), { customerId: "cus_OrgA", kind: "card", stripeKey: "pi_1", txns: [txn("1", 20, 0)], courseFeeMicros: 0, via: "event" }), /CHECK/);
  assert.equal(k(`SELECT COUNT(*) AS k FROM org_payments`), 0);
  assert.equal(k(`SELECT COUNT(*) AS k FROM credit_events`), 0);
  assert.equal(k(`SELECT COUNT(*) AS k FROM stripe_events`), 0);
  assert.equal(await creditOrgPayment(db, ev(), { customerId: "cus_OrgA", kind: "card", stripeKey: "pi_2", txns: [txn("2", 10, 0)], courseFeeMicros: 0, via: "event" }), "written", "exactly the bound");
  assert.deepEqual(balances(ORG_A), { unassigned: MAX, total: MAX });
});

test("the writers' scopes: the org writer can't name a person's ledger, nor the person's writer an org's", async () => {
  await assert.rejects(scopedDb(db, ORG_TABLES).all(`SELECT 1 FROM balance_entries`), /can't use the table balance_entries/);
  await assert.rejects(scopedDb(db, LEDGER_TABLES).all(`SELECT 1 FROM org_payments`), /can't use the table org_payments/);
  await assert.rejects(scopedDb(db, LEDGER_TABLES).run(`UPDATE orgs SET total_credit = 0`), /can't use the table orgs/);
});

test("the migration refuses a database whose credit references already use a reserved prefix", () => {
  for (const ref of ["stripe:pi_1", "MANUAL:x"]) {
    assert.throws(
      () =>
        sqliteDb({
          upgrade: {
            at: "0027",
            seed(raw) {
              raw.prepare(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'Old', 'resold', 0, ?)`).run(ORG_A, T);
              raw.prepare(`INSERT INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES ('cre_old', ?, 'credit', 1, ?, ?)`).run(ORG_A, ref, T);
            },
          },
        }),
      /malformed JSON/,
      ref,
    );
  }
});
