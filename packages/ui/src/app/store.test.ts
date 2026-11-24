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
  assert.match((await store.jupyterLink(id)) ?? "", /^https:\/\/m-mch_[0-9a-z]+\.machines\.invalid\/\?code=/);
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

test("a manager's people, teams and machines go when the session ends", async () => {
  const t = await controllable(seedDemo().emails.manager);
  await t.store.openProject(t.demo.projectId);
  assert.ok(t.store.members.value.length > 0);
  t.demo.backend.currentUserId = null;
  assert.equal(await t.store.poll(), false);
  assert.deepEqual([t.store.members.value, t.store.teams.value, t.store.allMachines.value], [[], [], []]);
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
  assert.match((await t.store.jupyterLink(id)) ?? "", new RegExp(`^https://m-${id}\\.machines\\.invalid/\\?code=`));
  assert.equal(t.store.error.value, null);
  // A server that answers with someone else's address: refused, and said so.
  const real = t.store.client.call.bind(t.store.client);
  (t.store.client as { call: typeof real }).call = (async (name: string, args: unknown) =>
    name === "openJupyterLink" ? { url: "https://evil.example/", expiresAt: "2027-02-01T09:02:30.000Z" } : real(name as never, args as never)) as typeof real;
  assert.equal(await t.store.jupyterLink(id), null);
  assert.match(t.store.error.value ?? "", /isn't the machine's own address/);
});

const unauthenticated = () => Response.json({ error: { code: "unauthenticated", message: "session expired" } }, { status: 401 });

/** Open A, start a poll of A whose spend answer is held (and replaced by `answer`), then open B. */
async function stalePoll(answer?: () => Response) {
  const t = await controllable();
  const a = t.demo.projectId;
  await t.store.openProject(a);
  const spendA = new RegExp(`^GET /v1/projects/${a}/spend$`);
  t.hold(spendA, true);
  if (answer) t.respondOnce(spendA, answer);
  const poll = t.store.poll();
  await new Promise((r) => setTimeout(r, 0));
  await t.store.openProject(t.otherId);
  return { t, poll };
}

test("stale poll: a 401 asked in the current session ends it, even after navigating", async () => {
  const { t, poll } = await stalePoll(unauthenticated);
  t.release();
  assert.equal(await poll, false);
  assert.equal(t.store.me.value, null);
  assert.equal(t.store.project.value, null);
});

test("stale poll: a 401 from before a re-sign-in doesn't end the new session", async () => {
  const { t, poll } = await stalePoll(unauthenticated);
  await t.store.signOut();
  await t.store.verifySignIn(`mock:${t.demo.emails.member}`);
  await t.store.openProject(t.otherId);
  t.release();
  assert.equal(await poll, true);
  assert.equal(t.store.me.value?.user.email, t.demo.emails.member);
  assert.equal(t.store.project.value?.id, t.otherId);
  assert.equal(t.store.error.value, null);
});

test("stale poll: an older project's network error doesn't banner the current one", async () => {
  const { t, poll } = await stalePoll(() => {
    throw new TypeError("connection reset");
  });
  t.release();
  assert.equal(await poll, true);
  assert.equal(t.store.error.value, null);
  assert.equal(t.store.project.value?.id, t.otherId);
});

test("stale poll: an older project's success doesn't clear the current one's newer banner", async () => {
  const { t, poll } = await stalePoll();
  t.failOnce(new TypeError("B is unreachable"));
  assert.equal(await t.store.poll(), false);
  const banner = t.store.error.value;
  assert.match(banner ?? "", /Couldn't refresh: network error: B is unreachable/);
  t.release();
  assert.equal(await poll, true);
  assert.equal(t.store.error.value, banner);
  assert.equal(t.store.project.value?.id, t.otherId);
});

test("an action's 401 from before a re-sign-in doesn't end the new session", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  const start = new RegExp(`^POST /v1/projects/${t.demo.projectId}/machines$`);
  t.hold(start, true);
  t.respondOnce(start, unauthenticated);
  const started = t.store.start("L4");
  await new Promise((r) => setTimeout(r, 0));
  await t.store.signOut();
  await t.store.verifySignIn(`mock:${t.demo.emails.member}`);
  t.release();
  assert.equal(await started, false);
  assert.equal(t.store.me.value?.user.email, t.demo.emails.member);
  assert.equal(t.store.error.value, null); // and its message doesn't banner the new session
});

test("signing in as someone else drops the previous session's load in flight", async () => {
  const t = await controllable();
  const a = t.demo.projectId;
  t.hold(new RegExp(`^GET /v1/projects/${a}$`));
  const first = t.store.openProject(a);
  await new Promise((r) => setTimeout(r, 0));
  await t.store.verifySignIn(`mock:${t.demo.emails.manager}`);
  t.release();
  await first;
  assert.equal(t.store.me.value?.user.email, t.demo.emails.manager);
  assert.equal(t.store.project.value, null); // the member's answer never reaches the manager's page
});

test("an action's success from a replaced session changes nothing in the new one", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  const start = new RegExp(`^POST /v1/projects/${t.demo.projectId}/machines$`);
  t.hold(start, true); // the server starts it; the answer arrives late
  const started = t.store.start("L4");
  await new Promise((r) => setTimeout(r, 0));
  await t.store.signOut();
  await t.store.verifySignIn(`mock:${t.demo.emails.teamMember}`);
  await t.store.openProject(t.otherId);
  t.store.error.value = "the new session's own message";
  t.release();
  assert.equal(await started, false);
  assert.equal(t.store.me.value?.user.email, t.demo.emails.teamMember);
  assert.equal(t.store.projectId.value, t.otherId);
  assert.deepEqual(t.store.machines.value, []); // not the old member's machine
  assert.equal(t.store.error.value, "the new session's own message");
});

test("an action's success after navigating away returns nothing (no link to open)", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  await t.store.start("L4");
  t.demo.backend.advance(90_000);
  const id = t.store.machines.value[0]!.id;
  t.hold(/\/jupyter-link$/, true);
  const link = t.store.jupyterLink(id);
  await new Promise((r) => setTimeout(r, 0));
  await t.store.openProject(t.otherId);
  t.release();
  assert.equal(await link, null);
  assert.equal(t.store.error.value, null);
});

test("staff refresh loads people, teams and every machine; members don't ask", async () => {
  const m = await controllable(); // a member
  await m.store.openProject(m.demo.projectId);
  assert.equal(m.store.isStaff.value, false);
  assert.equal(m.log.filter((x) => x.endsWith("/members") || x.includes("all=1")).length, 0);
  assert.deepEqual(m.store.members.value, []);
  const t = await controllable(seedDemo().emails.manager);
  await t.store.openProject(t.demo.projectId);
  assert.equal(t.store.isStaff.value, true);
  assert.equal(t.store.canManage.value, true);
  assert.equal(t.store.members.value.length, 8);
  assert.equal(t.store.teams.value.length, 2);
  assert.ok(t.log.includes(`GET /v1/projects/${t.demo.projectId}/machines?all=1`));
  const a = await controllable(seedDemo().emails.assistant);
  await a.store.openProject(a.demo.projectId);
  assert.deepEqual([a.store.isStaff.value, a.store.canManage.value], [true, false]);
  // Switching projects, or the session ending, forgets them.
  await t.store.openProject(t.otherId);
  assert.deepEqual([t.store.members.value, t.store.teams.value, t.store.allMachines.value], [[], [], []]);
});

test("manager actions: one allocation, a bulk change that stops at a refusal, invites, Stop all, CSV", async () => {
  const t = await controllable(seedDemo().emails.manager);
  const p = t.demo.projectId;
  await t.store.openProject(p);
  const id = (email: string) => t.store.members.value.find((m) => m.email === email)!.id;
  assert.equal(await t.store.setAllocation(id("ada@example.org"), 30_000_000), true);
  assert.equal(t.store.project.value?.allocated, 205_200_000); // refreshed
  // Bulk: the second change would pass the budget, so the server refuses it.
  const applied = await t.store.setAllocations([
    { memberId: id("alan@example.org"), to: 10_000_000 },
    { memberId: id("grace@example.org"), to: 5_000_000_000 },
    { memberId: id("edsger@example.org"), to: 1 },
  ]);
  assert.equal(applied, 1);
  assert.match(t.store.error.value ?? "", /^1 of 3 allocations changed, then: allocations would add up to more than the budget/);
  assert.equal(t.store.meters.value.find((m) => m.allocationId === t.store.members.value.find((x) => x.email === "edsger@example.org")!.allocationId)?.amount, 25_000_000);
  assert.equal(await t.store.setAllocations([]), 0);
  assert.equal(await t.store.invite(["new@example.org", "ada@example.org"], 2_000_000), 2);
  assert.equal(t.store.members.value.length, 9);
  const newcomer = t.store.members.value.find((m) => m.email === "new@example.org")!;
  assert.equal(t.store.meters.value.find((m) => m.allocationId === newcomer.allocationId)?.amount, 2_000_000);
  const sent = t.log.length;
  assert.equal(await t.store.invite([], 1), 0);
  assert.equal(t.log.length, sent); // nothing sent
  assert.equal(await t.store.stopAll(), 0);
  const me = t.store.members.value.find((m) => m.email === "manager@example.org")!;
  await t.store.setAllocation(me.id, 10_000_000);
  await t.store.client.call("startMachine", { params: { projectId: p }, body: { gpuType: "L4" } });
  assert.equal(await t.store.stopAll(), 1);
  const csv = await t.store.spendCsv("member");
  assert.match(csv ?? "", /^email,name,team,allocation_usd/);
  assert.equal(await t.store.removeMember(id("new@example.org")), true);
  assert.equal(t.store.members.value.find((m) => m.email === "new@example.org")?.status, "removed");
});

test("manager actions need a project", async () => {
  const t = await controllable(seedDemo().emails.manager);
  assert.equal(await t.store.setAllocation("mbr_x", 1), false);
  assert.equal(await t.store.setAllocations([{ memberId: "mbr_x", to: 1 }]), 0);
  assert.equal(await t.store.invite(["a@b.co"], 1), 0);
  assert.equal(await t.store.removeMember("mbr_x"), false);
  assert.equal(await t.store.stopAll(), null);
  assert.equal(await t.store.spendCsv("day"), null);
  assert.equal(t.log.filter((x) => !x.includes("/auth/")).length, 0);
});
