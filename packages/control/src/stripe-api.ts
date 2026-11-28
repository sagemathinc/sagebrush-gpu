// Stripe's API as the billing writers need it: read-only re-fetches of the objects a verified event names
// (design d3 T1, d3.2 H2: an event is a pointer, never the amount or the state). Nothing here writes to
// Stripe; Checkout and the plan's cancel come with their own PRs.
//
// - The key is a restricted key (rk_…), never the account's secret key (d2 B4), and its mode is the
//   deployment's: TEST takes rk_test_ only. Every answer's livemode must match too.
// - Ids are checked before they go into a path. Requests pin the API version (the shapes below are that
//   version's), never follow a redirect, have a deadline, and read at most 256 KiB of an answer.
// - Money is integer micro-USD (T5): Stripe's USD cents times 10,000. Any other currency is refused.
// - "unavailable" (Stripe couldn't be asked, or answered 5xx/429) is never reported as "invalid" (an answer
//   that isn't what we asked for, or a 4xx), nor the reverse: the webhook answers 5xx for the first, so
//   Stripe retries, and refuses the second.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface StripeConfig {
  /** A restricted key: rk_test_… for TEST, rk_live_… for LIVE. */
  readonly apiKey: string;
  /** This deployment's mode: false is TEST. */
  readonly livemode: boolean;
  /** Tests only: another API origin. */
  readonly api?: string;
  /**
   * Called when Stripe refuses our key (401 or 403): the key is revoked, rotated wrongly or lacks a scope.
   * The webhook wires it to an operator alert naming the key's mode and last four characters (never the key).
   * Retries alone won't fix this (SEC C1 on #119).
   */
  readonly keyRefused?: (status: 401 | 403, keyHint: string) => void;
}

/** The API version the shapes below are read in (a subscription's current_period_end is top-level here). */
export const STRIPE_VERSION = "2024-06-20";
const API = "https://api.stripe.com";
const DEADLINE_MS = 10_000;
export const ANSWER_MAX_BYTES = 256 * 1024;
const MICROS_PER_CENT = 10_000;

export class StripeError extends Error {
  readonly kind: "invalid" | "unavailable";
  constructor(kind: "invalid" | "unavailable", why: string) {
    super(why);
    this.kind = kind;
  }
}
const invalid = (why: string) => new StripeError("invalid", why);

const KEY = { test: /^rk_test_[A-Za-z0-9]{10,247}$/, live: /^rk_live_[A-Za-z0-9]{10,247}$/ };

/** Whether `c` is usable: a restricted key of the deployment's own mode. */
export function checkConfig(c: StripeConfig): string | null {
  if (typeof c.apiKey !== "string" || typeof c.livemode !== "boolean") return "the Stripe config is incomplete";
  if (!(c.livemode ? KEY.live : KEY.test).test(c.apiKey)) return `the Stripe key must be a restricted ${c.livemode ? "live" : "test"} key (rk_${c.livemode ? "live" : "test"}_…)`;
  return null;
}

const ID = {
  checkoutSession: /^cs_(test|live)_[A-Za-z0-9]{1,240}$/,
  charge: /^ch_[A-Za-z0-9]{1,252}$/,
  dispute: /^dp_[A-Za-z0-9]{1,252}$/,
  earlyFraudWarning: /^issfr_[A-Za-z0-9]{1,249}$/,
  subscription: /^sub_[A-Za-z0-9]{1,251}$/,
  paymentIntent: /^pi_[A-Za-z0-9]{1,252}$/,
  customer: /^cus_[A-Za-z0-9]{1,251}$/,
  refund: /^re_[A-Za-z0-9]{1,252}$/,
} as const;
type IdKind = keyof typeof ID;

function checkId(kind: IdKind, v: unknown): string {
  if (typeof v !== "string" || !ID[kind].test(v)) throw invalid(`not a Stripe ${kind} id`);
  return v;
}
/** An expandable field: the id, whether Stripe sent the id or the expanded object. */
function refId(kind: IdKind, v: unknown): string {
  return checkId(kind, typeof v === "object" && v !== null ? (v as Record<string, unknown>)["id"] : v);
}
function optRefId(kind: IdKind, v: unknown): string | null {
  return v === null || v === undefined ? null : refId(kind, v);
}
function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid(`${what} is not an object`);
  return v as Record<string, unknown>;
}
/**
 * A number in an answer whose source token isn't a plain integer in the safe range (a fraction, an exponent,
 * or past 2^53 - 1). JSON.parse would round it; the reviver below puts this in its place, so no money check
 * ever sees a rounded value (William's exact-money rule). Fields we don't read may hold one harmlessly.
 */
class Inexact {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}
// (no sign on zero: "-0" is not a plain integer token)
const INTEGER_TOKEN = /^(0|-?[1-9][0-9]{0,15})$/;
function exactNumbers(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value !== "number") return value;
  const src = context?.source;
  // (a runtime without the source text can't prove a number exact: fail closed)
  if (typeof src !== "string") throw invalid("this runtime can't read numbers exactly");
  if (!INTEGER_TOKEN.test(src)) return new Inexact(src);
  const b = BigInt(src);
  return b > BigInt(Number.MAX_SAFE_INTEGER) || b < -BigInt(Number.MAX_SAFE_INTEGER) ? new Inexact(src) : value;
}

/** JSON with every number either a safe integer as written or an Inexact (exported for its rows). */
export function parseExact(text: string): unknown {
  return JSON.parse(text, exactNumbers as (k: string, v: unknown) => unknown);
}
export function isInexact(v: unknown): boolean {
  return v instanceof Inexact;
}

function cents(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER / MICROS_PER_CENT) throw invalid(`${what} is not an amount`);
  return v * MICROS_PER_CENT;
}
function usd(o: Record<string, unknown>, what: string): void {
  if (o["currency"] !== "usd") throw invalid(`${what} isn't in USD`);
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw invalid(`${what} is not one we know`);
  return v as T;
}

async function boundedJson(r: Response): Promise<unknown> {
  const declared = r.headers.get("content-length");
  // (digits only, compared as BigInt: a malformed length is just not trusted, the streamed count decides)
  if (declared !== null && /^[0-9]{1,20}$/.test(declared) && BigInt(declared) > BigInt(ANSWER_MAX_BYTES)) throw new StripeError("unavailable", "the answer is too large");
  if (!r.body) throw invalid("no answer body");
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      // (the connection dropped or the deadline hit after the headers: Stripe may be asked again)
      throw new StripeError("unavailable", "the answer was cut off");
    }
    const { done, value } = chunk;
    if (done) break;
    n += value.byteLength;
    if (n > ANSWER_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new StripeError("unavailable", "the answer is too large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  try {
    return parseExact(new TextDecoder("utf-8", { fatal: true }).decode(all));
  } catch (e) {
    if (e instanceof StripeError) throw e;
    throw invalid("the answer is not JSON");
  }
}

export class StripeApi {
  readonly #c: StripeConfig;
  readonly #fetch: Fetch;

  constructor(c: StripeConfig, f: Fetch = (i, init) => fetch(i, init)) {
    const bad = checkConfig(c);
    if (bad !== null) throw new Error(bad);
    this.#c = c;
    this.#fetch = f;
  }

  /** GET a path (ids already checked) with expansions; the object, of `object` kind, in this deployment's mode. */
  async #get(path: string, object: string, expand: readonly string[] = []): Promise<Record<string, unknown>> {
    const q = expand.map((e) => `expand[]=${encodeURIComponent(e)}`).join("&");
    let r: Response;
    try {
      r = await this.#fetch(`${this.#c.api ?? API}${path}${q ? `?${q}` : ""}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.#c.apiKey}`, "stripe-version": STRIPE_VERSION },
        redirect: "manual",
        signal: AbortSignal.timeout(DEADLINE_MS),
      });
    } catch {
      throw new StripeError("unavailable", "Stripe couldn't be reached");
    }
    if (r.status === 429 || r.status >= 500) {
      await r.body?.cancel().catch(() => {});
      throw new StripeError("unavailable", `Stripe answered ${r.status}`);
    }
    // Our key refused: a fault on our side that a fix clears, so the event must be retried (5xx at the
    // webhook), never refused for good; and a human is told, since retries alone won't fix it (SEC C1).
    if (r.status === 401 || r.status === 403) {
      await r.body?.cancel().catch(() => {});
      try {
        this.#c.keyRefused?.(r.status, `${this.#c.livemode ? "live" : "test"} …${this.#c.apiKey.slice(-4)}`);
      } catch {
        // (an alert hook that fails must not turn a retry into a refusal)
      }
      throw new StripeError("unavailable", `Stripe refused our key (${r.status})`);
    }
    if (r.status !== 200) {
      await r.body?.cancel().catch(() => {});
      throw invalid(`Stripe answered ${r.status}`);
    }
    const o = obj(await boundedJson(r), "the answer");
    if (o["object"] !== object) throw invalid(`the answer is not a ${object}`);
    if (o["livemode"] !== this.#c.livemode) throw invalid("the answer's mode isn't this deployment's");
    return o;
  }

  /** A field that may be an expanded object: its mode checked when it is one, passed through otherwise. */
  #expanded(v: unknown, what: string): unknown {
    return typeof v === "object" && v !== null && !Array.isArray(v) ? this.#sameMode(v as Record<string, unknown>, what) : v;
  }

  /** An expanded object inside an answer: if it says which mode it's in, that's this deployment's too. */
  #sameMode(o: Record<string, unknown>, what: string): Record<string, unknown> {
    if ("livemode" in o && o["livemode"] !== this.#c.livemode) throw invalid(`${what}'s mode isn't this deployment's`);
    return o;
  }

  /**
   * A Checkout Session with its PaymentIntent's latest charge and balance transaction (T1). The fee is
   * null while the balance transaction is absent or still pending.
   */
  async checkoutSession(id: string): Promise<CheckoutFacts> {
    const s = await this.#get(`/v1/checkout/sessions/${checkId("checkoutSession", id)}`, "checkout.session", ["payment_intent.latest_charge.balance_transaction"]);
    const paymentStatus = oneOf(s["payment_status"], ["paid", "unpaid", "no_payment_required"] as const, "the payment status");
    const mode = oneOf(s["mode"], ["payment", "subscription", "setup"] as const, "the session's mode");
    const customer = optRefId("customer", s["customer"]);
    if (mode !== "payment") return { id, mode, paymentStatus, customer, payment: null };
    usd(s, "the session");
    const pi = s["payment_intent"];
    if (pi === null || pi === undefined) return { id, mode, paymentStatus, customer, payment: null };
    const p = this.#sameMode(obj(pi, "the PaymentIntent"), "the PaymentIntent");
    if (p["object"] !== "payment_intent") throw invalid("the PaymentIntent wasn't expanded");
    usd(p, "the PaymentIntent");
    const charge = p["latest_charge"] === null || p["latest_charge"] === undefined ? null : this.#sameMode(obj(p["latest_charge"], "the charge"), "the charge");
    return {
      id,
      mode,
      paymentStatus,
      customer,
      payment: {
        paymentIntent: checkId("paymentIntent", p["id"]),
        grossMicros: cents(p["amount_received"], "the amount received"),
        chargeId: charge === null ? null : checkId("charge", charge["id"]),
        feeMicros: charge === null ? null : fee(this.#expanded(charge["balance_transaction"], "the balance transaction")),
      },
    };
  }

  /**
   * A PaymentIntent with its latest charge and balance transaction: the scheduled re-fetch of a top-up whose
   * fee wasn't known at checkout (d3.2's second credit path; Codex audit G01 P2). The fee is null while the
   * balance transaction is absent or pending, as for a Checkout Session.
   */
  async paymentIntent(id: string): Promise<PaymentIntentFacts> {
    const p = await this.#get(`/v1/payment_intents/${checkId("paymentIntent", id)}`, "payment_intent", ["latest_charge.balance_transaction"]);
    usd(p, "the PaymentIntent");
    const status = oneOf(p["status"], ["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"] as const, "the PaymentIntent's status");
    const latest = p["latest_charge"];
    const charge = latest === null || latest === undefined ? null : this.#sameMode(obj(latest, "the charge"), "the charge");
    if (charge !== null && charge["object"] !== "charge") throw invalid("the charge wasn't expanded");
    return {
      id,
      status,
      customer: optRefId("customer", p["customer"]),
      grossMicros: cents(p["amount_received"], "the amount received"),
      chargeId: charge === null ? null : checkId("charge", charge["id"]),
      feeMicros: charge === null ? null : fee(this.#expanded(charge["balance_transaction"], "the balance transaction")),
    };
  }

  /** A charge with its balance transaction and every refund (T2: one debit per refund id). */
  async charge(id: string): Promise<ChargeFacts> {
    const c = await this.#get(`/v1/charges/${checkId("charge", id)}`, "charge", ["balance_transaction", "refunds"]);
    usd(c, "the charge");
    const list = this.#sameMode(obj(c["refunds"], "the refunds"), "the refunds");
    if (list["object"] !== "list" || !Array.isArray(list["data"])) throw invalid("the refunds are not a list");
    if (list["has_more"] !== false) throw invalid("the charge has more refunds than one page");
    return {
      id,
      customer: optRefId("customer", c["customer"]),
      paymentIntent: optRefId("paymentIntent", c["payment_intent"]),
      amountMicros: cents(c["amount"], "the charge's amount"),
      capturedMicros: cents(c["amount_captured"], "the charge's captured amount"),
      feeMicros: fee(this.#expanded(c["balance_transaction"], "the balance transaction")),
      refunds: list["data"].map((x) => {
        const r = this.#sameMode(obj(x, "a refund"), "a refund");
        usd(r, "a refund");
        return {
          id: checkId("refund", r["id"]),
          amountMicros: cents(r["amount"], "a refund's amount"),
          status: oneOf(r["status"], ["pending", "requires_action", "succeeded", "failed", "canceled"] as const, "a refund's status"),
        };
      }),
    };
  }

  async dispute(id: string): Promise<DisputeFacts> {
    const d = await this.#get(`/v1/disputes/${checkId("dispute", id)}`, "dispute");
    return {
      id,
      charge: refId("charge", d["charge"]),
      paymentIntent: optRefId("paymentIntent", d["payment_intent"]),
      status: oneOf(d["status"], ["warning_needs_response", "warning_under_review", "warning_closed", "needs_response", "under_review", "won", "lost"] as const, "the dispute's status"),
    };
  }

  async earlyFraudWarning(id: string): Promise<{ id: string; charge: string; paymentIntent: string | null }> {
    const w = await this.#get(`/v1/radar/early_fraud_warnings/${checkId("earlyFraudWarning", id)}`, "radar.early_fraud_warning");
    return { id, charge: refId("charge", w["charge"]), paymentIntent: optRefId("paymentIntent", w["payment_intent"]) };
  }

  /** A Subscription's current state (d3.2 H2: fetched on every event, the event's own state ignored). */
  async subscription(id: string): Promise<SubscriptionFacts> {
    const s = await this.#get(`/v1/subscriptions/${checkId("subscription", id)}`, "subscription");
    const end = s["current_period_end"];
    if (typeof end !== "number" || !Number.isSafeInteger(end) || end < 0 || end > 9_007_199_254_740) throw invalid("the period end is not a time");
    if (typeof s["cancel_at_period_end"] !== "boolean") throw invalid("cancel_at_period_end is not a boolean");
    return {
      id,
      customer: refId("customer", s["customer"]),
      status: oneOf(s["status"], ["active", "trialing", "past_due", "incomplete", "incomplete_expired", "unpaid", "canceled", "paused"] as const, "the subscription's status"),
      currentPeriodEndMs: end * 1000,
      cancelAtPeriodEnd: s["cancel_at_period_end"],
    };
  }
}

/** A balance transaction's fee, or null while it's absent or pending (T1: never guessed). */
function fee(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === "string") return null;
  const b = obj(v, "the balance transaction");
  if (b["object"] !== "balance_transaction") throw invalid("the balance transaction wasn't expanded");
  if (b["status"] === "pending") return null;
  if (b["status"] !== "available") throw invalid("the balance transaction's status is not one we know");
  usd(b, "the balance transaction");
  return cents(b["fee"], "the fee");
}

export interface CheckoutFacts {
  readonly id: string;
  readonly mode: "payment" | "subscription" | "setup";
  readonly paymentStatus: "paid" | "unpaid" | "no_payment_required";
  readonly customer: string | null;
  /** For a payment session with its PaymentIntent: what the ledger credits from. */
  readonly payment: { readonly paymentIntent: string; readonly grossMicros: number; readonly chargeId: string | null; readonly feeMicros: number | null } | null;
}
export interface PaymentIntentFacts {
  readonly id: string;
  readonly status: "requires_payment_method" | "requires_confirmation" | "requires_action" | "processing" | "requires_capture" | "canceled" | "succeeded";
  readonly customer: string | null;
  readonly grossMicros: number;
  readonly chargeId: string | null;
  readonly feeMicros: number | null;
}
export interface ChargeFacts {
  readonly id: string;
  readonly customer: string | null;
  readonly paymentIntent: string | null;
  readonly amountMicros: number;
  /** What was captured: less than the amount under a manual or partial capture. */
  readonly capturedMicros: number;
  readonly feeMicros: number | null;
  readonly refunds: ReadonlyArray<{ readonly id: string; readonly amountMicros: number; readonly status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled" }>;
}
export interface DisputeFacts {
  readonly id: string;
  readonly charge: string;
  readonly paymentIntent: string | null;
  readonly status: "warning_needs_response" | "warning_under_review" | "warning_closed" | "needs_response" | "under_review" | "won" | "lost";
}
export interface SubscriptionFacts {
  readonly id: string;
  readonly customer: string;
  readonly status: "active" | "trialing" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "canceled" | "paused";
  readonly currentPeriodEndMs: number;
  readonly cancelAtPeriodEnd: boolean;
}
