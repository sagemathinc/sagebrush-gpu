// The manager's page mounted in a DOM (happy-dom): what each role sees, and every control
// driven as a person would, against the mock backend.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import { seedDemo } from "../mock/seed.ts";
import { installDom, mountApp, settle } from "./domkit.ts";
import { controllable, FakeTimers } from "./testkit.ts";

let win: Window;
before(() => {
  win = installDom();
});
after(async () => {
  await win.happyDOM.close();
});

const EMAILS = seedDemo().emails;

async function open(email: string, path = "manage") {
  const t = await controllable(email);
  const page = mountApp(win, t.store, path === "manage" ? `/p/${t.demo.projectId}/manage` : `/p/${t.demo.projectId}`, new FakeTimers());
  await settle();
  return { t, page };
}

function allocationInput(page: ReturnType<typeof mountApp>, email: string) {
  return page.q<HTMLInputElement>(`input[aria-label="Allocation for ${email}"]`);
}

test("a manager sees the budget, everyone, invites and machines; Remove only where allowed", async () => {
  const { page } = await open(EMAILS.manager);
  const text = page.text();
  assert.match(text, /Fine-tuning lab: manage/);
  assert.match(text, /Budget \$2,000\.00 Allocated \$200\.20 Not yet allocated \$1,799\.80/);
  assert.match(text, /People \(8\)/);
  assert.match(text, /Invite students/);
  assert.match(text, /Machines \(0\)/);
  assert.equal(page.qa("table.members tbody tr").length, 8);
  // A manager may remove members and assistants, not managers or owners.
  const removable = page
    .qa<HTMLTableRowElement>("table.members tbody tr")
    .filter((tr) => [...tr.querySelectorAll("button")].some((b) => b.textContent === "Remove"))
    .map((tr) => tr.querySelectorAll("td")[1]!.textContent!.split(" ")[0]);
  assert.deepEqual(removable, ["ada@example.org", "alan@example.org", "assistant@example.org", "barbara@example.org", "edsger@example.org", "grace@example.org"]);
  // $0 staff allocations aren't flagged as used up; a low one is.
  const rowOf = (email: string) => page.qa<HTMLTableRowElement>("table.members tbody tr").find((tr) => tr.textContent?.includes(email))!;
  assert.equal(rowOf("manager@example.org").className, "");
  assert.equal(rowOf("ada@example.org").className, "band-ok");
  assert.equal(page.button("Stop all machines")?.disabled, true); // nothing running
  page.unmount();
});

test("an assistant's view is read-only", async () => {
  const { page } = await open(EMAILS.assistant);
  const text = page.text();
  assert.match(text, /read-only for TAs/);
  assert.doesNotMatch(text, /Invite students/);
  assert.equal(page.qa("table.members input").length, 0); // no checkboxes, no allocation inputs
  assert.equal(page.button("Remove"), null);
  assert.match(text, /ada@example\.org Ada Team Qwen \$25\.00/);
  assert.ok(page.button("Spend by member (CSV)"));
  page.unmount();
});

test("a member is turned away from the manager's page, and isn't offered it", async () => {
  const { page } = await open(EMAILS.member);
  assert.match(page.text(), /Only instructors and TAs can see this page\./);
  page.unmount();
  const own = await open(EMAILS.member, "project");
  assert.doesNotMatch(own.page.text(), /Manage this course/);
  own.page.unmount();
  const staff = await open(EMAILS.assistant, "project");
  assert.match(staff.page.text(), /Manage this course/);
  staff.page.unmount();
});

test("editing one allocation saves on blur, and refuses what isn't an amount", async () => {
  const { t, page } = await open(EMAILS.manager);
  const ada = allocationInput(page, "ada@example.org")!;
  assert.equal(ada.value, "25.00");
  page.type(ada, "25");
  page.blur(allocationInput(page, "ada@example.org"));
  await settle();
  assert.ok(!t.log.some((x) => x.startsWith("PUT ")), "an unchanged amount isn't sent");
  page.type(allocationInput(page, "ada@example.org"), "abc");
  await settle();
  assert.match(allocationInput(page, "ada@example.org")!.className, /invalid/);
  const before = t.log.length;
  page.blur(allocationInput(page, "ada@example.org"));
  await settle();
  assert.equal(t.log.length, before); // nothing sent
  page.type(allocationInput(page, "ada@example.org"), "$30");
  page.blur(allocationInput(page, "ada@example.org"));
  await settle();
  assert.ok(t.log.some((x) => /^PUT \/v1\/projects\/prj_\w+\/members\/mbr_\w+\/allocation$/.test(x)));
  assert.equal(allocationInput(page, "ada@example.org")!.value, "30.00");
  assert.match(page.text(), /Allocated \$205\.20/);
  page.unmount();
});

test("bulk: select, set or add, see the effect on the budget, apply", async () => {
  const { page } = await open(EMAILS.manager);
  const check = (email: string) => {
    page.q<HTMLInputElement>(`input[aria-label="Select ${email}"]`)!.click();
  };
  check("ada@example.org");
  check("alan@example.org");
  await settle();
  assert.match(page.text(), /2 selected:/);
  const amount = page.q<HTMLInputElement>('input[aria-label="Amount in dollars"]');
  page.type(amount, "10");
  await settle();
  assert.match(page.text(), /2 changes, −\$30\.00 allocated; \$1,829\.80 of the budget left unallocated/);
  assert.ok(page.root.textContent!.includes("2 changes, −$30.00 allocated; $1,829.80 of the budget left unallocated"));
  const select = page.q<HTMLSelectElement>('select[aria-label="How"]')!;
  select.value = "add";
  page.change(select);
  page.type(page.q<HTMLInputElement>('input[aria-label="Amount in dollars"]'), "1000");
  await settle();
  assert.match(page.text(), /2 changes, \+\$2,000\.00 allocated; \$200\.20 over the budget/);
  assert.equal(page.button("Apply")?.disabled, true);
  page.type(page.q<HTMLInputElement>('input[aria-label="Amount in dollars"]'), "5");
  await settle();
  page.button("Apply")!.click();
  await settle();
  assert.equal(allocationInput(page, "ada@example.org")!.value, "30.00");
  assert.equal(allocationInput(page, "alan@example.org")!.value, "30.00");
  assert.doesNotMatch(page.text(), /selected:/); // the selection was cleared
  page.unmount();
});

test("invite: a live preview, a budget check, and the people list grows", async () => {
  const { page } = await open(EMAILS.manager);
  const box = page.q<HTMLTextAreaElement>("#invite-emails");
  page.type(box, "new@example.org, Ada <ada@example.org>\nnope\nNEW@example.org");
  await settle();
  assert.match(page.text(), /1 to invite, 1 already students, 1 repeated\. Not addresses: nope\./);
  page.type(page.q<HTMLInputElement>("#invite-allocation"), "2000");
  await settle();
  assert.match(page.text(), /That's \$2,000\.00, more than the \$1,799\.80 not yet allocated\./);
  assert.equal(page.button(/^Invite/)?.disabled, true);
  page.type(page.q<HTMLInputElement>("#invite-allocation"), "5");
  await settle();
  assert.match(page.text(), /That allocates \$5\.00\./);
  // The sentences read right as rendered (htm drops whitespace that holds a line break).
  assert.ok(page.root.textContent!.includes("1 to invite, 1 already students, 1 repeated. Not addresses: nope. That allocates $5.00."));
  page.button(/^Invite 1/)!.click();
  await settle();
  assert.match(page.text(), /People \(9\)/);
  assert.match(page.text(), /new@example\.org invited/);
  assert.equal(page.q<HTMLTextAreaElement>("#invite-emails")!.value, "");
  page.unmount();
});

test("Stop all asks first, then stops every running machine", async () => {
  const t = await controllable(EMAILS.manager);
  const memberId = [...t.demo.backend.members.values()].find((m) => m.email === EMAILS.manager)!.id;
  await t.store.client.call("setMemberAllocation", { params: { projectId: t.demo.projectId, memberId }, body: { amount: 10_000_000 } });
  await t.store.client.call("startMachine", { params: { projectId: t.demo.projectId }, body: { gpuType: "L4" } });
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}/manage`, new FakeTimers());
  await settle();
  assert.match(page.text(), /Running now 1/);
  assert.match(page.text(), /Machines \(1\) Member GPU State Price Cost so far manager@example\.org 1× L4 runpod Starting/);
  const asked: string[] = [];
  (win as unknown as { confirm: (m: string) => boolean }).confirm = (m: string) => (asked.push(m), false);
  page.button("Stop all machines")!.click();
  await settle();
  assert.deepEqual(asked, ["Stop all 1 running machine? Each saves its workspace first."]);
  assert.match(page.text(), /Starting/);
  (win as unknown as { confirm: (m: string) => boolean }).confirm = () => true;
  page.button("Stop all machines")!.click();
  await settle();
  assert.match(page.text(), /Machines \(1\) .* Stopping/);
  assert.match(page.text(), /Running now 0/);
  assert.equal(page.qa("table.machines button").length, 0); // nothing left to stop
  page.unmount();
});

test("a CSV download is named after the project, the grouping and the day", async () => {
  const { t, page } = await open(EMAILS.manager);
  const clicked: Array<{ download: string; href: string }> = [];
  const proto = win.HTMLAnchorElement.prototype as unknown as { click: () => void };
  const original = proto.click;
  proto.click = function (this: { download: string; href: string }) {
    clicked.push({ download: this.download, href: this.href });
  };
  try {
    page.button("Spend by team (CSV)")!.click();
    await settle();
  } finally {
    proto.click = original;
  }
  assert.ok(t.log.includes(`GET /v1/projects/${t.demo.projectId}/spend.csv?by=team`));
  assert.equal(clicked.length, 1);
  assert.equal(clicked[0]!.download, "fine-tuning-lab-spend-by-team-2027-02-01.csv");
  assert.match(clicked[0]!.href, /^blob:/);
  page.unmount();
});

test("filter and sort the people table", async () => {
  const { page } = await open(EMAILS.manager);
  const emails = () => page.qa<HTMLTableRowElement>("table.members tbody tr").map((tr) => tr.querySelectorAll("td")[1]!.textContent!.split(" ")[0]);
  page.type(page.q<HTMLInputElement>('input[type="search"]'), "llama");
  await settle();
  assert.deepEqual(emails(), ["alan@example.org", "edsger@example.org"]);
  page.type(page.q<HTMLInputElement>('input[type="search"]'), "");
  await settle();
  const header = () => page.qa<HTMLButtonElement>("table.members thead button").find((b) => b.textContent === "Allocation")!;
  header().click();
  await settle();
  assert.deepEqual(emails().slice(0, 4), ["assistant@example.org", "manager@example.org", "owner@example.org", "grace@example.org"]);
  header().click();
  await settle();
  assert.equal(emails()[emails().length - 1], "owner@example.org");
  assert.equal(page.q("table.members thead th[aria-sort='descending']")?.textContent, "Allocation");
  page.unmount();
});

test("a failed allocation change shows the server's reason", async () => {
  const { page } = await open(EMAILS.manager);
  page.type(allocationInput(page, "ada@example.org"), "5000");
  page.blur(allocationInput(page, "ada@example.org"));
  await settle();
  assert.match(page.text(), /allocations would add up to more than the budget/);
  assert.equal(allocationInput(page, "ada@example.org")!.value, "5000"); // kept for correcting
  page.unmount();
});

test("bulk: when the server refuses part of it, the selection stays for another try", async () => {
  const { t, page } = await open(EMAILS.manager);
  page.q<HTMLInputElement>('input[aria-label="Select ada@example.org"]')!.click();
  page.q<HTMLInputElement>('input[aria-label="Select alan@example.org"]')!.click();
  await settle();
  page.type(page.q<HTMLInputElement>('input[aria-label="Amount in dollars"]'), "10");
  await settle();
  t.respondOnce(/^PUT .*\/allocation$/, () => Response.json({ error: { code: "conflict", message: "someone else changed the budget" } }, { status: 409 }));
  page.button("Apply")!.click();
  await settle();
  assert.match(page.text(), /0 of 2 allocations changed, then: someone else changed the budget/);
  assert.match(page.text(), /2 selected:/);
  page.unmount();
});
