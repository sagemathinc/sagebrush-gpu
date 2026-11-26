// Storage near or at its quota: the member's meter says so, the manager's people table
// flags it; and the manage page shows paused providers too.

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
const GIB = 1024 ** 3;
const QUOTA = 50 * GIB; // the default per-person quota

/** The world, with `used` bytes stored on each named member's own allocation, opened at `path`. */
async function world(email: string, used: Record<string, number>, path: "project" | "manage", seed: Parameters<typeof controllable>[2] = {}) {
  const t = await controllable(email, {}, seed);
  const b = t.demo.backend;
  for (const [who, bytes] of Object.entries(used)) {
    const member = [...b.members.values()].find((m) => m.email === who && m.projectId === t.demo.projectId)!;
    b.storageUsed.set(member.allocationId, bytes);
  }
  const page = mountApp(win, t.store, path === "manage" ? `/p/${t.demo.projectId}/manage` : `/p/${t.demo.projectId}`, new FakeTimers());
  await settle();
  return { t, b, page };
}

test("the member's meter: nothing below 90%, a warning from 90%, another at the quota", async () => {
  const low = await world(EMAILS.member, { [EMAILS.member]: 0.89 * QUOTA }, "project");
  assert.doesNotMatch(low.page.text(), /Storage is (nearly )?full/);
  unmountAll();
  const near = await world(EMAILS.member, { [EMAILS.member]: 0.9 * QUOTA }, "project");
  const card = near.page.q("[aria-label='Your allocation']");
  assert.match(card?.textContent ?? "", /Storage is nearly full\. Delete files you don't need, or ask an instructor to raise the limit\./);
  assert.equal(card?.querySelector("[role='status']")?.className, "warn storage-near");
  unmountAll();
  const full = await world(EMAILS.member, { [EMAILS.member]: QUOTA }, "project");
  assert.match(full.page.text(), /Storage is full: your workspace can't grow until you delete files or an instructor raises the limit\./);
  assert.doesNotMatch(full.page.text(), /nearly full/);
});

test("the manager's people table: used of quota, flagged nearly full or full; an empty one unflagged", async () => {
  const { t, page } = await world(EMAILS.manager, { [EMAILS.member]: 46 * GIB, [EMAILS.lowMember]: 51 * GIB, [EMAILS.teamMember]: 10 * GIB }, "manage");
  const cell = (email: string) => {
    const row = page.qa("table.members tbody tr").find((r) => r.textContent?.includes(email));
    return row?.querySelectorAll("td")[row.querySelectorAll("td").length - 2] ?? null; // storage is the column before the actions
  };
  assert.match(cell(EMAILS.member)?.textContent ?? "", /46(\.0)? GB of 50(\.0)? GB\s+nearly full/);
  assert.equal(cell(EMAILS.member)?.className, "storage-near");
  assert.match(cell(EMAILS.lowMember)?.textContent ?? "", /of 50(\.0)? GB\s+full/);
  assert.equal(cell(EMAILS.lowMember)?.className, "storage-full");
  assert.doesNotMatch(cell(EMAILS.teamMember)?.textContent ?? "", /full/);
  assert.equal(cell(EMAILS.teamMember)?.className, "");
  // An invited address with nothing stored: no flag.
  assert.match(cell("barbara@example.org")?.textContent ?? "", /^\s*0 B of 50(\.0)? GB\s*$/);
  // Before the meters are in (no quota known), bytes only: no quota and no flag.
  t.store.meters.value = [];
  await settle();
  assert.match(cell(EMAILS.lowMember)?.textContent ?? "", /^\s*0 B\s*$/);
  assert.equal(cell(EMAILS.lowMember)?.className, "");
});

test("the manage page shows paused providers too, with the reason for a manager", async () => {
  const t = await controllable(EMAILS.manager, {}, { billingMode: "byok" });
  const b = t.demo.backend;
  for (const provider of ["runpod", "hyperstack"] as const) {
    b.credentials.set(`${t.demo.orgId}|${provider}`, { fingerprint: "0badf00d", setBy: EMAILS.owner, setAt: b.now(), lastCheckedAt: b.now(), status: "ok" });
  }
  b.setKeyStatus(t.demo.orgId, "runpod", "revoked");
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}/manage`, new FakeTimers());
  await settle();
  assert.match(page.text(), /Fine-tuning lab: manage/);
  assert.ok(page.q("[aria-label='Paused providers']"), "the banner shows on the manage page");
  assert.match(page.text(), /Launches on RunPod are paused for this organization/);
  assert.match(page.text(), /The organization's RunPod key was revoked at the provider/);
});
