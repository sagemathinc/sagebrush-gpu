// The first-run walkthrough on the project page, in a DOM (happy-dom), against the mock: a member
// sees it and walks its four steps; staff don't; Skip hides it for that person on this browser.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import { seedDemo } from "../mock/seed.ts";
import { BOOT_SECONDS, PROVIDER_STOP_SECONDS, SAVE_BYTES, SAVE_BYTES_PER_SECOND } from "../mock/backend.ts";
import { installDom, mountApp, settle, unmountAll } from "./domkit.ts";
import { browserPrefs } from "./store.ts";
import { controllable, FakeTimers, memoryPrefs, signInAs } from "./testkit.ts";

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
const SAVE_SECONDS = Math.ceil(SAVE_BYTES / SAVE_BYTES_PER_SECOND);

async function open(email = EMAILS.member, prefs = memoryPrefs()) {
  const t = await controllable(email, { prefs });
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}`, new FakeTimers());
  await settle();
  const card = () => page.q<HTMLElement>("section.tour");
  // (elements set apart by spaces, as the page reads)
  type N = { nodeType: number; textContent: string | null; childNodes: ArrayLike<unknown> };
  const walk = (n: N): string => Array.from(n.childNodes).map((c) => ((c as N).nodeType === 3 ? ((c as N).textContent ?? "") : ` ${walk(c as N)} `)).join("");
  const text = () => (card() ? walk(card() as unknown as N) : "").replace(/\s+/g, " ").trim();
  const reload = async () => {
    await t.store.refresh();
    await settle();
  };
  return { t, page, card, text, reload, prefs };
}

test("a member sees the walkthrough, with the next step's hint; staff don't", async () => {
  const s = await open();
  assert.equal(s.card() !== null, true);
  assert.match(s.text(), /^Getting started Start a machine Pick a GPU below and press Start\. It takes a minute or two to boot\. Open Jupyter Save with a name Stop it when you're done Skip$/);
  s.page.unmount();
  for (const email of [EMAILS.manager, EMAILS.assistant]) {
    const staff = await open(email);
    assert.equal(staff.card() === null, true, email);
    staff.page.unmount();
  }
});

test("each step ticks as it really happens, then it says you're all set", async () => {
  const s = await open();
  await s.t.store.start("L4");
  s.t.demo.backend.advance(BOOT_SECONDS * SEC);
  await s.reload();
  assert.match(s.text(), /Start a machine Done Open Jupyter When the machine is running, press Open Jupyter on its card\./);
  const id = s.t.store.machines.value[0]!.id;
  assert.notEqual(await s.t.store.jupyterLink(id), null);
  await settle();
  assert.match(s.text(), /Open Jupyter Done Save with a name Press Save with a name… on the machine's card, so you can find this point again\./);
  assert.equal(await s.t.store.saveNamed(id, "first run"), true);
  s.t.demo.backend.advance(SAVE_SECONDS * SEC);
  await s.reload();
  assert.match(s.text(), /Save with a name Done Stop it when you're done Press Stop: your work is saved first, and it stops using your allocation once it has stopped\./);
  await s.t.store.stop(id);
  s.t.demo.backend.advance((SAVE_SECONDS + PROVIDER_STOP_SECONDS + 1) * SEC);
  await s.reload();
  assert.match(s.text(), /^Getting started You're all set: you've started a machine, used Jupyter, saved your work and stopped it\. Start a machine Done Open Jupyter Done Save with a name Done Stop it when you're done Done Hide$/);
});

test("Skip hides it for that person on this browser, and only for them", async () => {
  const prefs = memoryPrefs();
  const s = await open(EMAILS.member, prefs);
  const skip = s.page.button("Skip");
  assert.equal(skip !== null, true);
  skip!.click();
  await settle();
  assert.equal(s.card() === null, true, "hidden at once");
  s.page.unmount();
  // the same person on a fresh page: still hidden
  const again = await open(EMAILS.member, prefs);
  assert.equal(again.card() === null, true);
  again.page.unmount();
  // another member on the same browser: shown
  const other = await open(EMAILS.lowMember, prefs);
  assert.equal(other.card() !== null, true);
  // and after sign-out, nothing of the previous person's choice stays
  await other.t.store.signOut();
  assert.equal(other.t.store.tourHidden.value, false);
  assert.equal(other.t.store.jupyterOpened.value, false);
});

test("a new session starts the walkthrough afresh: sign-out, someone else signing in, then the first again", async () => {
  const s = await open();
  await s.t.store.start("L4");
  s.t.demo.backend.advance(BOOT_SECONDS * SEC);
  await s.reload();
  assert.notEqual(await s.t.store.jupyterLink(s.t.store.machines.value[0]!.id), null);
  s.page.button("Skip")!.click();
  await settle();
  assert.equal(s.t.store.tourHidden.value, true);
  await s.t.store.signOut();
  assert.equal(s.t.store.tourHidden.value, false, "sign-out forgets the choice in the page");
  assert.equal(s.t.store.jupyterOpened.value, false, "and that Jupyter was opened");
  // someone else signs in with no sign-out between: the first person's state never carries over
  await signInAs(s.t.store, s.t.demo.backend, EMAILS.member);
  assert.equal(s.t.store.tourHidden.value, true, "the first person's own choice is read back");
  s.t.store.jupyterOpened.value = true;
  await signInAs(s.t.store, s.t.demo.backend, EMAILS.lowMember);
  assert.equal(s.t.store.tourHidden.value, false);
  assert.equal(s.t.store.jupyterOpened.value, false);
});

test("Open Jupyter is ticked per project: another project starts unticked", async () => {
  const s = await open();
  await s.t.store.start("L4");
  s.t.demo.backend.advance(BOOT_SECONDS * SEC);
  await s.reload();
  assert.notEqual(await s.t.store.jupyterLink(s.t.store.machines.value[0]!.id), null);
  await s.t.store.openProject(s.t.demo.projectId);
  assert.equal(s.t.store.jupyterOpened.value, true, "reopening the same project keeps it");
  await s.t.store.openProject(s.t.otherId);
  assert.equal(s.t.store.jupyterOpened.value, false);
});

test("hiding before anyone is known keeps nothing", async () => {
  const inner = memoryPrefs();
  const writes: string[] = [];
  const prefs = { get: inner.get, set: (k: string, v: string) => (writes.push(k), inner.set(k, v)) };
  const s = await open(EMAILS.member, prefs);
  await s.t.store.signOut();
  s.t.store.hideTour();
  assert.deepEqual(writes, []);
  assert.equal(s.t.store.tourHidden.value, true);
  await signInAs(s.t.store, s.t.demo.backend, EMAILS.member);
  assert.equal(s.t.store.tourHidden.value, false);
});

test("browser prefs: localStorage when it works, memory when it's missing or throws", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const put = (v: unknown) => Object.defineProperty(globalThis, "localStorage", { value: v, configurable: true, writable: true });
  try {
    const kept = new Map<string, string>();
    put({ getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
    const a = browserPrefs();
    a.set("k", "1");
    assert.equal(kept.get("k"), "1", "written through");
    assert.equal(browserPrefs().get("k"), "1", "read back by a new page");
    put(undefined);
    const b = browserPrefs();
    assert.equal(b.get("k"), null);
    b.set("k", "1");
    assert.equal(b.get("k"), "1", "memory without storage");
    const boom = () => {
      throw new Error("denied");
    };
    put({ getItem: boom, setItem: boom });
    const c = browserPrefs();
    assert.equal(c.get("other"), null, "a read storage refuses is nothing");
    assert.doesNotThrow(() => c.set("k", "1"));
    assert.equal(c.get("k"), "1", "memory when storage throws");
    put({ getItem: () => null, setItem: boom }); // (full: reads work, writes don't)
    const full = browserPrefs();
    full.set("k", "1");
    assert.equal(full.get("k"), "1", "what this page set, when storage refused to keep it");
    Object.defineProperty(globalThis, "localStorage", { get: boom, configurable: true });
    const d = browserPrefs();
    d.set("k", "1");
    assert.equal(d.get("k"), "1", "memory when even reaching storage throws");
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("while the next person's sign-in is still being read, the previous person's choice doesn't show", async () => {
  const s = await open();
  s.page.button("Skip")!.click();
  await settle();
  assert.equal(s.t.store.tourHidden.value, true);
  const release = s.t.gate(/GET \/v1\/me/);
  s.t.demo.backend.signInAs(EMAILS.lowMember);
  const started = s.t.store.sessionStarted();
  await settle();
  assert.equal(s.t.store.tourHidden.value, false, "not the previous person's");
  release();
  await started;
  assert.equal(s.t.store.tourHidden.value, false);
});

test("a Jupyter link the page refuses doesn't tick the step", async () => {
  const s = await open();
  await s.t.store.start("L4");
  s.t.demo.backend.advance(BOOT_SECONDS * SEC);
  await s.reload();
  const real = s.t.store.client.call.bind(s.t.store.client);
  (s.t.store.client as { call: typeof real }).call = (async (name: string, args: unknown) =>
    name === "openJupyterLink" ? { url: "https://evil.example/", expiresAt: "2027-02-01T09:02:30.000Z" } : real(name as never, args as never)) as typeof real;
  assert.equal(await s.t.store.jupyterLink(s.t.store.machines.value[0]!.id), null);
  assert.equal(s.t.store.jupyterOpened.value, false);
});

test("an older read of who's signed in, answering after someone else signs in, changes nothing", async () => {
  const s = await open();
  s.page.button("Skip")!.click();
  await settle();
  const release = s.t.gate(/^GET \S*\/v1\/me$/);
  const old = s.t.store.loadMe(); // (still the first person's)
  await signInAs(s.t.store, s.t.demo.backend, EMAILS.lowMember);
  assert.equal(s.t.store.me.value?.user.email, EMAILS.lowMember);
  release();
  await old;
  await settle();
  assert.equal(s.t.store.me.value?.user.email, EMAILS.lowMember, "not put back");
  assert.equal(s.t.store.tourHidden.value, false, "nor the first person's choice");
});

test("an older read of who's signed in, answering after sign-out, changes nothing", async () => {
  const s = await open();
  s.page.button("Skip")!.click();
  await settle();
  const release = s.t.gate(/^GET \S*\/v1\/me$/);
  const old = s.t.store.loadMe();
  await s.t.store.signOut();
  release();
  await old;
  assert.equal(s.t.store.me.value, null);
  assert.equal(s.t.store.tourHidden.value, false);
  assert.equal(s.t.store.meLoaded.value, true);
});

test("an older read that fails, answering after someone else signs in, changes nothing", async () => {
  const s = await open();
  s.t.respondOnce(/^GET \S*\/v1\/me$/, () => Response.json({ error: { code: "internal", message: "x" } }, { status: 500 }));
  const release = s.t.gate(/^GET \S*\/v1\/me$/);
  const old = s.t.store.loadMe();
  await signInAs(s.t.store, s.t.demo.backend, EMAILS.lowMember);
  release();
  await old;
  assert.equal(s.t.store.me.value?.user.email, EMAILS.lowMember);
  assert.equal(s.t.store.error.value, null);
});
