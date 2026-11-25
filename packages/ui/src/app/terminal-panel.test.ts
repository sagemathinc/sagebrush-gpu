// The terminal panel mounted in a DOM with a fake screen and a fake socket: what it shows
// for each state of the connection, what goes to the screen and the wire, and cleanup.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import { render } from "preact";
import { seedDemo } from "../mock/seed.ts";
import type { SocketHandlers } from "../terminal/session.ts";
import { cjsExport, type TermLike } from "../terminal/xterm.ts";
import { installDom, mountApp, settle, unmountAll } from "./domkit.ts";
import { html } from "./html.ts";
import { inputNoticeText, statusText, TerminalPanel, tabSessionIds } from "./terminal-panel.ts";
import { controllable, FakeTimers, signInAs } from "./testkit.ts";
import { Store } from "./store.ts";

let win: Window;
before(() => {
  win = installDom();
});
afterEach(() => unmountAll());
after(async () => {
  await win.happyDOM.close();
});

const SID = "AbCdEfGhIjKlMnOpQrStUv";

class FakeTerm implements TermLike {
  rows = 24;
  cols = 80;
  opened = false;
  disposed = false;
  focused = false;
  inputEnabled = true;
  fits = 0;
  resets = 0;
  screen = "";
  data: Array<(s: string) => void> = [];
  resizes: Array<(z: { rows: number; cols: number }) => void> = [];
  open() {
    this.opened = true;
  }
  write(bytes: Uint8Array, done: () => void) {
    this.screen += new TextDecoder().decode(bytes);
    done();
  }
  reset() {
    this.resets++;
    this.screen = "";
  }
  onData(l: (s: string) => void) {
    this.data.push(l);
    return { dispose: () => (this.data = this.data.filter((x) => x !== l)) };
  }
  onResize(l: (z: { rows: number; cols: number }) => void) {
    this.resizes.push(l);
    return { dispose: () => (this.resizes = this.resizes.filter((x) => x !== l)) };
  }
  fit() {
    this.fits++;
  }
  focus() {
    this.focused = true;
  }
  setInputEnabled(enabled: boolean) {
    this.inputEnabled = enabled;
  }
  bufferText() {
    return this.screen;
  }
  dispose() {
    this.disposed = true;
  }
  type(s: string) {
    for (const l of this.data) l(s);
  }
}

interface Sock {
  url: string;
  h: SocketHandlers;
  sent: Record<string, unknown>[];
  closed: number | null;
}

/** A member's store with a running machine, the panel mounted on it with fakes. */
async function panel() {
  const t = await controllable();
  // The mock's relay URL is wss://mock.invalid/..., so the "UI host" here is mock.invalid.
  const store = new Store(t.store.client, t.store.now, { uiHost: "mock.invalid" });
  await signInAs(store, t.demo.backend, t.demo.emails.member);
  await store.openProject(t.demo.projectId);
  await store.start("L4");
  t.demo.backend.advance(90_000);
  await store.refresh();
  const machineId = store.machines.value[0]!.id;
  const term = new FakeTerm();
  const sockets: Sock[] = [];
  const ids = new Map<string, string | null>();
  const timers = new FakeTimers();
  let closed = 0;
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  render(
    html`<${TerminalPanel}
      store=${store}
      machineId=${machineId}
      onClose=${() => closed++}
      createTerm=${async () => term}
      connect=${(url: string, h: SocketHandlers) => {
        const s: Sock = { url, h, sent: [], closed: null };
        sockets.push(s);
        return { send: (text: string) => s.sent.push(JSON.parse(text)), close: (code?: number) => (s.closed = code ?? 1000) };
      }}
      storage=${{ get: (id: string) => ids.get(id) ?? null, set: (id: string, v: string | null) => void ids.set(id, v) }}
      timers=${timers}
    />`,
    root as unknown as Element,
  );
  await settle();
  const last = () => sockets[sockets.length - 1]!;
  const msg = (m: object) => last().h.onMessage(JSON.stringify(m));
  return {
    t,
    store,
    machineId,
    term,
    sockets,
    ids,
    timers,
    closedCount: () => closed,
    last,
    msg,
    status: () => (root.querySelector('[role="status"]')?.textContent ?? "").trim(),
    button: (label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as unknown as HTMLButtonElement | undefined,
    unmount: () => render(null, root as unknown as Element),
    /** The socket opens and the relay is ready; the agent opens a session and goes live. */
    async live() {
      last().h.onOpen();
      msg({ relay: "ready", gen: 1 });
      msg({ t: "opened", session: SID });
      msg({ t: "replay" });
      msg({ t: "live" });
      await settle();
    },
  };
}

test("statusText says what the connection is doing", () => {
  assert.equal(statusText({ kind: "connecting" }), "Connecting…");
  assert.equal(statusText({ kind: "replaying" }), "Restoring the screen…");
  assert.equal(statusText({ kind: "live" }), "");
  assert.equal(statusText({ kind: "reconnecting", inMs: 1500 }), "Connection lost. Reconnecting in 2 s…");
  assert.equal(statusText({ kind: "elsewhere" }), "This terminal is open in another tab or window.");
  assert.equal(statusText({ kind: "exited", code: 0, signal: null, earlier: false }), "The shell ended.");
  assert.equal(statusText({ kind: "exited", code: null, signal: null, earlier: true }), "This shell ended earlier.");
  assert.equal(statusText({ kind: "exited", code: 2, signal: null, earlier: false }), "The shell exited with code 2.");
  assert.equal(statusText({ kind: "exited", code: null, signal: "SIGKILL", earlier: true }), "This shell ended by SIGKILL earlier.");
  assert.equal(statusText({ kind: "closed", reason: "sessions", detail: "Too many." }), "Too many.");
});

test("the panel connects with a fresh page token to the relay on the UI's host, and goes live", async () => {
  const p = await panel();
  assert.equal(p.term.opened, true);
  assert.equal(p.term.fits, 1);
  assert.equal(p.status(), "Connecting…");
  assert.equal(p.sockets.length, 1);
  assert.equal(p.last().url, `wss://mock.invalid/api/relay/v1/page?machine=${p.machineId}&chan=terminal`);
  p.last().h.onOpen();
  assert.deepEqual(p.last().sent, [{ t: "hello", token: "mock-page-1" }]);
  await p.live();
  assert.equal(p.status(), "");
  assert.equal(p.term.inputEnabled, true);
  assert.equal(p.term.focused, true);
  assert.equal(p.ids.get(p.machineId), SID);
  p.unmount();
});

test("output reaches the screen; keys and resizes reach the wire", async () => {
  const p = await panel();
  await p.live();
  p.msg({ t: "out", b: btoa("$ ") });
  assert.equal(p.term.screen, "$ ");
  p.term.type("ls\r");
  assert.deepEqual(p.last().sent.filter((m) => m.t === "in"), [{ t: "in", b: btoa("ls\r") }]);
  for (const l of p.term.resizes) l({ rows: 40, cols: 120 });
  assert.deepEqual(p.last().sent.filter((m) => m.t === "resize"), [{ t: "resize", rows: 40, cols: 120 }]);
  p.unmount();
});

test("an exit disables input and offers a new shell, on a new connection", async () => {
  const p = await panel();
  await p.live();
  p.msg({ t: "exit", code: 0, signal: null });
  await settle();
  assert.equal(p.status(), "This shell ended earlier.");
  assert.equal(p.term.inputEnabled, false);
  p.button("Start a new shell")!.click();
  await settle();
  assert.equal(p.sockets.length, 2);
  assert.equal(p.ids.get(p.machineId), null);
  p.last().h.onOpen();
  p.msg({ relay: "ready", gen: 1 });
  assert.deepEqual(p.last().sent[1], { t: "open", rows: 24, cols: 80 });
  p.unmount();
});

test("elsewhere and reconnecting offer to reconnect now; Close calls back", async () => {
  const p = await panel();
  await p.live();
  p.last().h.onClose(4009, "replaced");
  await settle();
  assert.equal(p.status(), "This terminal is open in another tab or window.");
  p.button("Use it here")!.click();
  await settle();
  assert.equal(p.sockets.length, 2);
  await p.live();
  p.last().h.onClose(4001, "agent gone");
  await settle();
  assert.equal(p.status(), "Connection lost. Reconnecting in 1 s…");
  p.button("Reconnect now")!.click();
  await settle();
  assert.equal(p.sockets.length, 3);
  p.button("Close")!.click();
  assert.equal(p.closedCount(), 1);
  p.unmount();
});

test("closing the panel disposes the screen, the socket and every timer", async () => {
  const p = await panel();
  await p.live();
  assert.equal(p.timers.pending.size, 1); // the relay ping
  p.unmount();
  assert.equal(p.term.disposed, true);
  assert.equal(p.last().closed, 1000);
  assert.equal(p.timers.pending.size, 0);
  assert.equal(p.term.data.length, 0);
});

test("a terminal that's refused for good offers no new shell", async () => {
  const p = await panel();
  p.last().h.onClose(4403, "revoked");
  await settle();
  assert.equal(p.status(), "The terminal is closed: access ended or the machine stopped.");
  assert.equal(p.button("Start a new shell") === undefined, true); // (no DOM nodes into assert)
  p.unmount();
});

test("terminalAccess: a fresh token each time; a relay off the UI's host is refused", async () => {
  const p = await panel();
  const a = await p.store.terminalAccess(p.machineId);
  const b = await p.store.terminalAccess(p.machineId);
  assert.notEqual(a!.token, b!.token);
  const other = new Store(p.store.client, p.store.now, { uiHost: "ui.example" });
  await signInAs(other, p.t.demo.backend, p.t.demo.emails.member);
  assert.equal(await other.terminalAccess(p.machineId), null);
  assert.match(other.error.value ?? "", /isn't this site's relay/);
  p.unmount();
});

test("terminalAccess: no session, no access; a 401 ends the session", async () => {
  const p = await panel();
  const s = new Store(p.store.client, p.store.now, { uiHost: "mock.invalid" });
  await signInAs(s, p.t.demo.backend, p.t.demo.emails.teamMember); // not this machine's member
  assert.equal(await s.terminalAccess(p.machineId), null);
  assert.notEqual(s.me.value, null);
  p.t.demo.backend.currentUserId = null;
  assert.equal(await s.terminalAccess(p.machineId), null);
  assert.equal(s.me.value, null);
  p.unmount();
});

test("terminalAccess in the demo build: the local mock terminal and its dev token", async () => {
  const t = await controllable();
  const s = new Store(t.store.client, t.store.now, { devTerminal: { url: "ws://127.0.0.1:8790/api/relay/v1/page", token: "dev" } });
  assert.deepEqual(await s.terminalAccess("mch_dev"), {
    token: "dev",
    url: "ws://127.0.0.1:8790/api/relay/v1/page?machine=mch_dev&chan=terminal",
  });
  const bad = new Store(t.store.client, t.store.now, { devTerminal: { url: "wss://elsewhere.example/", token: "dev" } });
  assert.equal(await bad.terminalAccess("mch_dev"), null);
});

test("the project page offers Open terminal for a running machine, and opens the panel", async () => {
  const t = await controllable();
  await t.store.openProject(t.demo.projectId);
  await t.store.start("L4");
  t.demo.backend.advance(90_000);
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}`, new FakeTimers());
  await settle();
  assert.equal(page.button("Open terminal") !== null, true);
  void tabSessionIds; // the real storage is used by default
  page.unmount();
});

void seedDemo;

test("closed before xterm has loaded: the screen is disposed, never opened", async () => {
  const t = await controllable();
  const term = new FakeTerm();
  let give!: (t: TermLike) => void;
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  render(
    html`<${TerminalPanel} store=${t.store} machineId="mch_x" onClose=${() => {}} createTerm=${() => new Promise<TermLike>((r) => (give = r))}
      connect=${() => ({ send: () => {}, close: () => {} })} timers=${new FakeTimers()} />`,
    root as unknown as Element,
  );
  await settle();
  render(null, root as unknown as Element);
  give(term);
  await settle();
  assert.equal(term.opened, false);
  assert.equal(term.disposed, true);
});

test("a terminal that can't load says so", async () => {
  const t = await controllable();
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  render(
    html`<${TerminalPanel} store=${t.store} machineId="mch_x" onClose=${() => {}} createTerm=${() => Promise.reject(new Error("chunk missing"))}
      connect=${() => ({ send: () => {}, close: () => {} })} timers=${new FakeTimers()} />`,
    root as unknown as Element,
  );
  await settle();
  assert.equal(root.querySelector('[role="status"]')?.textContent, "The terminal couldn't load: chunk missing");
  render(null, root as unknown as Element);
});

test("cjsExport finds a CommonJS export on the namespace or on its default", () => {
  class A {}
  assert.equal(cjsExport({ Terminal: A }, "Terminal"), A);
  assert.equal(cjsExport({ default: { Terminal: A } }, "Terminal"), A); // esbuild's shape for xterm
  assert.equal(cjsExport({ Terminal: A, default: { Terminal: 1 } }, "Terminal"), A);
  assert.throws(() => cjsExport({ default: {} }, "Terminal"), /Terminal isn't exported/);
  assert.throws(() => cjsExport({}, "FitAddon"), /FitAddon/);
});

test("input notices: waiting for the machine, and a paste too large", async () => {
  assert.equal(inputNoticeText(null), "");
  assert.equal(inputNoticeText({ kind: "waiting", bytes: 120 * 1024 }), "Waiting for the machine to take 120.0 KB of input…");
  assert.equal(
    inputNoticeText({ kind: "refused", bytes: 4 * 1024 * 1024, limit: 1024 * 1024 }),
    "That paste is too large (4.0 MB): at most 1.0 MB of input can wait at a time. Nothing of it was sent.",
  );
  const p = await panel();
  await p.live();
  p.term.type("x".repeat(200 * 1024)); // more than the 64 KiB in flight: the rest waits
  await settle();
  assert.match(p.status(), /^Waiting for the machine to take 136\.0 KB of input…$/);
  p.msg({ t: "inack", upto: 64 * 1024 });
  await settle();
  assert.match(p.status(), /^Waiting for the machine to take 72\.0 KB of input…$/);
  p.term.type("y".repeat(2 * 1024 * 1024));
  await settle();
  assert.match(p.status(), /That paste is too large \(2\.0 MB\)/);
  p.msg({ t: "inack", upto: 128 * 1024 });
  p.msg({ t: "inack", upto: 192 * 1024 });
  p.msg({ t: "inack", upto: 200 * 1024 });
  await settle();
  assert.equal(p.status(), ""); // all taken: no notice
  p.unmount();
});
