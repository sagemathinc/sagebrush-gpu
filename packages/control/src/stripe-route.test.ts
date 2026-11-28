// The Stripe webhook route (stripe-route.ts): what Stripe is answered (retry or not), that only Stripe's
// re-fetched state is written, the alerts and their throttle, and the Worker's wiring of the path.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import { balanceOf, isFrozen, latestPlan, recordCustomer, type Who } from "./stripe-ledger.ts";
import { StripeError, type ChargeFacts, type CheckoutFacts, type DisputeFacts, type SubscriptionFacts } from "./stripe-api.ts";
import { ALERT_WINDOW_MS, AlertThrottle, STRIPE_WEBHOOK_PATH, handleStripeWebhook, stripeFromEnv, type StripeReader, type StripeRouteDeps } from "./stripe-route.ts";
import { MAX_BODY_BYTES } from "./stripe-webhook.ts";
import { createWorker } from "./worker.ts";

const SECRET = "whsec_routesecret0123456789";
const NOW = 1_800_000_000_000;
const ISS = "https://api.workos.com/user_management/client_test";
const A: Who = { iss: ISS, sub: "user_A" };
const URL_ = `https://gpu.example.com${STRIPE_WEBHOOK_PATH}`;

let db: TestDb;
let alerts: string[];
let clock: number;
let n = 0;

function person(w: Who, i: number) {
  db.raw.prepare(`INSERT INTO users (id, email, name, created_ms) VALUES (?, ?, NULL, ?)`).run(`usr_${i}`, `p${i}@example.com`, NOW);
  db.raw.prepare(`INSERT INTO identities (iss, sub, user_id, email, email_ticket, created_ms) VALUES (?, ?, ?, NULL, 0, ?)`).run(w.iss, w.sub, `usr_${i}`, NOW);
}

beforeEach(async () => {
  db = sqliteDb();
  alerts = [];
  clock = NOW;
  person(A, 1);
  await recordCustomer(db, A, "cus_A", NOW);
});

// ---- Stripe, as the route sees it: the facts each re-fetch returns (or the error it throws)

type Facts = {
  checkout?: Partial<CheckoutFacts> | Error;
  charges?: Record<string, Partial<ChargeFacts> | Error>;
  dispute?: Partial<DisputeFacts>;
  efw?: { charge: string; paymentIntent: string | null };
  subscription?: Partial<SubscriptionFacts>;
};
const CHARGE: ChargeFacts = { id: "ch_1", customer: "cus_A", paymentIntent: "pi_1", amountMicros: 20_000_000, capturedMicros: 20_000_000, feeMicros: 880_000, refunds: [] };
function reader(f: Facts, calls: string[] = []): StripeReader {
  const or = <T>(v: T | Error | undefined, what: string): T => {
    if (v === undefined) throw new Error(`unexpected fetch: ${what}`);
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    async checkoutSession(id) {
      calls.push(`checkout ${id}`);
      const c = or(f.checkout, "checkout");
      return { id, mode: "payment", paymentStatus: "paid", customer: "cus_A", payment: { paymentIntent: "pi_1", grossMicros: 20_000_000, chargeId: "ch_1", feeMicros: 880_000 }, ...c };
    },
    async charge(id) {
      calls.push(`charge ${id}`);
      return { ...CHARGE, id, ...or(f.charges?.[id], `charge ${id}`) };
    },
    async dispute(id) {
      calls.push(`dispute ${id}`);
      return { id, charge: "ch_1", paymentIntent: "pi_1", status: "needs_response", ...or(f.dispute, "dispute") };
    },
    async earlyFraudWarning(id) {
      calls.push(`efw ${id}`);
      return { id, ...or(f.efw, "efw") };
    },
    async subscription(id) {
      calls.push(`subscription ${id}`);
      return { id, customer: "cus_A", status: "active", currentPeriodEndMs: NOW + 30 * 86_400_000, cancelAtPeriodEnd: false, ...or(f.subscription, "subscription") };
    },
  };
}

function deps(stripe: StripeRouteDeps["stripe"], o: Partial<StripeRouteDeps> = {}): StripeRouteDeps {
  return { db, now: () => clock, alert: (l) => alerts.push(l), throttle: new AlertThrottle(), secrets: [SECRET], stripe, ...o };
}

const OBJECT: Record<string, [string, string]> = {
  "checkout.session.completed": ["cs_test_1", "checkout.session"],
  "charge.updated": ["ch_1", "charge"],
  "charge.refunded": ["ch_1", "charge"],
  "charge.dispute.created": ["dp_1", "dispute"],
  "charge.dispute.closed": ["dp_1", "dispute"],
  "radar.early_fraud_warning.created": ["issfr_1", "radar.early_fraud_warning"],
  "customer.subscription.updated": ["sub_1", "subscription"],
  "customer.subscription.deleted": ["sub_1", "subscription"],
  "invoice.paid": ["in_1", "invoice"],
};
function eventBody(type: string, o: { id?: string; object?: [string, string] } = {}): string {
  const [id, object] = o.object ?? OBJECT[type]!;
  // (a payload that says otherwise than Stripe's state: never read)
  return JSON.stringify({ id: o.id ?? `evt_${++n}r`, object: "event", type, livemode: false, created: Math.floor(clock / 1000), data: { object: { id, object, amount: 999_999_999, status: "succeeded" } } });
}
function signed(body: string | Uint8Array, o: { secret?: string; headers?: Record<string, string>; method?: string } = {}): Request {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const t = Math.floor(clock / 1000);
  const mac = createHmac("sha256", o.secret ?? SECRET).update(Buffer.concat([Buffer.from(`${t}.`), bytes])).digest("hex");
  return new Request(URL_, { method: o.method ?? "POST", body: o.method === "GET" ? null : bytes, headers: { "stripe-signature": `t=${t},v1=${mac}`, "content-type": "application/json", ...o.headers } });
}
const post = (d: StripeRouteDeps, type: string, o: Parameters<typeof eventBody>[1] = {}) => handleStripeWebhook(signed(eventBody(type, o)), d);
const count = (sql: string) => (db.raw.prepare(sql).get() as { k: number }).k;

// ---- answers before any event is read

test("only POST; unconfigured is 503 (retried), with one alert an hour", async () => {
  assert.equal((await handleStripeWebhook(new Request(URL_), deps(reader({})))).status, 404);
  const throttle = new AlertThrottle();
  for (const d of [deps(reader({}), { secrets: [], throttle }), deps({ unusable: "STRIPE_API_KEY is unset" }, { throttle })]) {
    const r = await post(d, "checkout.session.completed");
    assert.equal(r.status, 503);
  }
  assert.deepEqual(alerts, ["stripe webhook: not configured (STRIPE_WEBHOOK_SECRETS is unset); events are retried"], "one line for the kind, in the window");
  clock += ALERT_WINDOW_MS;
  await post(deps({ unusable: "STRIPE_API_KEY is unset" }, { throttle }), "checkout.session.completed");
  assert.equal(alerts.length, 2, "again after the window");
  assert.match(alerts[1]!, /STRIPE_API_KEY is unset/);
  assert.equal(count(`SELECT COUNT(*) AS k FROM stripe_events`), 0);
});

test("the body: a declared length over the cap is refused unread; a streamed one is cut at the cap", async () => {
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const declared = new Request(URL_, { method: "POST", body: endless, headers: { "content-length": String(MAX_BODY_BYTES + 1) }, duplex: "half" } as RequestInit);
  assert.equal((await handleStripeWebhook(declared, deps(reader({})))).status, 400);
  assert.ok(pulled <= 1, "nothing read past what the stream had ready");
  pulled = 0;
  const streamed = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const r = await handleStripeWebhook(new Request(URL_, { method: "POST", body: streamed, duplex: "half" } as RequestInit), deps(reader({})));
  assert.equal(r.status, 400);
  assert.ok(pulled <= MAX_BODY_BYTES / (64 * 1024) + 2, `stopped at the cap (${pulled} chunks)`);
});

test("a delivery that isn't Stripe's is 400, nothing fetched or written; refusals alert once an hour per reason", async () => {
  const calls: string[] = [];
  const d = deps(reader({ checkout: {} }, calls));
  const b = eventBody("checkout.session.completed");
  for (let i = 0; i < 3; i++) assert.equal((await handleStripeWebhook(signed(b, { secret: "whsec_someoneelse0000000" }), d)).status, 400);
  assert.equal((await handleStripeWebhook(new Request(URL_, { method: "POST", body: b }), d)).status, 400, "no signature header");
  assert.deepEqual(calls, []);
  assert.equal(count(`SELECT COUNT(*) AS k FROM stripe_events`), 0);
  assert.deepEqual(alerts, ["stripe webhook: deliveries refused (signature)", "stripe webhook: deliveries refused (header)"]);
});

// ---- the ledger events

test("checkout: Stripe's net is credited once, whatever the payload says; a replay is 200 and adds nothing", async () => {
  const calls: string[] = [];
  const d = deps(reader({ checkout: {} }, calls));
  const body = eventBody("checkout.session.completed");
  assert.equal((await handleStripeWebhook(signed(body), d)).status, 200);
  assert.equal(await balanceOf(db, A), 19_120_000);
  assert.equal((await handleStripeWebhook(signed(body), d)).status, 200, "the same event again");
  assert.equal((await post(d, "checkout.session.completed")).status, 200, "another event for the same PaymentIntent");
  assert.equal(await balanceOf(db, A), 19_120_000);
  assert.deepEqual(calls, ["checkout cs_test_1", "checkout cs_test_1", "checkout cs_test_1"], "re-fetched every time, by the event's object id");
  assert.deepEqual(alerts, []);
});

test("checkout: unpaid or not a payment credits nothing; the fee unknown writes the marker, then charge.updated credits once", async () => {
  for (const c of [{ paymentStatus: "unpaid" as const }, { mode: "subscription" as const, payment: null }]) {
    assert.equal((await post(deps(reader({ checkout: c })), "checkout.session.completed")).status, 200);
  }
  assert.equal(count(`SELECT COUNT(*) AS k FROM balance_entries`), 0);
  const pending = { payment: { paymentIntent: "pi_1", grossMicros: 20_000_000, chargeId: null, feeMicros: null } };
  assert.equal((await post(deps(reader({ checkout: pending })), "checkout.session.completed")).status, 200);
  assert.equal(await balanceOf(db, A), 0, "never gross, never a guess");
  assert.equal(count(`SELECT COUNT(*) AS k FROM balance_entries WHERE kind = 'pending'`), 1);
  // charge.updated without the fee yet: nothing
  assert.equal((await post(deps(reader({ charges: { ch_1: { feeMicros: null } } })), "charge.updated")).status, 200);
  assert.equal(await balanceOf(db, A), 0);
  const withFee = deps(reader({ charges: { ch_1: {} } }));
  assert.equal((await post(withFee, "charge.updated")).status, 200);
  assert.equal((await post(withFee, "charge.updated")).status, 200);
  assert.equal(await balanceOf(db, A), 19_120_000, "credited once");
  // a charge.updated with no marker: nothing
  assert.equal((await post(deps(reader({ charges: { ch_2: { paymentIntent: "pi_2" } } })), "charge.updated", { object: ["ch_2", "charge"] })).status, 200);
  assert.equal(await balanceOf(db, A), 19_120_000);
});

test("SEC N2 on #124: charge.updated credits only a charge captured whole; a partial capture is refused, never over-credited", async () => {
  await post(deps(reader({ checkout: { payment: { paymentIntent: "pi_1", grossMicros: 20_000_000, chargeId: null, feeMicros: null } } })), "checkout.session.completed");
  assert.equal((await post(deps(reader({ charges: { ch_1: { capturedMicros: 15_000_000 } } })), "charge.updated")).status, 400);
  assert.equal(await balanceOf(db, A), 0);
  assert.deepEqual(alerts, ["stripe webhook: charge.updated refused: the charge wasn't captured whole"]);
  assert.equal((await post(deps(reader({ charges: { ch_1: {} } })), "charge.updated")).status, 200);
  assert.equal(await balanceOf(db, A), 19_120_000);
});

test("an unknown Customer, or none: 200, nothing written, and an alert", async () => {
  assert.equal((await post(deps(reader({ checkout: { customer: "cus_Nobody" } })), "checkout.session.completed")).status, 200);
  assert.equal((await post(deps(reader({ checkout: { customer: null } })), "checkout.session.completed")).status, 200);
  assert.equal(count(`SELECT COUNT(*) AS k FROM balance_entries`), 0);
  assert.deepEqual(alerts, [
    "stripe webhook: checkout.session.completed names a Customer we don't know; nothing written",
    "stripe webhook: a paid checkout without a Customer; nothing credited",
  ]);
});

test("Stripe unavailable is 503 (retried, no alert); an answer we won't act on is 400 with an alert; a write failure is 500", async () => {
  assert.equal((await post(deps(reader({ checkout: new StripeError("unavailable", "Stripe answered 503") })), "checkout.session.completed")).status, 503);
  assert.deepEqual(alerts, []);
  assert.equal((await post(deps(reader({ checkout: new StripeError("invalid", "the session isn't in USD") })), "checkout.session.completed")).status, 400);
  assert.deepEqual(alerts, ["stripe webhook: checkout.session.completed refused: the session isn't in USD"]);
  alerts = [];
  // a fee not less than the amount: the writer's RangeError, refused
  const bad = { payment: { paymentIntent: "pi_1", grossMicros: 10, chargeId: "ch_1", feeMicros: 10 } };
  assert.equal((await post(deps(reader({ checkout: bad })), "checkout.session.completed")).status, 400);
  assert.deepEqual(alerts, ["stripe webhook: checkout.session.completed refused: the fee must be less than the amount paid"]);
  alerts = [];
  const broken = { ...db, batch: async () => { throw new Error("D1_ERROR: secret detail"); } };
  assert.equal((await post(deps(reader({ checkout: {} }), { db: broken }), "checkout.session.completed")).status, 500);
  assert.deepEqual(alerts, ["stripe webhook: checkout.session.completed: the write failed (Error); Stripe retries"], "the error's message is never in the line");
  assert.equal(await balanceOf(db, A), 0);
});

test("SEC N1 on #124: Stripe redelivers a refused event (400) and a failed write (500); each alerts once an hour per event type", async () => {
  const throttle = new AlertThrottle();
  const refused = deps(reader({ checkout: new StripeError("invalid", "the session isn't in USD") }), { throttle });
  const body = eventBody("checkout.session.completed");
  for (let i = 0; i < 3; i++) assert.equal((await handleStripeWebhook(signed(body), refused)).status, 400, "redelivered, refused again");
  assert.deepEqual(alerts, ["stripe webhook: checkout.session.completed refused: the session isn't in USD"]);
  const broken = { ...db, batch: async () => { throw new Error("D1_ERROR"); } };
  const failing = deps(reader({ charges: { ch_1: { refunds: [] } } }), { throttle, db: broken });
  for (let i = 0; i < 3; i++) assert.equal((await post(failing, "charge.refunded")).status, 500);
  assert.equal(alerts.length, 2, "one line for the failed writes");
  // another event type is its own kind; after an hour, the first pages again
  assert.equal((await post(deps(reader({ dispute: {}, charges: { ch_1: { feeMicros: 20_000_000 } } }), { throttle }), "charge.dispute.created")).status, 400);
  assert.equal(alerts.length, 3);
  clock += ALERT_WINDOW_MS;
  await handleStripeWebhook(signed(body), refused);
  assert.equal(alerts.length, 4);
  assert.equal(count(`SELECT COUNT(*) AS k FROM stripe_events`), 0, "nothing recorded: a fix on our side is acted on by a later delivery");
});

test("an event whose object is another kind than its type names is refused, unfetched", async () => {
  const calls: string[] = [];
  assert.equal((await post(deps(reader({ checkout: {} }, calls)), "checkout.session.completed", { object: ["ch_1", "charge"] })).status, 400);
  assert.deepEqual(calls, []);
});

test("refunds: one debit per refund; failed and cancelled ones aren't debited, and alert", async () => {
  await post(deps(reader({ checkout: {} })), "checkout.session.completed");
  const refunds = [
    { id: "re_1", amountMicros: 5_000_000, status: "succeeded" as const },
    { id: "re_2", amountMicros: 1_000_000, status: "pending" as const },
    { id: "re_3", amountMicros: 2_000_000, status: "failed" as const },
    { id: "re_4", amountMicros: 3_000_000, status: "canceled" as const },
  ];
  const d = deps(reader({ charges: { ch_1: { refunds } } }));
  assert.equal((await post(d, "charge.refunded")).status, 200);
  assert.equal((await post(d, "charge.refunded")).status, 200);
  assert.equal(await balanceOf(db, A), 19_120_000 - 6_000_000);
  assert.deepEqual(alerts, ["stripe webhook: a charge has a failed or cancelled refund; check its debits", "stripe webhook: a charge has a failed or cancelled refund; check its debits"]);
});

test("a dispute reverses the charge's net once and freezes; the fee unknown is 503; a win restores; an early fraud warning shares the one reversal", async () => {
  await post(deps(reader({ checkout: {} })), "checkout.session.completed");
  assert.equal((await post(deps(reader({ dispute: {}, charges: { ch_1: { feeMicros: null } } })), "charge.dispute.created")).status, 503, "retried until the fee is known");
  assert.equal(await isFrozen(db, A), false);
  assert.equal((await post(deps(reader({ efw: { charge: "ch_1", paymentIntent: "pi_1" }, charges: { ch_1: {} } })), "radar.early_fraud_warning.created")).status, 200);
  assert.equal(await balanceOf(db, A), 0);
  assert.equal(await isFrozen(db, A), true);
  assert.equal((await post(deps(reader({ dispute: {}, charges: { ch_1: {} } })), "charge.dispute.created")).status, 200);
  assert.equal(count(`SELECT COUNT(*) AS k FROM balance_entries WHERE kind = 'reversal'`), 1, "one reversal per charge");
  // lost: still the one reversal
  assert.equal((await post(deps(reader({ dispute: { status: "lost" }, charges: { ch_1: {} } })), "charge.dispute.closed")).status, 200);
  assert.equal(await balanceOf(db, A), 0);
  // an inquiry closed: nothing restored, and a human is told
  assert.equal((await post(deps(reader({ dispute: { status: "warning_closed" } })), "charge.dispute.closed")).status, 200);
  assert.deepEqual(alerts, ["stripe webhook: an inquiry closed; its reversal and freeze stay for a human"]);
  // won: restored once; the freeze stays
  const won = deps(reader({ dispute: { status: "won" }, charges: { ch_1: {} } }));
  assert.equal((await post(won, "charge.dispute.closed")).status, 200);
  assert.equal((await post(won, "charge.dispute.closed")).status, 200);
  assert.equal(await balanceOf(db, A), 19_120_000);
  assert.equal(await isFrozen(db, A), true);
});

test("a reversal reads the net from the re-fetched charge, and refuses a fee not less than the amount", async () => {
  await post(deps(reader({ checkout: {} })), "checkout.session.completed");
  assert.equal((await post(deps(reader({ dispute: {}, charges: { ch_1: { feeMicros: 20_000_000 } } })), "charge.dispute.created")).status, 400);
  assert.equal(await balanceOf(db, A), 19_120_000);
  assert.equal((await post(deps(reader({ dispute: {}, charges: { ch_1: { paymentIntent: null } } })), "charge.dispute.created")).status, 200, "the dispute's own PaymentIntent then");
  assert.equal(await balanceOf(db, A), 0);
});

// ---- the plan events

test("subscription events record Stripe's current state; a late one changes nothing", async () => {
  const d = deps(reader({ subscription: { status: "canceled" } }));
  assert.equal((await post(d, "customer.subscription.deleted")).status, 200);
  clock += 1000;
  // a late "updated" whose payload would say active: the fetch says canceled, so nothing is appended
  assert.equal((await post(d, "customer.subscription.updated")).status, 200);
  assert.equal((await latestPlan(db, A))!.status, "canceled");
  assert.equal(count(`SELECT COUNT(*) AS k FROM gpu_plans`), 1);
  assert.equal(count(`SELECT COUNT(*) AS k FROM gpu_plan_fetches`), 2);
});

test("events we don't act on are 200 and fetch nothing", async () => {
  const calls: string[] = [];
  assert.equal((await post(deps(reader({}, calls)), "invoice.paid")).status, 200);
  assert.deepEqual(calls, []);
  assert.equal(count(`SELECT COUNT(*) AS k FROM stripe_events`), 0);
});

// ---- our key refused (SEC C1 on #119): retried, and paged once an hour, not per event

test("our key refused: 503 for every event, and one alert an hour naming only the key's mode and last four", async () => {
  const throttle = new AlertThrottle();
  const KEY = "rk_test_SECRETKEYVALUE00001234";
  const s = stripeFromEnv({ STRIPE_API_KEY: KEY, STRIPE_WEBHOOK_SECRETS: SECRET }, {
    now: () => clock,
    alert: (l) => alerts.push(l),
    throttle,
    fetch: async () => new Response("{}", { status: 401 }),
  });
  assert.ok(!("unusable" in s.stripe));
  const d = deps(s.stripe, { throttle, secrets: s.secrets });
  for (let i = 0; i < 5; i++) assert.equal((await post(d, "checkout.session.completed")).status, 503);
  assert.deepEqual(alerts, ["stripe: Stripe refused our key (401, test …1234); events are retried until it's fixed"]);
  clock += ALERT_WINDOW_MS - 1;
  await post(d, "charge.updated");
  assert.equal(alerts.length, 1, "still in the window");
  clock += 1;
  await post(d, "charge.updated");
  assert.equal(alerts.length, 2, "once more after an hour");
  assert.ok(!alerts.join("\n").includes("SECRETKEYVALUE"));
  assert.equal(count(`SELECT COUNT(*) AS k FROM stripe_events`), 0, "nothing recorded, so the retries are acted on");
});

test("stripeFromEnv: the secrets list; no key, or not a restricted test key, is unusable; nothing shows the key", () => {
  const o = { now: () => clock, alert: () => {}, throttle: new AlertThrottle(), fetch: async () => new Response("") };
  assert.deepEqual(stripeFromEnv({ STRIPE_WEBHOOK_SECRETS: " whsec_a1234567 , whsec_b1234567,," }, o).secrets, ["whsec_a1234567", "whsec_b1234567"]);
  assert.deepEqual(stripeFromEnv({}, o), { secrets: [], stripe: { unusable: "STRIPE_API_KEY is unset" } });
  for (const k of ["sk_test_SECRETKEYVALUE0000", "rk_live_SECRETKEYVALUE0000"]) {
    const r = stripeFromEnv({ STRIPE_API_KEY: k }, o);
    assert.deepEqual(r.stripe, { unusable: "STRIPE_API_KEY is not a restricted test key" }, k.slice(0, 8));
  }
  const ok = stripeFromEnv({ STRIPE_API_KEY: "rk_test_SECRETKEYVALUE0000" }, o);
  assert.ok(!inspect(ok, { depth: null, showHidden: true }).includes("SECRETKEYVALUE"));
});

test("the throttle: once per key per window, keys apart, bounded", () => {
  const t = new AlertThrottle(1000);
  assert.equal(t.allow("a", 0), true);
  assert.equal(t.allow("a", 999), false);
  assert.equal(t.allow("b", 999), true);
  assert.equal(t.allow("a", 1000), true);
  for (let i = 0; i < 100; i++) t.allow(`k${i}`, 2000);
  assert.equal(t.allow("k99", 2001), false, "the newest is still held after the bound clears older keys");
});

// ---- the Worker's wiring

test("the Worker sends the path to the route, before the app's origin and session checks", async () => {
  const logs: string[] = [];
  const worker = createWorker({ now: () => clock, log: (l) => logs.push(l), jobs: [] });
  const env = { DB: { prepare() { throw new Error("unused"); }, batch() { throw new Error("unused"); } }, APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com" } as never;
  const r = await worker.fetch(signed(eventBody("checkout.session.completed")), env, { waitUntil() {} });
  assert.equal(r.status, 503, "no Origin, no session, and not the app's 403: the route's own answer");
  assert.deepEqual(logs, ["control: alert: stripe webhook: not configured (STRIPE_WEBHOOK_SECRETS is unset); events are retried"]);
  await worker.fetch(signed(eventBody("checkout.session.completed")), env, { waitUntil() {} });
  assert.equal(logs.length, 1, "the Worker's throttle holds across requests");
});
