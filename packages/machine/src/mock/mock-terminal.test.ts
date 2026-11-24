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
  out = "";
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/v1/page?machine=mch_dev&chan=terminal`);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      this.msgs.push(m);
      if (m.t === "out") {
        const b = Buffer.from(m.b, "base64");
        this.out += b.toString("latin1");
      }
    };
    this.ws.onclose = (e) => (this.closed = { code: e.code });
  }
  async opened() {
    await new Promise((r) => (this.ws.onopen = r));
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

test("hello, open, type, output, ack, resize, reattach with replay, exit", async () => {
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

test("a bad hello closes 4403; errors and closes as the agent's protocol has them", async () => {
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
  // an ack past what was sent closes 1008
  const sent = f.msgs.filter((m) => m.t === "out").reduce((n, m) => n + Buffer.from(m.b as string, "base64").length, 0);
  f.send({ t: "ack", upto: sent + 1 });
  await f.until(() => f.closed !== null);
  assert.equal(f.closed!.code, 1008);
});
