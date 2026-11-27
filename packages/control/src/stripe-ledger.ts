// The GPU billing ledger's writers (design d3.2, Stripe TEST mode first): what control records from
// Stripe, after a verified event and a re-fetch of the object it names (d3 T1, d3.2 H2). Each writer
// takes those fetched facts, never an event's payload or metadata, and writes one batch.
//
// - Who: a Stripe object's person is the stripe_customers row for its Customer (N3), found in SQL; an
//   unknown Customer writes nothing.
// - Once: every row is keyed by its Stripe object (migration 0022), and written with OR IGNORE, so a
//   replayed, retried or reordered event adds nothing. The event itself is recorded once in
//   stripe_events; a replay is reported, not an error.
// - Two writers, two scopes: the ledger writer can't name gpu_plans and the plan writer can't name
//   balance_entries or account_freezes (d3's per-writer pin). Each runs through scopedDb.

import { stmt, type Db, type SqlValue, type Stmt } from "./db.ts";

export interface Who {
  readonly iss: string;
  readonly sub: string;
}

export const LEDGER_TABLES: readonly string[] = Object.freeze(["stripe_customers", "stripe_events", "balance_entries", "account_freezes"]);
export const PLAN_TABLES: readonly string[] = Object.freeze(["stripe_customers", "stripe_events", "gpu_plans"]);

/** A Db whose statements may name only `tables` (every FROM, INTO, UPDATE and JOIN target). */
export function scopedDb(db: Db, tables: readonly string[]): Db {
  const check = (sql: string) => {
    for (const m of sql.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      if (!tables.includes(m[1]!.toLowerCase())) throw new Error(`this writer can't use the table ${m[1]}`);
    }
  };
  return {
    async all<T>(sql: string, params?: SqlValue[]) {
      check(sql);
      return db.all<T>(sql, params);
    },
    async run(sql: string, params?: SqlValue[]) {
      check(sql);
      return db.run(sql, params);
    },
    async batch(stmts: Stmt[]) {
      for (const s of stmts) check(s.sql);
      return db.batch(stmts);
    },
  };
}

const ID = {
  customer: /^cus_[A-Za-z0-9]{1,251}$/,
  event: /^evt_[A-Za-z0-9]{1,251}$/,
  paymentIntent: /^pi_[A-Za-z0-9]{1,252}$/,
  refund: /^re_[A-Za-z0-9]{1,252}$/,
  charge: /^ch_[A-Za-z0-9]{1,252}$/,
  subscription: /^sub_[A-Za-z0-9]{1,251}$/,
} as const;

function id(kind: keyof typeof ID, v: string): string {
  if (typeof v !== "string" || !ID[kind].test(v)) throw new RangeError(`not a Stripe ${kind} id`);
  return v;
}
function micros(v: number, min: number): number {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError("an amount must be a safe integer of micro-USD");
  return v;
}

export interface EventRef {
  readonly eventId: string;
  readonly type: string;
  readonly nowMs: number;
}

const eventStmt = (e: EventRef) => stmt(`INSERT OR IGNORE INTO stripe_events (event_id, type, received_ms) VALUES (?, ?, ?)`, id("event", e.eventId), e.type, e.nowMs);

/** Whether the batch's money rows were written; `replay` when the event was already recorded. */
export type Outcome = "written" | "nothing" | "replay";

/**
 * A replayed event writes nothing. (Two copies of one event delivered at once may both pass the read;
 * the rows' own keys then keep the money exactly-once, which is the guarantee: the event check is the
 * replay row, not what the ledger rests on.)
 */
async function run(db: Db, e: EventRef, money: Stmt[]): Promise<Outcome> {
  const ev = eventStmt(e);
  if ((await db.all(`SELECT 1 FROM stripe_events WHERE event_id = ?`, [e.eventId])).length > 0) return "replay";
  const r = await db.batch([ev, ...money]);
  return r.slice(1).some((x) => x.changes > 0) ? "written" : "nothing";
}

// ---- customers (N3)

/**
 * The person's Customer: the first one recorded is kept, so two concurrent first top-ups end with one.
 * Throws if `customerId` already belongs to someone else.
 */
export async function recordCustomer(db: Db, who: Who, customerId: string, nowMs: number): Promise<string> {
  const l = scopedDb(db, LEDGER_TABLES);
  await l.run(`INSERT OR IGNORE INTO stripe_customers (iss, sub, customer_id, created_ms) VALUES (?, ?, ?, ?)`, [who.iss, who.sub, id("customer", customerId), nowMs]);
  const r = await l.all<{ customer_id: string }>(`SELECT customer_id FROM stripe_customers WHERE iss = ? AND sub = ?`, [who.iss, who.sub]);
  if (r.length === 0) throw new Error("that Customer belongs to another person");
  return r[0]!.customer_id;
}

// ---- the ledger writer

const PERSON = `FROM stripe_customers c WHERE c.customer_id = ?`;

/**
 * A paid checkout.session.completed, with its PaymentIntent re-fetched. With the fee known, the net
 * (gross minus fee) is credited; without it, only the pending marker is written (d3 T1): never gross,
 * never zero.
 */
export async function creditCheckout(
  db: Db,
  e: EventRef,
  p: { customerId: string; paymentIntent: string; grossMicros: number; feeMicros: number | null },
): Promise<Outcome> {
  const pi = id("paymentIntent", p.paymentIntent);
  const gross = micros(p.grossMicros, 1);
  const c = id("customer", p.customerId);
  if (p.feeMicros === null) {
    return run(scopedDb(db, LEDGER_TABLES), e, [
      stmt(`INSERT OR IGNORE INTO balance_entries (iss, sub, kind, stripe_key, amount, event_id, created_ms) SELECT c.iss, c.sub, 'pending', ?, 0, ?, ? ${PERSON}`, pi, e.eventId, e.nowMs, c),
    ]);
  }
  const fee = micros(p.feeMicros, 0);
  if (fee >= gross) throw new RangeError("the fee must be less than the amount paid");
  return run(scopedDb(db, LEDGER_TABLES), e, [
    stmt(
      `INSERT OR IGNORE INTO balance_entries (iss, sub, kind, stripe_key, amount, gross, fee, via, event_id, created_ms)
       SELECT c.iss, c.sub, 'topup', ?, ?, ?, ?, 'checkout', ?, ? ${PERSON}`,
      pi, gross - fee, gross, fee, e.eventId, e.nowMs, c,
    ),
  ]);
}

/**
 * The fee arrived later, from charge.updated or a scheduled re-fetch (d3.2): credited only for a
 * PaymentIntent holding a pending marker, and once whichever path supplies it.
 */
export async function creditPending(
  db: Db,
  e: EventRef,
  p: { customerId: string; paymentIntent: string; grossMicros: number; feeMicros: number; via: "charge" | "refetch" },
): Promise<Outcome> {
  const pi = id("paymentIntent", p.paymentIntent);
  const gross = micros(p.grossMicros, 1);
  const fee = micros(p.feeMicros, 0);
  if (fee >= gross) throw new RangeError("the fee must be less than the amount paid");
  if (p.via !== "charge" && p.via !== "refetch") throw new RangeError("a later credit comes from charge.updated or a re-fetch");
  return run(scopedDb(db, LEDGER_TABLES), e, [
    stmt(
      `INSERT OR IGNORE INTO balance_entries (iss, sub, kind, stripe_key, amount, gross, fee, via, event_id, created_ms)
       SELECT c.iss, c.sub, 'topup', ?, ?, ?, ?, ?, ?, ? ${PERSON}
       AND EXISTS (SELECT 1 FROM balance_entries m WHERE m.kind = 'pending' AND m.stripe_key = ? AND m.iss = c.iss AND m.sub = c.sub)`,
      pi, gross - fee, gross, fee, p.via, e.eventId, e.nowMs, id("customer", p.customerId), pi,
    ),
  ]);
}

/** charge.refunded, with the charge's refunds list re-fetched: one debit per refund id (d3 T2). */
export async function recordRefunds(db: Db, e: EventRef, p: { customerId: string; refunds: ReadonlyArray<{ id: string; amountMicros: number }> }): Promise<Outcome> {
  const c = id("customer", p.customerId);
  return run(
    scopedDb(db, LEDGER_TABLES),
    e,
    p.refunds.map((r) =>
      stmt(`INSERT OR IGNORE INTO balance_entries (iss, sub, kind, stripe_key, amount, event_id, created_ms) SELECT c.iss, c.sub, 'refund', ?, ?, ?, ? ${PERSON}`, id("refund", r.id), -micros(r.amountMicros, 1), e.eventId, e.nowMs, c),
    ),
  );
}

/**
 * A dispute or an early fraud warning on a charge: the charge's net credit is reversed once, whichever
 * comes first (d3 T3, T4); a later signal adds a row with no amount. Either freezes the account.
 */
export async function recordReversal(db: Db, e: EventRef, p: { customerId: string; chargeId: string; paymentIntent: string; reason: "dispute" | "early fraud warning" }): Promise<Outcome> {
  const c = id("customer", p.customerId);
  const ch = id("charge", p.chargeId);
  const pi = id("paymentIntent", p.paymentIntent);
  if (p.reason !== "dispute" && p.reason !== "early fraud warning") throw new RangeError("a reversal is for a dispute or an early fraud warning");
  return run(scopedDb(db, LEDGER_TABLES), e, [
    // (before the reversal, so it sees only an earlier one)
    stmt(
      `INSERT OR IGNORE INTO balance_entries (iss, sub, kind, stripe_key, amount, event_id, created_ms) SELECT c.iss, c.sub, 'signal', ?, 0, ?, ? ${PERSON}
       AND EXISTS (SELECT 1 FROM balance_entries r WHERE r.kind = 'reversal' AND r.stripe_key = ? AND r.iss = c.iss AND r.sub = c.sub)`,
      e.eventId, e.eventId, e.nowMs, c, ch,
    ),
    stmt(
      `INSERT OR IGNORE INTO balance_entries (iss, sub, kind, stripe_key, amount, event_id, created_ms)
       SELECT c.iss, c.sub, 'reversal', ?, -COALESCE((SELECT t.amount FROM balance_entries t WHERE t.kind = 'topup' AND t.stripe_key = ? AND t.iss = c.iss AND t.sub = c.sub), 0), ?, ? ${PERSON}`,
      ch, pi, e.eventId, e.nowMs, c,
    ),
    stmt(
      `INSERT INTO account_freezes (iss, sub, frozen, reason, by_user, created_ms) SELECT c.iss, c.sub, 1, ?, NULL, ? ${PERSON}
       AND COALESCE((SELECT f.frozen FROM account_freezes f WHERE f.iss = c.iss AND f.sub = c.sub ORDER BY f.seq DESC LIMIT 1), 0) = 0`,
      p.reason, e.nowMs, c,
    ),
  ]);
}

/** charge.dispute.closed with status won: the reversal is restored once, exactly; the freeze stays (d3 T4). */
export async function recordDisputeWon(db: Db, e: EventRef, p: { customerId: string; chargeId: string }): Promise<Outcome> {
  const ch = id("charge", p.chargeId);
  return run(scopedDb(db, LEDGER_TABLES), e, [
    stmt(
      `INSERT OR IGNORE INTO balance_entries (iss, sub, kind, stripe_key, amount, event_id, created_ms)
       SELECT r.iss, r.sub, 'restore', ?, -r.amount, ?, ? FROM balance_entries r JOIN stripe_customers c ON c.iss = r.iss AND c.sub = r.sub
       WHERE c.customer_id = ? AND r.kind = 'reversal' AND r.stripe_key = ?`,
      ch, e.eventId, e.nowMs, id("customer", p.customerId), ch,
    ),
  ]);
}

/** The person's balance in micro-USD: the sum of their rows; negative after a dispute (T4). */
export async function balanceOf(db: Db, who: Who): Promise<number> {
  const r = await scopedDb(db, LEDGER_TABLES).all<{ b: number }>(`SELECT COALESCE(SUM(amount), 0) AS b FROM balance_entries WHERE iss = ? AND sub = ?`, [who.iss, who.sub]);
  return r[0]!.b;
}

export async function isFrozen(db: Db, who: Who): Promise<boolean> {
  const r = await scopedDb(db, LEDGER_TABLES).all<{ frozen: number }>(`SELECT frozen FROM account_freezes WHERE iss = ? AND sub = ? ORDER BY seq DESC LIMIT 1`, [who.iss, who.sub]);
  return r[0]?.frozen === 1;
}

// ---- the plan writer (d2 H1, d3.2 H2)

export type PlanStatus = "active" | "trialing" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "canceled" | "paused";
const STATUSES: readonly PlanStatus[] = ["active", "trialing", "past_due", "incomplete", "incomplete_expired", "unpaid", "canceled", "paused"];

export interface PlanState {
  readonly status: PlanStatus;
  readonly currentPeriodEndMs: number;
  readonly cancelAtPeriodEnd: boolean;
}

/** A hash of the compared fields only (Stripe has no updated-at): the plan's idempotency key. */
export async function planStateHash(s: PlanState): Promise<string> {
  const text = JSON.stringify([s.status, s.currentPeriodEndMs, s.cancelAtPeriodEnd]);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stripe's current state of a Subscription, as fetched after any of its events (or the daily re-fetch):
 * appended only if it differs from the latest row, so a replayed or late event adds nothing.
 */
export async function recordPlanState(
  db: Db,
  e: EventRef | null,
  p: { customerId: string; subscriptionId: string; fetchedMs: number } & PlanState,
): Promise<Outcome> {
  if (!STATUSES.includes(p.status)) throw new RangeError("not a Subscription status");
  micros(p.currentPeriodEndMs, 0);
  const sub = id("subscription", p.subscriptionId);
  const hash = await planStateHash(p);
  const plan = stmt(
    `INSERT INTO gpu_plans (iss, sub, subscription_id, status, current_period_end_ms, cancel_at_period_end, state_sha256, fetched_ms)
     SELECT c.iss, c.sub, ?, ?, ?, ?, ?, ? ${PERSON}
     AND (SELECT g.state_sha256 FROM gpu_plans g WHERE g.subscription_id = ? ORDER BY g.seq DESC LIMIT 1) IS NOT ?`,
    sub, p.status, p.currentPeriodEndMs, p.cancelAtPeriodEnd ? 1 : 0, hash, p.fetchedMs, id("customer", p.customerId), sub, hash,
  );
  const scoped = scopedDb(db, PLAN_TABLES);
  if (e === null) return (await scoped.batch([plan]))[0]!.changes > 0 ? "written" : "nothing";
  return run(scoped, e, [plan]);
}

/** The person's latest plan row (across their subscriptions), or null. */
export async function latestPlan(db: Db, who: Who): Promise<PlanState | null> {
  const r = await scopedDb(db, PLAN_TABLES).all<{ status: PlanStatus; current_period_end_ms: number; cancel_at_period_end: number }>(
    `SELECT status, current_period_end_ms, cancel_at_period_end FROM gpu_plans WHERE iss = ? AND sub = ? ORDER BY seq DESC LIMIT 1`,
    [who.iss, who.sub],
  );
  const x = r[0];
  return x === undefined ? null : { status: x.status, currentPeriodEndMs: x.current_period_end_ms, cancelAtPeriodEnd: x.cancel_at_period_end === 1 };
}

/**
 * Whether a plan permits a start now (d3.2 H2): active or trialing; past_due only until the period
 * ends (a grace period); with cancel_at_period_end, only before the period ends; nothing else.
 */
export function planPermitsStart(s: PlanState | null, nowMs: number): boolean {
  if (s === null) return false;
  const inPeriod = nowMs < s.currentPeriodEndMs;
  if (s.cancelAtPeriodEnd && !inPeriod) return false;
  if (s.status === "active" || s.status === "trialing") return true;
  if (s.status === "past_due") return inPeriod;
  return false;
}
