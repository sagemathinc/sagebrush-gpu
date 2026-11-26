// The saves on the project page, in a DOM (happy-dom), against the mock: the caller's own and
// their team's, naming, restoring (only while none of their machines runs, after a
// confirmation), the server's refusals, and "Save with a name…" on a running machine.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import { SNAPSHOT_REFUSALS, memberAreaKey, teamAreaKey } from "@sbgpu/api";
import { seedDemo } from "../mock/seed.ts";
import { BOOT_SECONDS, SAVE_BYTES, SAVE_BYTES_PER_SECOND } from "../mock/backend.ts";
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
const SEC = 1000;

async function open(email = EMAILS.member) {
  const t = await controllable(email);
  const b = t.demo.backend;
  const memberId = (e: string) => [...b.members.values()].find((m) => m.email === e && m.projectId === t.demo.projectId)!.id;
  const teamId = (name: string) => [...b.teams.values()].find((x) => x.name === name)!.id;
  const mine = memberAreaKey(t.demo.projectId, memberId(email));
  const team = (name: string) => teamAreaKey(t.demo.projectId, teamId(name));
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}`, new FakeTimers());
  await settle();
  const reload = async () => {
    await t.store.refresh();
    await settle();
  };
  const card = (area: "member" | "team") => page.q<HTMLElement>(`section.saves[data-area="${area}"]`);
  const rows = (area: "member" | "team") =>
    [...(card(area)?.querySelectorAll("tbody tr") ?? [])].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.replace(/\s+/g, " ").trim()).join(" | ").trim());
  const within = (area: "member" | "team", label: string | RegExp) =>
    ([...(card(area)?.querySelectorAll("button") ?? [])] as unknown as HTMLButtonElement[]).find((x) =>
      typeof label === "string" ? x.textContent?.trim() === label || x.getAttribute("aria-label") === label : label.test(x.getAttribute("aria-label") ?? x.textContent ?? ""),
    ) ?? null;
  const confirm = (answer: boolean) => {
    const asked: string[] = [];
    (win as unknown as { confirm: (m: string) => boolean }).confirm = (m: string) => (asked.push(m), answer);
    return asked;
  };
  const click = async (button: HTMLButtonElement | null) => {
    assert.ok(button, "no such button");
    button.click();
    await settle();
  };
  return { t, b, page, mine, team, reload, card, rows, within, confirm, click, memberId };
}

test("both areas newest first, with how each was made, its size, its name and the current one marked", async () => {
  const s = await open();
  assert.match(s.card("member")?.textContent ?? "", /No saves yet/, "an empty list says so");
  s.b.seedSnapshot(s.mine, { kind: "periodic" });
  s.b.advance(3600 * SEC);
  s.b.seedSnapshot(s.mine, { kind: "manual", name: "before I break it" });
  s.b.seedSnapshot(s.team("Team Qwen"), { kind: "final" });
  await s.reload();
  assert.match(s.card("member")!.textContent!, /Your saves/);
  assert.match(s.card("member")!.textContent!, /The newest 10 unnamed saves are kept, and every named one \(up to 5\)\. Name a save to keep it\./);
  assert.deepEqual(s.rows("member"), [
    "just now Current | Saved on request | 120.0 MB | before I break it Rename Remove name |",
    "1 h ago | Saved automatically | 120.0 MB | Name | Restore",
  ]);
  assert.match(s.card("team")!.textContent!, /Your team's saves/);
  assert.deepEqual(s.rows("team"), ["just now Current | Saved when the machine stopped | 120.0 MB | Name |"]);
  // the project's words for "team"
  s.page.unmount();
  // Grace has no team: her own saves only, and an empty list says so.
  const g = await open(EMAILS.lowMember);
  g.b.seedSnapshot(g.mine);
  await g.reload();
  assert.equal(g.card("member") !== null, true);
  assert.equal(g.card("team") === null, true, "no team, no team saves");
});

test("an area with no saves yet says so", async () => {
  const s = await open();
  s.b.seedSnapshot(s.team("Team Qwen"));
  await s.reload();
  assert.equal(s.card("team") !== null, true);
  assert.match(s.card("member")!.textContent!, /No saves yet\. A machine saves your work while it runs and when it stops\./);
});

test("naming: name a save, rename it, remove the name; a taken name or one over the limit is refused before sending", async () => {
  const s = await open();
  const first = s.b.seedSnapshot(s.mine);
  const second = s.b.seedSnapshot(s.mine, { name: "taken" });
  await s.reload();
  await s.click(s.within("member", /Name the save from/));
  const input = s.card("member")!.querySelector("input") as unknown as HTMLInputElement;
  s.page.type(input, "taken");
  await settle();
  assert.match(s.card("member")!.textContent!, /Another save here already has that name\./);
  assert.equal(s.within("member", "Save name")!.disabled, true);
  s.page.type(input, "  first good one  ");
  await settle();
  await s.click(s.within("member", "Save name"));
  assert.equal(s.b.snapshots.get(s.mine)!.find((x) => x.id === first)!.name, "first good one");
  assert.match(s.rows("member")[1]!, /first good one Rename Remove name/);
  // rename
  await s.click(s.within("member", "Rename first good one"));
  s.page.type(s.card("member")!.querySelector("input") as unknown as HTMLInputElement, "renamed");
  await settle();
  await s.click(s.within("member", "Save name"));
  assert.equal(s.b.snapshots.get(s.mine)!.find((x) => x.id === first)!.name, "renamed");
  // remove a name
  await s.click(s.within("member", "Remove the name taken"));
  assert.equal(s.b.snapshots.get(s.mine)!.find((x) => x.id === second)!.name, null);
  // the limit, as the project sets it
  s.b.projects.get(s.t.demo.projectId)!.policy.snapshotNamedMax = 1;
  await s.reload();
  await s.click(s.within("member", /Name the save from/));
  s.page.type(s.card("member")!.querySelector("input") as unknown as HTMLInputElement, "another");
  await settle();
  assert.match(s.card("member")!.textContent!, /This workspace already has 1 named save, the most allowed\. Remove a name first\./);
  assert.equal(s.within("member", "Save name")!.disabled, true);
  await s.click(s.within("member", "Cancel"));
  assert.equal(s.card("member")!.querySelector("input") === null, true);
});

test("restore: only on a save that isn't current, after a confirmation that names it; it becomes the current save", async () => {
  const s = await open();
  const old = s.b.seedSnapshot(s.mine, { name: "good run" });
  s.b.advance(600 * SEC);
  s.b.seedSnapshot(s.mine);
  await s.reload();
  assert.equal(s.rows("member")[0]!.endsWith("|"), true, "no restore on the current save");
  const asked = s.confirm(false);
  await s.click(s.within("member", /Restore the save from/));
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /^Restore "good run" \(saved 10 min ago\) into your workspace\? It becomes the current save\. Nothing is deleted now: the save that's current stays in the list, so you can restore it again\. Later saves follow the usual rule: only the newest 10 unnamed saves are kept, so name it to keep it for good\.$/);
  assert.equal(s.b.snapshots.get(s.mine)!.length, 2, "declined: nothing sent");
  assert.equal(s.t.log.some((l) => /restore/.test(l)), false);
  s.confirm(true);
  await s.click(s.within("member", /Restore the save from/));
  const list = s.b.snapshots.get(s.mine)!;
  assert.equal(list.length, 3);
  assert.deepEqual([list[2]!.kind, list[2]!.restoredFrom], ["restore", old]);
  assert.match(s.rows("member")[0]!, /^just now Current \| Restored from the save of 10 min ago \| 120\.0 MB \| Name \|$/);
});

test("a restore deletes nothing: with keepLast 1, the unnamed save that was current is still listed; the next save prunes as usual; a team restore names the shared workspace", async () => {
  const s = await open();
  s.b.projects.get(s.t.demo.projectId)!.policy.snapshotKeepLast = 1;
  const named = s.b.seedSnapshot(s.mine, { name: "A" });
  const current = s.b.seedSnapshot(s.mine);
  await s.reload();
  const asked = s.confirm(true);
  await s.click(s.within("member", /Restore "?A"?|Restore the save from/));
  assert.match(asked[0]!, /Nothing is deleted now: the save that's current stays in the list, so you can restore it again\. Later saves follow the usual rule: only the newest 1 unnamed saves are kept, so name it to keep it for good\.$/);
  const after = s.b.snapshots.get(s.mine)!.map((x) => x.id);
  assert.equal(after.length, 3);
  assert.equal(after.includes(current), true, "the unnamed save that was current is still listed");
  assert.equal(after.includes(named), true);
  assert.equal(s.rows("member").length, 3);
  // the next normal save prunes as usual: one unnamed save kept, and the named one
  s.b.seedSnapshot(s.mine);
  assert.equal(s.b.snapshots.get(s.mine)!.length, 2);
  assert.equal(s.b.snapshots.get(s.mine)!.some((x) => x.id === named), true);
  // a team restore names the team's shared workspace
  s.b.seedSnapshot(s.team("Team Qwen"), { name: "older" });
  s.b.seedSnapshot(s.team("Team Qwen"));
  await s.reload();
  const teamAsked = s.confirm(false);
  await s.click(s.within("team", /Restore the save from/));
  assert.match(teamAsked[0]!, / into your team's shared workspace\? /);
});

test("while one of your machines runs, no restore is offered, and the page says why", async () => {
  const s = await open();
  s.b.seedSnapshot(s.mine);
  s.b.seedSnapshot(s.mine);
  s.b.seedSnapshot(s.team("Team Qwen"));
  s.b.seedSnapshot(s.team("Team Qwen"));
  await s.reload();
  assert.equal(s.within("member", /Restore the save from/) !== null, true);
  await s.t.store.start("L4");
  await settle();
  for (const area of ["member", "team"] as const) {
    assert.equal(s.within(area, /Restore the save from/) === null, true, area);
    assert.match(s.card(area)!.textContent!, /To restore a save, stop your machines first: a running machine keeps writing to your workspace and your team's\./, area);
  }
  const id = s.t.store.machines.value[0]!.id;
  s.b.advance(BOOT_SECONDS * SEC);
  await s.t.store.stop(id);
  s.b.advance(60 * SEC);
  await s.reload();
  assert.equal(s.within("member", /Restore the save from/) !== null, true, "stopped: offered again");
  assert.doesNotMatch(s.card("member")!.textContent!, /stop your machines first/);
});

test("the server's refusals show in its words: a teammate's running machine, and a restore already in progress", async () => {
  // Edsger has no machine of his own; Alan, on his team, has one running.
  const s = await open("edsger@example.org");
  s.b.seedSnapshot(s.team("Team Llama"));
  s.b.seedSnapshot(s.team("Team Llama"));
  s.b.seedSnapshot(s.mine);
  s.b.seedSnapshot(s.mine);
  const alan = await controllable(EMAILS.teamMember); // (another store on another backend: not this one)
  void alan;
  s.b.signInAs(EMAILS.teamMember);
  s.b.request("POST", `/v1/projects/${s.t.demo.projectId}/machines`, {}, { gpuType: "L4" });
  s.b.signInAs("edsger@example.org");
  await s.reload();
  s.confirm(true);
  await s.click(s.within("team", /Restore the save from/));
  assert.match(s.page.text(), new RegExp(SNAPSHOT_REFUSALS.writerRunning.message.replace(/[.']/g, (c) => `\\${c}`)));
  // a restore of his own workspace already in progress elsewhere
  s.b.holdRestore(s.mine);
  await s.click(s.within("member", /Restore the save from/));
  assert.match(s.page.text(), /A restore of this workspace is already in progress\./);
});

test("while a restore is in flight, the area's restore buttons wait and the page says machines can't start yet", async () => {
  const s = await open();
  s.b.seedSnapshot(s.mine);
  s.b.seedSnapshot(s.mine);
  await s.reload();
  s.confirm(true);
  const release = s.t.gate(/POST \/v1\/projects\/[^/]+\/snapshots\/[^/]+\/restore/);
  const button = s.within("member", /Restore the save from/)!;
  button.click();
  await settle();
  assert.match(s.card("member")!.textContent!, /Restoring… Your machines can't start until it finishes\./);
  assert.equal(s.within("member", /Restore the save from/)?.disabled ?? true, true);
  release();
  await settle();
  await settle();
  assert.doesNotMatch(s.card("member")!.textContent!, /Restoring…/);
});

test("Save with a name…: a running machine saves now, and the save it makes carries the name", async () => {
  const s = await open();
  s.b.seedSnapshot(s.mine, { name: "taken" });
  await s.t.store.start("L4");
  s.b.advance(BOOT_SECONDS * SEC);
  await s.reload();
  await s.click(s.page.button("Save with a name…"));
  const input = s.page.q<HTMLInputElement>('input[aria-label="Name for this save"]')!;
  s.page.type(input, "taken");
  await settle();
  assert.match(s.page.text(), /Another save here already has that name\./);
  assert.equal(s.page.button("Save now") !== null, true);
  s.page.type(input, "checkpoint");
  await settle();
  const saveButtons = s.page.qa<HTMLButtonElement>("span.save-with-name button");
  await s.click(saveButtons.find((x) => x.textContent?.trim() === "Save now") ?? null);
  assert.ok(s.t.log.some((l) => /POST \/v1\/machines\/[^/]+\/save/.test(l)));
  assert.deepEqual(s.t.clientBodies.filter((x) => x.includes('"name"')).map((x) => JSON.parse(x)), [{ name: "checkpoint" }]);
  s.b.advance(Math.ceil(SAVE_BYTES / SAVE_BYTES_PER_SECOND) * SEC);
  await s.reload();
  assert.match(s.rows("member")[0]!, /^just now Current \| Saved on request \| 120\.0 MB \| checkpoint Rename Remove name \|$/);
  assert.equal(s.page.q('input[aria-label="Name for this save"]') === null, true, "the field closed");
});

test("saves belong to the project shown: answers for a project left meanwhile are dropped, and a new project starts empty", async () => {
  const s = await open();
  s.b.seedSnapshot(s.mine);
  await s.reload();
  const other = [...s.b.projects.values()].find((p) => p.name === "Second project")!.id;
  // a rename whose list reload answers after the page has moved to the other project
  const hold = s.t.gate(new RegExp(`GET /v1/projects/${s.t.demo.projectId}/snapshots\\?area=member`));
  const naming = s.t.store.nameSave("member", s.b.snapshots.get(s.mine)![0]!.id, "late");
  await settle();
  const moving = s.t.store.openProject(other);
  const shown = () => s.t.store.saves.value;
  assert.deepEqual(shown(), { member: null, team: null }, "a new project starts with no saves shown");
  await moving;
  assert.deepEqual(shown().member?.items, [], "the other project's (empty) list");
  hold();
  await naming;
  assert.deepEqual(shown().member?.items, [], "the first project's late answer is dropped");
  // the same, answering before the new project has asked for any saves (its load is held)
  await s.t.store.openProject(s.t.demo.projectId);
  const holdReload = s.t.gate(new RegExp(`GET /v1/projects/${s.t.demo.projectId}/snapshots\\?area=member`));
  const renaming = s.t.store.nameSave("member", s.b.snapshots.get(s.mine)![0]!.id, "later");
  await settle();
  const holdLoad = s.t.gate(new RegExp(`GET /v1/projects/${other}$`));
  const moving2 = s.t.store.openProject(other);
  holdReload();
  await renaming;
  assert.deepEqual(shown(), { member: null, team: null }, "nothing from the project left, even before the new one reads");
  holdLoad();
  await moving2;
  assert.deepEqual(shown().member?.items, []);
});

test("only the latest read of an area's saves is shown: an older reload, or a poll, answering after a newer name changes nothing", async () => {
  const s = await open();
  const a = s.b.seedSnapshot(s.mine);
  const z = s.b.seedSnapshot(s.mine);
  await s.reload();
  const list = new RegExp(`GET /v1/projects/${s.t.demo.projectId}/snapshots\\?area=member`);
  const nameOf = (id: string) => s.t.store.saves.value.member!.items.find((x) => x.id === id)!.name;
  // (1) the first rename's reload is held; a second rename completes; then the first answers
  const hold = s.t.gate(list);
  const first = s.t.store.nameSave("member", a, "name A");
  await settle();
  assert.equal(await s.t.store.nameSave("member", z, "name B"), true);
  assert.equal(nameOf(z), "name B");
  hold();
  await first;
  assert.equal(nameOf(z), "name B", "the older reload doesn't undo the newer name");
  assert.equal(nameOf(a), "name A");
  // (2) a polling refresh's read is held; a rename completes; then the poll answers
  const holdPoll = s.t.gate(list);
  const poll = s.t.store.refresh();
  await settle();
  assert.equal(await s.t.store.nameSave("member", a, "fresh name"), true);
  assert.equal(nameOf(a), "fresh name");
  holdPoll();
  await poll;
  assert.equal(nameOf(a), "fresh name", "the older poll doesn't undo the name");
  assert.equal(s.b.snapshots.get(s.mine)!.find((x) => x.id === a)!.name, "fresh name");
});
