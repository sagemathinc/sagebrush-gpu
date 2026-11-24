// The real App mounted into a DOM (happy-dom), so effects run: loading on mount, polling
// with its error and session handling, and cleanup on unmount and navigation.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { options, render } from "preact";
import { App, html, type Nav } from "./components.ts";
import { controllable, FakeTimers } from "./testkit.ts";

let win: Window;
before(() => {
  win = new Window({ url: "http://localhost/" });
  // Preact runs effects after the next frame; without requestAnimationFrame that waits
  // up to 100 ms. Run them on the next tick instead.
  (options as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame = (cb) => void setTimeout(cb, 0);
  Object.assign(globalThis, { window: win, document: win.document });
});
after(async () => {
  await win.happyDOM.close();
});

/** Let promises and Preact's deferred renders settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(t: Awaited<ReturnType<typeof controllable>>, path: string, timers: FakeTimers) {
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  const nav = (p: string): Nav => ({ path: p, search: "", go: () => {} });
  const show = (p: string) => render(html`<${App} store=${t.store} nav=${nav(p)} timers=${timers} />`, root as unknown as Element);
  show(path);
  return {
    root,
    text: () => (root.textContent ?? "").replace(/\s+/g, " "),
    show,
    unmount: () => render(null, root as unknown as Element),
  };
}

test("mounting a project page loads it and starts one polling loop", async () => {
  const t = await controllable();
  const timers = new FakeTimers();
  const page = mount(t, `/p/${t.demo.projectId}`, timers);
  await settle();
  assert.match(page.text(), /Fine-tuning lab/);
  assert.match(page.text(), /Start a machine/);
  assert.equal(timers.pending.size, 1);
  await timers.run();
  await settle();
  assert.equal(timers.pending.size, 1);
  page.unmount();
});

test("a failed poll shows a banner, backs off and recovers", async () => {
  const t = await controllable();
  const timers = new FakeTimers();
  const page = mount(t, `/p/${t.demo.projectId}`, timers);
  await settle();
  t.failOnce(new TypeError("connection reset"));
  await timers.run();
  await settle();
  assert.match(page.text(), /Couldn't refresh: network error: connection reset/);
  assert.deepEqual(timers.delays(), [2000]);
  await timers.run();
  await settle();
  assert.doesNotMatch(page.text(), /Couldn't refresh/);
  assert.equal(timers.pending.size, 1);
  page.unmount();
});

test("an expired session during polling shows sign-in and stops polling", async () => {
  const t = await controllable();
  const timers = new FakeTimers();
  const page = mount(t, `/p/${t.demo.projectId}`, timers);
  await settle();
  t.demo.backend.currentUserId = null;
  await timers.run();
  await settle();
  assert.match(page.text(), /Sign in/);
  assert.doesNotMatch(page.text(), /Fine-tuning lab/);
  assert.equal(timers.pending.size, 0);
  page.unmount();
});

test("unmounting stops polling; navigating restarts it for the new project", async () => {
  const t = await controllable();
  const timers = new FakeTimers();
  const page = mount(t, `/p/${t.demo.projectId}`, timers);
  await settle();
  assert.equal(timers.pending.size, 1);
  page.show(`/p/${t.otherId}`);
  await settle();
  assert.match(page.text(), /Second project/);
  assert.equal(timers.pending.size, 1); // the old loop's timer was cleared, the new one is pending
  assert.equal(timers.cleared.length, 1);
  page.show("/");
  await settle();
  assert.equal(timers.pending.size, 0);
  page.unmount();
});

test("unmounting before the project has loaded never starts polling", async () => {
  const t = await controllable();
  const timers = new FakeTimers();
  t.hold(new RegExp(`^GET /v1/projects/${t.demo.projectId}$`));
  const page = mount(t, `/p/${t.demo.projectId}`, timers);
  await settle();
  page.unmount();
  t.release();
  await settle();
  assert.equal(timers.pending.size, 0);
});

test("Open Jupyter opens the checked link in a new tab, and a hostile link not at all", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  await t.store.start("L4");
  t.demo.backend.advance(90_000);
  const timers = new FakeTimers();
  const opened: unknown[][] = [];
  (win as unknown as { open: (...a: unknown[]) => null }).open = (...a: unknown[]) => (opened.push(a), null);
  const page = mount(t, `/p/${t.demo.projectId}`, timers);
  await settle();
  const button = () => [...page.root.querySelectorAll("button")].find((b) => b.textContent === "Open Jupyter")!;
  (button() as unknown as HTMLElement).click();
  await settle();
  const id = t.store.machines.value[0]!.id;
  assert.equal(opened.length, 1);
  assert.match(String(opened[0]![0]), new RegExp(`^https://m-${id}\\.mock\\.invalid/\\?code=`));
  assert.deepEqual(opened[0]!.slice(1), ["_blank", "noopener,noreferrer"]);
  const real = t.store.client.call.bind(t.store.client);
  (t.store.client as { call: typeof real }).call = (async (name: string, args: unknown) =>
    name === "openJupyterLink" ? { url: "javascript:alert(1)", expiresAt: "2027-02-01T09:02:30.000Z" } : real(name as never, args as never)) as typeof real;
  (button() as unknown as HTMLElement).click();
  await settle();
  assert.equal(opened.length, 1);
  assert.match(page.text(), /isn't the machine's own address/);
  page.unmount();
});
