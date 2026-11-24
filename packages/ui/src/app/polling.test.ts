import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, FIRST_BACKOFF_MS, MAX_BACKOFF_MS, startPolling } from "./polling.ts";
import { FAST_POLL_MS, SLOW_POLL_MS } from "./store.ts";
import { controllable, FakeTimers } from "./testkit.ts";

const spendCalls = (log: string[]) => log.filter((x) => x.endsWith("/spend")).length;

test("backoff doubles from 2 s and stops at 60 s", () => {
  assert.equal(FIRST_BACKOFF_MS, 2000);
  assert.equal(MAX_BACKOFF_MS, 60_000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 100].map(backoffMs), [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
});

test("polls one round at a time at the store's pace", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  const timers = new FakeTimers();
  startPolling(t.store, { timers });
  assert.deepEqual(timers.delays(), [SLOW_POLL_MS]);
  const before = spendCalls(t.log);
  await timers.run();
  assert.equal(spendCalls(t.log), before + 1);
  assert.deepEqual(timers.delays(), [SLOW_POLL_MS]);
  await t.store.start("L4"); // a machine starting: poll fast
  await timers.run();
  assert.deepEqual(timers.delays(), [FAST_POLL_MS]);
});

test("a failed round backs off, shows why, and a good round resets", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  const timers = new FakeTimers();
  startPolling(t.store, { timers });
  t.failOnce(new TypeError("connection reset"));
  await timers.run();
  assert.deepEqual(timers.delays(), [2000]);
  assert.match(t.store.error.value ?? "", /Couldn't refresh/);
  t.failOnce(new TypeError("connection reset"));
  await timers.run();
  assert.deepEqual(timers.delays(), [4000]);
  await timers.run();
  assert.deepEqual(timers.delays(), [SLOW_POLL_MS]);
  assert.equal(t.store.error.value, null);
  t.failOnce(new TypeError("again"));
  await timers.run();
  assert.deepEqual(timers.delays(), [2000]); // the count started over
});

test("an ended session stops polling and signs the page out", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  const timers = new FakeTimers();
  startPolling(t.store, { timers });
  t.demo.backend.currentUserId = null;
  await timers.run();
  assert.equal(t.store.me.value, null);
  assert.deepEqual(timers.delays(), []);
});

test("signed out before a round: no request, no more rounds", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  const timers = new FakeTimers();
  startPolling(t.store, { timers });
  await t.store.signOut();
  const before = t.log.length;
  await timers.run();
  assert.equal(t.log.length, before);
  assert.deepEqual(timers.delays(), []);
});

test("stop() cancels the next round, even one in flight", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  const timers = new FakeTimers();
  const stop = startPolling(t.store, { timers });
  stop();
  assert.deepEqual(timers.delays(), []);
  assert.equal(timers.cleared.length, 1);

  const timers2 = new FakeTimers();
  const stop2 = startPolling(t.store, { timers: timers2 });
  t.hold(/\/spend$/);
  const round = timers2.run();
  await new Promise((r) => setTimeout(r, 0));
  stop2();
  t.release();
  await round;
  assert.deepEqual(timers2.delays(), []);
  assert.equal(timers2.cleared.length, 0); // nothing was pending to clear
});

test("a hidden tab skips rounds but keeps the schedule", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  const timers = new FakeTimers();
  let shown = false;
  startPolling(t.store, { timers, visible: () => shown });
  const before = spendCalls(t.log);
  await timers.run();
  assert.equal(spendCalls(t.log), before);
  assert.deepEqual(timers.delays(), [SLOW_POLL_MS]);
  shown = true;
  await timers.run();
  assert.equal(spendCalls(t.log), before + 1);
});
