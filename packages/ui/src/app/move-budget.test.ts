// Moving budget on the organization's page, in a DOM (happy-dom), against the mock; and
// the store's action.

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

async function open(email = EMAILS.owner) {
  const t = await controllable(email);
  const page = mountApp(win, t.store, `/o/${t.demo.orgId}`, new FakeTimers());
  await settle();
  const b = t.demo.backend;
  const project = () => b.projects.get(t.demo.projectId)!;
  const unassigned = () => b.orgs.get(t.demo.orgId)!.unassignedCredit;
  const row = () => page.qa<HTMLTableRowElement>("table.projects tbody tr").find((tr) => tr.textContent?.includes("Fine-tuning lab"))!;
  const input = () => row().querySelector("input") as unknown as HTMLInputElement;
  const button = (label: string) => [...row().querySelectorAll("button")].find((x) => x.textContent === label) as unknown as HTMLButtonElement;
  const type = async (v: string) => {
    page.type(input(), v);
    await settle();
  };
  return { t, page, project, unassigned, row, input, button, type };
}

test("an org owner adds budget to a project and returns it; both figures follow", async () => {
  const m = await open();
  assert.equal(m.unassigned(), 2_900_000_000);
  assert.equal(m.project().budget, 2_000_000_000);
  // The seed allocates $200.20 of the $2,000 budget.
  assert.match(m.row().textContent!, /Up to \$2,900\.00 can be added; up to \$1,799\.80 can be returned\./);
  await m.type("100");
  m.button("Add to budget").click();
  await settle();
  assert.deepEqual([m.unassigned(), m.project().budget], [2_800_000_000, 2_100_000_000]);
  assert.match(m.page.text(), /Credit not yet assigned to projects \$2,800\.00/);
  assert.match(m.row().textContent!, /\$2,100\.00/);
  assert.equal(m.input().value, ""); // cleared for the next one
  await m.type("50.5");
  m.button("Return to the organization").click();
  await settle();
  assert.deepEqual([m.unassigned(), m.project().budget], [2_850_500_000, 2_049_500_000]);
  m.page.unmount();
});

test("the exact bounds: up to them is offered, beyond them isn't, and the page says why", async () => {
  const m = await open();
  await m.type("1799.80"); // exactly what isn't allocated
  assert.equal(m.button("Return to the organization").disabled, false);
  await m.type("1799.800001");
  assert.equal(m.button("Return to the organization").disabled, true);
  assert.equal(m.button("Add to budget").disabled, false); // still fine the other way
  assert.match(m.row().textContent!, /Only \$1,799\.80 of this project's budget isn't allocated\./);
  await m.type("2900"); // exactly what's unassigned
  assert.equal(m.button("Add to budget").disabled, false);
  await m.type("2900.000001");
  assert.equal(m.button("Add to budget").disabled, true);
  assert.match(m.row().textContent!, /The organization has \$2,900\.00 not yet assigned\./);
  for (const bad of ["0", "0.0000001", "ten"]) {
    await m.type(bad);
    assert.equal(m.button("Add to budget").disabled, true, bad);
    assert.equal(m.button("Return to the organization").disabled, true, bad);
  }
  await m.type("");
  assert.equal(m.row().querySelectorAll(".warn").length, 0); // nothing typed, nothing to say
  assert.deepEqual([m.unassigned(), m.project().budget], [2_900_000_000, 2_000_000_000]);
  m.page.unmount();
});

test("the control is disabled while a move is in flight; a refusal keeps the amount and shows why", async () => {
  const m = await open();
  await m.type("10");
  m.t.hold(/^POST \/v1\/projects\/[^/]+\/budget$/, true);
  m.button("Add to budget").click();
  await settle();
  assert.deepEqual([m.input().disabled, m.button("Add to budget").disabled, m.button("Return to the organization").disabled], [true, true, true]);
  m.t.release();
  await settle();
  assert.equal(m.input().disabled, false);
  assert.equal(m.project().budget, 2_010_000_000);

  await m.type("5");
  m.t.respondOnce(/^POST \/v1\/projects\/[^/]+\/budget$/, () => Response.json({ error: { code: "conflict", message: "the organization doesn't have that much unassigned credit" } }, { status: 409 }));
  m.button("Add to budget").click();
  await settle();
  assert.match(m.page.text(), /doesn't have that much unassigned credit/);
  assert.equal(m.input().value, "5");
  assert.equal(m.project().budget, 2_010_000_000);
  m.page.unmount();
});

test("only an owner of the organization gets the control", async () => {
  const t = await controllable(EMAILS.owner);
  const b = t.demo.backend;
  const viewer = b.addUser("viewer@example.org");
  b.setOrgRole(t.demo.orgId, viewer.id, "viewer");
  b.currentUserId = viewer.id;
  await t.store.sessionStarted();
  const page = mountApp(win, t.store, `/o/${t.demo.orgId}`, new FakeTimers());
  await settle();
  assert.match(page.text(), /Example Org Billing/);
  assert.equal(page.qa("table.projects input").length, 0);
  assert.equal(page.qa("table.projects th").some((th) => th.textContent === "Move budget"), false);
  page.unmount();
});

test("store.moveProjectBudget sends the signed amount, then reads both figures again; it needs an organization", async () => {
  const t = await controllable(EMAILS.owner);
  assert.equal(await t.store.moveProjectBudget(t.demo.projectId, 1), false);
  await t.store.openOrg(t.demo.orgId);
  t.log.length = 0;
  assert.equal(await t.store.moveProjectBudget(t.demo.projectId, -1_000_000), true);
  assert.equal(t.log[0], `POST /v1/projects/${t.demo.projectId}/budget`);
  assert.ok(t.log.includes(`GET /v1/orgs/${t.demo.orgId}`));
  assert.equal(t.store.org.value?.unassignedCredit, 2_901_000_000);
  assert.equal(t.store.orgProjects.value.find((p) => p.id === t.demo.projectId)?.budget, 1_999_000_000);
  assert.equal(await t.store.moveProjectBudget(t.demo.projectId, -1_999_000_000), false); // the whole budget: below what's allocated
  assert.match(t.store.error.value ?? "", /the budget would be below its allocations/); // $200.20 is allocated
});
