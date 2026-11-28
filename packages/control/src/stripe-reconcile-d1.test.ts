// The D1 runtime contract for the pending re-fetch's refusal matcher (stripe-reconcile.ts ledgerRefusal): the
// repo's pinned local D1 (Miniflare) is asked to raise each ledger refusal for real, and the matcher must
// recognise exactly what it reports. Then the job runs against the real migrations on that D1, where a charge
// funding two PaymentIntents is refused by the ledger's own trigger: that marker alone is refused, the others
// are credited, and the run goes on. A change in how D1 reports trigger errors fails here, not in production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startWorker, type StartedWorker } from "@sbgpu/testing/worker";
import { d1Db, type D1Like } from "./db.ts";
import { balanceOf, creditCheckout, recordCustomer, type Who } from "./stripe-ledger.ts";
import { LEDGER_REFUSALS, ledgerRefusal, reconcilePendingTopups } from "./stripe-reconcile.ts";
import type { PaymentIntentFacts } from "./stripe-api.ts";

const T = 1_800_000_000_000;
const A: Who = { iss: "https://api.workos.com/user_management/client_test", sub: "user_A" };
let w: StartedWorker;
let d1: D1Like & { exec(sql: string): Promise<unknown> };

before(async () => {
  w = await startWorker({ entry: "packages/control/src/entry.ts", d1Databases: ["DB"], migrations: { DB: ["packages/control/migrations"] }, bindings: { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com" } });
  d1 = (await w.mf.getD1Database("DB")) as unknown as typeof d1;
});
after(async () => w?.dispose());

test("the pinned D1 runtime reports each ledger refusal in a form ledgerRefusal recognises", async () => {
  for (const [i, text] of LEDGER_REFUSALS.entries()) {
    await d1.exec(`CREATE TABLE contract${i} (x INTEGER)`);
    await d1.exec(`CREATE TRIGGER contract_deny${i} BEFORE INSERT ON contract${i} BEGIN SELECT RAISE(ABORT, '${text.replaceAll("'", "''")}'); END`);
    let caught: unknown;
    try {
      await d1Db(d1).batch([{ sql: `INSERT INTO contract${i} VALUES (?)`, params: [1] }]);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, text);
    assert.equal(ledgerRefusal(caught), text, `the runtime's message: ${(caught as Error).message}`);
  }
});

test("on the real migrations and D1: a charge funding two PaymentIntents refuses that one alone, and the run goes on", async () => {
  const db = d1Db(d1);
  await db.batch([
    { sql: `INSERT INTO users (id, email, name, created_ms) VALUES ('usr_1', 'a@example.com', NULL, ?)`, params: [T] },
    { sql: `INSERT INTO identities (iss, sub, user_id, email, email_ticket, created_ms) VALUES (?, ?, 'usr_1', NULL, 0, ?)`, params: [A.iss, A.sub, T] },
  ]);
  await recordCustomer(db, A, "cus_A", T);
  for (const [i, key] of ["pi_1", "pi_2", "pi_3"].entries()) {
    await creditCheckout(db, { eventId: `evt_d1${i}`, type: "checkout.session.completed", nowMs: T + i }, { customerId: "cus_A", paymentIntent: key, chargeId: null, grossMicros: 20_000_000, feeMicros: null });
  }
  const alerts: string[] = [];
  const pi = (id: string): PaymentIntentFacts => ({ id, status: "succeeded", customer: "cus_A", grossMicros: 20_000_000, chargeId: id === "pi_3" ? "ch_3" : "ch_same", feeMicros: 880_000 });
  const credited = await reconcilePendingTopups({ db, nowMs: T + 60_000, stripe: { paymentIntent: async (id) => pi(id) }, alert: (_k, line) => void alerts.push(line) });
  assert.equal(credited, 2);
  assert.equal(await balanceOf(db, A), 2 * 19_120_000);
  assert.deepEqual(alerts, ["stripe reconcile: a pending top-up's figures can't be credited (a balance entry is never replaced)"]);
});
