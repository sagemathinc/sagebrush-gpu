import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startMockTerminal } from "./mock-terminal.ts";

let server: { port: number; close(): void };
before(async () => {
  server = await startMockTerminal(0);
});
after(() => server.close());

class Client {
  ws: WebSocket;
  msgs: Array<Record<string, unknown>> = [];
  closed: { code: number } | null = null;
  autoAck = true;
  relay: Array<Record<string, unknown>> = [];
  out = "";
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/v1/page?machine=mch_dev&chan=terminal`);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (typeof m.relay === "string") {
        // (the relay's own messages, apart from the terminal's)
        this.relay.push(m);
        if (m.relay === "receipt" && this.autoAck) this.send({ relay: "ack", r: m.r });
        return;
      }
      this.msgs.push(m);
      if (m.t === "out") {
        const b = Buffer.from(m.b, "base64");
        this.out += b.toString("latin1");
      }
    };
    this.ws.onclose = (e) => (this.closed = { code: e.code });
  }
  async opened(ms = 10_000) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the WebSocket did not open")), ms);
      this.ws.onopen = () => (clearTimeout(t), resolve(undefined));
      this.ws.onerror = () => (clearTimeout(t), reject(new Error("the WebSocket failed to open")));
    });
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  type(s: string) {
    this.send({ t: "in", b: Buffer.from(s).toString("base64") });
  }
  async until(pred: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out; got " + JSON.stringify(this.msgs.slice(-5)) + " out=" + JSON.stringify(this.out.slice(-300)));
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

// A step that never finishes fails the test rather than hanging the run.
const TIMEOUT = { timeout: 60_000 };

test("hello, open, type, output, ack, resize, reattach with replay, exit", TIMEOUT, async () => {
  const a = new Client(server.port);
  await a.opened();
  a.send({ t: "hello", token: "dev" });
  a.send({ t: "open", rows: 24, cols: 80 });
  await a.until(() => a.msgs.some((m) => m.t === "opened"));
  const session = a.msgs.find((m) => m.t === "opened")!.session as string;
  a.type("echo hi-$((40+2))\n");
  await a.until(() => a.out.includes("hi-42"));
  assert.ok(a.msgs.some((m) => m.t === "inack" && typeof m.upto === "number"));
  a.send({ t: "resize", rows: 30, cols: 100 });
  a.type("stty size\n");
  await a.until(() => a.out.includes("30 100"));
  // the shell doesn't inherit the helper's control pipe (fd 3): it would outlive the helper
  a.type("[ -e /dev/fd/3 ] && echo fd3-$((3*3)) || echo nofd3-$((3*3))\n");
  await a.until(() => /(^|[^o])fd3-9|nofd3-9/.test(a.out));
  assert.ok(a.out.includes("nofd3-9"), "the shell holds fd 3");
  a.ws.close();
  await a.until(() => a.closed !== null);

  const b = new Client(server.port);
  await b.opened();
  b.send({ t: "hello", token: "dev" });
  b.send({ t: "open", session, rows: 24, cols: 80 });
  await b.until(() => b.msgs.some((m) => m.t === "live"));
  const kinds = b.msgs.map((m) => m.t);
  assert.deepEqual(kinds.slice(0, 2), ["opened", "replay"]);
  assert.ok(b.out.startsWith("\x1bc"), "a terminal reset first");
  assert.ok(b.out.includes("hi-42"), "the scrollback is replayed");
  b.type("exit 7\n");
  await b.until(() => b.msgs.some((m) => m.t === "exit"));
  assert.equal(b.msgs.find((m) => m.t === "exit")!.code, 7);
  b.ws.close();
});

test("the relay's page side: ready after the hello, receipts acked, ping answered, unknown receipts and a page that doesn't ack closed", TIMEOUT, async () => {
  const a = new Client(server.port);
  await a.opened();
  a.send({ t: "hello", token: "dev" });
  await a.until(() => a.relay.some((m) => m.relay === "ready"));
  assert.ok(Number.isInteger(a.relay.find((m) => m.relay === "ready")!.gen));
  a.send({ relay: "ping" });
  await a.until(() => a.relay.some((m) => m.relay === "pong"));
  a.send({ t: "open", rows: 24, cols: 80 });
  await a.until(() => a.msgs.some((m) => m.t === "live"));
  const termAck = setInterval(() => a.closed === null && a.send({ t: "ack", upto: Buffer.byteLength(a.out, "latin1") }), 20);
  try {
    // (a receipt comes after 256 KiB of serialized messages, before the terminal's own 256 KiB credit stalls)
    a.type("head -c 700000 /dev/zero | tr '\\0' x\n");
    await a.until(() => a.relay.some((m) => m.relay === "receipt"), 20_000);
  } finally {
    clearInterval(termAck);
  }
  assert.equal(a.closed, null);
  a.send({ relay: "ack", r: "A".repeat(22) });
  await a.until(() => a.closed !== null);
  assert.equal(a.closed!.code, 1008);
  // (a page that doesn't ack: closed 1013 past its window)
  const b = new Client(server.port);
  b.autoAck = false;
  await b.opened();
  b.send({ t: "hello", token: "dev" });
  b.send({ t: "open", rows: 24, cols: 80 });
  await b.until(() => b.msgs.some((m) => m.t === "live"));
  // (output until the page is closed: the mock drops what passes a page's terminal credit, so a bounded burst could
  // be produced faster than the acks free credit and never fill the window; this fills it however fast the machine)
  b.type("while :; do head -c 65536 /dev/zero | tr '\\0' y; done\n");
  // (the page's own ack keeps the terminal credit going; only relay receipts go unacked)
  const acker = setInterval(() => {
    const sent = b.msgs.filter((m) => m.t === "out").reduce((n, m) => n + Buffer.from(m.b as string, "base64").length, 0);
    if (b.closed === null) b.send({ t: "ack", upto: sent });
  }, 20);
  try {
    await b.until(() => b.closed !== null, 20_000);
  } finally {
    clearInterval(acker);
  }
  assert.equal(b.closed!.code, 1013);
  // (its session, still producing, is ended from a page that takes it over)
  const sid = b.msgs.find((m) => m.t === "opened")!.session as string;
  const k = new Client(server.port);
  await k.opened();
  k.send({ t: "hello", token: "dev" });
  k.send({ t: "open", session: sid, rows: 24, cols: 80 });
  await k.until(() => k.msgs.some((m) => m.t === "opened"));
  k.send({ t: "kill", session: sid });
  // (it acks its terminal output too: the exit comes after the output the page has credit for)
  const kAcker = setInterval(() => {
    const got = k.msgs.filter((m) => m.t === "out").reduce((n, m) => n + Buffer.from(m.b as string, "base64").length, 0);
    if (k.closed === null) k.send({ t: "ack", upto: got });
  }, 20);
  try {
    await k.until(() => k.msgs.some((m) => m.t === "exit"), 20_000);
  } finally {
    clearInterval(kAcker);
  }
  k.ws.close();
});

test("a bad hello closes 4403; errors and closes as the agent's protocol has them", TIMEOUT, async () => {
  const c = new Client(server.port);
  await c.opened();
  c.send({ t: "hello", token: "nope" });
  await c.until(() => c.closed !== null);
  assert.equal(c.closed!.code, 4403);

  const d = new Client(server.port);
  await d.opened();
  d.send({ t: "hello", token: "dev" });
  d.send({ t: "resize", rows: 24, cols: 80 });
  await d.until(() => d.msgs.length >= 1);
  assert.deepEqual(d.msgs[0], { t: "error", error: "not_open" });
  d.send({ t: "open", session: "A".repeat(22), rows: 24, cols: 80 });
  await d.until(() => d.msgs.length >= 2);
  assert.deepEqual(d.msgs[1], { t: "error", error: "unknown_session" });
  d.send({ t: "open", rows: 0, cols: 80 });
  await d.until(() => d.closed !== null);
  assert.equal(d.closed!.code, 1008);

  // a takeover: the first page hears "elsewhere" and is closed 4009
  const e = new Client(server.port);
  await e.opened();
  e.send({ t: "hello", token: "dev" });
  e.send({ t: "open", rows: 24, cols: 80 });
  await e.until(() => e.msgs.some((m) => m.t === "live"));
  const session = e.msgs.find((m) => m.t === "opened")!.session as string;
  assert.match(session, /^[A-Za-z0-9_-]{22}$/);
  const f = new Client(server.port);
  await f.opened();
  f.send({ t: "hello", token: "dev" });
  f.send({ t: "open", session, rows: 24, cols: 80 });
  await e.until(() => e.closed !== null);
  assert.equal(e.closed!.code, 4009);
  assert.ok(e.msgs.some((m) => m.t === "error" && m.error === "elsewhere"));
  await f.until(() => f.msgs.some((m) => m.t === "live"));
  // an ack past what was sent closes 1008 (well past: output still on its way, the shell's prompt, counts as sent)
  const sent = f.msgs.filter((m) => m.t === "out").reduce((n, m) => n + Buffer.from(m.b as string, "base64").length, 0);
  f.send({ t: "ack", upto: sent + 1_000_000 });
  await f.until(() => f.closed !== null);
  assert.equal(f.closed!.code, 1008);
});

test("close() ends the open pages, so a failed run still exits", TIMEOUT, async () => {
  const g = new Client(server.port);
  await g.opened();
  g.send({ t: "hello", token: "dev" });
  g.send({ t: "open", rows: 24, cols: 80 });
  await g.until(() => g.msgs.some((m) => m.t === "live"));
  server.close();
  await g.until(() => g.closed !== null, 5_000);
});
