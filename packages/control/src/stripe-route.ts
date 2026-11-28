// The Stripe webhook route (billing d4 §7 step 1): a delivery is verified (#116), the object it names is
// re-fetched from Stripe (#119), and the ledger or plan writer records what Stripe says now (#117). Nothing
// of an event's payload but its id, type and object id is ever read (d3 T1, d3.2 H2).
//
// - The body is counted before it is kept: a declared length over the cap is refused unread, and the
//   stream is cancelled at the first chunk past it. The signature is checked over those exact bytes.
// - What Stripe is told decides whether it retries (it retries any answer but 2xx for three days):
//   - 200: recorded, a replay, or nothing for us to do;
//   - 400: refused for good, a delivery that isn't Stripe's, or an answer from Stripe we won't act on;
//   - 503: try again, when Stripe couldn't be asked, refused our key, or we're not configured;
//   - 500: the write failed.
//   Every 400 after verification, every 500 and every unknown Customer alerts the operator.
// - Alerts are fixed lines, never a key, a secret, an id or an amount. The ones a retried event would
//   repeat (our key refused, the route unconfigured, deliveries refused) go out at most once per hour per
//   kind (SEC's note on #119), so a revoked key pages once, not once per event.
// - TEST mode only: livemode is fixed false here. LIVE comes with its own reviewed PR, after William has
//   seen TEST work.

import { errorBody, type ErrorCode } from "@sbgpu/api";
import { readCapped } from "./app.ts";
import type { Db } from "./db.ts";
import { json } from "./http.ts";
import { StripeApi, StripeError, type Fetch } from "./stripe-api.ts";
import {
  LEDGER_TABLES, creditCheckout, creditPending, recordDisputeWon, recordPlanState, recordRefunds, recordReversal, scopedDb, type EventRef, type Outcome,
} from "./stripe-ledger.ts";
import { MAX_BODY_BYTES, routeEvent, verifyStripeEvent, type StripeEvent } from "./stripe-webhook.ts";

export const STRIPE_WEBHOOK_PATH = "/v1/stripe/webhook";
/** This deployment's Stripe mode: TEST. */
export const STRIPE_LIVEMODE = false;
/** How often one kind of repeated alert may go out. */
export const ALERT_WINDOW_MS = 60 * 60 * 1000;

/**
 * At most one alert per key per window. It lives in the Worker's isolate, so a fleet of isolates may each
 * send one; that bounds a retry storm to a handful of lines an hour, not one per event. The keys are fixed
 * kinds (never a value from a request), and the map is bounded anyway.
 */
export class AlertThrottle {
  readonly #last = new Map<string, number>();
  readonly #windowMs: number;
  constructor(windowMs = ALERT_WINDOW_MS) {
    this.#windowMs = windowMs;
  }
  /** Whether an alert keyed `key` may go out at `nowMs` (and, if so, that it has). */
  allow(key: string, nowMs: number): boolean {
    const last = this.#last.get(key);
    if (last !== undefined && nowMs - last < this.#windowMs) return false;
    if (this.#last.size >= 64) this.#last.clear();
    this.#last.set(key, nowMs);
    return true;
  }
}

/** The re-fetches the route uses (StripeApi's, or a test's). */
export type StripeReader = Pick<StripeApi, "checkoutSession" | "charge" | "dispute" | "earlyFraudWarning" | "subscription">;

export interface StripeRouteDeps {
  readonly db: Db;
  now(): number;
  /** An operator alert: a fixed line. */
  alert(line: string): void;
  readonly throttle: AlertThrottle;
  /** The endpoint's signing secrets, the current one first (two while rotating). */
  readonly secrets: readonly string[];
  /** The re-fetch client, or why there is none. */
  readonly stripe: StripeReader | { readonly unusable: string };
}

/** The environment's Stripe settings: Worker secrets, never vars, never logged. */
export interface StripeEnv {
  /** A restricted TEST key, rk_test_…. */
  STRIPE_API_KEY?: unknown;
  /** The webhook's signing secrets, comma-separated: the current one, then (while rotating) the next. */
  STRIPE_WEBHOOK_SECRETS?: unknown;
}

/** The secrets and the client from the environment. The client's keyRefused alert is throttled. */
export function stripeFromEnv(
  env: StripeEnv,
  o: { now(): number; alert(line: string): void; throttle: AlertThrottle; fetch: Fetch },
): Pick<StripeRouteDeps, "secrets" | "stripe"> {
  const raw = env.STRIPE_WEBHOOK_SECRETS;
  const secrets = typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter((s) => s !== "") : [];
  const key = env.STRIPE_API_KEY;
  if (typeof key !== "string" || key === "") return { secrets, stripe: { unusable: "STRIPE_API_KEY is unset" } };
  try {
    const stripe = new StripeApi(
      {
        apiKey: key,
        livemode: STRIPE_LIVEMODE,
        // (the hint is the key's mode and last four characters, never the key)
        keyRefused: (status, hint) => {
          if (o.throttle.allow("stripe key refused", o.now())) o.alert(`stripe: Stripe refused our key (${status}, ${hint}); events are retried until it's fixed`);
        },
      },
      o.fetch,
    );
    return { secrets, stripe };
  } catch {
    return { secrets, stripe: { unusable: "STRIPE_API_KEY is not a restricted test key" } };
  }
}

const answer = (status: number, code: ErrorCode | null, message: string) =>
  code === null ? json(status, { received: true }) : json(status, errorBody(code, message));

/** What the route did with a verified event. */
export type Handled = Outcome | "ignored";

export async function handleStripeWebhook(req: Request, d: StripeRouteDeps): Promise<Response> {
  if (req.method !== "POST") {
    await req.body?.cancel().catch(() => {});
    return answer(404, "notFound", "no such endpoint");
  }
  const repeated = (key: string, line: string) => {
    if (d.throttle.allow(key, d.now())) d.alert(line);
  };
  if (d.secrets.length === 0 || "unusable" in d.stripe) {
    await req.body?.cancel().catch(() => {});
    repeated("stripe unconfigured", `stripe webhook: not configured (${d.secrets.length === 0 ? "STRIPE_WEBHOOK_SECRETS is unset" : (d.stripe as { unusable: string }).unusable}); events are retried`);
    return answer(503, "unavailable", "not configured");
  }
  const stripe = d.stripe;
  const declared = req.headers.get("content-length");
  if (declared !== null && /^[0-9]{1,20}$/.test(declared) && BigInt(declared) > BigInt(MAX_BODY_BYTES)) {
    await req.body?.cancel().catch(() => {});
    return answer(400, "badRequest", "too large");
  }
  let body: Uint8Array | null;
  try {
    body = await readCapped(req.body, MAX_BODY_BYTES);
  } catch {
    // (the connection dropped mid-body: nothing was verified, so nothing is refused for good)
    return answer(503, "unavailable", "the body was cut off");
  }
  if (body === null) return answer(400, "badRequest", "too large");
  const v = await verifyStripeEvent(body, req.headers.get("stripe-signature"), d.secrets, { nowMs: d.now(), livemode: STRIPE_LIVEMODE });
  if (!v.ok) {
    // (anyone can post here, so this is one line an hour per reason: a wrong secret or clock shows, spam doesn't page)
    repeated(`stripe refused ${v.reason}`, `stripe webhook: deliveries refused (${v.reason})`);
    return answer(400, "badRequest", "refused");
  }
  const e = v.event;
  try {
    await handleEvent(e, stripe, d);
    return answer(200, null, "");
  } catch (x) {
    if (x instanceof StripeError && x.kind === "unavailable") return answer(503, "unavailable", "try again");
    if (x instanceof StripeError || x instanceof RangeError) {
      // (both carry only our own fixed wording: never a value from Stripe)
      d.alert(`stripe webhook: ${e.type} refused: ${x.message}`);
      return answer(400, "badRequest", "refused");
    }
    d.alert(`stripe webhook: ${e.type}: the write failed (${x instanceof Error ? x.name : typeof x}); Stripe retries`);
    return answer(500, "internal", "the write failed");
  }
}

/** The object kind each routed event names. */
const OBJECT_OF: Readonly<Record<string, string>> = {
  "checkout.session.completed": "checkout.session",
  "charge.updated": "charge",
  "charge.refunded": "charge",
  "charge.dispute.created": "dispute",
  "charge.dispute.closed": "dispute",
  "radar.early_fraud_warning.created": "radar.early_fraud_warning",
};

/** One verified event, acted on from Stripe's current state. Exported for its rows. */
export async function handleEvent(e: StripeEvent, stripe: StripeReader, d: Pick<StripeRouteDeps, "db" | "now" | "alert">): Promise<Handled> {
  const route = routeEvent(e.type);
  if (route === "ignore") return "ignored";
  const ref: EventRef = { eventId: e.id, type: e.type, nowMs: d.now() };
  const expected = route === "plan" ? "subscription" : OBJECT_OF[e.type];
  if (e.object.object !== expected) throw new StripeError("invalid", "the event names another kind of object");
  const known = (customer: string) => warnUnknown(d, e, customer);

  if (route === "plan") {
    // (the fetch fence compares send times: taken before the request goes out)
    const fetchedMs = d.now();
    const s = await stripe.subscription(e.object.id);
    await known(s.customer);
    return recordPlanState(d.db, ref, {
      customerId: s.customer,
      subscriptionId: s.id,
      fetchedMs,
      status: s.status,
      currentPeriodEndMs: s.currentPeriodEndMs,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    });
  }

  switch (e.type) {
    case "checkout.session.completed": {
      const s = await stripe.checkoutSession(e.object.id);
      // (a subscription's Checkout is the plan writer's, through its own events; unpaid credits nothing, B3)
      if (s.mode !== "payment" || s.paymentStatus !== "paid") return "ignored";
      if (s.payment === null) throw new StripeError("invalid", "a paid session without its PaymentIntent");
      if (s.customer === null) {
        d.alert("stripe webhook: a paid checkout without a Customer; nothing credited");
        return "ignored";
      }
      await known(s.customer);
      return creditCheckout(d.db, ref, {
        customerId: s.customer,
        paymentIntent: s.payment.paymentIntent,
        chargeId: s.payment.chargeId,
        grossMicros: s.payment.grossMicros,
        feeMicros: s.payment.feeMicros,
      });
    }
    case "charge.updated": {
      // The second credit path (d3.2): only a PaymentIntent holding a pending marker is credited, by the writer.
      const c = await stripe.charge(e.object.id);
      if (c.customer === null || c.paymentIntent === null || c.feeMicros === null) return "ignored";
      return creditPending(d.db, ref, { customerId: c.customer, paymentIntent: c.paymentIntent, chargeId: c.id, grossMicros: c.amountMicros, feeMicros: c.feeMicros, via: "charge" });
    }
    case "charge.refunded": {
      const c = await stripe.charge(e.object.id);
      if (c.customer === null) {
        d.alert("stripe webhook: a refund on a charge without a Customer; nothing debited");
        return "ignored";
      }
      await known(c.customer);
      // A refund that failed or was cancelled returned nothing, so it isn't debited; a pending one is, as
      // money on its way out. If one of those fails later, a human puts it right (alerted here when seen).
      const out = c.refunds.filter((r) => r.status !== "failed" && r.status !== "canceled");
      if (out.length < c.refunds.length) d.alert("stripe webhook: a charge has a failed or cancelled refund; check its debits");
      return recordRefunds(d.db, ref, { customerId: c.customer, refunds: out.map((r) => ({ id: r.id, amountMicros: r.amountMicros })) });
    }
    case "charge.dispute.created":
    case "charge.dispute.closed": {
      const dp = await stripe.dispute(e.object.id);
      if (e.type === "charge.dispute.closed" && dp.status === "won") {
        const c = await stripe.charge(dp.charge);
        if (c.customer === null) return noCustomer(d, e);
        await known(c.customer);
        return recordDisputeWon(d.db, ref, { customerId: c.customer, chargeId: c.id });
      }
      // (an inquiry closed without a dispute, warning_closed, restores nothing here: the freeze and any
      // reversal are a human's to lift; a lost one, or a created one, reverses once)
      if (e.type === "charge.dispute.closed" && dp.status === "warning_closed") {
        d.alert("stripe webhook: an inquiry closed; its reversal and freeze stay for a human");
        return "ignored";
      }
      return reverse(d, e, ref, stripe, dp.charge, dp.paymentIntent, "dispute");
    }
    case "radar.early_fraud_warning.created": {
      const w = await stripe.earlyFraudWarning(e.object.id);
      return reverse(d, e, ref, stripe, w.charge, w.paymentIntent, "early fraud warning");
    }
    default:
      return "ignored";
  }
}

/** An alert when control doesn't know the Customer (the writers then write nothing for it, by their SQL). */
async function warnUnknown(d: Pick<StripeRouteDeps, "db" | "alert">, e: StripeEvent, customer: string): Promise<void> {
  const r = await scopedDb(d.db, LEDGER_TABLES).all(`SELECT 1 FROM stripe_customers WHERE customer_id = ?`, [customer]);
  if (r.length === 0) d.alert(`stripe webhook: ${e.type} names a Customer we don't know; nothing written`);
}

function noCustomer(d: Pick<StripeRouteDeps, "alert">, e: StripeEvent): Handled {
  d.alert(`stripe webhook: ${e.type} on a charge without a Customer; nothing written`);
  return "ignored";
}

/** A dispute's or warning's reversal: the charge's net, from the re-fetched charge (d3 T3, T4). */
async function reverse(
  d: Pick<StripeRouteDeps, "db" | "alert">,
  e: StripeEvent,
  ref: EventRef,
  stripe: StripeReader,
  chargeId: string,
  paymentIntent: string | null,
  reason: "dispute" | "early fraud warning",
): Promise<Handled> {
  const c = await stripe.charge(chargeId);
  if (c.customer === null) return noCustomer(d, e);
  const pi = c.paymentIntent ?? paymentIntent;
  if (pi === null) throw new StripeError("invalid", "the charge has no PaymentIntent");
  // (as for a top-up: while the fee isn't known, Stripe retries rather than a guess being reversed)
  if (c.feeMicros === null) throw new StripeError("unavailable", "the charge's fee isn't known yet");
  if (c.feeMicros >= c.amountMicros) throw new StripeError("invalid", "the charge's fee is not less than its amount");
  await warnUnknown(d, e, c.customer);
  return recordReversal(d.db, ref, { customerId: c.customer, chargeId: c.id, paymentIntent: pi, netMicros: c.amountMicros - c.feeMicros, reason });
}
