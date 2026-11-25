// The organization page: the store's loading, and the page in a DOM (happy-dom), for
// both billing modes, against the mock.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import { seedDemo } from "../mock/seed.ts";
import { installDom, mountApp, settle, unmountAll } from "./domkit.ts";
import { formatUsd } from "../money.ts";
import { BILLING_WORDS } from "./org-page.ts";
import { controllable, FakeTimers } from "./testkit.ts";

let win: Window;
before(() => {
  win = installDom();
});
afterEach(() => unmountAll());
after(async () => {
  await win.happyDOM.close();
});

const EMAILS = seedDemo().emails;
type T = Awaited<ReturnType<typeof controllable>>;

/** A byok organization the owner can view, with `n` projects. */
async function ownKeysOrg(t: T, n = 1) {
  const b = t.demo.backend;
  const org = b.addOrg("Own keys org", 0, 900_000_000, "byok");
  for (let i = 0; i < n; i++) {
    b.addProject(org.id, { name: `Lab ${i}`, budget: i === 0 ? 100_000_000 : 0, startsAt: "2027-01-01T00:00:00.000Z", endsAt: "2027-06-01T00:00:00.000Z" });
  }
  const owner = [...b.users.values()].find((u) => u.email === EMAILS.owner)!;
  b.setOrgRole(org.id, owner.id, "viewer");
  await t.store.loadMe();
  return org;
}

test("openOrg loads the organization and every page of its projects; a cap says so", async () => {
  const t = await controllable(EMAILS.owner, { maxListPages: 1 });
  const org = await ownKeysOrg(t, 201);
  await t.store.openOrg(org.id);
  assert.equal(t.store.org.value?.billingMode, "byok");
  assert.equal(t.store.orgProjects.value.length, 200);
  assert.equal(t.store.truncated.value.has("orgProjects"), true);
  // The seed's organization fits in a page: the mark goes.
  await t.store.openOrg(t.demo.orgId);
  assert.equal(t.store.org.value?.name, "Example Org");
  assert.deepEqual(t.store.orgProjects.value.map((p) => p.name), ["Fine-tuning lab", "Second project"]);
  assert.equal(t.store.truncated.value.has("orgProjects"), false);
});

test("openOrg: a later navigation wins; signing out forgets the organization", async () => {
  const t = await controllable(EMAILS.owner);
  const org = await ownKeysOrg(t);
  t.hold(new RegExp(`GET /v1/orgs/${org.id}$`), true);
  const slow = t.store.openOrg(org.id);
  await t.store.openOrg(t.demo.orgId);
  t.release();
  await slow;
  assert.equal(t.store.orgId.value, t.demo.orgId);
  assert.equal(t.store.org.value?.name, "Example Org");
  assert.equal(t.store.error.value, null);
  await t.store.signOut();
  assert.deepEqual([t.store.orgId.value, t.store.org.value, t.store.orgProjects.value], [null, null, []]);
});

test("Home lists the organizations someone has a role in, with links", async () => {
  const t = await controllable(EMAILS.owner);
  const page = mountApp(win, t.store, "/", new FakeTimers());
  await settle();
  assert.match(page.text(), /Your organizations Example Org owner/);
  assert.equal(page.q(`a[href="/o/${t.demo.orgId}"]`) === null, false);
  page.unmount();
  const m = await controllable(EMAILS.member);
  const home = mountApp(win, m.store, "/", new FakeTimers());
  await settle();
  assert.doesNotMatch(home.text(), /Your organizations/);
  home.unmount();
});

test("a resold organization: credit, bought from us", async () => {
  const t = await controllable(EMAILS.owner);
  const page = mountApp(win, t.store, `/o/${t.demo.orgId}`, new FakeTimers());
  await settle();
  const text = page.text();
  assert.match(text, /Example Org Billing Credit is bought from us and assigned to projects as budgets\./);
  assert.match(text, /Credit not yet assigned to projects \$2,900\.00 Credit bought in all \$5,000\.00/);
  assert.match(text, /Projects \(2\) Project Budget Allocated Spent Fine-tuning lab \$2,000\.00 \$200\.20 \$0\.00 Second project \$100\.00 \$5\.00 \$0\.00/);
  assert.equal(page.q(`a[href="/p/${t.demo.projectId}"]`) === null, false);
  page.unmount();
});

test("Spent is the total charged, provider cost and our margin together", async () => {
  const t = await controllable(EMAILS.owner);
  const b = t.demo.backend;
  // A member runs a machine for half an hour.
  const owner = b.currentUserId;
  b.currentUserId = [...b.users.values()].find((u) => u.email === EMAILS.member)!.id;
  assert.equal(b.request("POST", `/v1/projects/${t.demo.projectId}/machines`, {}, { gpuType: "L4" }).status, 200);
  b.advance(30 * 60_000);
  b.currentUserId = owner;
  const page = mountApp(win, t.store, `/o/${t.demo.orgId}`, new FakeTimers());
  await settle();
  const spent = t.store.orgProjects.value.find((p) => p.id === t.demo.projectId)!.spent;
  assert.ok(spent.margin > 0 && spent.providerCost > 0);
  const row = page.qa<HTMLTableRowElement>("table.projects tbody tr").find((tr) => tr.textContent?.includes("Fine-tuning lab"))!;
  assert.equal(row.querySelectorAll("td")[3]?.textContent, formatUsd(spent.total));
  assert.notEqual(formatUsd(spent.total), formatUsd(spent.providerCost));
  page.unmount();
});

test("an organization on its own provider accounts: a budget, metered use, and never 'no charge'", async () => {
  const t = await controllable(EMAILS.owner);
  const org = await ownKeysOrg(t);
  const page = mountApp(win, t.store, `/o/${org.id}`, new FakeTimers());
  await settle();
  const text = page.text();
  assert.match(text, /Own keys org Billing Machines run on your organization's own provider accounts, which the providers bill\. Our flat fee is set in your agreement\. Project budgets limit what each project may spend\./);
  // A byok organization pays a flat fee by agreement: the paragraph must say so.
  assert.match(BILLING_WORDS.byok.about, /\bflat fee\b/);
  assert.match(text, /Budget not yet assigned to projects \$800\.00 Budget granted in all \$900\.00/);
  assert.match(text, /Projects \(1\) Project Budget Allocated Metered use Lab 0 \$100\.00 \$0\.00 \$0\.00/);
  assert.doesNotMatch(text, /credit/i);
  for (const words of Object.values(BILLING_WORDS)) {
    for (const w of Object.values(words)) assert.doesNotMatch(w, /no charge|no markup|free|without (a )?fee/i, w);
  }
  page.unmount();
});

test("an organization someone has no role in isn't asked for", async () => {
  const t = await controllable(EMAILS.member);
  t.log.length = 0;
  const page = mountApp(win, t.store, `/o/${t.demo.orgId}`, new FakeTimers());
  await settle();
  assert.match(page.text(), /Not found Your projects/);
  assert.deepEqual(t.log.filter((x) => x.includes("/v1/orgs/")), []);
  page.unmount();
});

test("an organization with no projects says so", async () => {
  const t = await controllable(EMAILS.owner);
  const org = await ownKeysOrg(t, 0);
  const page = mountApp(win, t.store, `/o/${org.id}`, new FakeTimers());
  assert.match(page.text(), /Loading/);
  await settle();
  assert.match(page.text(), /Projects \(0\) No projects yet\./);
  page.unmount();
});

test("a failure answering an earlier navigation stays silent", async () => {
  const t = await controllable(EMAILS.owner);
  const org = await ownKeysOrg(t);
  t.respondOnce(new RegExp(`^GET /v1/orgs/${org.id}$`), () => Response.json({ error: { code: "internal", message: "late failure" } }, { status: 500 }));
  t.hold(new RegExp(`^GET /v1/orgs/${org.id}$`), true);
  const slow = t.store.openOrg(org.id);
  await t.store.openOrg(t.demo.orgId);
  t.release();
  await slow;
  assert.equal(t.store.error.value, null);
  assert.equal(t.store.org.value?.name, "Example Org");
});

test("a failed load shows its error", async () => {
  const t = await controllable(EMAILS.owner);
  t.respondOnce(/^GET \/v1\/orgs\/[^/]+$/, () => Response.json({ error: { code: "internal", message: "the database is down" } }, { status: 500 }));
  await t.store.openOrg(t.demo.orgId);
  assert.equal(t.store.error.value, "the database is down");
  assert.equal(t.store.org.value, null);
});

test("the very first render after moving between organizations is Loading, both ways", async () => {
  const t = await controllable(EMAILS.owner);
  const org = await ownKeysOrg(t);
  const page = mountApp(win, t.store, `/o/${t.demo.orgId}`, new FakeTimers());
  await settle();
  assert.match(page.text(), /Example Org Billing Credit is bought/);
  page.show(`/o/${org.id}`); // resold -> byok: checked before anything else runs
  assert.match(page.text(), /Loading/);
  assert.doesNotMatch(page.text(), /Example Org|Credit/);
  await settle();
  assert.match(page.text(), /Own keys org Billing Machines run on your organization's own provider accounts/);
  page.show(`/o/${t.demo.orgId}`); // and back: byok -> resold
  assert.match(page.text(), /Loading/);
  assert.doesNotMatch(page.text(), /Own keys org|Budget/);
  await settle();
  assert.match(page.text(), /Example Org Billing Credit is bought/);
  page.unmount();
});

test("moving to another organization shows Loading, never the last one's figures", async () => {
  const t = await controllable(EMAILS.owner);
  const org = await ownKeysOrg(t);
  const page = mountApp(win, t.store, `/o/${t.demo.orgId}`, new FakeTimers());
  await settle();
  assert.match(page.text(), /Example Org/);
  t.hold(new RegExp(`GET /v1/orgs/${org.id}$`), true);
  page.show(`/o/${org.id}`);
  await settle();
  assert.match(page.text(), /Loading/);
  assert.doesNotMatch(page.text(), /Example Org Billing/);
  t.release();
  await settle();
  assert.match(page.text(), /Own keys org Billing/);
  page.unmount();
});

test("more projects than a page load reads: the count and a notice", async () => {
  const t = await controllable(EMAILS.owner, { maxListPages: 1 });
  const org = await ownKeysOrg(t, 201);
  const page = mountApp(win, t.store, `/o/${org.id}`, new FakeTimers());
  await settle();
  assert.match(page.text(), /Projects \(200\+\) Showing the first 200 projects\./);
  page.unmount();
});
