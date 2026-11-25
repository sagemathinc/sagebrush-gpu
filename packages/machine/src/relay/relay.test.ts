// The relay (relay.ts, routes.ts) in Miniflare: the control Worker's routes, the MachineRelay object on SQLite, real
// WebSockets for both legs, and tokens signed as control signs them.  The SEC ruling's required rows (Nov 24), the
// wire, the caps, and LIMITS' per-machine bounds.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newId, signToken, TOKEN_TTL_SECONDS, type ClaimsOf, type Key } from "@sbgpu/api";
import { startWorker, type StartedWorker } from "@sbgpu/testing/worker";
import { CHANNEL_CAPS, RELAY_LIMITS } from "./caps.ts";

const SITE = "https://api.test";
const ENTRY = "packages/machine/src/relay/test-entry.ts";
let w: StartedWorker;
let persist: string;
let K1: { publicKey: Key; privateKey: Key };
let K2: { publicKey: Key; privateKey: Key };
let bindings: Record<string, string>;

const pair = () => crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as unknown as Promise<{ publicKey: Key; privateKey: Key }>;
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const jti = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(): Promise<void> {
  w = await startWorker({ entry: ENTRY, durableObjects: { MACHINE_RELAY: "TestMachineRelay" }, bindings, persist });
}

before(async () => {
  K1 = await pair();
  K2 = await pair();
  bindings = { RELAY_TOKEN_KEYS: JSON.stringify({ k1: await crypto.subtle.exportKey("jwk", K1.publicKey) }) };
  persist = mkdtempSync(join(tmpdir(), "sbgpu-relay-"));
  await start();
});
after(async () => {
  // (every leg closed first, so a run with a failed row still exits)
  for (const l of LEGS) {
    try {
      l.ws.close(1000);
    } catch {
      // (closed)
    }
  }
  await w.dispose();
  rmSync(persist, { recursive: true, force: true });
});

async function agentToken(mch: string, inc: number, o: { key?: Key; kid?: string; iat?: number; exp?: number } = {}): Promise<string> {
  const iat = o.iat ?? nowS() - 5;
  const claims: ClaimsOf<"agent"> = { v: 1, kind: "agent", jti: jti(), iat, exp: o.exp ?? iat + TOKEN_TTL_SECONDS.agent, mch, inc };
  return signToken(claims, o.key ?? K1.privateKey, o.kid ?? "k1");
}
async function pageToken(mch: string, inc: number, o: { jti?: string; mbr?: string } = {}): Promise<string> {
  const iat = nowS() - 5;
  const claims: ClaimsOf<"page"> = { v: 1, kind: "page", jti: o.jti ?? jti(), iat, exp: iat + TOKEN_TTL_SECONDS.page, mch, inc, mbr: o.mbr ?? MBR };
  return signToken(claims, K1.privateKey, "k1");
}
const MBR = newId("member");

const LEGS: Leg[] = [];

/** One leg: the WebSocket, what it received, and how it closed. */
class Leg {
  msgs: string[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Ack each receipt as it arrives (a well-behaved receiver). */
  autoAck = true;
  ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    LEGS.push(this);
    ws.addEventListener("message", (e) => {
      const m = String((e as MessageEvent).data);
      this.msgs.push(m);
      if (this.autoAck && m.startsWith('{"relay":"receipt"')) {
        try {
          this.ws.send(JSON.stringify({ relay: "ack", r: (JSON.parse(m) as { r: string }).r }));
        } catch {
          // (closed)
        }
      }
    });
    ws.addEventListener("close", (e) => (this.closed = { code: (e as CloseEvent).code, reason: (e as CloseEvent).reason }));
  }
  send(x: string | object) {
    this.ws.send(typeof x === "string" ? x : JSON.stringify(x));
  }
  // (generous defaults: only a wait that would fail runs to them; under heavy load Miniflare's first answers are slow)
  async until(f: () => boolean, ms = 20_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!f()) {
      if (Date.now() > end) return false;
      await sleep(10);
    }
    return true;
  }
  async closedWith(ms = 20_000): Promise<number | null> {
    await this.until(() => this.closed !== null, ms);
    return this.closed?.code ?? null;
  }
  json(): Array<Record<string, unknown>> {
    return this.msgs.filter((m) => m.startsWith("{")).map((m) => JSON.parse(m));
  }
  controls(op: string) {
    return this.json().filter((m) => m.relay === op);
  }
}

async function connect(side: "peer" | "page", mch: string, chan: string | null = side === "page" ? "terminal" : null): Promise<Leg | Response> {
  const q = new URLSearchParams({ machine: mch });
  if (chan !== null) q.set("chan", chan);
  const res = await w.mf.dispatchFetch(`${SITE}/api/relay/v1/${side}?${q}`, { headers: { upgrade: "websocket" } });
  if (res.status !== 101 || !res.webSocket) return res as unknown as Response;
  res.webSocket.accept();
  return new Leg(res.webSocket as unknown as WebSocket);
}
async function leg(side: "peer" | "page", mch: string, chan?: string | null): Promise<Leg> {
  const l = await connect(side, mch, chan);
  assert.ok(l instanceof Leg, `upgrade refused: ${(l as Response).status}`);
  return l;
}
async function peer(mch: string, inc: number): Promise<Leg> {
  const p = await leg("peer", mch);
  p.send({ t: "hello", token: await agentToken(mch, inc) });
  assert.ok(await p.until(() => p.controls("ready").length === 1), `peer not ready: ${JSON.stringify(p.closed)} ${p.msgs}`);
  return p;
}
async function page(mch: string, inc: number, o: { jti?: string } = {}): Promise<Leg> {
  const g = await leg("page", mch);
  g.send({ t: "hello", token: await pageToken(mch, inc, o) });
  assert.ok(await g.until(() => g.controls("ready").length === 1), `page not ready: ${JSON.stringify(g.closed)}`);
  return g;
}
async function doPost(mch: string, path: string, body: string): Promise<unknown> {
  return (await w.mf.dispatchFetch(`${SITE}/__test/do/${mch}/${path}`, { method: "POST", body })).json();
}
async function state(mch: string): Promise<{ kv: Record<string, unknown>; usedJtis: number; legs: number }> {
  return (await (await w.mf.dispatchFetch(`${SITE}/__test/do/${mch}/__state`)).json()) as never;
}
async function revoke(mch: string, inc: number): Promise<boolean> {
  const r = (await (await w.mf.dispatchFetch(`${SITE}/__test/revoke`, { method: "POST", body: JSON.stringify({ mch, inc }) })).json()) as { acknowledged: boolean };
  return r.acknowledged;
}
async function setClock(mch: string, offsetMs: number) {
  await doPost(mch, "__clock", String(offsetMs));
}
const freeze = (mch: string, at: number) => doPost(mch, "__freeze", String(at));
const take = async (mch: string, n: number) => ((await doPost(mch, "__take", String(n))) as { ok: boolean }).ok;
const stored = async (mch: string) => (JSON.parse((await state(mch)).kv.machineBucket as string) as { t: number }).t;
/** Bytes as the relay charges a frame: its UTF-8 length plus the overhead. */
const cost = (m: string) => Buffer.byteLength(m) + RELAY_LIMITS.overhead;

// ================= routes

test("routes: only /peer and /page, a websocket upgrade, exactly the expected parameters, a machine id, a known channel", async () => {
  const mch = newId("machine");
  const r = async (url: string, headers: Record<string, string> = { upgrade: "websocket" }) => (await w.mf.dispatchFetch(url, { headers })).status;
  assert.equal(await r(`${SITE}/api/relay/v1/other?machine=${mch}`), 404);
  assert.equal(await r(`${SITE}/api/relay/v1/peer?machine=${mch}`, {}), 426);
  assert.equal(await r(`${SITE}/api/relay/v1/peer?machine=nope`), 400);
  assert.equal(await r(`${SITE}/api/relay/v1/peer?machine=${mch}&token=x`), 400); // (no token, nor anything else, in a URL)
  assert.equal(await r(`${SITE}/api/relay/v1/peer?machine=${mch}&machine=${mch}`), 400);
  assert.equal(await r(`${SITE}/api/relay/v1/page?machine=${mch}`), 400);
  assert.equal(await r(`${SITE}/api/relay/v1/page?machine=${mch}&chan=kernel`), 400);
  assert.equal(await r(`${SITE}/api/relay/v1/page?machine=${mch}&chan=terminal&x=1`), 400);
  assert.equal(await r(`${SITE}/api/relay/v1/page?machine=${mch}&chan=terminal`), 101);
  assert.equal(await r(`${SITE}/elsewhere`), 404);
});

// ================= the agent's authentication (SEC rows)

test("agent hello: a good token makes the peer, ready with its incarnation", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  assert.deepEqual(p.controls("ready"), [{ relay: "ready", inc: 1 }]);
  assert.equal((await state(mch)).kv.accepted, 1);
});

test("agent hello refusals before any pairing: another machine, an expired token, an unknown key, a page token, malformed hellos, binary", async () => {
  const mch = newId("machine");
  const cases: Array<[string, () => Promise<string>, number]> = [
    ["another machine's token", async () => JSON.stringify({ t: "hello", token: await agentToken(newId("machine"), 1) }), 4403],
    ["an expired token", async () => JSON.stringify({ t: "hello", token: await agentToken(mch, 1, { iat: nowS() - 1000, exp: nowS() - 10 }) }), 4403],
    ["another key under a known kid", async () => JSON.stringify({ t: "hello", token: await agentToken(mch, 1, { key: K2.privateKey }) }), 4403],
    ["an unknown kid", async () => JSON.stringify({ t: "hello", token: await agentToken(mch, 1, { key: K2.privateKey, kid: "k2" }) }), 4403],
    ["a page token on the peer leg", async () => JSON.stringify({ t: "hello", token: await pageToken(mch, 1) }), 4403],
    ["an extra key", async () => JSON.stringify({ t: "hello", token: await agentToken(mch, 1), x: 1 }), 1008],
    ["keys in another order", async () => JSON.stringify({ token: await agentToken(mch, 1), t: "hello" }), 1008],
    ["not JSON", async () => "hello", 1008],
    ["over the hello cap", async () => JSON.stringify({ t: "hello", token: "x".repeat(RELAY_LIMITS.helloBytes) }), 1008],
    ["a control before the hello", async () => '{"relay":"ping"}', 1008],
  ];
  for (const [why, make, code] of cases) {
    const p = await leg("peer", mch);
    p.send(await make());
    assert.equal(await p.closedWith(), code, why);
    assert.equal(p.controls("ready").length, 0, why);
  }
  const b = await leg("peer", mch);
  b.ws.send(new Uint8Array([1, 2, 3]));
  assert.equal(await b.closedWith(), 1003);
  assert.equal((await state(mch)).kv.accepted ?? 0, 0);
});

test("one hello only: a second hello closes the leg (1008), whether it arrives during the first's check or after", async () => {
  const mch = newId("machine");
  const p = await leg("peer", mch);
  const hello = JSON.stringify({ t: "hello", token: await agentToken(mch, 1) });
  p.send(hello);
  p.send(hello);
  assert.equal(await p.closedWith(), 1008);
  assert.ok(p.controls("ready").length <= 1);
});

test("incarnations: a higher one advances the floor and closes every lower leg; a lower one is refused", async () => {
  const mch = newId("machine");
  const p1 = await peer(mch, 1);
  const g1 = await page(mch, 1);
  const p2 = await peer(mch, 2);
  assert.equal(await p1.closedWith(), 4009);
  assert.equal(await g1.closedWith(), 4001);
  assert.equal((await state(mch)).kv.accepted, 2);
  const low = await leg("peer", mch);
  low.send({ t: "hello", token: await agentToken(mch, 1) });
  assert.equal(await low.closedWith(), 4403);
  // (a page token of the old incarnation is refused too)
  const g = await leg("page", mch);
  g.send({ t: "hello", token: await pageToken(mch, 1) });
  assert.equal(await g.closedWith(), 4403);
  assert.equal(p2.closed, null);
});

test("revoke: durable before it's acknowledged, both legs closed, the same and lower incarnations refused after, a higher one accepted", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 3);
  const g = await page(mch, 3);
  assert.equal(await revoke(mch, 3), true);
  assert.equal(await p.closedWith(), 4403);
  assert.deepEqual(p.controls("revoked"), [{ relay: "revoked" }]);
  assert.equal(await g.closedWith(), 4403);
  assert.equal((await state(mch)).kv.revokedThrough, 3);
  for (const inc of [2, 3]) {
    const again = await leg("peer", mch);
    again.send({ t: "hello", token: await agentToken(mch, inc) });
    assert.equal(await again.closedWith(), 4403, `inc ${inc}`);
  }
  const g2 = await leg("page", mch);
  g2.send({ t: "hello", token: await pageToken(mch, 3) });
  assert.equal(await g2.closedWith(), 4403);
  await peer(mch, 4);
  // (revokedThrough never goes down; malformed revokes aren't acknowledged)
  assert.equal(await revoke(mch, 1), true);
  assert.equal((await state(mch)).kv.revokedThrough, 3);
  assert.equal(await revoke(mch, -1), false);
  assert.equal(await revoke("nope", 1), false);
});

test("revoke survives the object's restart (durable)", async () => {
  const mch = newId("machine");
  await peer(mch, 5);
  assert.equal(await revoke(mch, 5), true);
  await w.dispose();
  await start();
  const p = await leg("peer", mch);
  p.send({ t: "hello", token: await agentToken(mch, 5) });
  assert.equal(await p.closedWith(), 4403);
  assert.equal((await state(mch)).kv.revokedThrough, 5);
});

// ================= pages (SEC rows)

test("page hello: paired with the agent (page-open with its member), ready with its generation; jti consumed", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  const g = await page(mch, 1);
  const open = p.controls("page-open");
  assert.equal(open.length, 1);
  assert.deepEqual(Object.keys(open[0]!), ["relay", "conn", "chan", "gen", "mbr"]);
  assert.equal(open[0]!.chan, "terminal");
  assert.equal(open[0]!.mbr, MBR);
  assert.deepEqual(g.controls("ready"), [{ relay: "ready", gen: open[0]!.gen }]);
  assert.equal((await state(mch)).usedJtis, 1);
});

test("page refusals: another machine, another incarnation, a channel not allowlisted, an agent token", async () => {
  const mch = newId("machine");
  await peer(mch, 2);
  for (const [why, token] of [
    ["another machine", await pageToken(newId("machine"), 2)],
    ["another incarnation", await pageToken(mch, 1)],
    ["a higher incarnation than accepted", await pageToken(mch, 3)],
    ["an agent token", await agentToken(mch, 2)],
  ] as const) {
    const g = await leg("page", mch);
    g.send({ t: "hello", token });
    assert.equal(await g.closedWith(), 4403, why);
  }
  assert.equal((await connect("page", mch, "jupyter")) instanceof Leg, false);
});

test("a page jti is single use: refused again after close, after a pairing failure, and after the object restarts", async () => {
  const mch = newId("machine");
  // (consumed, used, closed; refused again)
  const p = await peer(mch, 1);
  const j = jti();
  const g1 = await page(mch, 1, { jti: j });
  g1.ws.close(1000);
  await g1.closedWith();
  const g2 = await leg("page", mch);
  g2.send({ t: "hello", token: await pageToken(mch, 1, { jti: j }) });
  assert.equal(await g2.closedWith(), 4403);
  // (consumed, then the pairing fails: the agent has gone; the token is spent all the same)
  p.ws.close(1000);
  await p.closedWith();
  await sleep(50);
  const tok = await pageToken(mch, 1);
  const g3 = await leg("page", mch);
  g3.send({ t: "hello", token: tok });
  assert.equal(await g3.closedWith(), 4001);
  await peer(mch, 1);
  const g4 = await leg("page", mch);
  g4.send({ t: "hello", token: tok });
  assert.equal(await g4.closedWith(), 4403);
  // (across a restart)
  await w.dispose();
  await start();
  await peer(mch, 1);
  const g5 = await leg("page", mch);
  g5.send({ t: "hello", token: await pageToken(mch, 1, { jti: j }) });
  assert.equal(await g5.closedWith(), 4403);
});

test("two concurrent presentations of one page token: exactly one is accepted", async () => {
  const mch = newId("machine");
  await peer(mch, 1);
  const tok = await pageToken(mch, 1);
  const legs = await Promise.all([leg("page", mch), leg("page", mch), leg("page", mch)]);
  for (const g of legs) g.send({ t: "hello", token: tok });
  await Promise.all(legs.map((g) => g.until(() => g.closed !== null || g.controls("ready").length > 0)));
  assert.equal(legs.filter((g) => g.controls("ready").length === 1).length, 1);
  assert.equal(legs.filter((g) => g.closed?.code === 4403).length, 2);
});

test("a storage failure while consuming a page token refuses it, with nothing paired or forwarded", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  await doPost(mch, "__failjti", "1");
  const g = await leg("page", mch);
  g.send({ t: "hello", token: await pageToken(mch, 1) });
  assert.equal(await g.closedWith(), 1011);
  assert.equal(p.controls("page-open").length, 0);
  await doPost(mch, "__failjti", "0");
});

test("nothing is forwarded before a leg authenticates, either way; and no token is in any close reason", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  const pending = await leg("page", mch);
  pending.send("1\nsomething for the agent");
  assert.equal(await pending.closedWith(), 1008);
  // (a pending agent leg's application text isn't forwarded either)
  const pp = await leg("peer", mch);
  pp.send("1\nhello page");
  assert.equal(await pp.closedWith(), 1008);
  await sleep(50);
  assert.deepEqual(p.msgs.filter((m) => !m.startsWith('{"relay":"ready"')), []);
  const tok = await agentToken(newId("machine"), 1);
  const bad = await leg("peer", mch);
  bad.send({ t: "hello", token: tok });
  await bad.closedWith();
  assert.ok(!bad.closed!.reason.includes(tok.slice(0, 20)));
});

// ================= the wire

test("forwarding: page to agent with its generation, agent to page by generation, dropped for no page", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  const g = await page(mch, 1);
  const gen = p.controls("page-open")[0]!.gen as number;
  g.send('{"t":"open","rows":24,"cols":80}');
  assert.ok(await p.until(() => p.msgs.includes(`${gen}\n{"t":"open","rows":24,"cols":80}`)));
  p.send(`${gen}\n{"t":"opened","session":"x"}`);
  assert.ok(await g.until(() => g.msgs.includes('{"t":"opened","session":"x"}')));
  p.send("999\nnobody");
  assert.ok(await p.until(() => p.controls("dropped").length === 1));
  assert.deepEqual(p.controls("dropped")[0], { relay: "dropped", gen: 999, bytes: 6 });
  // (the agent ends one page)
  p.send(JSON.stringify({ relay: "close", gen }));
  assert.equal(await g.closedWith(), 4000);
  assert.ok(await p.until(() => p.controls("page-close").length === 1));
});

test("caps: a message over its channel's cap closes its sender 1009, both ways", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  const g = await page(mch, 1);
  const gen = p.controls("page-open")[0]!.gen as number;
  g.send("x".repeat(CHANNEL_CAPS.terminal.pageToPeer + 1));
  assert.equal(await g.closedWith(), 1009);
  const g2 = await page(mch, 1);
  const gen2 = p.controls("page-open")[1]!.gen as number;
  p.send(`${gen2}\n${"y".repeat(CHANNEL_CAPS.terminal.peerToPage + 1)}`);
  assert.equal(await p.closedWith(), 1009);
  assert.equal(await g2.closedWith(), 4001);
  void gen;
});

test("receipts and windows: a receiver that doesn't ack stops its sender 1013; acks free it; an unknown receipt closes 1008", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  const g = await page(mch, 1);
  const gen = p.controls("page-open")[0]!.gen as number;
  const chunk = "z".repeat(60_000);
  // (the page acks each receipt: 3.6 MB, several times its 1 MiB window, goes through)
  for (let i = 0; i < 60; i++) {
    p.send(`${gen}\n${chunk}`);
    assert.ok(await g.until(() => g.msgs.filter((m) => m === chunk).length === i + 1), `${i} ${JSON.stringify(p.closed)}`);
  }
  assert.equal(p.closed, null);
  assert.ok(g.controls("receipt").length >= 10);
  // (each receipt's upto is every byte charged to this page before it: data, controls and earlier receipts alike)
  let charged = 0;
  for (const m of g.msgs) {
    if (m.startsWith('{"relay":"receipt"')) assert.equal((JSON.parse(m) as { upto: number }).upto, charged);
    charged += cost(m);
  }
  // (a page that never acks: the agent is closed 1013 at the window, and nothing past it is sent)
  const g2 = await page(mch, 1);
  g2.autoAck = false;
  const gen2 = p.controls("page-open")[1]!.gen as number;
  for (let i = 0; i < 40 && p.closed === null; i++) {
    p.send(`${gen2}\n${chunk}`);
    await sleep(5);
  }
  assert.equal(await p.closedWith(), 1013);
  const got = g2.msgs.filter((m) => m === chunk).length * (chunk.length + 256);
  assert.ok(got <= CHANNEL_CAPS.terminal.window, `${got}`);
  // (an unknown receipt)
  const p2 = await peer(mch, 1);
  p2.send(JSON.stringify({ relay: "ack", r: "A".repeat(22) }));
  assert.equal(await p2.closedWith(), 1008);
});

test("controls: strict grammar; ping answered with pong", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  p.send('{"relay":"ping"}');
  assert.ok(await p.until(() => p.controls("pong").length === 1));
  for (const bad of ['{"relay":"ping","x":1}', '{ "relay":"ping"}', '{"relay":"ping" }', '{"relay":"close","gen":1.0}', '{"relay":"close","gen":0}', '{"relay":"revoked"}']) {
    const q = await peer(mch, 1);
    q.send(bad);
    assert.equal(await q.closedWith(), 1008, bad);
  }
});

// ================= LIMITS: per-machine bounds

test("pending legs are capped, and upgrade attempts are rate-limited per machine (durably)", async () => {
  const mch = newId("machine");
  // (time frozen, here and after the restart: the bucket refills one attempt every 2 s, so on a slow run the wall
  // clock alone could rightly admit one more)
  const T = Date.now();
  await freeze(mch, T);
  const pend: Leg[] = [];
  for (let i = 0; i < RELAY_LIMITS.pending; i++) pend.push(await leg("page", mch));
  const over = await connect("page", mch);
  assert.ok(!(over instanceof Leg) && (over as Response).status === 429);
  for (const l of pend) l.ws.close(1000);
  await Promise.all(pend.map((l) => l.closedWith()));
  await sleep(50);
  // (attempts: the burst is used by the 5 above; spend the rest, then one more is refused even with no pending leg)
  let refused = 0;
  for (let i = 0; i < RELAY_LIMITS.attemptsBurst + 2; i++) {
    const l = await connect("peer", mch);
    if (l instanceof Leg) {
      l.ws.close(1000);
      await l.closedWith();
    } else {
      refused++;
      assert.equal((l as Response).status, 429);
    }
  }
  assert.ok(refused >= 2, `${refused}`);
  // (a reconnect doesn't refill it: the bucket is stored, and a restart reads it back)
  await w.dispose();
  await start();
  await freeze(mch, T);
  const again = await connect("peer", mch);
  assert.ok(!(again instanceof Leg), "an attempt after a restart wasn't limited");
});

test("a pending leg that doesn't say hello within helloMs is closed", async () => {
  const mch = newId("machine");
  const l = await leg("page", mch);
  assert.equal((await state(mch)).legs, 1);
  await setClock(mch, RELAY_LIMITS.helloMs + 1000);
  // (the object closed it: gone from its legs, and a hello on it now gets nowhere.  Miniflare's client doesn't
  // always report the close of a socket that never sent anything, so the server's side is what's asserted.)
  assert.equal((await state(mch)).legs, 0);
  try {
    l.send({ t: "hello", token: await pageToken(mch, 1) });
  } catch {
    // (already closed on this side too)
  }
  await sleep(200);
  assert.equal(l.controls("ready").length, 0);
});

test("dead legs: no ping for deadMs closes the page (1001) and the agent (4001)", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  const g = await page(mch, 1);
  await setClock(mch, RELAY_LIMITS.deadMs + 1000);
  assert.equal(await g.closedWith(), 1001);
  assert.equal(await p.closedWith(), 4001);
});

test("pages per channel are capped: a fifth replaces the oldest (4009), with its page-close to the agent", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  const pages: Leg[] = [];
  for (let i = 0; i < CHANNEL_CAPS.terminal.legs; i++) pages.push(await page(mch, 1));
  const fifth = await page(mch, 1);
  assert.equal(await pages[0]!.closedWith(), 4009);
  assert.ok(await p.until(() => p.controls("page-close").length === 1));
  assert.equal(fifth.closed, null);
  assert.equal(pages.slice(1).every((g) => g.closed === null), true);
});

test("a leg over its message rate is closed 4008", async () => {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  await freeze(mch, Date.now()); // (no refill while the pings arrive, however slowly a loaded machine delivers them)
  for (let i = 0; i < RELAY_LIMITS.legBurst + 50 && p.closed === null; i++) p.send('{"relay":"ping"}');
  assert.equal(await p.closedWith(), 4008);
});

test("the machine's byte bucket bounds all its traffic, whatever the legs: over it, the sender is closed 4429", async () => {
  // (the production figures are 16 MiB and 4 MiB/s; the same bucket is exercised here at 1 MiB and 64 KiB/s, so a test
  // reaches it in well under a second)
  assert.deepEqual([RELAY_LIMITS.machineBytesBurst, RELAY_LIMITS.machineBytesPerSecond], [16 * 1024 * 1024, 4 * 1024 * 1024]);
  const mch = newId("machine");
  await doPost(mch, "__machinerate", JSON.stringify({ perSecond: 64 * 1024, burst: 1024 * 1024 }));
  const p = await peer(mch, 1); // (it acks every receipt)
  const pages: Leg[] = [];
  for (let i = 0; i < 4; i++) pages.push(await page(mch, 1));
  const chunk = "q".repeat(60_000);
  // (four pages, each well under its own message rate and window: together past the machine's bucket)
  let sent = 0;
  for (let round = 0; round < 10 && pages.every((g) => g.closed === null); round++) {
    for (const g of pages) {
      if (g.closed === null) {
        g.send(chunk);
        sent++;
      }
    }
    await p.until(() => p.msgs.filter((m) => m.endsWith(chunk)).length >= sent || pages.some((g) => g.closed !== null), 2000);
  }
  await pages[0]!.until(() => pages.some((g) => g.closed !== null), 3000);
  const codes = pages.map((g) => g.closed?.code ?? null);
  assert.ok(codes.includes(4429), JSON.stringify(codes));
  assert.ok(!codes.includes(4008) && !codes.includes(1013), JSON.stringify(codes));
  const delivered = p.msgs.filter((m) => m.endsWith(chunk)).length * (chunk.length + 3 + RELAY_LIMITS.overhead);
  assert.ok(delivered <= 1024 * 1024 + 2 * 64 * 1024, `${delivered} of ${sent}`);
  // (a new page right away finds the bucket still spent: a reconnect doesn't refill it)
  const g2 = await page(mch, 1);
  for (let i = 0; i < 4 && g2.closed === null; i++) g2.send(chunk);
  assert.equal(await g2.closedWith(), 4429);
});

test("the byte bucket across a restart: credit taken before it is never given back", async () => {
  const T = Date.now();
  const mch = newId("machine");
  const other = newId("machine");
  for (const m of [mch, other]) {
    await freeze(m, T);
    await doPost(m, "__machinerate", JSON.stringify({ perSecond: 0, burst: 1000 }));
  }
  assert.equal(await take(mch, 1), true);
  assert.equal(await stored(mch), 999); // (stored before it is spent)
  assert.equal(await take(mch, 999), true);
  assert.equal(await stored(mch), 0);
  assert.equal(await take(mch, 1), false);
  await w.dispose();
  await start();
  for (const m of [mch, other]) {
    await freeze(m, T);
    await doPost(m, "__machinerate", JSON.stringify({ perSecond: 0, burst: 1000 }));
  }
  assert.equal(await take(mch, 1), false, "a restart gave spent credit back");
  assert.equal(await take(mch, 999), false);
  // (the control: a machine that spent nothing has its whole burst after the same restart)
  assert.equal(await take(other, 999), true);
  // (a reservation's unspent rest is lost at a restart, never regained: a rate of 4000/s reserves 1000 at once)
  const r = newId("machine");
  await freeze(r, T);
  await doPost(r, "__machinerate", JSON.stringify({ perSecond: 4000, burst: 1000 }));
  assert.equal(await take(r, 1), true);
  assert.equal(await stored(r), 0);
  await w.dispose();
  await start();
  await freeze(r, T);
  await doPost(r, "__machinerate", JSON.stringify({ perSecond: 4000, burst: 1000 }));
  assert.equal(await take(r, 1), false);
});

test("the byte bucket: what is stored and what is reserved together never pass the burst", async () => {
  const T = Date.now();
  const mch = newId("machine");
  await freeze(mch, T);
  await doPost(mch, "__machinerate", JSON.stringify({ perSecond: 4000, burst: 1000 }));
  assert.equal(await take(mch, 1), true); // (reserves the whole 1000: 999 left in memory, 0 stored)
  await freeze(mch, T + 1000); // (a second: the stored bucket may refill only to 1000 - 999)
  assert.equal(await take(mch, 1000), true);
  assert.equal(await take(mch, 1), false);
});

/** A peer and a page, then the bucket set to `budget` with time frozen and no refill, then the agent sends the message
 * whose window-quarter crossing makes a receipt due.  Returns what each side got after the budget was set. */
async function receiptAtTheBoundary(budget: (data: number, receipt: number) => number) {
  const mch = newId("machine");
  const p = await peer(mch, 1);
  const g = await page(mch, 1);
  const gen = p.controls("page-open")[0]!.gen as number;
  const threshold = Math.min(RELAY_LIMITS.receiptEvery, CHANNEL_CAPS.terminal.window / 4);
  const body = "d".repeat(60_000);
  const w1 = Buffer.byteLength(body) + RELAY_LIMITS.overhead;
  let sent = cost(g.msgs[0]!); // (the page's ready)
  let k = 0;
  while (sent + w1 < threshold) {
    p.send(`${gen}\n${body}`);
    k++;
    assert.ok(await g.until(() => g.msgs.filter((m) => m === body).length === k));
    sent += w1;
  }
  assert.equal(g.controls("receipt").length, 0);
  await freeze(mch, Date.now());
  await doPost(mch, "__machinerate", JSON.stringify({ perSecond: 0, burst: 16 * 1024 * 1024 }));
  // (the receipt this message makes due: its upto is every byte through this one; r is 22 characters)
  const receipt = JSON.stringify({ relay: "receipt", r: "R".repeat(22), upto: sent + w1 });
  const b = budget(w1, cost(receipt));
  await doPost(mch, "__bucket", String(b));
  const pBefore = p.msgs.length;
  const gBefore = g.msgs.length;
  p.send(`${gen}\n${body}`);
  await p.until(() => p.closed !== null || g.msgs.length > gBefore + 1, 3000);
  await sleep(100);
  const after = [...p.msgs.slice(pBefore), ...g.msgs.slice(gBefore)];
  return { p, g, budget: b, after, charged: after.reduce((n, m) => n + cost(m), 0), mch };
}

test("receipts are admitted with the frame that makes them due: past the bucket, neither is sent (all output counted)", async () => {
  // (one byte short of the data and its receipt: the agent is closed 4429, and nothing at all goes out)
  const short = await receiptAtTheBoundary((d, r) => d + r - 1);
  assert.equal(await short.p.closedWith(), 4429);
  assert.deepEqual(short.after, []);
  // (the control: exactly enough; both go, and every frame sent since the budget was set fits it exactly)
  const exact = await receiptAtTheBoundary((d, r) => d + r);
  assert.equal(exact.p.closed, null);
  assert.equal(exact.g.controls("receipt").length, 1);
  assert.equal(exact.charged, exact.budget);
  assert.equal(await stored(exact.mch), 0);
});

test("the revoke notice is charged like any frame: with no room the agent is still closed 4403, without it", async () => {
  for (const room of [0, 1_000_000]) {
    const mch = newId("machine");
    const p = await peer(mch, 7);
    await freeze(mch, Date.now());
    await doPost(mch, "__machinerate", JSON.stringify({ perSecond: 0, burst: 16 * 1024 * 1024 }));
    await doPost(mch, "__bucket", String(room));
    assert.equal(await revoke(mch, 7), true);
    assert.equal(await p.closedWith(), 4403);
    assert.equal(p.controls("revoked").length, room ? 1 : 0, String(room));
  }
});
