// Organization payments (billing d4 step 2, migration 0027): what control records when a course's credit is
// paid through Stripe, by invoice or by card, after a verified event and a re-fetch of what it names (as for
// individuals, stripe-ledger.ts). The invoice and card flows (steps 3 and 4) call these with Stripe's
// re-fetched facts, never an event's payload or metadata.
//
// - Whose: the org whose Customer the re-fetched object names (A3), found in SQL; an unknown Customer
//   writes nothing.
// - How much: always net of fees (William, Nov 27). The credit is the balance transactions' net, less the
//   invoice's course-fee lines, computed here and checked again by the database (0027), with each balance
//   transaction kept once across every credit (I6).
// - Once: every row is keyed by its Stripe object and a replay adds nothing. The credit_events row and the
//   balance change are conditional on this call's own fresh credit event id, so a replay or a race that
//   loses writes no second credit and moves no balance.
// - One batch: the event, the transactions, the fee row, the credit row, then the credit event and the
//   org's unassigned and total credit (in the order 0027's triggers read them, d4.5 D4).

import { newId } from "@sbgpu/api";
import { stmt, type Db, type Stmt } from "./db.ts";
import { scopedDb, type EventRef, type Outcome } from "./stripe-ledger.ts";

export const ORG_TABLES: readonly string[] = Object.freeze(["stripe_org_customers", "stripe_events", "org_payments", "org_payment_txns", "credit_events", "orgs"]);

const ID = {
  customer: /^cus_[A-Za-z0-9]{1,251}$/,
  event: /^evt_[A-Za-z0-9]{1,251}$/,
  paymentIntent: /^pi_[A-Za-z0-9]{1,252}$/,
  invoice: /^in_[A-Za-z0-9]{1,252}$/,
  txn: /^txn_[A-Za-z0-9]{1,251}$/,
} as const;
function id(kind: keyof typeof ID, v: string): string {
  if (typeof v !== "string" || !ID[kind].test(v)) throw new RangeError(`not a Stripe ${kind} id`);
  return v;
}
function micros(v: number, min: number): number {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError("an amount must be a safe integer of micro-USD");
  return v;
}

/**
 * The org's Customer (one per org, A3). Created at Stripe with `Idempotency-Key: org-customer:<org_id>`, so two
 * concurrent first payments record the same Customer once. Throws if the org already has another Customer,
 * the Customer belongs to another org, or it is a person's (0022's stripe_customers).
 */
export async function recordOrgCustomer(db: Db, orgId: string, customerId: string, nowMs: number): Promise<string> {
  await scopedDb(db, ORG_TABLES).run(`INSERT INTO stripe_org_customers (org_id, customer_id, created_ms) VALUES (?, ?, ?)`, [orgId, id("customer", customerId), micros(nowMs, 0)]);
  return customerId;
}

const ORG = `FROM stripe_org_customers c WHERE c.customer_id = ?`;
const eventStmt = (e: EventRef) => stmt(`INSERT OR IGNORE INTO stripe_events (event_id, type, received_ms) VALUES (?, ?, ?)`, id("event", e.eventId), e.type, e.nowMs);

/** One balance transaction that funded the payment: Stripe's amount and fee for it. */
export interface PaymentTxn {
  readonly id: string;
  readonly amountMicros: number;
  readonly feeMicros: number;
}

/**
 * A paid card top-up (a PaymentIntent) or a paid invoice, credited to the Customer's org at its net: the
 * balance transactions' amounts less their fees, less an invoice's course-fee lines (`courseFeeMicros`, 0 for
 * a card; recorded as a fee row and never credited). `via` is 'event' for the object's own event (checkout
 * completed, invoice paid) and 'later' for a pending marker's object (refused without the marker). Throws
 * when there is nothing to credit: no transactions, or fees and course fees at or above what was paid (d4.1:
 * refuse and alert).
 */
export async function creditOrgPayment(
  db: Db,
  e: EventRef,
  p: { customerId: string; kind: "card" | "invoice"; stripeKey: string; txns: readonly PaymentTxn[]; courseFeeMicros: number; via: "event" | "later" },
): Promise<Outcome> {
  const c = id("customer", p.customerId);
  const key = p.kind === "card" ? id("paymentIntent", p.stripeKey) : p.kind === "invoice" ? id("invoice", p.stripeKey) : null;
  if (key === null) throw new RangeError("a payment is a card top-up or an invoice");
  if (p.via !== "event" && p.via !== "later") throw new RangeError("a credit comes from its event or later, for a pending marker");
  const courseFee = micros(p.courseFeeMicros, 0);
  if (p.kind === "card" && courseFee !== 0) throw new RangeError("a card top-up has no course fee");
  if (p.txns.length === 0) throw new RangeError("a payment needs its balance transactions");
  const seen = new Set<string>();
  let paid = 0;
  let fees = 0;
  for (const t of p.txns) {
    if (seen.has(id("txn", t.id))) throw new RangeError("a balance transaction is listed twice");
    seen.add(t.id);
    const a = micros(t.amountMicros, 1);
    const f = micros(t.feeMicros, 0);
    if (f > a) throw new RangeError("a balance transaction's fee is more than its amount");
    paid += a;
    fees += f;
    if (!Number.isSafeInteger(paid) || !Number.isSafeInteger(fees)) throw new RangeError("the payments add up past the exact integer range");
  }
  // gross: what was paid toward credit (the deposits); credit: that, less the processing fees
  const gross = paid - courseFee;
  if (gross < 1 || fees >= gross) throw new RangeError("the fees and course fees are not less than what was paid: nothing to credit");
  const credit = gross - fees;
  const kind = p.kind === "card" ? "card_credit" : "invoice_credit";
  const creditEventId = newId("creditEvent");
  const reference = `stripe:${key}`;
  const stmts: Stmt[] = [
    ...p.txns.map((t) =>
      stmt(`INSERT INTO org_payment_txns (txn_id, org_id, stripe_key, amount, fee, created_ms) SELECT ?, c.org_id, ?, ?, ?, ? ${ORG}`, t.id, key, t.amountMicros, t.feeMicros, e.nowMs, c),
    ),
    ...(courseFee > 0 ? [stmt(`INSERT INTO org_payments (org_id, kind, stripe_key, gross, credit, event_id, created_ms) SELECT c.org_id, 'fee', ?, ?, 0, ?, ? ${ORG}`, key, courseFee, e.eventId, e.nowMs, c)] : []),
    stmt(
      `INSERT INTO org_payments (org_id, kind, stripe_key, gross, fee, credit, via, event_id, created_ms) SELECT c.org_id, ?, ?, ?, ?, ?, ?, ?, ? ${ORG}`,
      kind, key, gross, fees, credit, p.via, e.eventId, e.nowMs, c,
    ),
    // (the amount and org from the kept row, whichever call wrote it; only once per reference)
    stmt(
      `INSERT INTO credit_events (id, org_id, kind, amount, reference, created_ms)
       SELECT ?, p.org_id, 'credit', p.credit, ?, ? FROM org_payments p JOIN stripe_org_customers c ON c.org_id = p.org_id
       WHERE p.kind = ? AND p.stripe_key = ? AND c.customer_id = ? AND NOT EXISTS (SELECT 1 FROM credit_events WHERE reference = ?)`,
      creditEventId, reference, e.nowMs, kind, key, c, reference,
    ),
    // (only the call whose credit event this is moves the balance)
    stmt(
      `UPDATE orgs SET unassigned_credit = unassigned_credit + (SELECT amount FROM credit_events WHERE id = ?), total_credit = total_credit + (SELECT amount FROM credit_events WHERE id = ?)
       WHERE id = (SELECT org_id FROM credit_events WHERE id = ?)`,
      creditEventId, creditEventId, creditEventId,
    ),
  ];
  return run(db, e, stmts, stmts.length - 1);
}

/** The marker for a payment whose fees weren't known yet (d3 T1, d4.1): nothing is credited until they are. */
export async function markOrgPending(db: Db, e: EventRef, p: { customerId: string; stripeKey: string }): Promise<Outcome> {
  const key = p.stripeKey.startsWith("pi_") ? id("paymentIntent", p.stripeKey) : id("invoice", p.stripeKey);
  return run(db, e, [stmt(`INSERT INTO org_payments (org_id, kind, stripe_key, credit, event_id, created_ms) SELECT c.org_id, 'pending', ?, 0, ?, ? ${ORG}`, key, e.eventId, e.nowMs, id("customer", p.customerId))], 0);
}

/** `written` when the statement at `decisive` (of the money statements) changed a row. */
async function run(db: Db, e: EventRef, money: Stmt[], decisive: number): Promise<Outcome> {
  const scoped = scopedDb(db, ORG_TABLES);
  if ((await scoped.all(`SELECT 1 FROM stripe_events WHERE event_id = ?`, [e.eventId])).length > 0) return "replay";
  const r = await scoped.batch([eventStmt(e), ...money]);
  return r[decisive + 1]!.changes > 0 ? "written" : "nothing";
}
