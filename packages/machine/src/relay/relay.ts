// The relay (DESIGN.md section 4): one MachineRelay Durable Object per machine (named by its machine id) joins the
// machine agent's one peer leg and its page legs (members' browsers), as a pipe for text messages.
//
// Ported from Sagebrush's relay (web/cloud/remote/relay.ts; SageMath, Inc.): the generation-prefixed wire, the strict
// control grammar, per-channel caps, receipts and receive windows, per-leg rates, dead-leg alarms, peer replacement
// and revoke are its design.  What differs here:
//   - authentication is in the object, on each leg's first message (SEC ruling, Nov 24): a closed hello frame
//     {"t":"hello","token":"<compact JWS>"} of at most RELAY_LIMITS.helloBytes within helloMs; nothing is forwarded to
//     or from a leg before it authenticates, and no token is ever in a URL, a log or a close reason;
//       - the agent: an `agent` token for this machine; the durable accepted incarnation and the separate
//         revokedThrough decide it (a higher incarnation advances the floor and closes every lower leg; a lower one,
//         or one at or below revokedThrough, is refused);
//       - a page: a `page` token for this machine and the accepted incarnation, on an allowlisted channel; its jti is
//         consumed by one atomic insert into the used set before anything is paired, and stays consumed whatever
//         happens next;
//   - no account byte leases: the machine's traffic is bounded by one machine-wide byte bucket (every message to every
//     receiver, counted with its overhead), stored so a reconnect or an eviction doesn't refill it, with the caps
//     on legs, pending legs, upgrade attempts, message sizes, windows and per-leg rates (caps.ts);
//   - revoke (control, at a stop or a restart) is durable before it is acknowledged, and closes every leg.
//
// On the wire, after its hello:
//   - the agent's messages are controls ({"relay":"close","gen":n}, {"relay":"ack","r":r}, {"relay":"ping"}) or
//     application messages prefixed with their page's generation, "<gen>\n<payload>";
//   - a page's messages are controls ({"relay":"ack","r":r}, {"relay":"ping"}) or application payloads, forwarded to
//     the agent with the page's generation prefixed;
//   - the relay sends the agent {"relay":"ready","inc":n}, page-open {conn, chan, gen, mbr}, page-close {conn, gen},
//     dropped {gen, bytes}, receipt {r, upto}, pong and revoked; a page {"relay":"ready","gen":n}, receipt and pong.
//   Every receiver acks each receipt it is sent; a receiver whose unacknowledged bytes would pass its window closes its
//   sender 1013.
import { DurableObject } from "cloudflare:workers";

import { isId, verifyToken, type Key } from "@sbgpu/api";
import { CHANNEL_CAPS, CHANNELS, CLOSE, RELAY_LIMITS, type Chan } from "./caps.ts";

const SAFE = 2 ** 53 - 1;
const enc = new TextEncoder();
const CONTROL = '{"relay":"';
const PREFIX = /^([1-9][0-9]{0,15})\n/;
const PONG = '{"relay":"pong"}';
const bytes = (s: string) => enc.encode(s).length;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type Rx = { sent: number; acked: number; since: number; tokens: [string, number][] };
type Bucket = { t: number; at: number };
type PendingAtt = { leg: "pending"; side: "peer" | "page"; chan: Chan | null; at: number; hello: boolean };
type PeerAtt = { leg: "peer"; inc: number; rx: Rx; ping: number; bucket: Bucket; ended?: boolean };
type PageAtt = { leg: "page"; inc: number; gen: number; conn: string; chan: Chan; mbr: string; rx: Rx; ping: number; bucket: Bucket; ended?: boolean };
type Att = PendingAtt | PeerAtt | PageAtt;

const newRx = (): Rx => ({ sent: 0, acked: 0, since: 0, tokens: [] });

/** A control message, strictly, or null: <= RELAY_LIMITS.control bytes, `relay` first, then exactly the op's keys in
 * order, each value checked, and the text exactly its one serialization. */
export function parseControl(text: string, ops: Record<string, string[]>): Record<string, unknown> | null {
  if (!text.startsWith(CONTROL) || bytes(text) > RELAY_LIMITS.control) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const op = o.relay;
  if (typeof op !== "string" || !Object.hasOwn(ops, op)) return null;
  const keys = ["relay", ...ops[op]!];
  if (Object.keys(o).join() !== keys.join()) return null;
  for (const k of ops[op]!) {
    const x = o[k];
    if (k === "gen" && !(Number.isInteger(x) && (x as number) >= 1 && (x as number) <= SAFE)) return null;
    if (k === "r" && !(typeof x === "string" && /^[A-Za-z0-9_-]{22}$/.test(x))) return null;
  }
  return JSON.stringify(o) === text ? o : null;
}
export const PEER_OPS: Record<string, string[]> = { close: ["gen"], ack: ["r"], ping: [] };
export const PAGE_OPS: Record<string, string[]> = { ack: ["r"], ping: [] };

/** What the agent's text is: a control, an application message for a generation, or neither (1008). */
export function classifyPeer(text: string): { control: Record<string, unknown> } | { gen: number; payload: string } | null {
  if (text.startsWith(CONTROL)) {
    const c = parseControl(text, PEER_OPS);
    return c ? { control: c } : null;
  }
  const m = PREFIX.exec(text.slice(0, RELAY_LIMITS.prefix));
  const gen = m ? Number(m[1]) : NaN;
  return m && gen <= SAFE ? { gen, payload: text.slice(m[0].length) } : null;
}

/** The hello's token, or null: exactly {"t":"hello","token":"<string>"} in that order, its one serialization. */
export function parseHello(text: string): string | null {
  if (bytes(text) > RELAY_LIMITS.helloBytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).join() !== "t,token" || o.t !== "hello" || typeof o.token !== "string") return null;
  return JSON.stringify(o) === text ? o.token : null;
}

export interface RelayEnv {
  /** The control plane's token-signing public keys: JSON {kid: Ed25519 public JWK}. */
  RELAY_TOKEN_KEYS?: string;
}

export class MachineRelay extends DurableObject<RelayEnv> {
  private keysCache: Map<string, Key> | null = null;
  // (the machine-wide byte bucket, in memory, written to storage at most every bucketPersistMs; read back after an
  // eviction, so neither a reconnect nor an eviction refills it beyond what time would)
  private machine: Bucket | null = null;
  private machineSavedAt = 0;

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS used_jti (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
  }

  /** The clock (ms).  (Tests: a subclass with a logical one.) */
  protected now(): number {
    return Date.now();
  }

  /** The machine-wide byte bucket's rate and burst.  (Tests: a subclass may lower them, to reach them quickly.) */
  protected machineRate(): { perSecond: number; burst: number } {
    return { perSecond: RELAY_LIMITS.machineBytesPerSecond, burst: RELAY_LIMITS.machineBytesBurst };
  }

  // ---- durable state
  private get<T>(k: string): T | null {
    const rows = this.ctx.storage.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray();
    return rows.length ? (rows[0]!.v as T) : null;
  }
  private put(k: string, v: unknown): void {
    this.ctx.storage.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v as SqlStorageValue);
  }
  private accepted(): number {
    return this.get<number>("accepted") ?? 0;
  }
  private revokedThrough(): number {
    return this.get<number>("revokedThrough") ?? 0;
  }

  private async keys(): Promise<Map<string, Key>> {
    if (this.keysCache) return this.keysCache;
    const m = new Map<string, Key>();
    const jwks = JSON.parse(this.env.RELAY_TOKEN_KEYS ?? "{}") as Record<string, JsonWebKey>;
    for (const [kid, jwk] of Object.entries(jwks)) {
      // (only the public key's own fields: an `alg` spelled either way, or any other member, is never passed on)
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("RELAY_TOKEN_KEYS: not an Ed25519 public key");
      const pub = { kty: "OKP", crv: "Ed25519", x: jwk.x };
      m.set(kid, (await crypto.subtle.importKey("jwk", pub, { name: "Ed25519" }, false, ["verify"])) as unknown as Key);
    }
    return (this.keysCache = m);
  }

  // ---- legs
  private att(ws: WebSocket): Att {
    return ws.deserializeAttachment() as Att;
  }
  private live(w: WebSocket): boolean {
    try {
      const a = this.att(w);
      return w.readyState === WebSocket.OPEN && !(a.leg !== "pending" && a.ended);
    } catch {
      return false;
    }
  }
  private legs(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => this.live(w));
  }
  private pending(): WebSocket[] {
    return this.legs().filter((w) => this.att(w).leg === "pending");
  }
  private peers(): WebSocket[] {
    return this.legs().filter((w) => this.att(w).leg === "peer");
  }
  private pages(): WebSocket[] {
    return this.legs().filter((w) => this.att(w).leg === "page");
  }
  private page(gen: number): WebSocket | undefined {
    return this.pages().find((w) => (this.att(w) as PageAtt).gen === gen);
  }
  private send(ws: WebSocket | undefined, text: string): boolean {
    if (!ws) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }
  /** Close a leg from here, and settle what its end means at once (a page's page-close, a peer's pages). */
  private close(ws: WebSocket, code: number, reason: string): void {
    const wasLive = this.live(ws);
    try {
      ws.close(code, reason);
    } catch {
      // (already closed)
    }
    if (wasLive) this.gone(ws);
  }
  private endPeer(p: WebSocket, code: number, reason: string): void {
    const a = this.att(p) as PeerAtt;
    if (a.ended) return;
    a.ended = true;
    p.serializeAttachment(a);
    try {
      p.close(code, reason);
    } catch {
      // (already closed)
    }
  }
  private endPage(p: WebSocket, code: number, reason: string, announce: boolean): void {
    const a = this.att(p) as PageAtt;
    if (a.ended) return;
    a.ended = true;
    p.serializeAttachment(a);
    try {
      p.close(code, reason);
    } catch {
      // (already closed)
    }
    if (announce) this.pageClose(a);
  }
  private pageClose(a: PageAtt): void {
    for (const p of this.peers()) this.sendControl(p, p, this.att(p) as PeerAtt, JSON.stringify({ relay: "page-close", conn: a.conn, gen: a.gen }));
  }

  // ---- buckets
  /** A durable bucket for upgrade attempts: true if one more is allowed now. */
  private attempt(now: number): boolean {
    const per = RELAY_LIMITS.attemptsPerMinute / 60_000;
    const b = this.get<string>("attempts");
    const cur: Bucket = b ? (JSON.parse(b) as Bucket) : { t: RELAY_LIMITS.attemptsBurst, at: now };
    const t = Math.min(RELAY_LIMITS.attemptsBurst, cur.t + Math.max(0, now - cur.at) * per);
    if (t < 1) return false;
    this.put("attempts", JSON.stringify({ t: t - 1, at: now }));
    return true;
  }
  /** Take n bytes from the machine-wide bucket: false if it hasn't them (nothing taken). */
  private machineTake(n: number): boolean {
    const now = this.now();
    const { perSecond, burst } = this.machineRate();
    if (!this.machine) {
      const b = this.get<string>("machineBucket");
      this.machine = b ? (JSON.parse(b) as Bucket) : { t: burst, at: now };
    }
    const m = this.machine;
    const t = Math.min(burst, m.t + (Math.max(0, now - m.at) * perSecond) / 1000);
    if (t < n) {
      this.machine = { t, at: now };
      return false;
    }
    this.machine = { t: t - n, at: now };
    if (now - this.machineSavedAt >= RELAY_LIMITS.bucketPersistMs) {
      this.machineSavedAt = now;
      this.put("machineBucket", JSON.stringify(this.machine));
    }
    return true;
  }

  // ---- the Worker's internal requests: a leg's upgrade, and revoke
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const no = (status: number, error: string) => Response.json({ error }, { status });
    const mch = req.headers.get("x-r-mch") ?? "";
    if (!isId("machine", mch)) return no(400, "bad request");
    const stored = this.get<string>("mch");
    if (stored === null) this.put("mch", mch);
    else if (stored !== mch) return no(400, "bad request");
    if (url.pathname === "/revoke" && req.method === "POST") return this.revoke(req);
    if (url.pathname !== "/leg") return no(404, "not found");
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return no(426, "upgrade required");
    const side = url.searchParams.get("side");
    if (side !== "peer" && side !== "page") return no(400, "bad request");
    const chanRaw = url.searchParams.get("chan");
    const chan = side === "page" ? (CHANNELS as readonly string[]).includes(chanRaw ?? "") ? (chanRaw as Chan) : null : null;
    if (side === "page" && chan === null) return no(400, "unknown channel");
    if (side === "peer" && chanRaw !== null) return no(400, "bad request");
    const now = this.now();
    if (!this.attempt(now)) return no(429, "too many connection attempts");
    if (this.pending().length >= RELAY_LIMITS.pending) return no(429, "too many unauthenticated connections");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ leg: "pending", side, chan, at: now, hello: false } satisfies PendingAtt);
    await this.arm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Control's revoke (a stop or a restart): revokedThrough raised durably first, then every leg at or below it
   * closed.  The response (the acknowledgement control waits for) is sent only after the write. */
  private async revoke(req: Request): Promise<Response> {
    let inc: unknown;
    try {
      inc = ((await req.json()) as { inc?: unknown }).inc;
    } catch {
      inc = undefined;
    }
    if (!(Number.isSafeInteger(inc) && (inc as number) >= 0)) return Response.json({ error: "bad request" }, { status: 400 });
    const through = Math.max(this.revokedThrough(), inc as number);
    this.put("revokedThrough", through);
    await this.ctx.storage.sync(); // (durable before the acknowledgement)
    for (const w of this.legs()) {
      const a = this.att(w);
      if (a.leg === "pending") {
        this.close(w, CLOSE.forbidden, "revoked");
      } else if (a.inc <= through) {
        if (a.leg === "peer") {
          this.send(w, '{"relay":"revoked"}');
          this.endPeer(w, CLOSE.forbidden, "revoked");
        } else {
          this.endPage(w, CLOSE.forbidden, "revoked", false);
        }
      }
    }
    await this.arm();
    return Response.json({ ok: true, revokedThrough: through });
  }

  // ---- messages
  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.live(ws)) return;
    const a = this.att(ws);
    if (typeof raw !== "string") return this.close(ws, 1003, "text messages only");
    if (a.leg === "pending") {
      try {
        return await this.hello(ws, a, raw);
      } catch {
        // (anything unexpected while authenticating: refused, nothing paired)
        return this.close(ws, 1011, "unavailable");
      }
    }
    // (the leg's rate, from its own bucket: over it, closed 4008)
    const now = this.now();
    const t = Math.min(RELAY_LIMITS.legBurst, a.bucket.t + ((now - a.bucket.at) * RELAY_LIMITS.legRate) / 1000);
    if (t < 1) return this.close(ws, CLOSE.rate, "rate");
    a.bucket = { t: t - 1, at: now };
    ws.serializeAttachment(a);
    if (a.leg === "peer") return this.fromPeer(ws, a, raw);
    return this.fromPage(ws, a, raw);
  }

  /** A pending leg's one hello: everything checked before the leg becomes a peer or a page; any failure closes it. */
  private async hello(ws: WebSocket, a: PendingAtt, text: string): Promise<void> {
    if (a.hello) return this.close(ws, 1008, "one hello only"); // (a second message while the first is checked)
    a.hello = true;
    ws.serializeAttachment(a);
    const token = parseHello(text);
    if (token === null) return this.close(ws, 1008, "a malformed hello");
    const mch = this.get<string>("mch");
    const nowS = Math.floor(this.now() / 1000);
    const r = a.side === "peer"
      ? await verifyToken(token, await this.keys(), "agent", nowS)
      : await verifyToken(token, await this.keys(), "page", nowS);
    // (after the await: the leg still this pending one)
    if (!this.live(ws) || this.att(ws).leg !== "pending") return;
    if (!r.ok || r.claims.mch !== mch) return this.close(ws, CLOSE.forbidden, "refused");
    const claims = r.claims;
    try {
      if (a.side === "peer") return this.acceptPeer(ws, claims.inc);
      return this.acceptPage(ws, a.chan!, claims.inc, claims.jti, claims.exp, (claims as { mbr: string }).mbr);
    } catch {
      // (a storage failure: refused, nothing paired)
      return this.close(ws, 1011, "unavailable");
    }
  }

  private acceptPeer(ws: WebSocket, inc: number): void {
    if (inc <= this.revokedThrough()) return this.close(ws, CLOSE.forbidden, "refused");
    const floor = this.accepted();
    if (inc < floor) return this.close(ws, CLOSE.forbidden, "refused");
    // (a new incarnation: the floor advances durably)
    if (inc > floor) this.put("accepted", inc);
    // (every existing leg goes, so every leg of a lower incarnation too: a newer peer replaces the older (4009), and
    // the pages paired with it end (4001) and reconnect with fresh tokens)
    for (const o of this.peers()) this.endPeer(o, CLOSE.replaced, "replaced by a newer connection");
    for (const p of this.pages()) this.endPage(p, CLOSE.peerGone, "the machine reconnected", false);
    const now = this.now();
    const att: PeerAtt = { leg: "peer", inc, rx: newRx(), ping: now, bucket: { t: RELAY_LIMITS.legBurst, at: now } };
    ws.serializeAttachment(att);
    this.sendControl(ws, ws, att, JSON.stringify({ relay: "ready", inc }));
    void this.arm();
  }

  private acceptPage(ws: WebSocket, chan: Chan, inc: number, jti: string, exp: number, mbr: string): void {
    if (inc <= this.revokedThrough() || inc !== this.accepted()) return this.close(ws, CLOSE.forbidden, "refused");
    // (the jti, once: one atomic insert into the used set, before anything is paired; it stays consumed whatever
    // happens next.  Expired entries go first: their tokens can't verify any more.)
    const consumed = this.consumeJti(jti, exp);
    if (consumed === "full") return this.close(ws, CLOSE.machineRate, "too many page tokens");
    if (consumed !== "consumed") return this.close(ws, CLOSE.forbidden, "refused");
    // ---- consumed; now the pairing
    const peer = this.peers().find((p) => (this.att(p) as PeerAtt).inc === inc);
    if (!peer) return this.close(ws, CLOSE.peerGone, "the machine isn't connected");
    const caps = CHANNEL_CAPS[chan];
    const same = this.pages().filter((p) => (this.att(p) as PageAtt).chan === chan);
    if (same.length >= caps.legs) {
      const oldest = same.sort((x, y) => (this.att(x) as PageAtt).gen - (this.att(y) as PageAtt).gen)[0]!;
      this.endPage(oldest, CLOSE.replaced, "opened in another page", true);
    }
    if (this.pages().length >= RELAY_LIMITS.pages) return this.close(ws, CLOSE.machineRate, "too many pages");
    const gen = (this.get<number>("gen") ?? 0) + 1;
    this.put("gen", gen); // (never reused, across hibernation and eviction)
    const now = this.now();
    const att: PageAtt = { leg: "page", inc, gen, conn: b64url(crypto.getRandomValues(new Uint8Array(12))), chan, mbr, rx: newRx(), ping: now, bucket: { t: RELAY_LIMITS.legBurst, at: now } };
    ws.serializeAttachment(att);
    this.sendControl(ws, peer, this.att(peer) as PeerAtt, JSON.stringify({ relay: "page-open", conn: att.conn, chan, gen, mbr }));
    if (this.live(ws)) this.sendControl(ws, ws, att, JSON.stringify({ relay: "ready", gen }));
    void this.arm();
  }

  /** A page token's jti, consumed once: expired entries pruned (their tokens can't verify any more), then one atomic
   * insert.  "used" if it was already there; "full" past RELAY_LIMITS.usedJtis unexpired entries.  A storage error
   * throws (the hello then refuses: fail closed).  (Tests: a subclass may fail it.) */
  protected consumeJti(jti: string, exp: number): "consumed" | "used" | "full" {
    const nowS = Math.floor(this.now() / 1000);
    this.ctx.storage.sql.exec("DELETE FROM used_jti WHERE exp <= ?", nowS);
    const count = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM used_jti").one().n as number;
    if (count >= RELAY_LIMITS.usedJtis) return "full";
    // (RETURNING gives the row only if this insert made it; rowsWritten would count the key's index row too)
    const made = this.ctx.storage.sql.exec("INSERT INTO used_jti (jti, exp) VALUES (?, ?) ON CONFLICT (jti) DO NOTHING RETURNING jti", jti, exp).toArray();
    return made.length === 1 ? "consumed" : "used";
  }

  private fromPeer(ws: WebSocket, a: PeerAtt, text: string): void {
    const k = classifyPeer(text);
    if (!k) return this.close(ws, 1008, "neither a control nor a prefixed application message");
    if ("control" in k) {
      const c = k.control;
      if (c.relay === "ping") {
        a.ping = this.now();
        ws.serializeAttachment(a);
        this.sendControl(ws, ws, a, PONG);
        return;
      }
      if (c.relay === "close") {
        const p = this.page(c.gen as number);
        if (p) this.endPage(p, CLOSE.closedByPeer, "closed by the machine", true);
        return;
      }
      return this.ack(ws, a, c.r as string);
    }
    const { gen, payload } = k;
    const n = bytes(payload);
    const p = this.page(gen);
    if (!p) {
      this.sendControl(ws, ws, a, JSON.stringify({ relay: "dropped", gen, bytes: n }));
      return;
    }
    const pa = this.att(p) as PageAtt;
    const caps = CHANNEL_CAPS[pa.chan];
    if (n > caps.peerToPage) return this.close(ws, 1009, "a message over its channel's cap");
    this.forward(ws, p, pa, payload, n, caps.window);
  }

  private fromPage(ws: WebSocket, a: PageAtt, text: string): void {
    if (text.startsWith(CONTROL)) {
      const c = parseControl(text, PAGE_OPS);
      if (!c) return this.close(ws, 1008, "a malformed control");
      if (c.relay === "ping") {
        a.ping = this.now();
        ws.serializeAttachment(a);
        this.sendControl(ws, ws, a, PONG);
        return;
      }
      return this.ack(ws, a, c.r as string);
    }
    const peer = this.peers().find((p) => (this.att(p) as PeerAtt).inc === a.inc);
    if (!peer) return this.close(ws, CLOSE.peerGone, "the machine isn't connected");
    const n = bytes(text);
    if (n > CHANNEL_CAPS[a.chan].pageToPeer) return this.close(ws, 1009, "a message over its channel's cap");
    const head = `${a.gen}\n`;
    this.forward(ws, peer, this.att(peer) as PeerAtt, head + text, head.length + n, RELAY_LIMITS.peerWindow);
  }

  /** Send `text` (n bytes) to `to`, or close the sender, sending nothing: 1013 if the receiver's unacknowledged bytes
   * plus this message would pass its window (or every receipt token is out); 4429 if the machine's byte bucket hasn't
   * room.  Nothing is ever queued: the relay forwards at once or closes. */
  private forward(from: WebSocket, to: WebSocket, ta: PeerAtt | PageAtt, text: string, n: number, window: number): boolean {
    const w = n + RELAY_LIMITS.overhead;
    if (ta.rx.sent - ta.rx.acked + w > window || ta.rx.tokens.length >= RELAY_LIMITS.tokens) {
      this.close(from, 1013, "the receiver isn't reading");
      return false;
    }
    if (!this.machineTake(w)) {
      this.close(from, CLOSE.machineRate, "the machine's relay rate");
      return false;
    }
    return this.push(to, ta, text, w, window);
  }

  /** Send, charge the receiver, and once receiptEvery (or a quarter of the window) has gone since the last receipt, a
   * receipt behind it (charged too). */
  private push(to: WebSocket, ta: PeerAtt | PageAtt, text: string, w: number, window: number): boolean {
    const rx = ta.rx;
    if (!this.send(to, text)) return false;
    rx.sent += w;
    rx.since += w;
    if (rx.since >= Math.min(RELAY_LIMITS.receiptEvery, window / 4) && rx.tokens.length < RELAY_LIMITS.tokens) {
      const r = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const receipt = JSON.stringify({ relay: "receipt", r, upto: rx.sent });
      rx.tokens.push([r, rx.sent]);
      rx.since = 0;
      this.machineTake(bytes(receipt) + RELAY_LIMITS.overhead); // (counted; never refused: it is the relay's own)
      this.send(to, receipt);
    }
    to.serializeAttachment(ta);
    return true;
  }

  /** A control from the relay to a receiver, charged against its window and the machine's bucket like data; one that
   * doesn't fit closes `offender` (whose action caused it), unsent. */
  private sendControl(offender: WebSocket, to: WebSocket, ta: PeerAtt | PageAtt, text: string): boolean {
    const window = ta.leg === "page" ? CHANNEL_CAPS[ta.chan].window : RELAY_LIMITS.peerWindow;
    const w = bytes(text) + RELAY_LIMITS.overhead;
    if (ta.rx.sent - ta.rx.acked + w > window) {
      this.close(offender, 1013, "the receiver isn't reading");
      return false;
    }
    if (!this.machineTake(w)) {
      this.close(offender, CLOSE.machineRate, "the machine's relay rate");
      return false;
    }
    return this.push(to, ta, text, w, window);
  }

  /** An ack: only a token issued to this very connection, still open; cumulative. */
  private ack(ws: WebSocket, a: PeerAtt | PageAtt, r: string): void {
    const i = a.rx.tokens.findIndex(([t]) => t === r);
    if (i < 0) return this.close(ws, 1008, "an unknown receipt");
    a.rx.acked = Math.max(a.rx.acked, a.rx.tokens[i]![1]);
    a.rx.tokens.splice(0, i + 1);
    ws.serializeAttachment(a);
  }

  // ---- deadlines: a pending leg's hello, and dead legs; one alarm at the earliest
  private async arm(): Promise<void> {
    const times: number[] = [];
    for (const w of this.legs()) {
      const a = this.att(w);
      times.push(a.leg === "pending" ? a.at + RELAY_LIMITS.helloMs : a.ping + RELAY_LIMITS.deadMs);
    }
    if (!times.length) return this.ctx.storage.deleteAlarm();
    await this.ctx.storage.setAlarm(Math.min(...times));
  }
  override async alarm(): Promise<void> {
    const now = this.now();
    for (const w of this.legs()) {
      const a = this.att(w);
      if (a.leg === "pending") {
        if (now - a.at >= RELAY_LIMITS.helloMs) this.close(w, CLOSE.forbidden, "no hello");
      } else if (now - a.ping >= RELAY_LIMITS.deadMs) {
        this.close(w, a.leg === "peer" ? CLOSE.peerGone : 1001, "no ping");
      }
    }
    await this.arm();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.gone(ws);
    try {
      ws.close(1000, "closed");
    } catch {
      // (already closed)
    }
  }
  override async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws);
  }
  private gone(ws: WebSocket): void {
    let a: Att;
    try {
      a = this.att(ws);
    } catch {
      return;
    }
    if (!a || a.leg === "pending" || a.ended) {
      void this.arm();
      return;
    }
    a.ended = true;
    ws.serializeAttachment(a);
    if (a.leg === "page") {
      this.pageClose(a);
      void this.arm();
      return;
    }
    if (this.peers().length) return;
    for (const p of this.pages()) this.endPage(p, CLOSE.peerGone, "the machine disconnected", false);
    void this.arm();
  }
}
