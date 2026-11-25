// The teams on the manager's page, in a DOM (happy-dom), against the mock.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import { seedDemo } from "../mock/seed.ts";
import { installDom, mountApp, settle, unmountAll } from "./domkit.ts";
import { formatUsd } from "../money.ts";
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
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}/manage`, new FakeTimers());
  await settle();
  const teams = () => [...t.demo.backend.teams.values()].filter((x) => x.projectId === t.demo.projectId);
  const byName = (name: string) => teams().find((x) => x.name === name);
  const allocation = (name: string) => t.demo.backend.allocations.get(byName(name)!.allocationId)!.amount;
  // Each row's cells, as their text, joined with " | ".
  const rows = () =>
    page.qa<HTMLTableRowElement>("table.teams tbody tr").map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent!.replace(/\s+/g, " ").trim()).join(" | "),
    );
  const section = () => page.qa<HTMLElement>("section.card").find((s) => s.querySelector("table.teams, .new-team") !== null || /No teams yet/.test(s.textContent ?? ""));
  const confirm = (answer: boolean) => {
    const asked: string[] = [];
    (win as unknown as { confirm: (m: string) => boolean }).confirm = (m: string) => (asked.push(m), answer);
    return asked;
  };
  return { t, page, teams, byName, allocation, rows, section, confirm };
}

test("staff see every team with its people, allocation, spend and remainder; only managers change them", async () => {
  const m = await open();
  assert.match(m.page.text(), /Teams \(2\)/);
  assert.equal(m.rows().length, 2);
  assert.equal(m.rows()[0], "Team Llama Rename | 2 | $ | $0.00 | $50.00 | Delete");
  assert.equal(m.rows()[1], "Team Qwen Rename | 1 | $ | $0.00 | $50.00 | Delete");
  assert.equal(m.page.q<HTMLInputElement>('input[aria-label="Allocation for Team Llama"]')?.value, "50.00");
  assert.equal(m.page.button("Create team")?.disabled, true); // no name yet
  m.page.unmount();

  const a = await open(EMAILS.assistant);
  assert.match(a.page.text(), /Teams \(2\)/);
  assert.equal(a.rows()[0], "Team Llama | 2 | $50.00 | $0.00 | $50.00");
  assert.equal(a.page.q('input[aria-label="Allocation for Team Llama"]') === null, true);
  assert.equal(a.page.button("Delete") === null, true);
  assert.equal(a.page.button(/Rename/) === null, true);
  assert.equal(a.page.q("#new-team-name") === null, true);
  a.page.unmount();
});

test("create a team: a fresh name and an allocation within what's left", async () => {
  const m = await open();
  m.page.type(m.page.q("#new-team-name"), "  Team Phi ");
  m.page.type(m.page.q("#new-team-allocation"), "12.50");
  await settle();
  assert.equal(m.page.button("Create team")?.disabled, false);
  m.page.button("Create team")!.click();
  await settle();
  assert.equal(m.allocation("Team Phi"), 12_500_000);
  assert.deepEqual(m.rows().map((r) => r.split(" Rename")[0]), ["Team Llama", "Team Phi", "Team Qwen"]);
  // The form is cleared for the next one.
  assert.equal(m.page.q<HTMLInputElement>("#new-team-name")?.value, "");
  assert.equal(m.page.q<HTMLInputElement>("#new-team-allocation")?.value, "0");
  m.page.unmount();
});

test("create a team: a name in use, or more than is left, is refused before sending", async () => {
  const m = await open();
  m.page.type(m.page.q("#new-team-name"), "Team Qwen");
  await settle();
  assert.match(m.section()!.textContent!, /There's already one called Team Qwen\./);
  assert.equal(m.page.button("Create team")?.disabled, true);
  m.page.type(m.page.q("#new-team-name"), "team qwen"); // another case is the same name to the server
  await settle();
  assert.match(m.section()!.textContent!, /There's already one called Team Qwen\./);
  assert.equal(m.page.button("Create team")?.disabled, true);
  m.page.type(m.page.q("#new-team-name"), "Team Phi");
  m.page.type(m.page.q("#new-team-allocation"), "1799.81"); // $1,799.80 is not yet allocated
  await settle();
  assert.match(m.section()!.textContent!, /That's more than the \$1,799\.80 not yet allocated\./);
  assert.equal(m.page.button("Create team")?.disabled, true);
  m.page.type(m.page.q("#new-team-allocation"), "1799.80");
  await settle();
  assert.equal(m.page.button("Create team")?.disabled, false);
  m.page.type(m.page.q("#new-team-allocation"), "ten");
  await settle();
  assert.equal(m.page.button("Create team")?.disabled, true);
  assert.equal(m.teams().length, 2);
  m.page.unmount();
});

test("rename a team; Escape cancels; another team's name is refused", async () => {
  const m = await open();
  m.page.button(/Rename/)!.click(); // Team Llama's
  await settle();
  const field = () => m.page.q<HTMLInputElement>('input[aria-label="New name for Team Llama"]');
  assert.equal(field()?.value, "Team Llama");
  m.page.type(field(), "Team Qwen");
  await settle();
  assert.match(m.rows()[0]!, /There's already one called Team Qwen\./);
  assert.equal(m.page.button("Save")?.disabled, true);
  field()!.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event);
  await settle();
  assert.equal(field() === null, true);
  assert.equal(m.byName("Team Llama") === undefined, false);

  m.page.button(/Rename/)!.click();
  await settle();
  m.page.type(field(), " Team Mu ");
  await settle();
  field()!.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter" }) as unknown as Event);
  await settle();
  assert.equal(m.byName("Team Mu") === undefined, false);
  assert.equal(m.byName("Team Llama"), undefined);
  assert.match(m.rows()[0]!, /^Team Mu Rename/);
  m.page.unmount();
});

test("a team's allocation is set from its field", async () => {
  const m = await open();
  const input = m.page.q<HTMLInputElement>('input[aria-label="Allocation for Team Qwen"]')!;
  m.page.type(input, "75");
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter" }) as unknown as Event);
  await settle();
  assert.equal(m.allocation("Team Qwen"), 75_000_000);
  assert.equal(m.page.q<HTMLInputElement>('input[aria-label="Allocation for Team Qwen"]')?.value, "75.00");
  m.page.unmount();
});

test("delete a team: asked first, saying what happens; No keeps it", async () => {
  const m = await open();
  let asked = m.confirm(false);
  m.page.qa<HTMLButtonElement>("table.teams button").find((b) => b.textContent === "Delete")!.click();
  await settle();
  assert.deepEqual(asked, ["Delete Team Llama? Its 2 students leave the team, and its $50.00 allocation returns to the course."]);
  assert.equal(m.teams().length, 2);
  asked = m.confirm(true);
  m.page.qa<HTMLButtonElement>("table.teams button").filter((b) => b.textContent === "Delete")[1]!.click();
  await settle();
  assert.deepEqual(asked, ["Delete Team Qwen? Its 1 student leaves the team, and its $50.00 allocation returns to the course."]);
  assert.deepEqual(m.teams().map((x) => x.name), ["Team Llama"]);
  assert.match(m.page.text(), /Teams \(1\)/);
  m.page.unmount();
});

test("a refusal from the server keeps what was typed and shows why", async () => {
  const m = await open();
  m.page.type(m.page.q("#new-team-name"), "Team Phi");
  m.page.type(m.page.q("#new-team-allocation"), "5");
  await settle();
  m.t.respondOnce(/^POST \/v1\/projects\/[^/]+\/teams$/, () => Response.json({ error: { code: "conflict", message: "a team with that name exists" } }, { status: 409 }));
  m.page.button("Create team")!.click();
  await settle();
  assert.match(m.page.text(), /a team with that name exists/);
  assert.equal(m.page.q<HTMLInputElement>("#new-team-name")?.value, "Team Phi");
  assert.equal(m.page.q<HTMLInputElement>("#new-team-allocation")?.value, "5");
  assert.equal(m.teams().length, 2);
  // A refused rename stays open with the typed name.
  m.page.button(/Rename/)!.click();
  await settle();
  const field = () => m.page.q<HTMLInputElement>('input[aria-label="New name for Team Llama"]');
  m.page.type(field(), "Team Mu");
  await settle();
  m.t.respondOnce(/^PATCH /, () => Response.json({ error: { code: "conflict", message: "the team was deleted" } }, { status: 409 }));
  m.page.button("Save")!.click();
  await settle();
  assert.match(m.page.text(), /the team was deleted/);
  assert.equal(field()?.value, "Team Mu");
  m.page.unmount();
});

test("each team's spend and remainder come from its meter", async () => {
  const m = await open();
  // A team member runs a machine on the team's allocation for half an hour.
  const b = m.t.demo.backend;
  const manager = b.currentUserId;
  b.currentUserId = [...b.users.values()].find((u) => u.email === EMAILS.teamMember)!.id;
  assert.equal(b.request("POST", `/v1/projects/${m.t.demo.projectId}/machines`, {}, { gpuType: "L4", chargeTo: "team" }).status, 200);
  b.advance(30 * 60_000);
  b.currentUserId = manager;
  await m.t.store.refresh();
  await settle();
  const team = m.t.store.teams.value.find((x) => x.memberCount === 2)!;
  const meter = m.t.store.meters.value.find((x) => x.allocationId === team.allocationId)!;
  assert.ok(meter.spent.total > 0 && meter.reserved > 0);
  const cells = m.rows()[0]!.split(" | ");
  assert.equal(cells[3], formatUsd(meter.spent.total));
  assert.equal(cells[4], formatUsd(50_000_000 - meter.spent.total - meter.reserved));
  m.page.unmount();
});

test("nothing is sent for an unchanged allocation or a rename to the same name; the name hint waits for typing", async () => {
  const m = await open();
  assert.doesNotMatch(m.section()!.textContent!, /A name has/);
  const input = m.page.q<HTMLInputElement>('input[aria-label="Allocation for Team Qwen"]')!;
  m.page.type(input, "50");
  await settle(); // typed, so the field holds an edit, of the same amount
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter" }) as unknown as Event);
  await settle();
  m.page.button(/Rename/)!.click();
  await settle();
  const field = m.page.q<HTMLInputElement>('input[aria-label="New name for Team Llama"]')!;
  field.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter" }) as unknown as Event);
  await settle();
  assert.equal(m.page.q('input[aria-label="New name for Team Llama"]') === null, true); // closed
  assert.deepEqual(m.t.log.filter((x) => /^(PUT|PATCH) /.test(x)), []);
  m.page.type(m.page.q("#new-team-name"), " ");
  await settle();
  assert.doesNotMatch(m.section()!.textContent!, /A name has/);
  m.page.unmount();
});

test("deleting a team with running machines says they will be stopped", async () => {
  const m = await open();
  const b = m.t.demo.backend;
  const manager = b.currentUserId;
  b.currentUserId = [...b.users.values()].find((u) => u.email === EMAILS.teamMember)!.id;
  assert.equal(b.request("POST", `/v1/projects/${m.t.demo.projectId}/machines`, {}, { gpuType: "L4", chargeTo: "team" }).status, 200);
  b.currentUserId = manager;
  await m.t.store.refresh();
  await settle();
  const asked = m.confirm(false);
  m.page.qa<HTMLButtonElement>("table.teams button").find((x) => x.textContent === "Delete")!.click();
  await settle();
  assert.deepEqual(asked, [
    "Delete Team Llama? Its 2 students leave the team, and its $50.00 allocation returns to the course. Its 1 running machine will be stopped.",
  ]);
  m.page.unmount();
});
