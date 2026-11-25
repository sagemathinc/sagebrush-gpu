// Choosing a person's team in the manager's people table, in a DOM (happy-dom), against
// the mock; and the store's action.

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
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}/manage`, new FakeTimers());
  await settle();
  const select = (who: string) => page.q<HTMLSelectElement>(`select[aria-label="Team for ${who}"]`);
  const teamOf = (who: string) => {
    const m = [...t.demo.backend.members.values()].find((x) => x.email === who && x.projectId === t.demo.projectId)!;
    return m.teamId === null ? null : (t.demo.backend.teams.get(m.teamId)?.name ?? "?");
  };
  const choose = async (who: string, label: string) => {
    const el = select(who)!;
    const option = [...el.options].find((o) => o.textContent === label)!;
    el.value = option.value;
    page.change(el);
    await settle();
  };
  return { t, page, select, teamOf, choose };
}

test("a manager chooses a person's team, or none; the table follows", async () => {
  const m = await open();
  const ada = EMAILS.member;
  assert.equal(m.teamOf(ada), "Team Qwen");
  const el = m.select(ada)!;
  assert.deepEqual([...el.options].map((o) => o.textContent), ["No team", "Team Llama", "Team Qwen"]);
  assert.equal(el.options[el.selectedIndex]?.textContent, "Team Qwen");
  await m.choose(ada, "Team Llama");
  assert.equal(m.teamOf(ada), "Team Llama");
  assert.equal(m.select(ada)!.options[m.select(ada)!.selectedIndex]?.textContent, "Team Llama");
  assert.equal(m.t.store.teams.value.find((x) => x.name === "Team Llama")?.memberCount, 3); // the teams table counts her too
  await m.choose(ada, "No team");
  assert.equal(m.teamOf(ada), null);
  assert.equal(m.select(ada)!.value, "");
  m.page.unmount();
});

test("only rows the membership rules let this person change get a choice", async () => {
  const m = await open();
  // A manager can't change the owner or another manager; the team shows as text there.
  assert.equal(m.select(EMAILS.owner) === null, true);
  assert.equal(m.select(EMAILS.manager) === null, true);
  assert.equal(m.select(EMAILS.assistant) === null, false);
  m.page.unmount();
  // An owner can change everyone.
  const o = await open(EMAILS.owner);
  assert.equal(o.select(EMAILS.manager) === null, false);
  o.page.unmount();
  // An assistant sees names only.
  const a = await open(EMAILS.assistant);
  assert.equal(a.page.qa("table.members select").length, 0);
  assert.match(a.page.text(), /Team Qwen/);
  a.page.unmount();
});

test("with no teams there's nothing to choose", async () => {
  const m = await open();
  for (const team of [...m.t.demo.backend.teams.values()]) m.t.demo.backend.teams.delete(team.id);
  for (const member of m.t.demo.backend.members.values()) member.teamId = null;
  await m.t.store.refresh();
  await settle();
  assert.equal(m.page.qa("table.members select").length, 0);
  m.page.unmount();
});

test("the choice is disabled while it's being saved; a refusal shows why and the table keeps the old team", async () => {
  const m = await open();
  const ada = EMAILS.member;
  m.t.hold(/^PATCH /, true);
  const el = m.select(ada)!;
  el.value = [...el.options].find((o) => o.textContent === "Team Llama")!.value;
  m.page.change(el);
  await settle();
  assert.equal(m.select(ada)?.disabled, true);
  m.t.release();
  await settle();
  assert.equal(m.select(ada)?.disabled, false);
  assert.equal(m.teamOf(ada), "Team Llama");

  m.t.respondOnce(/^PATCH /, () => Response.json({ error: { code: "badRequest", message: "no such team in this project" } }, { status: 400 }));
  await m.choose(ada, "Team Qwen");
  assert.match(m.page.text(), /no such team in this project/);
  assert.equal(m.teamOf(ada), "Team Llama");
  assert.equal(m.select(ada)!.options[m.select(ada)!.selectedIndex]?.textContent, "Team Llama");
  m.page.unmount();
});

test("store.setMemberTeam sends the team (or null), then reloads; it needs a project", async () => {
  const t = await controllable(EMAILS.manager);
  assert.equal(await t.store.setMemberTeam("mbr_x", null), false);
  assert.deepEqual(t.log, ["GET /v1/me"]);
  await t.store.openProject(t.demo.projectId);
  const ada = t.store.members.value.find((x) => x.email === EMAILS.member)!;
  const llama = t.store.teams.value.find((x) => x.name === "Team Llama")!;
  t.log.length = 0;
  assert.equal(await t.store.setMemberTeam(ada.id, llama.id), true);
  assert.equal(t.log[0], `PATCH /v1/projects/${t.demo.projectId}/members/${ada.id}`);
  assert.equal(t.store.members.value.find((x) => x.id === ada.id)?.teamId, llama.id);
  assert.equal(await t.store.setMemberTeam(ada.id, null), true);
  assert.equal(t.store.members.value.find((x) => x.id === ada.id)?.teamId, null);
  assert.equal(await t.store.setMemberTeam(ada.id, "team_nope"), false);
  assert.match(t.store.error.value ?? "", /no such team in this project/);
});
