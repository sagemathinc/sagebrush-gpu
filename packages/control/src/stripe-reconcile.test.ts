// The pending top-up re-fetch (stripe-reconcile.ts; Codex audit G01 P2): a Checkout paid before Stripe knew
// its fee is credited once the fee is known, even with charge.updated lost and the checkout event replayed.
import { test, beforeEach } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import { balanceOf, creditCheckout, creditPending, recordCustomer, type EventRef, type Who } from "./stripe-ledger.ts";
import { StripeError, type PaymentIntentFacts } from "./stripe-api.ts";
import { RECONCILE_BATCH, RECONCILE_WINDOW_MS, STUCK_MS, reconcilePendingTopups } from "./stripe-reconcile.ts";
import { handleEvent } from "./stripe-route.ts";

const T = 1_800_000_000_000;
const ISS = "https://api.workos.com/user_management/client_test";
const A: Who = { iss: ISS, sub: "user_A" };
let db: TestDb;
let alerts: string[];
let n = 0;
const ev = (type = "checkout.session.completed"): EventRef => ({ eventId: `evt_${++n}q`, type, nowMs: T });

beforeEach(async () => {
  db = sqliteDb();
  alerts = [];
  db.raw.prepare(`INSERT INTO users (id, email, name, created_ms) VALUES ('usr_1', 'a@example.com', NULL, ?)`).run(T);
  db.raw.prepare(`INSERT INTO identities (iss, sub, user_id, email, email_ticket, created_ms) VALUES (?, ?, 'usr_1', NULL, 0, ?)`).run(A.iss, A.sub, T);
  await recordCustomer(db, A, "cus_A", T);
});

/** A checkout paid with its fee not yet known: the pending marker, no credit. */
const paidWithoutFee = (pi: string, at = T) =>
  creditCheckout(db, { ...ev(), nowMs: at }, { customerId: "cus_A", paymentIntent: pi, chargeId: null, grossMicros: 20_000_000, feeMicros: null });

/** (each PaymentIntent its own charge: a charge funds one top-up) */
const pi = (o: Partial<PaymentIntentFacts> = {}): PaymentIntentFacts => {
  const id = o.id ?? "pi_1";
  return { id, status: "succeeded", customer: "cus_A", grossMicros: 20_000_000, chargeId: `ch_${id.slice(3)}`, feeMicros: 880_000, ...o };
};
function deps(facts: (id: string) => PaymentIntentFacts | Error, nowMs = T + 60_000, calls: string[] = []) {
  return {
    db,
    nowMs,
    stripe: {
      async paymentIntent(id: string) {
        calls.push(id);
        const f = facts(id);
        if (f instanceof Error) throw f;
        return f;
      },
    },
    alert: (_key: string, line: string) => void alerts.push(line),
  };
}

test("G01 P2: paid before the fee was known, charge.updated lost, the checkout replayed: the job credits the net once", async () => {
  // the audit's repro: the event is recorded with the marker, so its redelivery is a replay, even once the fee is known
  const e = ev();
  assert.equal(await creditCheckout(db, e, { customerId: "cus_A", paymentIntent: "pi_1", chargeId: null, grossMicros: 20_000_000, feeMicros: null }), "written");
  assert.equal(await creditCheckout(db, e, { customerId: "cus_A", paymentIntent: "pi_1", chargeId: "ch_1", grossMicros: 20_000_000, feeMicros: 880_000 }), "replay");
  assert.equal(await balanceOf(db, A), 0, "the gap: paid, and nothing credited");
  // the job
  assert.equal(await reconcilePendingTopups(deps(() => pi())), 1);
  assert.equal(await balanceOf(db, A), 19_120_000, "the net");
  assert.equal(await reconcilePendingTopups(deps(() => pi())), 0, "a second run: nothing more");
  assert.equal(await balanceOf(db, A), 19_120_000);
  // and a charge.updated arriving after the job: still once
  assert.equal(await creditPending(db, ev("charge.updated"), { customerId: "cus_A", paymentIntent: "pi_1", chargeId: "ch_1", grossMicros: 20_000_000, feeMicros: 880_000, via: "charge" }), "nothing");
  assert.equal(await balanceOf(db, A), 19_120_000);
  assert.deepEqual(alerts, []);
});

test("the fee still unknown, or not succeeded: nothing credited, and after a day it alerts", async () => {
  await paidWithoutFee("pi_1");
  for (const p of [pi({ feeMicros: null }), pi({ chargeId: null, feeMicros: null }), pi({ status: "processing" })]) {
    assert.equal(await reconcilePendingTopups(deps(() => p)), 0);
  }
  assert.equal(await balanceOf(db, A), 0);
  assert.deepEqual(alerts, []);
  assert.equal(await reconcilePendingTopups(deps(() => pi({ feeMicros: null }), T + STUCK_MS - 1)), 0);
  assert.deepEqual(alerts, [], "just short of a day");
  assert.equal(await reconcilePendingTopups(deps(() => pi({ feeMicros: null }), T + STUCK_MS)), 0);
  assert.deepEqual(alerts, ["stripe reconcile: 1 paid top-up(s) still have no fee after a day"]);
});

test("only Stripe's facts for the marker's own person: another Customer credits nothing and alerts; a refused answer alerts and the rest go on", async () => {
  await paidWithoutFee("pi_1");
  await paidWithoutFee("pi_2", T + 1);
  assert.equal(await reconcilePendingTopups(deps((id) => (id === "pi_2" ? pi({ id, customer: "cus_Other" }) : pi({ id })))), 1);
  assert.equal(await balanceOf(db, A), 19_120_000, "pi_1 only");
  assert.deepEqual(alerts, ["stripe reconcile: a pending top-up's PaymentIntent names another Customer; nothing credited"]);
  alerts = [];
  await paidWithoutFee("pi_3", T + 2);
  assert.equal(await reconcilePendingTopups(deps((id) => (id === "pi_3" ? new StripeError("invalid", "the PaymentIntent isn't in USD") : pi({ id, customer: "cus_Other" })))), 0);
  assert.deepEqual(alerts.slice(0, 1), ["stripe reconcile: a pending top-up's PaymentIntent was refused (the PaymentIntent isn't in USD)"]);
});

test("TESTS H1 on #128: figures that can't be credited refuse that marker alone, with an alert; the rest are credited; a database failure still fails the run", async () => {
  await paidWithoutFee("pi_good");
  await paidWithoutFee("pi_bad", T + 1);
  await paidWithoutFee("pi_zero", T + 2);
  const facts = (id: string) =>
    id === "pi_bad" ? pi({ id, grossMicros: 880_000, feeMicros: 880_000 }) : id === "pi_zero" ? pi({ id, grossMicros: 0, feeMicros: 0 }) : pi({ id });
  assert.equal(await reconcilePendingTopups(deps(facts)), 1);
  assert.equal(await balanceOf(db, A), 19_120_000, "pi_good, behind the two refused ones");
  assert.deepEqual(alerts, [
    "stripe reconcile: a pending top-up's figures can't be credited (the fee must be less than the amount paid)",
    "stripe reconcile: a pending top-up's figures can't be credited (an amount must be a safe integer of micro-USD)",
  ], "longest unchecked first: pi_bad, then pi_zero");
  // a database failure in the credit itself (the check is recorded; the ledger write fails) still fails the run
  const broken = { ...db, batch: async (stmts: Parameters<typeof db.batch>[0]) => (stmts.some((x) => x.sql.includes("balance_entries")) ? Promise.reject(new Error("D1_ERROR")) : db.batch(stmts)) };
  await paidWithoutFee("pi_more", T + 3);
  await assert.rejects(reconcilePendingTopups({ ...deps((id) => pi({ id }), T + 120_000), db: broken }), /D1_ERROR/);
});

test("Stripe unavailable stops the run, crediting nothing more; the next run credits", async () => {
  await paidWithoutFee("pi_1");
  await paidWithoutFee("pi_2", T + 1);
  const calls: string[] = [];
  assert.equal(await reconcilePendingTopups(deps(() => new StripeError("unavailable", "Stripe answered 503"), T + 60_000, calls)), 0);
  assert.deepEqual(calls, ["pi_1"], "stopped at the first: no hammering a Stripe that's down");
  assert.deepEqual(alerts, []);
  assert.equal(await reconcilePendingTopups(deps((id) => pi({ id }))), 2);
  assert.equal(await balanceOf(db, A), 2 * 19_120_000);
});

test("bounded and fair: a batch a run, rotating through every open marker; past the window it isn't fetched, and alerts for a human", async () => {
  for (let i = 0; i < RECONCILE_BATCH + 3; i++) await paidWithoutFee(`pi_b${i}`, T + i);
  // two consecutive runs: a batch each, no repeats within a run, and between them every open marker
  const seen = new Set<string>();
  for (const at of [T + 60_000, T + 120_000]) {
    const calls: string[] = [];
    await reconcilePendingTopups(deps((id) => pi({ id, feeMicros: null }), at, calls));
    assert.equal(calls.length, RECONCILE_BATCH);
    assert.equal(new Set(calls).size, RECONCILE_BATCH, "no marker twice in one run");
    for (const c of calls) seen.add(c);
  }
  assert.equal(seen.size, RECONCILE_BATCH + 3, "all of them within ceil(23 / 20) = 2 runs");
  const old = sqliteDb();
  db = old;
  db.raw.prepare(`INSERT INTO users (id, email, name, created_ms) VALUES ('usr_1', 'a@example.com', NULL, ?)`).run(T);
  db.raw.prepare(`INSERT INTO identities (iss, sub, user_id, email, email_ticket, created_ms) VALUES (?, ?, 'usr_1', NULL, 0, ?)`).run(A.iss, A.sub, T);
  await recordCustomer(db, A, "cus_A", T);
  await paidWithoutFee("pi_old", T);
  const late: string[] = [];
  assert.equal(await reconcilePendingTopups(deps((id) => pi({ id }), T + RECONCILE_WINDOW_MS + 1, late)), 0);
  assert.deepEqual(late, [], "past the window: not fetched");
  assert.deepEqual(alerts, ["stripe reconcile: 1 paid top-up(s) still uncredited after 7 days; a human must settle them"]);
  alerts = [];
  assert.equal(await reconcilePendingTopups(deps((id) => pi({ id }), T + RECONCILE_WINDOW_MS, late)), 1, "exactly 7 days: still fetched");
});

/** n markers, the first payable and the rest with no fee yet (oldest first, a millisecond apart from `at`). */
async function markers(n: number, at = T, prefix = "pi_w") {
  for (let i = 0; i < n; i++) await paidWithoutFee(`${prefix}${i}`, at + i);
}
const onlyPayable = (payable: string) => (id: string) => (id === payable ? pi({ id }) : pi({ id, feeMicros: null }));
/** Runs at the given times until A is credited; how many it took (or the number of times, if never). */
async function runsUntilCredited(times: number[], facts: (id: string) => PaymentIntentFacts, before?: (i: number) => Promise<void>) {
  for (let i = 0; i < times.length; i++) {
    if (before) await before(i);
    await reconcilePendingTopups(deps(facts, times[i]!));
    if ((await balanceOf(db, A)) > 0) return i + 1;
  }
  return times.length;
}

test("Codex cx3 P2 on #128: twenty newer markers with no fee yet can't keep an older payable one from being credited", async () => {
  await paidWithoutFee("pi_payable", T);
  await markers(RECONCILE_BATCH, T + 1);
  // (the payable one is the oldest unchecked: it goes in the first batch)
  assert.equal(await runsUntilCredited([T + 60_000], onlyPayable("pi_payable")), 1);
  assert.equal(await balanceOf(db, A), 19_120_000);
});

test("TESTS H2 on #128 (1): runs every five minutes, 100 open; the oldest payable one is credited within ceil(100/20) runs", async () => {
  await paidWithoutFee("pi_payable", T);
  await markers(99, T + 1);
  // (worst case for it: everything newer was checked more recently, so it waits its turn behind none)
  const times = Array.from({ length: 10 }, (_, k) => T + 60_000 + k * 5 * 60_000);
  const took = await runsUntilCredited(times, onlyPayable("pi_payable"));
  assert.ok(took <= Math.ceil(100 / RECONCILE_BATCH), `took ${took}`);
  assert.equal(await balanceOf(db, A), 19_120_000);
});

test("TESTS H2 on #128 (2): twenty new markers arrive before every run; an older payable one is still credited, within two runs", async () => {
  // (the reviewer's repro, on its own timestamps from 0: the minute-offset rotation fetched the same twenty
  // every run here, since open = 21 + 20m and the offset was 20m)
  await paidWithoutFee("pi_payable", 0);
  await markers(RECONCILE_BATCH, 1, "pi_first");
  const times = Array.from({ length: 9 }, (_, m) => (m + 1) * 60_000);
  const took = await runsUntilCredited(times, onlyPayable("pi_payable"), (m) => markers(RECONCILE_BATCH, times[m]! - 1_000, `pi_wave${m}x`));
  assert.ok(took <= 2, `took ${took}`);
  assert.equal(await balanceOf(db, A), 19_120_000);
});

test("a marker checked once while unready, then payable, isn't starved by new arrivals that were never checked", async () => {
  await paidWithoutFee("pi_old", T);
  let ready = false;
  const facts = (id: string) => (id === "pi_old" && ready ? pi({ id }) : pi({ id, feeMicros: null }));
  await reconcilePendingTopups(deps(facts, T + 60_000));
  assert.equal(await balanceOf(db, A), 0, "checked, not ready");
  ready = true;
  const times = Array.from({ length: 6 }, (_, m) => T + (m + 2) * 60_000);
  // twenty never-checked markers before each run, all newer than pi_old's check
  const took = await runsUntilCredited(times, facts, (m) => markers(RECONCILE_BATCH, times[m]! - 1_000, `pi_new${m}x`));
  assert.ok(took <= 2, `took ${took}`);
  assert.equal(await balanceOf(db, A), 19_120_000);
});

test("fair at any cadence: 50 open, never more than a batch a run, none twice, each fetched within ceil(50/20) runs of its turn", async () => {
  await markers(50);
  for (const gapMinutes of [1, 2, 5, 13]) {
    const seen = new Set<string>();
    for (let k = 0; k < Math.ceil(50 / RECONCILE_BATCH); k++) {
      const calls: string[] = [];
      await reconcilePendingTopups(deps((id) => pi({ id, feeMicros: null }), T + 60_000 + (gapMinutes * 10 + k * gapMinutes) * 60_000, calls));
      assert.equal(calls.length, RECONCILE_BATCH);
      assert.equal(new Set(calls).size, RECONCILE_BATCH, "none twice in a run");
      for (const c of calls) seen.add(c);
    }
    assert.equal(seen.size, 50, `every ${gapMinutes} minutes: all 50 within 3 runs`);
  }
});

test("a check is recorded only when Stripe answered: unavailable records nothing; refused, unready and credited do", async () => {
  await paidWithoutFee("pi_1");
  const at = T + 60_000;
  await reconcilePendingTopups(deps(() => new StripeError("unavailable", "Stripe answered 503"), at));
  assert.equal((db.raw.prepare(`SELECT COUNT(*) AS k FROM pending_checks`).get() as { k: number }).k, 0);
  await reconcilePendingTopups(deps(() => pi({ feeMicros: null }), at));
  assert.deepEqual({ ...(db.raw.prepare(`SELECT stripe_key, checked_ms FROM pending_checks`).get() as object) }, { stripe_key: "pi_1", checked_ms: at });
  await reconcilePendingTopups(deps(() => new StripeError("invalid", "x"), at + 60_000));
  assert.equal((db.raw.prepare(`SELECT checked_ms FROM pending_checks`).get() as { checked_ms: number }).checked_ms, at + 60_000, "rewritten in place, one row");
  // a database failure recording the check fails the run
  const broken = { ...db, batch: async () => { throw new Error("D1_ERROR"); } };
  await assert.rejects(reconcilePendingTopups({ ...deps(() => pi({ feeMicros: null }), at + 120_000), db: broken }), /D1_ERROR/);
});

test("a credited marker isn't fetched again; the re-fetch path needs no event, and an event-less charge credit is refused", async () => {
  await paidWithoutFee("pi_1");
  await reconcilePendingTopups(deps(() => pi()));
  const calls: string[] = [];
  await reconcilePendingTopups(deps(() => pi(), T + 120_000, calls));
  assert.deepEqual(calls, []);
  await assert.rejects(creditPending(db, { eventId: null, nowMs: T }, { customerId: "cus_A", paymentIntent: "pi_9", chargeId: "ch_9", grossMicros: 2, feeMicros: 1, via: "charge" }), /re-fetch has no event/);
  await assert.rejects(creditPending(db, ev(), { customerId: "cus_A", paymentIntent: "pi_9", chargeId: "ch_9", grossMicros: 2, feeMicros: 1, via: "refetch" }), /re-fetch has no event/);
});

test("the webhook still never names paymentIntent: the route's reader is unchanged", async () => {
  // (the re-fetch is only the job's; an event for a PaymentIntent is ignored, as before)
  const r = await handleEvent(
    { id: "evt_x", type: "payment_intent.succeeded", livemode: false, created: 0, object: { id: "pi_1", object: "payment_intent" } },
    {} as never,
    { db, now: () => T, alert: () => {} },
  );
  assert.equal(r, "ignored");
});

// ---- the Worker's cron runs it where the Stripe key is set

/** A D1 over the test database (only what d1Db uses). */
function d1Of(t: TestDb) {
  const prep = (sql: string) => ({
    bind: (...v: Array<string | number | null>) => ({
      async all<R>() {
        return { results: t.raw.prepare(sql).all(...v) as R[] };
      },
      async run() {
        return { meta: { changes: Number(t.raw.prepare(sql).run(...v).changes) } };
      },
      sql,
      v,
    }),
  });
  return {
    prepare: prep,
    async batch(stmts: Array<{ sql: string; v: Array<string | number | null> }>) {
      const r = await t.batch(stmts.map((s) => ({ sql: s.sql, params: s.v })));
      return r.map((x) => ({ meta: { changes: x.changes } }));
    },
  };
}

test("the Worker's cron credits a pending top-up with the key set; without it, Stripe is never asked", async () => {
  const { createWorker } = await import("./worker.ts");
  await paidWithoutFee("pi_1");
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = String(input instanceof Request ? input.url : input);
    urls.push(u);
    return new Response(JSON.stringify({
      object: "payment_intent", id: "pi_1", livemode: false, currency: "usd", status: "succeeded", customer: "cus_A", amount_received: 2000,
      latest_charge: { object: "charge", id: "ch_1", livemode: false, balance_transaction: { object: "balance_transaction", id: "txn_1", status: "available", currency: "usd", fee: 88 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const logs: string[] = [];
    const env = { DB: d1Of(db), APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com" };
    await createWorker({ now: () => T + 60_000, log: (l) => logs.push(l), jobs: [] }).scheduled({ scheduledTime: 0, cron: "" }, env as never, { waitUntil() {} });
    assert.deepEqual(urls, [], "no key: not asked");
    assert.equal(await balanceOf(db, A), 0);
    await createWorker({ now: () => T + 60_000, log: (l) => logs.push(l), jobs: [] }).scheduled({ scheduledTime: 0, cron: "" }, { ...env, STRIPE_API_KEY: "rk_test_SECRETKEYVALUE0000" } as never, { waitUntil() {} });
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /\/v1\/payment_intents\/pi_1\?/);
    assert.equal(await balanceOf(db, A), 19_120_000);
    assert.deepEqual(logs, ["control: pending top-ups credited: 1"]);
    assert.ok(!logs.join("\n").includes("SECRETKEYVALUE"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("every migration is on the PROD checklist (William's per-file OK before control's first PROD deploy)", () => {
  const dir = new URL("../migrations/", import.meta.url);
  const list = readFileSync(new URL("PROD-CHECKLIST.md", dir), "utf8");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) assert.ok(list.includes(`| ${f} |`), `${f} is missing from migrations/PROD-CHECKLIST.md`);
});
