import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { options, render } from "preact";
import { MAX_RETURN_PATH_LENGTH } from "@sbgpu/api";
import { createClient } from "../client.ts";
import { mockFetch } from "../mock/fetch.ts";
import { seedDemo } from "../mock/seed.ts";
import { App, html, type DemoAccount } from "./components.ts";
import { signInHref, takeSignInOutcome } from "./signin.ts";
import { Store } from "./store.ts";

test("signInHref: the start route, with a return path only when the server would keep it", () => {
  assert.equal(signInHref("/"), "/v1/auth/start");
  assert.equal(signInHref("/p/prj_1?x=1#t"), "/v1/auth/start?return=%2Fp%2Fprj_1%3Fx%3D1%23t");
  for (const bad of ["", "//evil.example/x", "/\\evil", "https://evil.example/", "p/prj_1", "/a\nb", `/${"x".repeat(MAX_RETURN_PATH_LENGTH)}`]) {
    assert.equal(signInHref(bad), "/v1/auth/start", JSON.stringify(bad));
  }
  assert.equal(signInHref(`/${"x".repeat(MAX_RETURN_PATH_LENGTH - 1)}`).length > "/v1/auth/start".length, true);
});

test("takeSignInOutcome: reads the outcome and gives back the rest of the query", () => {
  assert.equal(takeSignInOutcome(""), null);
  assert.equal(takeSignInOutcome("?mock=1"), null);
  assert.deepEqual(takeSignInOutcome("?signin=refused"), { outcome: "refused", search: "" });
  assert.deepEqual(takeSignInOutcome("?mock=1&signin=expired&speed=60"), { outcome: "expired", search: "?mock=1&speed=60" });
  for (const outcome of ["error", "unavailable"] as const) {
    assert.deepEqual(takeSignInOutcome(`?signin=${outcome}`), { outcome, search: "" });
  }
  // An unknown word is dropped from the address bar too, and shows nothing.
  assert.deepEqual(takeSignInOutcome("?signin=%3Cb%3Ehi"), { outcome: null, search: "" });
  assert.deepEqual(takeSignInOutcome("?signin="), { outcome: null, search: "" });
});

let win: Window;
before(() => {
  win = new Window({ url: "http://localhost/" });
  (options as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame = (cb) => void setTimeout(cb, 0);
  Object.assign(globalThis, { window: win, document: win.document });
});
after(async () => {
  await win.happyDOM.close();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

test("in the demo, the sign-in button signs in as the first demo account instead of leaving", async () => {
  const demo = seedDemo();
  const store = new Store(createClient({ fetch: mockFetch(demo.backend) }), () => demo.backend.now());
  await store.loadMe();
  const chosen: string[] = [];
  const account = (email: string): DemoAccount => ({
    label: email,
    email,
    signIn: async () => {
      chosen.push(email);
      demo.backend.signInAs(email);
      await store.sessionStarted();
    },
  });
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  const nav = { path: "/", search: "?mock=1", go: () => {} };
  render(html`<${App} store=${store} nav=${nav} demoAccounts=${[account(demo.emails.member), account(demo.emails.manager)]} />`, root as unknown as Element);
  const link = root.querySelector("a.button")!;
  const click = new win.MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true); // no navigation to a server the demo hasn't got
  await settle();
  assert.deepEqual(chosen, [demo.emails.member]);
  assert.equal(store.me.value?.user.email, demo.emails.member);
  render(null, root as unknown as Element);
  root.remove();
});

test("outside the demo, the sign-in link is left to navigate", async () => {
  const demo = seedDemo();
  const store = new Store(createClient({ fetch: mockFetch(demo.backend) }));
  await store.loadMe();
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  render(html`<${App} store=${store} nav=${{ path: "/", search: "", go: () => {} }} />`, root as unknown as Element);
  const link = root.querySelector("a.button")!;
  const click = new win.MouseEvent("click", { bubbles: true, cancelable: true });
  // happy-dom would follow the link: count it rather than let it load.
  const prevented: boolean[] = [];
  link.addEventListener("click", (e) => {
    prevented.push(e.defaultPrevented);
    e.preventDefault();
  });
  link.dispatchEvent(click);
  assert.deepEqual(prevented, [false]); // the app left it alone
  assert.equal(store.me.value, null);
  render(null, root as unknown as Element);
  root.remove();
});
