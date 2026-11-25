import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeTimers } from "../app/testkit.ts";
import {
  ACK_EVERY_BYTES,
  MAX_PENDING_INPUT_BYTES,
  PING_EVERY_MS,
  base64ToBytes,
  bytesToBase64,
  clampSize,
  IN_FRAME_BYTES,
  INPUT_CREDIT_BYTES,
  isSessionId,
  reconnectDelayMs,
  terminalUrl,
  TerminalSession,
  type InputNotice,
  type SocketHandlers,
  type TerminalStatus,
} from "./session.ts";

const SID = "AbCdEfGhIjKlMnOpQrStUv"; // 22 base64url characters
const SID2 = "ZZZZZZZZZZZZZZZZZZZZ-_";

class FakeSocket {
  sent: Record<string, unknown>[] = [];
  closed: { code: number | undefined } | null = null;
  readonly url: string;
  readonly h: SocketHandlers;
  constructor(url: string, h: SocketHandlers) {
    this.url = url;
    this.h = h;
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code?: number) {
    this.closed = { code };
  }
  // the relay's and agent's side
  open() {
    this.h.onOpen();
  }
  /** Open, then the relay says ready. */
  start() {
    this.h.onOpen();
    this.msg({ relay: "ready", gen: 1 });
  }
  msg(m: object) {
    this.h.onMessage(JSON.stringify(m));
  }
  raw(text: string) {
    this.h.onMessage(text);
  }
  drop(code: number, reason = "") {
    this.h.onClose(code, reason);
  }
  ofType(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
  relay(kind: string) {
    return this.sent.filter((m) => m.relay === kind);
  }
}

function setup(stored: string | null = null, opts: { deferWrites?: boolean; openFails?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: TerminalStatus[] = [];
  const screen: string[] = [];
  const pendingWrites: Array<() => void> = [];
  let resets = 0;
  const store = new Map<string, string | null>([["mch_1", stored]]);
  const timers = new FakeTimers();
  let tokens = 0;
  let failures = opts.openFails ?? 0;
  const term = new TerminalSession({
    machineId: "mch_1",
    connect: (url, h) => {
      const s = new FakeSocket(url, h);
      sockets.push(s);
      return s;
    },
    open: async () => {
      if (failures > 0) {
        failures--;
        return null;
      }
      return { token: `tok-${++tokens}`, url: "wss://ui.example/api/relay/v1/page?machine=mch_1&chan=terminal" };
    },
    sink: {
      write: (bytes, done) => {
        screen.push(new TextDecoder().decode(bytes));
        if (opts.deferWrites) pendingWrites.push(done);
        else done();
      },
      reset: () => {
        resets++;
        screen.length = 0;
      },
    },
    storage: { get: (id) => store.get(id) ?? null, set: (id, v) => void store.set(id, v) },
    timers,
    size: () => ({ rows: 24, cols: 80 }),
    onStatus: (s) => statuses.push(s),
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    term,
    sockets,
    statuses,
    screen,
    store,
    timers,
    pendingWrites,
    resets: () => resets,
    tick,
    last: () => sockets[sockets.length - 1] as FakeSocket,
    status: () => statuses[statuses.length - 1],
    /** start, wait for the socket, open it */
    async connect() {
      term.start();
      await tick();
      this.last().start();
      return this.last();
    },
  };
}

const out = (s: string) => ({ t: "out", b: bytesToBase64(new TextEncoder().encode(s)) });

test("helpers: session ids, sizes, backoff, base64", () => {
  assert.equal(isSessionId(SID), true);
  assert.equal(isSessionId(SID.slice(1)), false);
  assert.equal(isSessionId(SID + "A"), false);
  assert.equal(isSessionId("AbCdEfGhIjKlMnOpQrStU="), false);
  assert.equal(isSessionId(42), false);
  assert.deepEqual([0, 1, 2, 3, 5, 6, 50].map(reconnectDelayMs), [1000, 1000, 2000, 4000, 16_000, 30_000, 30_000]);
  assert.deepEqual([0, 1, 24.9, 1000, 1001, Number.NaN, -5].map(clampSize), [1, 1, 24, 1000, 1000, 1, 1]);
  const all = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(base64ToBytes(bytesToBase64(all)), all);
  const big = new Uint8Array(100_000).map((_, i) => i % 251);
  assert.deepEqual(base64ToBytes(bytesToBase64(big)), big);
  assert.equal(bytesToBase64(new TextEncoder().encode("hé")), "aMOp");
});

test("terminalUrl: wss on the UI's own host only (ws://127.0.0.1 only when allowed)", () => {
  const ok = terminalUrl("wss://ui.example/api/relay/v1/page", "mch_1", "ui.example");
  assert.equal(ok, "wss://ui.example/api/relay/v1/page?machine=mch_1&chan=terminal");
  assert.equal(terminalUrl("wss://UI.example/api/relay/v1/page?x=1#f", "mch_1", "ui.EXAMPLE"), ok);
  for (const bad of [
    "ws://ui.example/api/relay/v1/page",
    "wss://evil.example/api/relay/v1/page",
    "wss://ui.example.evil.example/",
    "wss://ui.example:444/",
    "wss://user@ui.example/",
    "https://ui.example/",
    "ws://127.0.0.1:8790/api/relay/v1/page",
    "not a url",
    "",
  ]) {
    assert.equal(terminalUrl(bad, "mch_1", "ui.example"), null, bad);
  }
  assert.equal(terminalUrl(42, "mch_1", "ui.example"), null);
  assert.equal(
    terminalUrl("ws://127.0.0.1:8790/api/relay/v1/page", "mch_dev", "ui.example", true),
    "ws://127.0.0.1:8790/api/relay/v1/page?machine=mch_dev&chan=terminal",
  );
  assert.equal(terminalUrl("ws://localhost:8790/", "mch_dev", "ui.example", true), null);
  assert.equal(terminalUrl("ws://127.0.0.1:8790/", "mch_dev", "ui.example", false), null);
});

test("a new session: hello first, then open with the size; opened stores the id", async () => {
  const t = setup();
  const s = await t.connect();
  assert.deepEqual(s.sent, [
    { t: "hello", token: "tok-1" },
    { t: "open", rows: 24, cols: 80 },
  ]);
  s.msg({ t: "opened", session: SID });
  assert.equal(t.store.get("mch_1"), SID);
  s.msg({ t: "live" });
  assert.deepEqual(t.status(), { kind: "live" });
});

test("a stored session is reattached; a malformed stored id is not sent", async () => {
  const t = setup(SID);
  const s = await t.connect();
  assert.deepEqual(s.sent[1], { t: "open", session: SID, rows: 24, cols: 80 });
  const u = setup("not-a-session-id");
  const s2 = await u.connect();
  assert.deepEqual(s2.sent[1], { t: "open", rows: 24, cols: 80 });
});

test("replay resets the screen, then live", async () => {
  const t = setup(SID);
  const s = await t.connect();
  s.msg({ t: "opened", session: SID });
  s.msg(out("old"));
  s.msg({ t: "replay" });
  assert.equal(t.resets(), 1);
  assert.deepEqual(t.status(), { kind: "replaying" });
  s.msg(out("\x1bcscrollback"));
  s.msg({ t: "live" });
  assert.deepEqual(t.screen, ["\x1bcscrollback"]);
  assert.deepEqual(t.status(), { kind: "live" });
});

test("output is acked as it is written, every 32 KiB, counting replay bytes", async () => {
  const t = setup(null, { deferWrites: true });
  const s = await t.connect();
  s.msg({ t: "opened", session: SID });
  s.msg({ t: "replay" });
  const chunk = "x".repeat(16 * 1024);
  s.msg(out(chunk));
  s.msg({ t: "live" });
  s.msg(out(chunk));
  s.msg(out(chunk));
  assert.deepEqual(s.ofType("ack"), []); // nothing written yet
  t.pendingWrites.shift()!();
  assert.deepEqual(s.ofType("ack"), []); // 16 KiB written
  t.pendingWrites.shift()!();
  assert.deepEqual(s.ofType("ack"), [{ t: "ack", upto: ACK_EVERY_BYTES }]);
  t.pendingWrites.shift()!();
  assert.deepEqual(s.ofType("ack"), [{ t: "ack", upto: ACK_EVERY_BYTES }]); // 48 KiB: next ack at 64
  s.msg(out(chunk));
  t.pendingWrites.shift()!();
  assert.deepEqual(s.ofType("ack").map((a) => a.upto), [32 * 1024, 64 * 1024]);
});

test("input: frames of at most 16 KiB, never more than 64 KiB unacknowledged", async () => {
  const t = setup();
  const s = await t.connect();
  t.term.input("ignored before live");
  assert.deepEqual(s.ofType("in"), []);
  s.msg({ t: "opened", session: SID });
  s.msg({ t: "live" });
  t.term.input("ls\r");
  assert.deepEqual(s.ofType("in"), [{ t: "in", b: bytesToBase64(new TextEncoder().encode("ls\r")) }]);
  s.msg({ t: "inack", upto: 3 });
  t.term.input("y".repeat(100 * 1024)); // a big paste
  const sizes = () => s.ofType("in").slice(1).map((m) => base64ToBytes(m.b as string).length);
  assert.deepEqual(sizes(), [IN_FRAME_BYTES, IN_FRAME_BYTES, IN_FRAME_BYTES, IN_FRAME_BYTES]); // 64 KiB in flight
  assert.equal(sizes().reduce((a, b) => a + b, 0), INPUT_CREDIT_BYTES);
  s.msg({ t: "inack", upto: 3 + IN_FRAME_BYTES });
  assert.equal(sizes().length, 5);
  s.msg({ t: "inack", upto: 3 + 5 * IN_FRAME_BYTES });
  assert.deepEqual(sizes(), [IN_FRAME_BYTES, IN_FRAME_BYTES, IN_FRAME_BYTES, IN_FRAME_BYTES, IN_FRAME_BYTES, IN_FRAME_BYTES, 4 * 1024]);
});

test("an inack that goes backwards or beyond what was sent is a fault", async () => {
  for (const upto of [-1, 99, 1.5]) {
    const t = setup();
    const s = await t.connect();
    s.msg({ t: "opened", session: SID });
    s.msg({ t: "live" });
    t.term.input("abc");
    s.msg({ t: upto === -1 ? "inack" : "inack", upto: upto === -1 ? 2 : upto });
    if (upto === -1) {
      s.msg({ t: "inack", upto: 1 }); // backwards
    }
    assert.equal(t.status()?.kind, "closed", String(upto));
    assert.equal(s.closed?.code, 1000);
  }
});

test("resize is clamped and sent only once a session is open", async () => {
  const t = setup();
  const s = await t.connect();
  t.term.resize(30, 100);
  assert.deepEqual(s.ofType("resize"), []);
  s.msg({ t: "opened", session: SID });
  s.msg({ t: "live" });
  t.term.resize(0, 5000);
  assert.deepEqual(s.ofType("resize"), [{ t: "resize", rows: 1, cols: 1000 }]);
});

test("exit: just now, or earlier (right after live); input stops; a new shell is a new connection", async () => {
  const t = setup(SID);
  const s = await t.connect();
  s.msg({ t: "opened", session: SID });
  s.msg({ t: "replay" });
  s.msg(out("bye\r\n"));
  s.msg({ t: "live" });
  s.msg({ t: "exit", code: 0, signal: null });
  assert.deepEqual(t.status(), { kind: "exited", code: 0, signal: null, earlier: true });
  t.term.input("x");
  assert.deepEqual(s.ofType("in"), []);
  s.drop(1000); // the page leg closes: no reconnect after an exit
  assert.equal(t.timers.pending.size, 0);
  t.term.newShell();
  assert.equal(t.store.get("mch_1"), null);
  await t.tick();
  const s2 = t.last();
  assert.notEqual(s2, s);
  s2.start();
  assert.deepEqual(s2.sent, [
    { t: "hello", token: "tok-2" },
    { t: "open", rows: 24, cols: 80 },
  ]);

  const u = setup();
  const v = await u.connect();
  v.msg({ t: "opened", session: SID });
  v.msg({ t: "live" });
  v.msg(out("$ exit\r\n"));
  v.msg({ t: "exit", code: null, signal: "SIGHUP" });
  assert.deepEqual(u.status(), { kind: "exited", code: null, signal: "SIGHUP", earlier: false });
});

test("a lost session starts a new shell", async () => {
  for (const error of ["unknown_session", "expired"]) {
    const t = setup(SID);
    const s = await t.connect();
    s.msg({ t: "error", error });
    assert.equal(t.store.get("mch_1"), null, error);
    assert.equal(s.closed?.code, 1000);
    await t.tick();
    t.last().start();
    assert.deepEqual(t.last().sent[1], { t: "open", rows: 24, cols: 80 });
  }
});

test("errors that end the terminal", async () => {
  const cases: Array<[string, string]> = [
    ["sessions", "sessions"],
    ["spawn", "spawn"],
    ["not_open", "fault"],
    ["mystery", "fault"],
  ];
  for (const [error, reason] of cases) {
    const t = setup();
    const s = await t.connect();
    s.msg({ t: "error", error });
    assert.deepEqual([t.status()?.kind, (t.status() as { reason?: string }).reason], ["closed", reason], error);
    assert.equal(s.closed?.code, 1000);
    s.drop(1000);
    assert.equal(t.timers.pending.size, 0);
  }
  const t = setup();
  const s = await t.connect();
  s.msg({ t: "error", error: "elsewhere" });
  assert.deepEqual(t.status(), { kind: "elsewhere" });
});

test("malformed messages from the terminal are faults, not guesses", async () => {
  for (const bad of ["{", "null", JSON.stringify({ t: "out" }), JSON.stringify({ t: "out", b: "%%%" }), JSON.stringify({ t: "opened", session: "short" }), JSON.stringify({ t: "zap" })]) {
    const t = setup();
    const s = await t.connect();
    s.raw(bad);
    assert.equal(t.status()?.kind, "closed", bad);
    assert.equal((t.status() as { reason: string }).reason, "fault", bad);
  }
});

test("closes: 4001 and network drops reconnect with backoff and reattach; 4403, 4009 and protocol closes don't", async () => {
  const t = setup();
  const s = await t.connect();
  s.msg({ t: "opened", session: SID });
  s.msg({ t: "live" });
  s.drop(4001, "agent gone");
  assert.deepEqual(t.status(), { kind: "reconnecting", inMs: 1000 });
  await t.timers.run();
  await t.tick();
  t.last().drop(1006);
  assert.deepEqual(t.status(), { kind: "reconnecting", inMs: 2000 });
  await t.timers.run();
  await t.tick();
  const s3 = t.last();
  s3.start();
  assert.deepEqual(s3.sent, [
    { t: "hello", token: "tok-3" }, // a fresh token for each connection
    { t: "open", session: SID, rows: 24, cols: 80 },
  ]);
  s3.msg({ t: "replay" });
  s3.msg({ t: "live" });
  s3.drop(4001);
  assert.deepEqual(t.status(), { kind: "reconnecting", inMs: 1000 }); // live reset the backoff

  for (const [code, kind] of [
    [4403, "closed"],
    [4009, "elsewhere"],
    [1002, "closed"],
    [1003, "closed"],
    [1008, "closed"],
    [1009, "closed"],
  ] as const) {
    const u = setup();
    const v = await u.connect();
    v.drop(code);
    assert.equal(u.status()?.kind, kind, String(code));
    assert.equal(u.timers.pending.size, 0, String(code));
  }
});

test("no page token: retry with backoff", async () => {
  const t = setup(null, { openFails: 2 });
  t.term.start();
  await t.tick();
  assert.deepEqual(t.status(), { kind: "reconnecting", inMs: 1000 });
  assert.equal(t.sockets.length, 0);
  await t.timers.run();
  await t.tick();
  assert.deepEqual(t.status(), { kind: "reconnecting", inMs: 2000 });
  await t.timers.run();
  await t.tick();
  assert.equal(t.sockets.length, 1);
});

test("reconnect() and dispose(); an old connection's late events are ignored", async () => {
  const t = setup(SID);
  const s = await t.connect();
  s.msg({ t: "error", error: "elsewhere" });
  t.term.reconnect();
  await t.tick();
  const s2 = t.last();
  assert.notEqual(s2, s);
  s.msg({ t: "opened", session: SID2 }); // the old socket: ignored
  assert.equal(t.store.get("mch_1"), SID);
  s.drop(4403);
  assert.equal(t.status()?.kind, "connecting");
  s2.start();
  s2.msg({ t: "opened", session: SID });
  s2.msg({ t: "live" });
  t.term.dispose();
  assert.equal(s2.closed?.code, 1000);
  s2.drop(1006);
  assert.equal(t.timers.pending.size, 0);
  assert.equal(t.status()?.kind, "live");
});

test("relay: only the hello goes out until the relay is ready; then open", async () => {
  const t = setup(SID);
  t.term.start();
  await t.tick();
  const s = t.last();
  s.open();
  assert.deepEqual(s.sent, [{ t: "hello", token: "tok-1" }]);
  t.term.resize(30, 90);
  t.term.input("too early");
  assert.deepEqual(s.sent, [{ t: "hello", token: "tok-1" }]);
  s.msg({ relay: "ready", gen: 7 });
  assert.deepEqual(s.sent[1], { t: "open", session: SID, rows: 24, cols: 80 });
  s.msg({ relay: "ready", gen: 7 }); // a repeat changes nothing
  assert.equal(s.ofType("open").length, 1);
});

test("relay: the terminal speaking before ready is a fault", async () => {
  const t = setup();
  t.term.start();
  await t.tick();
  const s = t.last();
  s.open();
  s.msg({ t: "opened", session: SID });
  assert.equal((t.status() as { reason?: string }).reason, "fault");
});

test("relay: every receipt is acked at once, and never reaches the terminal protocol", async () => {
  const t = setup();
  const s = await t.connect();
  s.msg({ t: "opened", session: SID });
  s.msg({ relay: "receipt", r: SID2, upto: 10 });
  s.msg({ t: "live" });
  s.msg({ relay: "receipt", r: SID, upto: 99 });
  assert.deepEqual(s.relay("ack"), [
    { relay: "ack", r: SID2 },
    { relay: "ack", r: SID },
  ]);
  assert.deepEqual(t.status(), { kind: "live" });
  s.msg({ relay: "pong" });
  s.msg({ relay: "something-new", x: 1 }); // a later relay message: ignored
  assert.deepEqual(t.status(), { kind: "live" });
  s.msg({ relay: "receipt", r: "short", upto: 1 });
  assert.equal((t.status() as { reason?: string }).reason, "fault");
  const u = setup();
  const v = await u.connect();
  v.raw('{"relay":"ready" oops');
  assert.equal((u.status() as { reason?: string }).reason, "fault");
});

test("relay: a ping every 15 s while connected, and none after the close", async () => {
  const t = setup();
  const s = await t.connect();
  assert.equal(PING_EVERY_MS, 15_000); // the relay closes a page silent for 40 s
  assert.deepEqual(t.timers.delays(), [PING_EVERY_MS]);
  await t.timers.run();
  await t.timers.run();
  assert.deepEqual(s.relay("ping"), [{ relay: "ping" }, { relay: "ping" }]);
  assert.deepEqual(t.timers.delays(), [PING_EVERY_MS]);
  s.drop(4403);
  assert.equal(t.timers.pending.size, 0);
  const u = setup();
  await u.connect();
  u.term.dispose();
  assert.equal(u.timers.pending.size, 0);
});

test("relay: rate limits, a stalled agent and a quiet close back off and reconnect", async () => {
  for (const code of [4429, 4008, 1013, 1001]) {
    const t = setup(SID);
    const s = await t.connect();
    s.msg({ t: "opened", session: SID });
    s.msg({ t: "live" });
    s.drop(code);
    assert.deepEqual(t.status(), { kind: "reconnecting", inMs: 1000 }, String(code));
  }
});

test("disposed while the page token is on its way: no socket is ever opened", async () => {
  const sockets: unknown[] = [];
  let give!: (v: { token: string; url: string }) => void;
  const term = new TerminalSession({
    machineId: "mch_1",
    connect: (url) => (sockets.push(url), { send: () => {}, close: () => {} }),
    open: () => new Promise((r) => (give = r)),
    sink: { write: (_b, done) => done(), reset: () => {} },
    storage: { get: () => null, set: () => {} },
    timers: new FakeTimers(),
    size: () => ({ rows: 24, cols: 80 }),
    onStatus: () => {},
  });
  term.start();
  term.dispose();
  give({ token: "late", url: "wss://ui.example/" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sockets.length, 0);
});

test("a newer connection supersedes one still waiting for its token", async () => {
  const urls: string[] = [];
  const gives: Array<(v: { token: string; url: string }) => void> = [];
  const term = new TerminalSession({
    machineId: "mch_1",
    connect: (url) => (urls.push(url), { send: () => {}, close: () => {} }),
    open: () => new Promise((r) => gives.push(r)),
    sink: { write: (_b, done) => done(), reset: () => {} },
    storage: { get: () => null, set: () => {} },
    timers: new FakeTimers(),
    size: () => ({ rows: 24, cols: 80 }),
    onStatus: () => {},
  });
  term.start();
  term.reconnect(); // the first is still waiting for its token
  gives[1]!({ token: "new", url: "wss://ui.example/new" });
  gives[0]!({ token: "old", url: "wss://ui.example/old" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(urls, ["wss://ui.example/new"]);
});

/** A live session whose agent never acks input, with its notices recorded. */
async function stalled() {
  const t = setup();
  const s = await t.connect();
  s.msg({ t: "opened", session: SID });
  s.msg({ t: "live" });
  return { t, s, inBytes: () => s.ofType("in").reduce((n, m) => n + base64ToBytes(m.b as string).length, 0) };
}

test("input: with no ack, repeated pastes stop at the cap; nothing past it is kept", async () => {
  const { t, s, inBytes } = await stalled();
  assert.equal(MAX_PENDING_INPUT_BYTES, 1024 * 1024);
  const paste = "p".repeat(512 * 1024);
  assert.equal(t.term.input(paste), true);
  assert.equal(inBytes(), INPUT_CREDIT_BYTES); // 64 KiB on the wire
  assert.equal(t.term.pendingInputBytes, 512 * 1024 - INPUT_CREDIT_BYTES);
  assert.equal(t.term.input(paste), true); // still fits: 960 KiB waiting
  assert.equal(t.term.pendingInputBytes, 1024 * 1024 - INPUT_CREDIT_BYTES);
  for (let i = 0; i < 4; i++) assert.equal(t.term.input(paste), false); // four more: all refused
  assert.equal(t.term.pendingInputBytes, 1024 * 1024 - INPUT_CREDIT_BYTES);
  assert.equal(inBytes(), INPUT_CREDIT_BYTES);
  // Up to the cap exactly is fine; one byte more is not.
  assert.equal(t.term.input("q".repeat(INPUT_CREDIT_BYTES)), true);
  assert.equal(t.term.pendingInputBytes, MAX_PENDING_INPUT_BYTES);
  assert.equal(t.term.input("r"), false);
  // Once the machine takes it, everything queued goes out, in order, and nothing else.
  let acked = 0;
  while (inBytes() > acked) {
    acked = inBytes();
    s.msg({ t: "inack", upto: acked });
  }
  assert.equal(inBytes(), 2 * 512 * 1024 + INPUT_CREDIT_BYTES);
  assert.equal(t.term.pendingInputBytes, 0);
});

test("input: one oversized paste is refused whole, before it is encoded", async () => {
  const { t, inBytes } = await stalled();
  const encodes: number[] = [];
  const realEncode = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = function (this: TextEncoder, s?: string) {
    encodes.push(s?.length ?? 0);
    return realEncode.call(this, s);
  };
  try {
    assert.equal(t.term.input("z".repeat(MAX_PENDING_INPUT_BYTES + 1)), false);
    // Multi-byte text that fits as UTF-16 but not as UTF-8 is measured, then refused.
    assert.equal(t.term.input("é".repeat(MAX_PENDING_INPUT_BYTES / 2 + 1)), false);
  } finally {
    TextEncoder.prototype.encode = realEncode;
  }
  assert.deepEqual(encodes, [MAX_PENDING_INPUT_BYTES / 2 + 1]); // the first was never encoded
  assert.equal(inBytes(), 0);
  assert.equal(t.term.pendingInputBytes, 0);
  // Control: a paste that fits is taken.
  assert.equal(t.term.input("ok"), true);
  assert.equal(inBytes(), 2);
});

test("input: the cap is exact in UTF-8 bytes, also when the text is short in UTF-16", async () => {
  const { t } = await stalled();
  const half = "é".repeat(MAX_PENDING_INPUT_BYTES / 2); // 2 bytes each: exactly the cap
  assert.equal(t.term.input(half + "x"), false); // one byte over, though only half as many characters
  assert.equal(t.term.pendingInputBytes, 0);
  assert.equal(t.term.input(half), true);
  assert.equal(t.term.pendingInputBytes + INPUT_CREDIT_BYTES, MAX_PENDING_INPUT_BYTES);
});

test("input notices: waiting while held back, refused when too large, gone when drained or closed", async () => {
  const notices: Array<InputNotice | null> = [];
  const sockets: Array<{ h: SocketHandlers; sent: Record<string, unknown>[] }> = [];
  const term = new TerminalSession({
    machineId: "mch_1",
    connect: (_url, h) => {
      const s = { h, sent: [] as Record<string, unknown>[] };
      sockets.push(s);
      return { send: (x) => s.sent.push(JSON.parse(x)), close: () => {} };
    },
    open: async () => ({ token: "t", url: "wss://ui.example/" }),
    sink: { write: (_b, done) => done(), reset: () => {} },
    storage: { get: () => null, set: () => {} },
    timers: new FakeTimers(),
    size: () => ({ rows: 24, cols: 80 }),
    onStatus: () => {},
    onInputNotice: (n) => notices.push(n),
  });
  term.start();
  await new Promise((r) => setTimeout(r, 0));
  const s = sockets[0]!;
  s.h.onOpen();
  for (const m of [{ relay: "ready", gen: 1 }, { t: "opened", session: SID }, { t: "live" }]) s.h.onMessage(JSON.stringify(m));
  term.input("a".repeat(INPUT_CREDIT_BYTES + 10));
  assert.deepEqual(notices, [{ kind: "waiting", bytes: 10 }]);
  term.input("b".repeat(MAX_PENDING_INPUT_BYTES));
  assert.deepEqual(notices.at(-1), { kind: "refused", bytes: MAX_PENDING_INPUT_BYTES, limit: MAX_PENDING_INPUT_BYTES });
  s.h.onMessage(JSON.stringify({ t: "inack", upto: 0 })); // back to "waiting" after the refusal
  assert.deepEqual(notices.at(-1), { kind: "waiting", bytes: 10 });
  const before = notices.length;
  s.h.onMessage(JSON.stringify({ t: "inack", upto: 0 })); // an ack that changes nothing
  assert.equal(notices.length, before); // the same notice isn't sent twice
  s.h.onMessage(JSON.stringify({ t: "inack", upto: INPUT_CREDIT_BYTES }));
  assert.equal(notices.at(-1), null); // the last 10 bytes went out
  term.input("c".repeat(INPUT_CREDIT_BYTES)); // 10 bytes in flight: three 16 KiB frames go, one waits
  assert.deepEqual(notices.at(-1), { kind: "waiting", bytes: 16 * 1024 });
  s.h.onClose(4001, "");
  assert.equal(notices.at(-1), null); // a closed connection holds nothing
  assert.equal(term.pendingInputBytes, 0);
});
