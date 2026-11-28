// Stripe webhook events, verified before anything else reads them (billing d1 §4, d2 B4, d3.2). Stripe signs
// each delivery: the Stripe-Signature header carries t=<unix seconds> and one or more v1=<hex HMAC-SHA256 of
// "<t>.<raw body>"> under the endpoint's signing secret. Only a delivery whose signature matches one of our
// secrets (the current one and, while rotating, the next), within five minutes of our clock, is parsed; and only
// an event in this deployment's mode (TEST refuses livemode=true, and later the reverse) is returned. Nothing of
// the body is read or logged before that, and the reason for a refusal never echoes it.
//
// Routing: payment events go to the ledger writer and subscription events to the plan writer (d2 H1), each from
// a closed list; anything else is acknowledged and ignored. The writers re-fetch what they act on from Stripe
// (d3 T1, d3.2 H2), so an event's payload is a pointer, never the amount or the state.

/** Stripe's own tolerance for the signed timestamp. */
export const TOLERANCE_SECONDS = 300;
/** A delivery larger than this is refused unread (Stripe's events are far smaller). */
export const MAX_BODY_BYTES = 512 * 1024;

export type Refusal = "header" | "stale" | "signature" | "size" | "body" | "livemode";

export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  /** unix seconds */
  readonly created: number;
  /** the event's object: read only for its id and type, never for amounts or states */
  readonly object: { readonly id: string; readonly object: string } & Record<string, unknown>;
}

export const LEDGER_EVENTS: readonly string[] = Object.freeze([
  "checkout.session.completed",
  "charge.updated",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "radar.early_fraud_warning.created",
]);
export const PLAN_EVENTS: readonly string[] = Object.freeze([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

export function routeEvent(type: string): "ledger" | "plan" | "ignore" {
  if (LEDGER_EVENTS.includes(type)) return "ledger";
  if (PLAN_EVENTS.includes(type)) return "plan";
  return "ignore";
}

const enc = new TextEncoder();

function parseHeader(h: string | null): { t: number; v1: string[] } | null {
  if (h == null || h.length > 4096) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of h.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) return null;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") {
      if (t != null || !/^[0-9]{1,12}$/.test(v)) return null;
      t = Number(v);
    } else if (k === "v1") {
      if (!/^[0-9a-f]{64}$/.test(v)) return null;
      v1.push(v);
    } // other schemes (v0) are ignored, as Stripe advises
  }
  return t == null || v1.length === 0 ? null : { t, v1 };
}

/** HMAC-SHA256 of "<t>." followed by the body's bytes exactly as received (never a decoded and re-encoded copy). */
async function hmacHex(secret: string, t: number, body: Uint8Array): Promise<string> {
  const prefix = enc.encode(`${t}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix, 0);
  signed.set(body, prefix.byteLength);
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hex strings compared in time independent of where they differ. Both are 64 hex digits here (parseHeader and
 * hmacHex), so the length check is defence only. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * The event, or why it was refused. `rawBody` is the delivery's bytes as received: the signature is checked
 * over exactly those, and only then are they decoded (UTF-8, strictly) and parsed. `secrets` are the
 * endpoint's signing secrets (whsec_…), the current one first; an empty list refuses everything. `livemode`
 * is this deployment's mode.
 */
export async function verifyStripeEvent(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  secrets: readonly string[],
  opts: { nowMs: number; livemode: boolean },
): Promise<{ ok: true; event: StripeEvent } | { ok: false; reason: Refusal }> {
  if (rawBody.byteLength > MAX_BODY_BYTES) return { ok: false, reason: "size" };
  const h = parseHeader(signatureHeader);
  if (h == null) return { ok: false, reason: "header" };
  if (Math.abs(Math.floor(opts.nowMs / 1000) - h.t) > TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  let matched = false;
  for (const s of secrets) {
    if (!/^whsec_[A-Za-z0-9]{8,}$/.test(s)) continue;
    const want = await hmacHex(s, h.t, rawBody);
    for (const v of h.v1) if (sameHex(v, want)) matched = true;
  }
  if (!matched) return { ok: false, reason: "signature" };
  let j: unknown;
  try {
    j = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return { ok: false, reason: "body" };
  }
  const e = j as Record<string, unknown> | null;
  const data = e?.["data"] as Record<string, unknown> | undefined;
  const obj = data?.["object"] as Record<string, unknown> | undefined;
  if (
    e == null || typeof e !== "object" || Array.isArray(e) ||
    e["object"] !== "event" ||
    typeof e["id"] !== "string" || !/^evt_[A-Za-z0-9]{1,250}$/.test(e["id"]) ||
    typeof e["type"] !== "string" || !/^[a-z_.]{1,100}$/.test(e["type"]) ||
    typeof e["livemode"] !== "boolean" ||
    typeof e["created"] !== "number" || !Number.isSafeInteger(e["created"]) || e["created"] < 0 ||
    obj == null || typeof obj !== "object" || Array.isArray(obj) ||
    typeof obj["id"] !== "string" || obj["id"] === "" || obj["id"].length > 255 ||
    typeof obj["object"] !== "string"
  ) {
    return { ok: false, reason: "body" };
  }
  if (e["livemode"] !== opts.livemode) return { ok: false, reason: "livemode" };
  return {
    ok: true,
    event: { id: e["id"], type: e["type"], livemode: e["livemode"], created: e["created"], object: obj as StripeEvent["object"] },
  };
}
