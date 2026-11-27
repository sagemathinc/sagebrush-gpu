import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MAX_BODY_BYTES, routeEvent, TOLERANCE_SECONDS, verifyStripeEvent } from "./stripe-webhook.ts";

const SECRET = "whsec_testsecret0123456789";
const NEXT = "whsec_nextsecret9876543210";
const NOW = 1_795_800_000_000;
const t = Math.floor(NOW / 1000);
const sign = (body: string, ts = t, secret = SECRET) => createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
const header = (body: string, ts = t, secret = SECRET) => `t=${ts},v1=${sign(body, ts, secret)}`;
const event = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ id: "evt_1Abc", object: "event", type: "checkout.session.completed", livemode: false, created: t, data: { object: { id: "cs_test_1", object: "checkout.session" } }, ...o });
const verify = (body: string, h: string | null, secrets = [SECRET], o: Partial<{ nowMs: number; livemode: boolean }> = {}) =>
  verifyStripeEvent(body, h, secrets, { nowMs: NOW, livemode: false, ...o });

test("a correctly signed TEST event in the window is accepted", async () => {
  const b = event();
  const r = await verify(b, header(b));
  assert.ok(r.ok);
  assert.equal(r.event.id, "evt_1Abc");
  assert.equal(r.event.object.id, "cs_test_1");
});

test("the signature: wrong secret, changed body, extra v0, rotation", async () => {
  const b = event();
  assert.deepEqual(await verify(b, header(b, t, "whsec_someoneelse00000")), { ok: false, reason: "signature" });
  assert.deepEqual(await verify(event({ id: "evt_2Zzz" }), header(b)), { ok: false, reason: "signature" });
  assert.ok((await verify(b, `t=${t},v0=${"0".repeat(64)},v1=${sign(b)}`)).ok, "v0 is ignored");
  assert.ok((await verify(b, `t=${t},v1=${"0".repeat(64)},v1=${sign(b)}`)).ok, "any v1 may match");
  assert.ok((await verify(b, header(b, t, NEXT), [SECRET, NEXT])).ok, "the next secret, while rotating");
  assert.deepEqual(await verify(b, header(b), []), { ok: false, reason: "signature" }, "no secrets refuse all");
  assert.deepEqual(await verify(b, header(b, t, "not-a-secret"), ["not-a-secret"]), { ok: false, reason: "signature" }, "a malformed secret is never used");
});

test("the timestamp window is five minutes either way", async () => {
  const b = event();
  assert.ok((await verify(b, header(b, t - TOLERANCE_SECONDS))).ok);
  assert.ok((await verify(b, header(b, t + TOLERANCE_SECONDS))).ok);
  assert.deepEqual(await verify(b, header(b, t - TOLERANCE_SECONDS - 1)), { ok: false, reason: "stale" });
  assert.deepEqual(await verify(b, header(b, t + TOLERANCE_SECONDS + 1)), { ok: false, reason: "stale" });
});

test("malformed headers are refused before any HMAC", async () => {
  const b = event();
  for (const h of [null, "", "v1=" + sign(b), `t=${t}`, `t=${t},v1=xyz`, `t=abc,v1=${sign(b)}`, `t=${t},t=${t},v1=${sign(b)}`, "x".repeat(5000)]) {
    assert.deepEqual(await verify(b, h), { ok: false, reason: "header" }, String(h).slice(0, 40));
  }
  const padded = `t=${t},v1=${sign(b)},v0=${"0".repeat(4096)}`;
  assert.deepEqual(await verify(b, padded), { ok: false, reason: "header" }, "a valid header padded past 4 KiB");
});

test("livemode must match the deployment: TEST refuses live, LIVE refuses test", async () => {
  const live = event({ livemode: true });
  assert.deepEqual(await verify(live, header(live)), { ok: false, reason: "livemode" });
  const test_ = event();
  assert.deepEqual(await verify(test_, header(test_), [SECRET], { livemode: true }), { ok: false, reason: "livemode" });
  assert.ok((await verify(live, header(live), [SECRET], { livemode: true })).ok);
});

test("a signed body that isn't an event is refused", async () => {
  for (const b of ["not json", "[]", JSON.stringify({ id: "evt_1" }), event({ object: "charge" }), event({ id: "ch_1" }), event({ livemode: "false" }),
    event({ created: -1 }), event({ data: { object: { object: "charge" } } }), event({ data: null }), event({ type: "Bad Type" })]) {
    assert.deepEqual(await verify(b, header(b)), { ok: false, reason: "body" }, b.slice(0, 60));
  }
});

test("an oversized delivery is refused unread", async () => {
  const b = "x".repeat(MAX_BODY_BYTES + 1);
  assert.deepEqual(await verify(b, header(b)), { ok: false, reason: "size" });
});

test("routing: payments to the ledger, subscriptions to plans, the rest ignored", () => {
  for (const e of ["checkout.session.completed", "charge.updated", "charge.refunded", "charge.dispute.created", "charge.dispute.closed", "radar.early_fraud_warning.created"]) {
    assert.equal(routeEvent(e), "ledger", e);
  }
  for (const e of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed"]) {
    assert.equal(routeEvent(e), "plan", e);
  }
  for (const e of ["invoice.paid", "customer.created", "payment_intent.succeeded", ""]) assert.equal(routeEvent(e), "ignore", e);
});
