// The settings section on the manager's page, in a DOM (happy-dom), against the mock.

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

async function open(email = EMAILS.manager) {
  const t = await controllable(email);
  const timers = new FakeTimers();
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}/manage`, timers);
  await settle();
  const project = () => t.demo.backend.projects.get(t.demo.projectId)!;
  const input = (id: string) => page.q<HTMLInputElement>(`#${id}`);
  const status = () => page.q("details.settings p[aria-live]")?.textContent ?? null;
  const save = async () => {
    page.button("Save changes")!.click();
    await settle();
  };
  const patches = () => t.log.filter((x) => x === `PATCH /v1/projects/${t.demo.projectId}`).length;
  return { t, page, timers, project, input, status, save, patches };
}

test("only managers get the settings, filled from the project", async () => {
  const m = await open();
  assert.equal(m.page.q("details.settings") === null, false);
  assert.equal(m.input("settings-name")?.value, "Fine-tuning lab");
  assert.equal(m.input("settings-gpu-types")?.value, "L4, A6000, A100-80GB, A10");
  assert.equal(m.input("settings-provider-runpod")?.checked, true);
  assert.equal(m.input("settings-provider-nebius")?.checked, false);
  assert.equal(m.input("settings-idleStopMinutes")?.value, "30");
  assert.equal(m.input("settings-price")?.value, "2.00");
  assert.equal(m.page.q<HTMLTextAreaElement>("#settings-setup-script")?.value, "pip install transformers peft datasets");
  assert.equal(m.input("settings-custom-labels")?.checked, true);
  assert.equal(m.input("settings-label-member")?.value, "student");
  assert.equal(m.status(), "No changes.");
  assert.equal(m.page.button("Save changes")?.disabled, true);
  assert.equal(m.page.button("Discard changes")?.disabled, true);
  m.page.unmount();

  const a = await open(EMAILS.assistant);
  assert.match(a.page.text(), /Fine-tuning lab: manage/);
  assert.equal(a.page.q("details.settings") === null, true);
  a.page.unmount();
});

test("Save sends what was edited, and leaves alone what someone else changed meanwhile", async () => {
  const m = await open();
  m.project().policy.maxConcurrentMachines = 77; // another manager, after the form was filled
  m.page.type(m.input("settings-idleStopMinutes"), "45");
  await settle();
  assert.equal(m.status(), "");
  await m.save();
  assert.equal(m.patches(), 1);
  assert.equal(m.project().policy.idleStopMinutes, 45);
  assert.equal(m.project().policy.maxConcurrentMachines, 77);
  assert.equal(m.status(), "Saved.");
  // The form is filled again from the saved project: the other change shows now.
  assert.equal(m.input("settings-maxConcurrentMachines")?.value, "77");
  assert.equal(m.page.button("Save changes")?.disabled, true);
  m.page.unmount();
});

test("a value out of range says so, can't be saved, and Discard puts the form back", async () => {
  const m = await open();
  m.page.type(m.input("settings-idleStopMinutes"), "4");
  await settle();
  assert.equal(m.status(), "Stop when idle for (minutes): a whole number from 5 to 1440");
  assert.equal(m.page.button("Save changes")?.disabled, true);
  assert.equal(m.page.button("Discard changes")?.disabled, false);
  m.page.button("Discard changes")!.click();
  await settle();
  assert.equal(m.input("settings-idleStopMinutes")?.value, "30");
  assert.equal(m.status(), "No changes.");
  assert.equal(m.patches(), 0);
  m.page.unmount();
});

test("polling doesn't overwrite what is being typed", async () => {
  const m = await open();
  m.page.type(m.input("settings-name"), "Spring lab");
  await settle();
  m.project().name = "Renamed elsewhere";
  await m.timers.run();
  await settle();
  assert.match(m.page.text(), /Renamed elsewhere: manage/); // the page did refresh
  assert.equal(m.input("settings-name")?.value, "Spring lab");
  await m.save();
  assert.equal(m.project().name, "Spring lab");
  m.page.unmount();
});

test("providers, where machines run, and the words", async () => {
  const m = await open();
  const nebius = m.input("settings-provider-nebius")!;
  nebius.checked = true;
  m.page.change(nebius);
  const runpod = m.input("settings-provider-runpod")!;
  runpod.checked = false;
  m.page.change(runpod);
  const locality = m.page.q<HTMLSelectElement>("#settings-locality")!;
  locality.value = "uk";
  m.page.change(locality);
  await settle();
  await m.save();
  assert.deepEqual(m.project().policy.allowedProviders, ["hyperstack", "nebius"]);
  assert.equal(m.project().policy.locality, "uk");

  // Back to the generic words: the page speaks of members again.
  assert.match(m.page.text(), /Invite students/);
  const custom = m.input("settings-custom-labels")!;
  custom.checked = false;
  m.page.change(custom);
  await settle();
  assert.equal(m.input("settings-label-member") === null, true);
  await m.save();
  assert.equal(m.project().labels, null);
  assert.match(m.page.text(), /Invite members/);
  m.page.unmount();
});

test("a refusal from the server keeps the edits and shows the error", async () => {
  const m = await open();
  m.page.type(m.input("settings-name"), "Spring lab");
  await settle();
  m.t.respondOnce(/^PATCH /, () => Response.json({ error: { code: "badRequest", message: "a project name has 1 to 200 characters" } }, { status: 400 }));
  await m.save();
  assert.match(m.page.text(), /a project name has 1 to 200 characters/);
  assert.equal(m.input("settings-name")?.value, "Spring lab");
  assert.notEqual(m.status(), "Saved.");
  assert.equal(m.project().name, "Fine-tuning lab");
  m.page.unmount();
});

test("moving to another project fills the form from that project", async () => {
  const m = await open();
  const manager = [...m.t.demo.backend.users.values()].find((u) => u.email === EMAILS.manager)!;
  m.t.demo.backend.addMember(m.t.otherId, { email: manager.email, role: "manager", userId: manager.id });
  await m.t.store.loadMe(); // the new role
  m.page.type(m.input("settings-name"), "Typed, then left");
  await settle();
  m.page.show(`/p/${m.t.otherId}/manage`);
  await settle();
  assert.match(m.page.text(), /Second project: manage/);
  assert.equal(m.input("settings-name")?.value, "Second project");
  assert.equal(m.input("settings-gpu-types")?.value, "A6000");
  m.page.unmount();
});
