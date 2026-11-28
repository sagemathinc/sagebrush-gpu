// The scheduled re-fetch of pending top-ups (d3.2's second credit path; Codex audit G01 P2). A Checkout paid
// while Stripe's fee wasn't known yet leaves a pending marker and no credit (d3 T1: never gross, never a
// guess). charge.updated usually brings the fee, but if that event is lost, or arrived first, the marker
// would stay forever and the person's paid money would never be credited. So every run re-fetches the
// newest open markers' PaymentIntents and credits the net once the fee is known.
//
// - Once: creditPending's own rows (one topup per PaymentIntent, needing its marker) keep it exactly-once,
//   whichever of charge.updated and this job comes first; a re-run adds nothing.
// - Only Stripe's facts: the amount, charge and fee come from the re-fetched PaymentIntent, and it must still
//   be the marker's person's Customer and succeeded; anything else credits nothing and alerts.
// - Bounded: at most RECONCILE_BATCH markers a run, newest first (a stuck one can't hold the others back),
//   none older than RECONCILE_WINDOW_MS. Stripe unavailable stops the run; the next run tries again.
// - Loud: a marker still open after STUCK_MS, or one past the window, alerts (throttled by the caller).

import type { Db } from "./db.ts";
import { StripeError, type PaymentIntentFacts } from "./stripe-api.ts";
import { LEDGER_TABLES, creditPending, scopedDb } from "./stripe-ledger.ts";

export const RECONCILE_BATCH = 20;
export const STUCK_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReconcileDeps {
  readonly db: Db;
  readonly nowMs: number;
  readonly stripe: { paymentIntent(id: string): Promise<PaymentIntentFacts> };
  /** A repeated alert: the caller throttles it by `key`. */
  alert(key: string, line: string): void;
}

/** The open markers to look at, newest first: a pending marker with no topup for its PaymentIntent. */
export const OPEN_MARKERS = `SELECT m.stripe_key, m.created_ms, c.customer_id FROM balance_entries m
  JOIN stripe_customers c ON c.iss = m.iss AND c.sub = m.sub
  WHERE m.kind = 'pending' AND m.created_ms >= ?
    AND NOT EXISTS (SELECT 1 FROM balance_entries t WHERE t.kind = 'topup' AND t.stripe_key = m.stripe_key)
  ORDER BY m.created_ms DESC, m.seq DESC LIMIT ?`;

/** One run: how many top-ups it credited. */
export async function reconcilePendingTopups(d: ReconcileDeps): Promise<number> {
  const l = scopedDb(d.db, LEDGER_TABLES);
  const rows = await l.all<{ stripe_key: string; created_ms: number; customer_id: string }>(OPEN_MARKERS, [d.nowMs - RECONCILE_WINDOW_MS, RECONCILE_BATCH]);
  const expired = await l.all<{ k: number }>(
    `SELECT COUNT(*) AS k FROM balance_entries m WHERE m.kind = 'pending' AND m.created_ms < ?
     AND NOT EXISTS (SELECT 1 FROM balance_entries t WHERE t.kind = 'topup' AND t.stripe_key = m.stripe_key)`,
    [d.nowMs - RECONCILE_WINDOW_MS],
  );
  if (expired[0]!.k > 0) d.alert("stripe pending expired", `stripe reconcile: ${expired[0]!.k} paid top-up(s) still uncredited after 7 days; a human must settle them`);
  let credited = 0;
  let stuck = 0;
  for (const r of rows) {
    let p: PaymentIntentFacts;
    try {
      p = await d.stripe.paymentIntent(r.stripe_key);
    } catch (e) {
      // (Stripe down or our key refused: stop, and the next run tries again; anything else is this one's)
      if (e instanceof StripeError && e.kind === "unavailable") break;
      d.alert("stripe pending refused", `stripe reconcile: a pending top-up's PaymentIntent was refused (${e instanceof StripeError ? e.message : "an error"})`);
      continue;
    }
    if (p.customer !== r.customer_id) {
      d.alert("stripe pending customer", "stripe reconcile: a pending top-up's PaymentIntent names another Customer; nothing credited");
      continue;
    }
    if (p.status !== "succeeded" || p.chargeId === null || p.feeMicros === null) {
      if (d.nowMs - r.created_ms >= STUCK_MS) stuck++;
      continue;
    }
    let o;
    try {
      o = await creditPending(d.db, { eventId: null, nowMs: d.nowMs }, {
        customerId: r.customer_id, paymentIntent: p.id, chargeId: p.chargeId, grossMicros: p.grossMicros, feeMicros: p.feeMicros, via: "refetch",
      });
    } catch (e) {
      // (Stripe's figures that can't be credited, such as a fee not less than the amount, are this marker's
      // alone, refused with our own wording, and the rest go on (TESTS H1 on #128); a database failure
      // still fails the run)
      if (!(e instanceof RangeError)) throw e;
      d.alert("stripe pending refused", `stripe reconcile: a pending top-up's figures can't be credited (${e.message})`);
      continue;
    }
    if (o === "written") credited++;
  }
  if (stuck > 0) d.alert("stripe pending stuck", `stripe reconcile: ${stuck} paid top-up(s) still have no fee after a day`);
  return credited;
}
