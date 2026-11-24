import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../client.ts";
import { mockFetch } from "../mock/fetch.ts";
import { seedDemo, type Demo } from "../mock/seed.ts";
import { FAST_POLL_MS, SLOW_POLL_MS, Store } from "./store.ts";
import { controllable } from "./testkit.ts";

const MIN = 60_000;

export async function signedIn(email?: string): Promise<{ demo: Demo; store: Store }> {
  const demo = seedDemo();
  const store = new Store(createClient({ fetch: mockFetch(demo.backend) }), () => demo.backend.now());
  await store.verifySignIn(`mock:${email ?? demo.emails.member}`);
  return { demo, store };
}

test("loadMe: signed out is not an error", async () => {
  const demo = seedDemo();
  const store = new Store(createClient({ fetch: mockFetch(demo.backend) }));
  assert.equal(store.meLoaded.value, false);
  await store.loadMe();
  assert.equal(store.me.value, null);
  assert.equal(store.meLoaded.value, true);
  assert.equal(store.error.value, null);
});

test("sign-in: a bad token is an error and leaves you signed out", async () => {
  const demo = seedDemo();
  const store = new Store(createClient({ fetch: mockFetch(demo.backend) }));
  assert.equal(await store.verifySignIn("mock:nobody"), false);
  assert.equal(store.me.value, null);
  assert.match(store.error.value ?? "", /sign-in link/);
  assert.equal(await store.requestSignInLink("x@example.org"), true);
  assert.equal(store.error.value, null);
});

test("openProject loads the project, meters, machines and a quote per GPU type", async () => {
  const { demo, store } = await signedIn();
  await store.openProject(demo.projectId);
  assert.equal(store.project.value?.name, "Fine-tuning lab");
  assert.equal(store.role.value, "member");
  assert.equal(store.labels.value.member, "student");
  assert.deepEqual(store.gpuTypes.value.map((t) => t.gpuType), ["L4", "A6000", "A100-80GB", "A10"]);
  assert.deepEqual(Object.keys(store.quotes.value).sort(), ["A10", "A100-80GB", "A6000", "L4"]);
  assert.equal(store.quotes.value.L4?.canStart, true);
  assert.equal(store.myMeter.value?.amount, 25_000_000);
  assert.equal(store.teamMeter.value?.amount, 50_000_000);
  assert.equal(store.machines.value.length, 0);
  assert.equal(store.busy.value.size, 0);
});

test("a manager sees no team meter of their own", async () => {
  const { demo, store } = await signedIn(seedDemo().emails.manager);
  await store.openProject(demo.projectId);
  assert.equal(store.role.value, "manager");
  assert.equal(store.teamMeter.value, null);
  assert.equal(store.meters.value.length, 10);
  assert.equal(store.myMeter.value?.allocationId, store.membership.value && demo.backend.members.get(store.membership.value.memberId)?.allocationId);
  assert.equal(store.myMeter.value?.amount, 0);
});

test("start, poll, stop: the machine moves through its states", async () => {
  const { demo, store } = await signedIn();
  await store.openProject(demo.projectId);
  assert.equal(await store.start("L4"), true);
  assert.equal(store.machines.value[0]?.state, "starting");
  assert.equal(store.pollDelayMs(), FAST_POLL_MS);
  assert.equal(store.activeMachines.value.length, 1);
  assert.equal(store.quotes.value.L4?.reason, "concurrencyCap");
  demo.backend.advance(90_000);
  await store.refresh();
  const id = store.machines.value[0]?.id as string;
  assert.equal(store.machines.value[0]?.state, "running");
  assert.equal(store.pollDelayMs(), SLOW_POLL_MS);
  assert.equal(await store.save(id), true);
  assert.equal(store.pollDelayMs(), FAST_POLL_MS);
  demo.backend.advance(10 * MIN);
  assert.equal(await store.stop(id), true);
  assert.equal(store.machines.value[0]?.state, "saving");
  demo.backend.advance(MIN);
  await store.refresh();
  assert.equal(store.machines.value[0]?.state, "stopped");
  assert.equal(store.activeMachines.value.length, 0);
  assert.equal(await store.restart(id), true);
  assert.equal(store.machines.value[0]?.state, "starting");
  assert.equal(await store.stop(id), true);
  demo.backend.advance(MIN);
  await store.refresh();
  assert.equal(await store.remove(id), true);
  assert.deepEqual(store.machines.value, []);
});

test("start uses the price the member saw as a ceiling", async () => {
  const { demo, store } = await signedIn();
  await store.openProject(demo.projectId);
  // The price goes up after the quote was shown.
  demo.backend.offers = demo.backend.offers.map((o) => (o.gpuType === "L4" ? { ...o, providerCostPerHour: o.providerCostPerHour + 10_000 } : o));
  assert.equal(await store.start("L4"), false);
  assert.match(store.error.value ?? "", /above what you accepted/);
  await store.refresh();
  assert.equal(await store.start("L4"), true);
  assert.equal(store.error.value, null);
});

test("refused and unknown starts", async () => {
  const { demo, store } = await signedIn();
  await store.openProject(demo.projectId);
  assert.equal(await store.start("A10"), false); // no capacity: refused by the server
  assert.match(store.error.value ?? "", /noCapacity/);
  assert.equal(await store.start("H100"), false); // not in the price list: never sent
  assert.equal(store.machines.value.length, 0);
});

test("an action while signed out clears the session", async () => {
  const { demo, store } = await signedIn();
  await store.openProject(demo.projectId);
  demo.backend.currentUserId = null; // the session expired on the server
  assert.equal(await store.start("L4"), false);
  assert.equal(store.me.value, null);
  assert.equal(store.meLoaded.value, true);
});

test("signOut", async () => {
  const { demo, store } = await signedIn();
  await store.openProject(demo.projectId);
  await store.signOut();
  assert.equal(store.me.value, null);
  assert.equal(store.project.value, null);
  assert.equal(store.projectId.value, null);
});

test("jupyterLink returns the one-time URL", async () => {
  const { demo, store } = await signedIn();
  await store.openProject(demo.projectId);
  await store.start("L4");
  const id = store.machines.value[0]?.id as string;
  assert.equal(await store.jupyterLink(id), null); // not running yet
  demo.backend.advance(90_000);
  assert.match((await store.jupyterLink(id)) ?? "", /^https:\/\/m-mch_[0-9a-z]+\.mock\.invalid\/\?code=/);
});

/** A store whose fetches are counted per "METHOD path". */
async function counted(email?: string) {
  const demo = seedDemo();
  const sent: string[] = [];
  const inner = mockFetch(demo.backend);
  const store = new Store(createClient({ fetch: (url, init) => (sent.push(`${init.method} ${url}`), inner(url, init)) }), () => demo.backend.now());
  await store.verifySignIn(`mock:${email ?? demo.emails.member}`);
  await store.openProject(demo.projectId);
  return { demo, store, starts: () => sent.filter((x) => x === `POST /v1/projects/${demo.projectId}/machines`).length };
}

test("a busy action is not sent twice", async () => {
  const { store, starts } = await counted();
  const [a, b] = await Promise.all([store.start("L4"), store.start("L4")]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(starts(), 1);
  assert.equal(store.machines.value.length, 1);
  assert.equal(store.error.value, null);
});

test("a type with no offer to show is never sent", async () => {
  const { demo, store, starts } = await counted();
  demo.backend.projects.get(demo.projectId)!.policy.allowedProviders = ["nebius"];
  await store.refresh();
  assert.deepEqual(store.quotes.value.L4?.offers, []);
  assert.equal(await store.start("L4"), false);
  assert.equal(starts(), 0);
  assert.equal(store.error.value, null);
});

test("switching projects clears the old project's data", async () => {
  const { demo, store } = await signedIn();
  await store.openProject(demo.projectId);
  await store.openProject("prj_zzzzzzzzzzzzzzzzzzzz");
  assert.equal(store.project.value, null);
  assert.deepEqual(store.gpuTypes.value, []);
  assert.deepEqual(store.meters.value, []);
  assert.match(store.error.value ?? "", /no such project/);
});

test("navigation race: the latest project wins, even when an older load answers last", async () => {
  const t = await controllable();
  const a = t.demo.projectId;
  const b = t.otherId;
  t.hold(new RegExp(`^GET /v1/projects/${a}$`));
  const first = t.store.openProject(a); // its getProject waits
  await t.store.openProject(b);
  assert.equal(t.store.project.value?.id, b);
  t.release();
  await first;
  assert.equal(t.store.projectId.value, b);
  assert.equal(t.store.project.value?.id, b);
  assert.deepEqual(t.store.gpuTypes.value.map((g) => g.gpuType), ["A6000"]);
  assert.deepEqual(Object.keys(t.store.quotes.value), ["A6000"]);
  assert.equal(t.store.myMeter.value?.amount, 5_000_000);
  assert.ok(t.log.includes(`GET /v1/projects/${b}`));
  // A's late answer led to nothing more for A.
  assert.ok(!t.log.some((x) => x === `GET /v1/projects/${a}/spend` || x === `GET /v1/projects/${a}/machines`));
  assert.equal(t.store.error.value, null);
  assert.equal(t.store.busy.value.size, 0);
});

test("navigation race: a superseded load's refresh is dropped too", async () => {
  const t = await controllable();
  const a = t.demo.projectId;
  const b = t.otherId;
  t.hold(new RegExp(`^GET /v1/projects/${a}/spend$`)); // A gets as far as its meters
  const first = t.store.openProject(a);
  await new Promise((r) => setTimeout(r, 0));
  await t.store.openProject(b);
  t.release();
  await first;
  assert.equal(t.store.project.value?.id, b);
  assert.ok(t.store.meters.value.every((m) => m.amount === 5_000_000));
  assert.deepEqual(t.store.gpuTypes.value.map((g) => g.gpuType), ["A6000"]);
});

test("navigation race: a superseded load's error stays hidden", async () => {
  const t = await controllable();
  t.hold(/^GET \/v1\/projects\/prj_zzzzzzzzzzzzzzzzzzzz/); // both of its requests fail late
  const first = t.store.openProject("prj_zzzzzzzzzzzzzzzzzzzz"); // will be notFound
  await t.store.openProject(t.otherId);
  t.release();
  await first;
  assert.equal(t.store.error.value, null);
  assert.equal(t.store.project.value?.id, t.otherId);
});

test("reopening the same project while it loads still loads it", async () => {
  const t = await controllable();
  const a = t.demo.projectId;
  t.hold(new RegExp(`^GET /v1/projects/${a}$`));
  const first = t.store.openProject(a);
  const second = t.store.openProject(a);
  t.release();
  await Promise.all([first, second]);
  assert.equal(t.store.project.value?.id, a);
  assert.equal(t.store.gpuTypes.value.length, 4);
});

test("poll: a failure keeps polling alive and clears itself when a later round succeeds", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  t.failOnce(new TypeError("connection reset"));
  await t.store.poll(); // never throws
  assert.match(t.store.error.value ?? "", /^Couldn't refresh: network error: connection reset/);
  assert.notEqual(t.store.me.value, null);
  await t.store.poll();
  assert.equal(t.store.error.value, null);
});

test("poll: an action's error is not cleared by a good poll", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  await t.store.start("A10"); // noCapacity
  const message = t.store.error.value;
  assert.match(message ?? "", /noCapacity/);
  await t.store.poll();
  assert.equal(t.store.error.value, message);
});

test("poll: an ended session signs the page out", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  t.demo.backend.currentUserId = null;
  await t.store.poll();
  assert.equal(t.store.me.value, null);
  assert.equal(t.store.meLoaded.value, true);
});

test("signing out drops a load still in flight", async () => {
  const t = await controllable();
  const a = t.demo.projectId;
  t.hold(new RegExp(`^GET /v1/projects/${a}$`));
  const first = t.store.openProject(a);
  await t.store.signOut();
  t.release();
  await first;
  assert.equal(t.store.project.value, null);
  assert.equal(t.store.projectId.value, null);
});

test("navigation race: an older load of the same project can't overwrite a newer one", async () => {
  const t = await controllable();
  const a = t.demo.projectId;
  t.hold(new RegExp(`^GET /v1/projects/${a}/machines$`), true); // only the first load's answer is late
  const first = t.store.openProject(a);
  await new Promise((r) => setTimeout(r, 0));
  // Meanwhile a machine starts (by another tab, say), and the project is opened again.
  await t.store.client.call("startMachine", { params: { projectId: a }, body: { gpuType: "L4" } });
  await t.store.openProject(t.otherId);
  await t.store.openProject(a);
  assert.equal(t.store.machines.value.length, 1);
  t.release();
  await first; // its stale answer (no machines) arrives last
  assert.equal(t.store.machines.value.length, 1);
});

test("an action that finds the session over clears every protected object", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  t.demo.backend.currentUserId = null;
  assert.equal(await t.store.start("L4"), false);
  assert.equal(t.store.me.value, null);
  assert.equal(t.store.projectId.value, null);
  assert.equal(t.store.project.value, null);
  assert.deepEqual([t.store.meters.value, t.store.machines.value, t.store.gpuTypes.value], [[], [], []]);
  assert.deepEqual(t.store.quotes.value, {});
});

test("a poll that finds the session over clears every protected object too", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  t.demo.backend.currentUserId = null;
  assert.equal(await t.store.poll(), false);
  assert.equal(t.store.me.value, null);
  assert.equal(t.store.project.value, null);
  assert.deepEqual(t.store.meters.value, []);
  assert.deepEqual(t.store.quotes.value, {});
});

test("jupyterLink opens only the machine's own https origin", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  await t.store.start("L4");
  t.demo.backend.advance(90_000);
  const id = t.store.machines.value[0]!.id;
  assert.match((await t.store.jupyterLink(id)) ?? "", new RegExp(`^https://m-${id}\\.mock\\.invalid/\\?code=`));
  assert.equal(t.store.error.value, null);
  // A server that answers with someone else's address: refused, and said so.
  const real = t.store.client.call.bind(t.store.client);
  (t.store.client as { call: typeof real }).call = (async (name: string, args: unknown) =>
    name === "openJupyterLink" ? { url: "https://evil.example/", expiresAt: "2027-02-01T09:02:30.000Z" } : real(name as never, args as never)) as typeof real;
  assert.equal(await t.store.jupyterLink(id), null);
  assert.match(t.store.error.value ?? "", /isn't the machine's own address/);
});
