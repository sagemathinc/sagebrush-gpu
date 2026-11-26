// The start panel against the mock, in a DOM (happy-dom): before Start, how long the allocation
// lasts at each GPU's all-in price; at Start, each refusal in the page's own words beside that GPU
// (never the server's message text), and a conflict (two starts at once) retried quietly.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import { ERROR_STATUS, memberAreaKey, type ErrorCode } from "@sbgpu/api";
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
const START = /POST \/v1\/projects\/[^/]+\/machines$/;

async function open(email = EMAILS.member) {
  const t = await controllable(email);
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}`, new FakeTimers());
  await settle();
  const row = (gpu: string) => page.qa<HTMLTableRowElement>("table.gpus tbody tr").find((tr) => tr.querySelector("th")?.textContent?.includes(gpu)) ?? null;
  const rowText = (gpu: string) => (row(gpu)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const startButton = (gpu: string) => (row(gpu)?.querySelector("button") as unknown as HTMLButtonElement | null) ?? null;
  const start = async (gpu = "L4") => {
    const b = startButton(gpu);
    assert.ok(b !== null, `no Start for ${gpu}`);
    b.click();
    await settle();
    await settle();
  };
  const starts = () => t.log.filter((l) => START.test(l)).length;
  return { t, page, row, rowText, start, starts };
}

const refusal = (code: ErrorCode) => () => Response.json({ error: { code, message: "the server's own words" } }, { status: ERROR_STATUS[code] });

test("before Start, each GPU says about how long the allocation lasts at its all-in price", async () => {
  const s = await open();
  // Ada has $25.00; L4 is $0.624/h all-in (provider $0.48 + 30%): about 40 hours
  assert.match(s.rowText("L4"), /Your allocation buys about 40 h at this price\./);
  // Grace has $0.20 left: the quote refuses before Start, in the quote's own words, with no estimate
  s.page.unmount();
  const g = await open(EMAILS.lowMember);
  assert.match(g.rowText("L4"), /Not enough allocation left to start\./);
  assert.doesNotMatch(g.rowText("L4"), /buys about/);
});

test("each refusal at Start shows in the page's own words beside that GPU, never the server's text", async () => {
  const cases: Array<[ErrorCode, RegExp]> = [
    ["priceCap", /The price is now higher than the one you saw, or above the course's limit\. Check the price and try again\./],
    ["allocationTooLow", /Your allocation doesn't have enough left for this GPU's shortest run\. Try a cheaper one, or ask an instructor for more\./],
    ["budgetExhausted", /Your allocation is used up\. Ask an instructor for more\./],
    ["projectNotStarted", /The course hasn't started yet\./],
    ["projectEnded", /The course has ended\./],
    ["invalidState", /It can't start right now, perhaps while a restore of your workspace finishes\. Try again in a moment\./],
  ];
  for (const [code, words] of cases) {
    const s = await open();
    const quotes = () => s.t.log.filter((l) => /POST \/v1\/projects\/[^/]+\/quote$/.test(l)).length;
    const quotesBefore = quotes();
    s.t.respondOnce(START, refusal(code));
    await s.start("L4");
    assert.ok(quotes() > quotesBefore, `${code}: the prices were read again after the refusal`);
    assert.match(s.rowText("L4"), words, code);
    assert.doesNotMatch(s.page.text(), /the server's own words/, `${code}: not the server's text`);
    assert.equal(s.t.store.error.value, null, `${code}: nothing in the banner`);
    assert.equal(s.t.store.machines.value.length, 0, code);
    assert.doesNotMatch(s.rowText("A6000"), /course|allocation is used up/, `${code}: only beside the GPU started`);
    s.page.unmount();
  }
});

test("a code the page has no words for goes to the banner with the server's message", async () => {
  const s = await open();
  s.t.respondOnce(START, refusal("internal"));
  await s.start("L4");
  assert.equal(s.t.store.error.value, "the server's own words");
  assert.equal(s.t.store.startRefusal.value, null);
});

test("a conflict (two starts at once) is retried once, quietly; a second conflict is shown", async () => {
  const s = await open();
  s.t.respondOnce(START, refusal("conflict"));
  await s.start("L4");
  assert.equal(s.starts(), 2, "the start was sent again");
  assert.equal(s.t.store.machines.value.length, 1, "and the retry started the machine");
  assert.equal(s.t.store.startRefusal.value, null);
  assert.equal(s.t.store.error.value, null);
  s.page.unmount();
  // both attempts refused: then it says so, once
  const c = await open();
  let n = 0;
  c.t.respondOnce(START, () => {
    n++;
    c.t.respondOnce(START, refusal("conflict"));
    return refusal("conflict")();
  });
  await c.start("L4");
  assert.equal(n, 1);
  assert.equal(c.starts(), 2, "one retry only");
  assert.match(c.rowText("L4"), /Several starts happened at once\. Try again\./);
});

test("a real refusal from the mock: a restore of the workspace in progress", async () => {
  const s = await open();
  const ada = [...s.t.demo.backend.members.values()].find((m) => m.email === EMAILS.member && m.projectId === s.t.demo.projectId)!;
  s.t.demo.backend.holdRestore(memberAreaKey(s.t.demo.projectId, ada.id));
  await s.start("L4");
  assert.match(s.rowText("L4"), /It can't start right now, perhaps while a restore of your workspace finishes\./);
  assert.equal(s.t.store.machines.value.length, 0);
  // once it finishes, a new Start clears the words and starts
  s.t.demo.backend.releaseRestore(memberAreaKey(s.t.demo.projectId, ada.id));
  await s.start("L4");
  assert.doesNotMatch(s.rowText("L4"), /can't start right now/);
  assert.equal(s.t.store.machines.value.length, 1);
});

test("moving to another project forgets a refusal", async () => {
  const s = await open();
  s.t.respondOnce(START, refusal("budgetExhausted"));
  await s.start("L4");
  assert.notEqual(s.t.store.startRefusal.value, null);
  await s.t.store.openProject(s.t.otherId);
  assert.equal(s.t.store.startRefusal.value, null);
});
