// The browser side of a machine terminal: one WebSocket per terminal session, through the
// machine relay (packages/machine/DESIGN.md 4), speaking the terminal protocol (4.1). No DOM
// and no xterm here: the screen is a TerminalSink, so every protocol rule is tested with a
// fake socket.
//
// The relay's own layer comes first on each connection: the page sends its hello (the
// single-use page token), waits for {"relay":"ready"}, acks every {"relay":"receipt"} at
// once, and pings every 15 s. Messages starting with {"relay":" are the relay's and never
// reach the terminal protocol.

import type { PollTimers } from "../app/polling.ts";

// ---------------------------------------------------------------- limits (the agent enforces them)

/** Ack the output written to the screen at least this often (the agent stops at 256 KiB unacked). */
export const ACK_EVERY_BYTES = 32 * 1024;
/** At most this much input sent and not yet written to the PTY (inack). */
export const INPUT_CREDIT_BYTES = 64 * 1024;
/** Decoded bytes per `in` frame. */
export const IN_FRAME_BYTES = 16 * 1024;
/** Reconnect waits after the agent goes away or the network drops: 1, 2, 4 ... 30 s. */
export const RECONNECT_MAX_MS = 30_000;
/** Ping the relay this often; it closes a page that's silent for 40 s. */
export const PING_EVERY_MS = 15_000;
export const RELAY_PREFIX = '{"relay":"';
export const SIZE_MIN = 1;
export const SIZE_MAX = 1000;

const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;

export function isSessionId(x: unknown): x is string {
  return typeof x === "string" && SESSION_ID.test(x);
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, 1000 * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
}

export function clampSize(n: number): number {
  if (!Number.isFinite(n)) return SIZE_MIN;
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.floor(n)));
}

// ---------------------------------------------------------------- base64 of bytes

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- the relay URL

/**
 * The terminal channel's WebSocket URL, or null when the relay URL from the API isn't one
 * to send a page token to: it must be wss: on exactly the UI's own host (the relay is a
 * route of the UI's site), with no user info. `allowLocal` admits ws://127.0.0.1 for the
 * mock terminal in the demo build only.
 */
export function terminalUrl(relayUrl: unknown, machineId: string, uiHost: string, allowLocal = false): string | null {
  if (typeof relayUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  const local = allowLocal && url.protocol === "ws:" && url.hostname === "127.0.0.1";
  if (!local && (url.protocol !== "wss:" || url.host !== uiHost.toLowerCase())) return null;
  url.search = "";
  url.hash = "";
  url.searchParams.set("machine", machineId);
  url.searchParams.set("chan", "terminal");
  return url.href;
}

// ---------------------------------------------------------------- interfaces

export interface SocketLike {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(code: number, reason: string): void;
}

export type Connect = (url: string, handlers: SocketHandlers) => SocketLike;

export interface TerminalSink {
  /** Put decoded output on the screen; call done() once it is written (xterm's write callback). */
  write(bytes: Uint8Array, done: () => void): void;
  /** Clear the screen before a replay. */
  reset(): void;
}

/** Where the session id survives a reload (sessionStorage, keyed by machine). */
export interface SessionIdStore {
  get(machineId: string): string | null;
  set(machineId: string, id: string | null): void;
}

export type TerminalStatus =
  | { kind: "connecting" }
  | { kind: "replaying" }
  | { kind: "live" }
  /** The shell ended: just now, or before this page attached (its output is shown). */
  | { kind: "exited"; code: number | null; signal: string | null; earlier: boolean }
  | { kind: "reconnecting"; inMs: number }
  /** Another page took this session over. */
  | { kind: "elsewhere" }
  /** Closed for good: access revoked or the machine stopped, too many shells, or a fault. */
  | { kind: "closed"; reason: "revoked" | "sessions" | "spawn" | "unavailable" | "fault"; detail: string };

export interface TerminalOptions {
  machineId: string;
  connect: Connect;
  /** A fresh page token and the terminal URL for one connection; null when none can be had. */
  open: () => Promise<{ token: string; url: string } | null>;
  sink: TerminalSink;
  storage: SessionIdStore;
  timers: PollTimers;
  size: () => { rows: number; cols: number };
  onStatus: (status: TerminalStatus) => void;
}

// ---------------------------------------------------------------- the connection

/** One page-to-agent connection's counters. */
interface Leg {
  socket: SocketLike;
  /** Output bytes written to the screen, and the last amount acked. */
  written: number;
  acked: number;
  /** Input bytes sent, and the agent's last inack. */
  inSent: number;
  inAcked: number;
  /** True between `live` and the first output after it (an exit then ended earlier). */
  justLive: boolean;
  opened: boolean;
  /** The relay said ready: until then nothing but the hello may be sent. */
  ready: boolean;
  ping: unknown;
}

const encoder = new TextEncoder();

export class TerminalSession {
  readonly #o: TerminalOptions;
  #leg: Leg | null = null;
  #status: TerminalStatus = { kind: "connecting" };
  #attempt = 0;
  #timer: unknown;
  #disposed = false;
  /** Input waiting for credit, as encoded frames. */
  #queue: Uint8Array[] = [];
  /** Connections started; an older one's late events are ignored. */
  #epoch = 0;

  constructor(options: TerminalOptions) {
    this.#o = options;
  }

  get status(): TerminalStatus {
    return this.#status;
  }

  start(): void {
    void this.#connect();
  }

  /** Type or paste: sent in frames of at most 16 KiB, never past 64 KiB unacknowledged. */
  input(data: string): void {
    if (this.#status.kind !== "live" || this.#leg == null) return;
    const bytes = encoder.encode(data);
    for (let i = 0; i < bytes.length; i += IN_FRAME_BYTES) this.#queue.push(bytes.subarray(i, i + IN_FRAME_BYTES));
    this.#flushInput();
  }

  resize(rows: number, cols: number): void {
    if (this.#leg?.opened && (this.#status.kind === "live" || this.#status.kind === "replaying")) {
      this.#send({ t: "resize", rows: clampSize(rows), cols: clampSize(cols) });
    }
  }

  /** After an exit (or a lost session): a new shell, on a new connection. */
  newShell(): void {
    this.#o.storage.set(this.#o.machineId, null);
    this.#attempt = 0;
    this.#closeLeg();
    void this.#connect();
  }

  /** Reconnect now (from "elsewhere" or "reconnecting"), reattaching the stored session. */
  reconnect(): void {
    this.#attempt = 0;
    this.#closeLeg();
    void this.#connect();
  }

  dispose(): void {
    this.#disposed = true;
    this.#closeLeg();
  }

  // ---------------------------------------------------------------- internals

  #setStatus(status: TerminalStatus): void {
    this.#status = status;
    this.#o.onStatus(status);
  }

  #closeLeg(): void {
    if (this.#timer !== undefined) this.#o.timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#epoch++;
    const leg = this.#leg;
    this.#leg = null;
    this.#queue = [];
    if (leg) {
      this.#stopPing(leg);
      try {
        leg.socket.close(1000, "");
      } catch {
        // already closed
      }
    }
  }

  async #connect(): Promise<void> {
    if (this.#disposed) return;
    const epoch = ++this.#epoch;
    this.#setStatus({ kind: "connecting" });
    const access = await this.#o.open().catch(() => null);
    if (epoch !== this.#epoch || this.#disposed) return;
    if (access == null) return this.#retry();
    const handlers: SocketHandlers = {
      onOpen: () => epoch === this.#epoch && this.#onOpen(access.token),
      onMessage: (text) => epoch === this.#epoch && this.#onMessage(text),
      onClose: (code, reason) => epoch === this.#epoch && this.#onClose(code, reason),
    };
    let socket: SocketLike;
    try {
      socket = this.#o.connect(access.url, handlers);
    } catch {
      return this.#retry();
    }
    this.#leg = { socket, written: 0, acked: 0, inSent: 0, inAcked: 0, justLive: false, opened: false, ready: false, ping: undefined };
  }

  #schedulePing(leg: Leg): void {
    leg.ping = this.#o.timers.setTimeout(() => {
      leg.ping = undefined;
      if (this.#leg !== leg) return;
      this.#sendRaw({ relay: "ping" });
      this.#schedulePing(leg);
    }, PING_EVERY_MS);
  }

  #stopPing(leg: Leg): void {
    if (leg.ping !== undefined) this.#o.timers.clearTimeout(leg.ping);
    leg.ping = undefined;
  }

  #retry(): void {
    if (this.#disposed) return;
    this.#leg = null;
    const inMs = reconnectDelayMs(++this.#attempt);
    this.#setStatus({ kind: "reconnecting", inMs });
    this.#timer = this.#o.timers.setTimeout(() => {
      this.#timer = undefined;
      void this.#connect();
    }, inMs);
  }

  /**
   * A terminal-protocol message. The relay closes a page that speaks before it's ready;
   * none can: open waits for ready, and everything else needs an open session.
   */
  #send(message: { t: string } & Record<string, unknown>): void {
    this.#leg?.socket.send(JSON.stringify(message));
  }

  /** The relay layer's own messages (and the hello, which comes before ready). */
  #sendRaw(message: object): void {
    this.#leg?.socket.send(JSON.stringify(message));
  }

  #onOpen(token: string): void {
    const leg = this.#leg;
    if (leg == null) return;
    this.#sendRaw({ t: "hello", token });
    this.#schedulePing(leg);
  }

  #onRelay(text: string): void {
    const leg = this.#leg;
    if (leg == null) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return this.#fault("the relay sent something that isn't JSON");
    }
    if (m.relay === "ready") {
      if (leg.ready) return;
      leg.ready = true;
      return this.#openSession();
    }
    if (m.relay === "receipt") {
      if (typeof m.r !== "string" || !SESSION_ID.test(m.r)) return this.#fault("the relay sent a malformed receipt");
      return this.#sendRaw({ relay: "ack", r: m.r });
    }
    // pong, and anything the relay adds later: nothing to do
  }

  #openSession(): void {
    const { rows, cols } = this.#o.size();
    const session = this.#o.storage.get(this.#o.machineId);
    this.#send(
      isSessionId(session)
        ? { t: "open", session, rows: clampSize(rows), cols: clampSize(cols) }
        : { t: "open", rows: clampSize(rows), cols: clampSize(cols) },
    );
  }

  /** A message the protocol doesn't allow: our bug or theirs; stop rather than guess. */
  #fault(detail: string): void {
    this.#closeLeg();
    this.#setStatus({ kind: "closed", reason: "fault", detail });
  }

  #onMessage(text: string): void {
    const leg = this.#leg;
    if (leg == null) return;
    if (text.startsWith(RELAY_PREFIX)) return this.#onRelay(text);
    if (!leg.ready) return this.#fault("the terminal spoke before the relay was ready");
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return this.#fault("the terminal sent something that isn't JSON");
    }
    if (typeof m !== "object" || m === null) return this.#fault("the terminal sent a message that isn't an object");
    switch (m.t) {
      case "opened":
        if (!isSessionId(m.session)) return this.#fault("the terminal sent a malformed session id");
        leg.opened = true;
        this.#o.storage.set(this.#o.machineId, m.session);
        return;
      case "replay":
        this.#o.sink.reset();
        this.#setStatus({ kind: "replaying" });
        return;
      case "live":
        leg.justLive = true;
        this.#attempt = 0;
        this.#setStatus({ kind: "live" });
        return;
      case "out": {
        if (typeof m.b !== "string") return this.#fault("the terminal sent output without bytes");
        let bytes: Uint8Array;
        try {
          bytes = base64ToBytes(m.b);
        } catch {
          return this.#fault("the terminal sent output that isn't base64");
        }
        leg.justLive = false;
        const n = bytes.length;
        this.#o.sink.write(bytes, () => {
          if (this.#leg !== leg) return;
          leg.written += n;
          if (leg.written - leg.acked >= ACK_EVERY_BYTES) {
            leg.acked = leg.written;
            this.#send({ t: "ack", upto: leg.written });
          }
        });
        return;
      }
      case "inack":
        if (typeof m.upto !== "number" || !Number.isSafeInteger(m.upto) || m.upto < leg.inAcked || m.upto > leg.inSent) {
          return this.#fault("the terminal acknowledged input it wasn't sent");
        }
        leg.inAcked = m.upto;
        this.#flushInput();
        return;
      case "exit": {
        const code = typeof m.code === "number" ? m.code : null;
        const signal = typeof m.signal === "string" ? m.signal : null;
        this.#queue = [];
        this.#setStatus({ kind: "exited", code, signal, earlier: leg.justLive });
        return;
      }
      case "error":
        return this.#onError(String(m.error));
      default:
        return this.#fault(`the terminal sent an unknown message (${String(m.t)})`);
    }
  }

  #onError(error: string): void {
    switch (error) {
      case "unknown_session":
      case "expired":
        // The stored session is gone: start a new shell.
        this.#o.storage.set(this.#o.machineId, null);
        this.#closeLeg();
        void this.#connect();
        return;
      case "elsewhere":
        this.#closeLeg();
        this.#setStatus({ kind: "elsewhere" });
        return;
      case "sessions":
        this.#closeLeg();
        this.#setStatus({ kind: "closed", reason: "sessions", detail: "Too many shells are running on this machine (4). Close one first." });
        return;
      case "spawn":
        this.#closeLeg();
        this.#setStatus({ kind: "closed", reason: "spawn", detail: "The shell couldn't start on the machine." });
        return;
      default:
        return this.#fault(`the terminal reported an error: ${error}`);
    }
  }

  #onClose(code: number, reason: string): void {
    if (this.#leg) this.#stopPing(this.#leg);
    this.#leg = null;
    this.#queue = [];
    if (this.#disposed) return;
    if (code === 4009) return this.#setStatus({ kind: "elsewhere" });
    if (code === 4403) {
      return this.#setStatus({ kind: "closed", reason: "revoked", detail: "The terminal is closed: access ended or the machine stopped." });
    }
    if (code === 1002 || code === 1003 || code === 1008 || code === 1009) {
      return this.#setStatus({ kind: "closed", reason: "fault", detail: `The terminal connection was refused (${code}${reason ? `: ${reason}` : ""}).` });
    }
    if (this.#status.kind === "exited") return; // nothing more to show; a new shell is the user's call
    // 4001 (the agent went away), 4429 (the machine's relay rate), 4008 (our rate),
    // 1013 (the agent isn't reading), 1001 (gone quiet), 1006 (network) and the rest
    this.#retry();
  }

  #flushInput(): void {
    const leg = this.#leg;
    while (leg && this.#queue.length > 0) {
      const next = this.#queue[0] as Uint8Array;
      if (leg.inSent - leg.inAcked + next.length > INPUT_CREDIT_BYTES) return;
      this.#queue.shift();
      leg.inSent += next.length;
      this.#send({ t: "in", b: bytesToBase64(next) });
    }
  }
}
