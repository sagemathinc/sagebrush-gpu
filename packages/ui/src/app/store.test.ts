import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../client.ts";
import { mockFetch } from "../mock/fetch.ts";
import { seedDemo, type Demo } from "../mock/seed.ts";
import { FAST_POLL_MS, SLOW_POLL_MS, Store } from "./store.ts";

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
