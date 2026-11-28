// The Stripe re-fetch client (stripe-api.ts) against a fake Stripe: the key and mode, what each request
// sends, what each answer must be, micro-USD, and "unavailable" kept apart from "invalid".
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_MAX_BYTES, STRIPE_VERSION, StripeApi, StripeError, checkConfig, isInexact, parseExact, type Fetch } from "./stripe-api.ts";

const KEY = "rk_test_abcdefghij0123";
const API = "https://stripe.example.test";
type Call = { url: string; init: RequestInit };

function fake(answer: (url: string) => Response | Promise<Response>): { f: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, f: async (url, init) => { calls.push({ url, init: init ?? {} }); return answer(url); } };
}
const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const stripe = (f: Fetch, livemode = false, apiKey = KEY) => new StripeApi({ apiKey, livemode, api: API }, f);
const kind = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof StripeError ? e.kind : `other: ${(e as Error).message}`; }
  return "resolved";
};

const bt = (o: Record<string, unknown> = {}) => ({ object: "balance_transaction", id: "txn_1", status: "available", currency: "usd", fee: 88, ...o });
const session = (o: Record<string, unknown> = {}, pi: Record<string, unknown> = {}, ch: Record<string, unknown> | null = {}) => ({
  object: "checkout.session", id: "cs_test_a1", livemode: false, mode: "payment", payment_status: "paid", currency: "usd", customer: "cus_A",
  payment_intent: { object: "payment_intent", id: "pi_1", currency: "usd", amount_received: 2000, latest_charge: ch === null ? null : { object: "charge", id: "ch_1", balance_transaction: bt(), ...ch }, ...pi },
  ...o,
});

test("B4: only a restricted key of the deployment's own mode", () => {
  assert.equal(checkConfig({ apiKey: KEY, livemode: false }), null);
  assert.match(checkConfig({ apiKey: "sk_test_abcdefghij0123", livemode: false })!, /restricted test key/, "never the secret key");
  assert.match(checkConfig({ apiKey: "rk_live_abcdefghij0123", livemode: false })!, /restricted test key/, "TEST takes no live key");
  assert.match(checkConfig({ apiKey: KEY, livemode: true })!, /restricted live key/, "LIVE takes no test key");
  assert.equal(checkConfig({ apiKey: "rk_live_abcdefghij0123", livemode: true }), null);
  assert.match(checkConfig({ apiKey: "rk_test_short", livemode: false })!, /restricted/);
  assert.throws(() => stripe(fake(() => ok({})).f, false, "sk_test_abcdefghij0123"), /restricted/);
});

test("a request: GET, the key as a bearer, the pinned version, no redirects, a deadline, the expansions", async () => {
  const { f, calls } = fake(() => ok(session()));
  await stripe(f).checkoutSession("cs_test_a1");
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.url, `${API}/v1/checkout/sessions/cs_test_a1?expand[]=payment_intent.latest_charge.balance_transaction`);
  assert.equal(c.init.method, "GET");
  assert.equal(c.init.redirect, "manual");
  assert.ok(c.init.signal instanceof AbortSignal);
  const h = c.init.headers as Record<string, string>;
  assert.equal(h["authorization"], `Bearer ${KEY}`);
  assert.equal(h["stripe-version"], STRIPE_VERSION);
  assert.equal(c.init.body, undefined);
});

test("ids are checked before they reach a path", async () => {
  const { f, calls } = fake(() => ok({}));
  for (const [m, id] of [["checkoutSession", "cs_test_../../v1/charges"], ["charge", "ch_1/refunds"], ["subscription", "sub_1?x=1"], ["dispute", "ch_1"], ["earlyFraudWarning", "issfr_"], ["charge", ""]] as const) {
    assert.equal(await kind((stripe(f) as unknown as Record<string, (id: string) => Promise<unknown>>)[m]!(id)), "invalid", `${m} ${id}`);
  }
  assert.equal(calls.length, 0);
});

test("T1: a paid session's net facts in micro-USD; a pending or absent balance transaction is a null fee", async () => {
  const s = await stripe(fake(() => ok(session())).f).checkoutSession("cs_test_a1");
  assert.deepEqual(s, { id: "cs_test_a1", mode: "payment", paymentStatus: "paid", customer: "cus_A", payment: { paymentIntent: "pi_1", grossMicros: 20_000_000, chargeId: "ch_1", feeMicros: 880_000 } });
  for (const ch of [{ balance_transaction: bt({ status: "pending" }) }, { balance_transaction: null }, { balance_transaction: "txn_1" }]) {
    assert.equal((await stripe(fake(() => ok(session({}, {}, ch))).f).checkoutSession("cs_test_a1")).payment!.feeMicros, null, JSON.stringify(ch).slice(0, 50));
  }
  const noCharge = await stripe(fake(() => ok(session({}, {}, null))).f).checkoutSession("cs_test_a1");
  assert.deepEqual(noCharge.payment, { paymentIntent: "pi_1", grossMicros: 20_000_000, chargeId: null, feeMicros: null });
  assert.equal((await stripe(fake(() => ok(session({ customer: { id: "cus_A", object: "customer" } }))).f).checkoutSession("cs_test_a1")).customer, "cus_A", "an expanded customer");
  assert.equal((await stripe(fake(() => ok(session({ mode: "subscription", payment_intent: null }))).f).checkoutSession("cs_test_a1")).payment, null);
  assert.equal((await stripe(fake(() => ok(session({ payment_status: "unpaid" }))).f).checkoutSession("cs_test_a1")).paymentStatus, "unpaid");
});

test("an answer that isn't what was asked for is invalid", async () => {
  for (const [what, a] of [
    ["another object", session({ object: "charge" })],
    ["live in TEST", session({ livemode: true })],
    ["no livemode", session({ livemode: undefined })],
    ["not USD", session({ currency: "eur" })],
    ["PI not USD", session({}, { currency: "eur" })],
    ["fee not USD", session({}, {}, { balance_transaction: bt({ currency: "eur" }) })],
    ["PI not expanded", session({ payment_intent: "pi_1" })],
    ["a fractional amount", session({}, { amount_received: 1.5 })],
    ["a negative amount", session({}, { amount_received: -1 })],
    ["a string amount", session({}, { amount_received: "2000" })],
    ["a huge amount", session({}, { amount_received: Number.MAX_SAFE_INTEGER })],
    ["an unknown status", session({ payment_status: "maybe" })],
    ["an unknown balance status", session({}, {}, { balance_transaction: bt({ status: "weird" }) })],
    ["a bad customer id", session({ customer: "user_1" })],
    ["a bad PI id", session({}, { id: "ch_1" })],
    ["an array", [session()]],
  ] as const) {
    assert.equal(await kind(stripe(fake(() => ok(a)).f).checkoutSession("cs_test_a1")), "invalid", what);
  }
  assert.equal(await kind(stripe(fake(() => new Response("not json", { status: 200 })).f).checkoutSession("cs_test_a1")), "invalid");
  assert.equal(await kind(stripe(fake(() => new Response(new Uint8Array([0xff, 0xfe]), { status: 200 })).f).checkoutSession("cs_test_a1")), "invalid", "not UTF-8");
  // LIVE refuses a test answer
  assert.equal(await kind(new StripeApi({ apiKey: "rk_live_abcdefghij0123", livemode: true, api: API }, fake(() => ok(session())).f).checkoutSession("cs_test_a1")), "invalid");
});

test("unavailable vs invalid: network, 5xx and 429 retry; 4xx and redirects don't", async () => {
  const s = (status: number) => fake(() => new Response("{}", { status, headers: status >= 300 && status < 400 ? { location: "https://evil.example/" } : {} })).f;
  assert.equal(await kind(stripe(fake(() => { throw new TypeError("network"); }).f).charge("ch_1")), "unavailable");
  for (const st of [500, 502, 503, 429]) assert.equal(await kind(stripe(s(st)).charge("ch_1")), "unavailable", String(st));
  for (const st of [400, 404, 301, 302, 307]) assert.equal(await kind(stripe(s(st)).charge("ch_1")), "invalid", String(st));
  // our key refused (SEC C1): a retry, never a refusal, and the operator is told which key, never the key itself
  for (const st of [401, 403] as const) {
    const told: Array<[number, string]> = [];
    const api = new StripeApi({ apiKey: KEY, livemode: false, api: API, keyRefused: (status, hint) => told.push([status, hint]) }, s(st));
    assert.equal(await kind(api.charge("ch_1")), "unavailable", String(st));
    assert.deepEqual(told, [[st, "test …0123"]], String(st));
    assert.ok(!told[0]![1].includes(KEY), "the hint never carries the key");
    // a hook that throws still gives a retry
    const loud = new StripeApi({ apiKey: KEY, livemode: false, api: API, keyRefused: () => { throw new Error("alert down"); } }, s(st));
    assert.equal(await kind(loud.charge("ch_1")), "unavailable", `${st}, alert hook failing`);
  }
});

test("an answer is read to at most 256 KiB, declared or streamed", async () => {
  const big = "x".repeat(ANSWER_MAX_BYTES + 1);
  assert.equal(await kind(stripe(fake(() => new Response(big, { status: 200, headers: { "content-length": String(big.length) } })).f).charge("ch_1")), "unavailable");
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)); if (pulled > 100) c.close(); } });
  assert.equal(await kind(stripe(fake(() => new Response(stream, { status: 200 })).f).charge("ch_1")), "unavailable");
  assert.ok(pulled <= 6, `stopped at the cap (${pulled} chunks)`);
  const exact = JSON.stringify({ ...charge(), pad: "" });
  const padded = JSON.stringify({ ...charge(), pad: "y".repeat(ANSWER_MAX_BYTES - exact.length) });
  assert.equal(padded.length, ANSWER_MAX_BYTES);
  assert.equal(await kind(stripe(fake(() => ok(JSON.parse(padded))).f).charge("ch_1")), "resolved", "exactly the cap");
});

const charge = (o: Record<string, unknown> = {}) => ({
  object: "charge", id: "ch_1", livemode: false, currency: "usd", amount: 5000, amount_captured: 5000, customer: "cus_A", payment_intent: "pi_1", balance_transaction: bt({ fee: 175 }),
  refunds: { object: "list", has_more: false, data: [
    { object: "refund", id: "re_1", currency: "usd", amount: 1000, status: "succeeded" },
    { object: "refund", id: "re_2", currency: "usd", amount: 500, status: "pending" },
  ] },
  ...o,
});

test("T2: a charge with every refund, each in micro-USD with its status", async () => {
  const { f, calls } = fake(() => ok(charge()));
  const c = await stripe(f).charge("ch_1");
  assert.equal(calls[0]!.url, `${API}/v1/charges/ch_1?expand[]=balance_transaction&expand[]=refunds`);
  assert.deepEqual(c, {
    id: "ch_1", customer: "cus_A", paymentIntent: "pi_1", amountMicros: 50_000_000, capturedMicros: 50_000_000, feeMicros: 1_750_000,
    refunds: [{ id: "re_1", amountMicros: 10_000_000, status: "succeeded" }, { id: "re_2", amountMicros: 5_000_000, status: "pending" }],
  });
  assert.equal(await kind(stripe(fake(() => ok(charge({ refunds: { object: "list", has_more: true, data: [] } }))).f).charge("ch_1")), "invalid", "a second page is never silently dropped");
  assert.equal(await kind(stripe(fake(() => ok(charge({ amount_captured: undefined }))).f).charge("ch_1")), "invalid", "the captured amount is required (SEC N2 on #124)");
  assert.equal((await stripe(fake(() => ok(charge({ amount_captured: 3000 }))).f).charge("ch_1")).capturedMicros, 30_000_000);
  assert.equal(await kind(stripe(fake(() => ok(charge({ refunds: "x" }))).f).charge("ch_1")), "invalid");
  assert.equal(await kind(stripe(fake(() => ok(charge({ refunds: { object: "list", has_more: false, data: [{ id: "ch_9", currency: "usd", amount: 1, status: "succeeded" }] } }))).f).charge("ch_1")), "invalid");
  assert.equal(await kind(stripe(fake(() => ok(charge({ refunds: { object: "list", has_more: false, data: [{ id: "re_9", currency: "usd", amount: 1, status: "done" }] } }))).f).charge("ch_1")), "invalid");
});

test("disputes and early fraud warnings: the charge they're about", async () => {
  const d = await stripe(fake(() => ok({ object: "dispute", id: "dp_1", livemode: false, charge: "ch_1", payment_intent: "pi_1", status: "won" })).f).dispute("dp_1");
  assert.deepEqual(d, { id: "dp_1", charge: "ch_1", paymentIntent: "pi_1", status: "won" });
  const { f, calls } = fake(() => ok({ object: "radar.early_fraud_warning", id: "issfr_1", livemode: false, charge: { id: "ch_2", object: "charge" }, payment_intent: null }));
  assert.deepEqual(await stripe(f).earlyFraudWarning("issfr_1"), { id: "issfr_1", charge: "ch_2", paymentIntent: null });
  assert.equal(calls[0]!.url, `${API}/v1/radar/early_fraud_warnings/issfr_1`);
  assert.equal(await kind(stripe(fake(() => ok({ object: "dispute", id: "dp_1", livemode: false, charge: null, status: "won" })).f).dispute("dp_1")), "invalid");
  assert.equal(await kind(stripe(fake(() => ok({ object: "dispute", id: "dp_1", livemode: false, charge: "ch_1", status: "settled" })).f).dispute("dp_1")), "invalid");
});

test("H2: a subscription's current state, the period end in ms", async () => {
  const sub = (o: Record<string, unknown> = {}) => ({ object: "subscription", id: "sub_1", livemode: false, customer: "cus_A", status: "past_due", current_period_end: 1_800_000_000, cancel_at_period_end: true, ...o });
  assert.deepEqual(await stripe(fake(() => ok(sub())).f).subscription("sub_1"), { id: "sub_1", customer: "cus_A", status: "past_due", currentPeriodEndMs: 1_800_000_000_000, cancelAtPeriodEnd: true });
  for (const [what, o] of [["no customer", { customer: null }], ["an unknown status", { status: "frozen" }], ["a string period end", { current_period_end: "1800000000" }], ["a fractional end", { current_period_end: 1.5 }], ["a non-boolean cancel", { cancel_at_period_end: 1 }], ["the period end in items only", { current_period_end: undefined }]] as const) {
    assert.equal(await kind(stripe(fake(() => ok(sub(o))).f).subscription("sub_1")), "invalid", what);
  }
});

test("sharper edges: only 200 is an answer; a declared length past the cap is refused unread; UTF-8 is strict; a PaymentIntent must be expanded", async () => {
  // a 2xx that isn't 200, with a body that would otherwise pass
  for (const st of [201, 202, 203]) {
    assert.equal(await kind(stripe(fake(() => new Response(JSON.stringify(charge()), { status: st })).f).charge("ch_1")), "invalid", String(st));
  }
  // a small, valid body whose declared length is over the cap
  const small = JSON.stringify(charge());
  assert.equal(await kind(stripe(fake(() => new Response(small, { status: 200, headers: { "content-length": String(ANSWER_MAX_BYTES + 1) } })).f).charge("ch_1")), "unavailable");
  // a malformed declared length is ignored: the streamed count decides
  assert.equal(await kind(stripe(fake(() => new Response(small, { status: 200, headers: { "content-length": "12abc" } })).f).charge("ch_1")), "resolved");
  // valid JSON carrying an invalid UTF-8 byte inside a string
  const bytes = new TextEncoder().encode(JSON.stringify({ ...charge(), pad: "XX" }));
  const at = bytes.indexOf(0x58);
  bytes[at] = 0xff;
  assert.equal(await kind(stripe(fake(() => new Response(bytes, { status: 200 })).f).charge("ch_1")), "invalid");
  // a PaymentIntent that is an object but not an expanded PaymentIntent
  assert.equal(await kind(stripe(fake(() => ok(session({ payment_intent: { id: "pi_1", currency: "usd", amount_received: 2000, latest_charge: null } }))).f).checkoutSession("cs_test_a1")), "invalid");
});

/** The charge answer as text, with one numeric token swapped in on the wire (never a rounded JS number). */
const wire = (from: string, to: string, base: string = JSON.stringify(charge())) => {
  assert.ok(base.includes(from), from);
  return new Response(base.replace(from, to), { status: 200 });
};

test("exact money on the wire: a money token that isn't a plain safe integer is refused, not rounded", async () => {
  for (const tok of ["1.0000000000000001", "5000.0", "50e2", "1e-400", "-1e-400", "900719925474.00001", "9007199254740993", "-0", "5000.5"]) {
    assert.equal(await kind(stripe(fake(() => wire('"amount":5000', `"amount":${tok}`)).f).charge("ch_1")), "invalid", `amount ${tok}`);
  }
  assert.equal(await kind(stripe(fake(() => wire('"fee":175', '"fee":175.00000000000001')).f).charge("ch_1")), "invalid", "a fee");
  assert.equal(await kind(stripe(fake(() => wire('"amount":1000', '"amount":1e3')).f).charge("ch_1")), "invalid", "a refund");
  const s = JSON.stringify(session());
  assert.equal(await kind(stripe(fake(() => wire('"amount_received":2000', '"amount_received":2000.0000000000001', s)).f).checkoutSession("cs_test_a1")), "invalid", "amount received");
  // a legitimate integer passes, and a fraction in a field we don't read is harmless
  assert.equal(await kind(stripe(fake(() => wire('"amount":5000', '"amount":5000')).f).charge("ch_1")), "resolved");
  assert.equal(await kind(stripe(fake(() => wire('"fee":175', '"fee":175,"exchange_rate":1.0825')).f).charge("ch_1")), "resolved");
  // the period end too
  const sub = JSON.stringify({ object: "subscription", id: "sub_1", livemode: false, customer: "cus_A", status: "active", current_period_end: 1800000000, cancel_at_period_end: false });
  assert.equal(await kind(stripe(fake(() => wire('"current_period_end":1800000000', '"current_period_end":1800000000.5', sub)).f).subscription("sub_1")), "invalid");
});

test("a body cut off after the headers is unavailable (a retry), not a raw error", async () => {
  const cut = (reason: unknown) => () => {
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (!sent) { sent = true; c.enqueue(new TextEncoder().encode('{"object":"charge",')); } else c.error(reason); } }), { status: 200 });
  };
  assert.equal(await kind(stripe(fake(cut(new TypeError("socket reset"))).f).charge("ch_1")), "unavailable", "a disconnect");
  assert.equal(await kind(stripe(fake(cut(new DOMException("The operation was aborted.", "AbortError"))).f).charge("ch_1")), "unavailable", "the deadline mid-body");
});

test("every expanded object that states a mode must be this deployment's (B4)", async () => {
  const live = { livemode: true };
  const c = charge();
  const cases: Array<[string, unknown, "charge" | "checkoutSession"]> = [
    ["the balance transaction", { ...c, balance_transaction: { ...bt(), ...live } }, "charge"],
    ["a refund", { ...c, refunds: { ...c.refunds, data: [{ ...c.refunds.data[0], ...live }] } }, "charge"],
    ["the refunds list", { ...c, refunds: { ...c.refunds, ...live } }, "charge"],
    ["the PaymentIntent", session({}, live), "checkoutSession"],
    ["the latest charge", session({}, {}, live), "checkoutSession"],
    ["the charge's balance transaction", session({}, {}, { balance_transaction: { ...bt(), ...live } }), "checkoutSession"],
  ];
  for (const [what, body, m] of cases) {
    const api = stripe(fake(() => ok(body)).f);
    assert.equal(await kind(m === "charge" ? api.charge("ch_1") : api.checkoutSession("cs_test_a1")), "invalid", what);
  }
  // the same objects in this mode pass
  assert.equal(await kind(stripe(fake(() => ok({ ...c, balance_transaction: { ...bt(), livemode: false } })).f).charge("ch_1")), "resolved");
});

test("parseExact: a number is kept only when its token is a plain integer in the safe range, whatever field it's in", () => {
  const n = (tok: string) => (parseExact(`{"n":${tok}}`) as { n: unknown }).n;
  for (const tok of ["0", "1", "-1", "9007199254740991", "-9007199254740991", "42"]) assert.equal(n(tok), Number(tok), tok);
  for (const tok of ["9007199254740992", "9007199254740993", "-9007199254740992", "99999999999999999", "1.5", "1.0", "1e3", "-0", "0.0", "1E2"]) assert.ok(isInexact(n(tok)), tok);
  assert.ok(isInexact((parseExact(`[{"a":{"b":[1.25]}}]`) as Array<{ a: { b: unknown[] } }>)[0]!.a.b[0]), "nested");
  assert.deepEqual(parseExact(`{"s":"1.5","t":true,"z":null}`), { s: "1.5", t: true, z: null }, "only numbers are touched");
});
