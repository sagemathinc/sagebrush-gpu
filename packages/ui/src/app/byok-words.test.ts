// A project of an organization on its own provider accounts (byok): every page shows
// prices as one rate billed by the provider, and spend as metered use; nothing says
// "service" (there is none) or claims no charge.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import { seedDemo } from "../mock/seed.ts";
import { installDom, mountApp, settle, unmountAll } from "./domkit.ts";
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
const FORBIDDEN = /service|no charge|no markup|free of charge|without (a )?fee/i;

/** A byok organization's project, with the seed's member and manager in it, a team, and a machine running. */
async function byokProject(email: string) {
  const t = await controllable(email);
  const b = t.demo.backend;
  const org = b.addOrg("Own keys org", 0, 1_000_000_000, "byok");
  // (a byok organization launches only where it has a key)
  for (const provider of ["runpod", "hyperstack"] as const) {
    b.credentials.set(`${org.id}|${provider}`, { fingerprint: "0badf00d", setBy: EMAILS.owner, setAt: b.now(), lastCheckedAt: b.now(), status: "ok" });
  }
  const project = b.addProject(org.id, {
    name: "Own keys lab",
    budget: 500_000_000,
    startsAt: "2027-01-01T00:00:00.000Z",
    endsAt: "2027-12-01T00:00:00.000Z",
    policy: { allowedGpuTypes: ["L4"], allowedProviders: ["runpod", "hyperstack"] },
  });
  const user = (e: string) => [...b.users.values()].find((u) => u.email === e)!;
  const ada = b.addMember(project.id, { email: EMAILS.member, userId: user(EMAILS.member).id, allocation: 25_000_000 });
  b.addMember(project.id, { email: EMAILS.manager, role: "manager", userId: user(EMAILS.manager).id });
  b.addTeam(project.id, "Team Own", [ada.id], 10_000_000);
  // Ada starts a machine on her allocation and it runs for a while.
  const me = b.currentUserId;
  b.currentUserId = user(EMAILS.member).id;
  assert.equal(b.request("POST", `/v1/projects/${project.id}/machines`, {}, { gpuType: "L4" }).status, 200);
  b.advance(30 * 60_000);
  b.currentUserId = me;
  await t.store.loadMe();
  return { t, project };
}

test("the member's page: GPU prices, the machine and the meter, in byok words", async () => {
  const { t, project } = await byokProject(EMAILS.member);
  const page = mountApp(win, t.store, `/p/${project.id}`, new FakeTimers());
  await settle();
  assert.equal(t.store.billingMode.value, "byok");
  const text = page.text();
  assert.match(text, /\$0\.\d\d\/h billed by the provider to your organization/); // the GPU row
  assert.match(text, /Metered so far: \$\d/); // the machine card
  assert.match(text, /runpod · [^·]+ · \$0\.\d\d\/h|hyperstack · [^·]+ · \$0\.\d\d\/h/);
  assert.doesNotMatch(text, FORBIDDEN);
  assert.doesNotMatch(text, /Cost so far/);
  page.unmount();
});

test("the manager's page: totals, people, teams and machines, in byok words", async () => {
  const { t, project } = await byokProject(EMAILS.manager);
  const page = mountApp(win, t.store, `/p/${project.id}/manage`, new FakeTimers());
  await settle();
  const text = page.text();
  assert.match(text, /Metered use \$\d/); // the budget summary, with no split
  assert.equal(page.qa("table.members th").some((th) => th.textContent?.trim() === "Metered use"), true);
  assert.equal(page.qa("table.teams th").some((th) => th.textContent?.trim() === "Metered use"), true);
  assert.equal(page.qa("table.machines th").some((th) => th.textContent?.trim() === "Metered so far"), true);
  assert.match(page.q("table.machines tbody td.small")!.textContent!, /^\$0\.\d\d\/h$/);
  assert.doesNotMatch(text, FORBIDDEN);
  assert.doesNotMatch(text, /Spent|Cost so far/);
  page.unmount();
});

test("a resold project keeps the provider and service parts", async () => {
  const t = await controllable(EMAILS.manager);
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}/manage`, new FakeTimers());
  await settle();
  assert.equal(t.store.billingMode.value, "resold");
  assert.match(page.text(), /Spent \$\d[\d,.]* \(provider \$[\d,.]+ \+ service \$[\d,.]+\)/);
  assert.equal(page.qa("table.members th").some((th) => th.textContent?.trim() === "Spent"), true);
  assert.equal(page.qa("table.teams th").some((th) => th.textContent?.trim() === "Spent"), true);
  page.unmount();
});
