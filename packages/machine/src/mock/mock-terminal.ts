// A mock of the relay's page leg plus the agent's terminal (DESIGN.md section 4.1), for building the UI's terminal
// before the real relay and agent exist.  Local development only: it binds 127.0.0.1, accepts the page token "dev",
// and runs a real shell on this computer in a PTY.  Never deploy it.
//
//   node packages/machine/src/mock/mock-terminal.ts [port]      (default 8790)
//   then: new WebSocket("ws://127.0.0.1:8790/api/relay/v1/page?machine=mch_dev&chan=terminal")
//         first message {"t":"hello","token":"dev"}
//
// It follows the relay's page side (DESIGN.md section 4.1): after the hello, {"relay":"ready","gen":n}; a receipt
// {"relay":"receipt","r":…,"upto":n} after every 256 KiB sent, which the page must ack ({"relay":"ack","r":…}): past
// 1 MiB unacknowledged, or 16 receipts out, the page is closed 1013; {"relay":"ping"} answered with pong, and a page
// silent for 40 s closed 1001; any other relay control closes 1008.  And the agent's protocol (sbgpu_agent/terminal.py): hello; open (new) and open (reattach, with replay); in
// and inack; resize; ack credit (256 KiB high, 64 KiB low); kill; exit last; the errors not_open, sessions,
// unknown_session, elsewhere (then 4009); a malformed message closes the page (1002 or 1008); 4403 for a bad hello;
// 1009 and 1003 for too big and binary.  Output credit is the agent's: while the page is paused (256 KiB
// unacknowledged, until acks bring it to 64 KiB) the PTY isn't read, so the program blocks in write(); nothing is
// skipped from the live stream.  Simplified: input is written at once (no input credit), output isn't coalesced, and
// an exited session stays 10 minutes.  No Node dependencies: a minimal RFC 6455 server (text frames,
// no extensions) and a Python PTY helper.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const MOCK_LIMITS = Object.freeze({
  helloMs: 10_000,
  receiptEvery: 256 * 1024, // bytes sent to the page between receipts
  window: 1024 * 1024, // the page's unacknowledged bytes, at most
  receipts: 16, // receipts out, at most
  overhead: 256, // what each message to the page counts on top of its bytes
  deadMs: 40_000, // a page with no ping for this long is closed 1001
  preHelloBytes: 1024,
  message: 8 * 1024, // any page message but `in`
  inFrame: 16 * 1024, // decoded bytes of one `in`
  outFrame: 48 * 1024, // decoded bytes of one `out`
  creditHigh: 256 * 1024, // unacknowledged output at which sending stops ...
  creditLow: 64 * 1024, // ... until acks bring it down to this
  ring: 1024 * 1024, // scrollback per session
  replayCut: 4096,
  sessions: 4,
  frameMax: 64 * 1024, // the largest WebSocket frame accepted from a page
});
const DEV_TOKEN = "dev";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The PTY helper: runs $SHELL (else /bin/sh) in a PTY; stdin -> PTY, PTY -> stdout; fd 3 takes "rows cols\n" lines.
const PTY_HELPER = `
import fcntl, os, pty, select, signal, struct, sys, termios
os.set_inheritable(3, False)  # the shell and its children must not hold the control pipe open
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    sh = os.environ.get("SHELL") or "/bin/sh"
    os.execv(sh, [sh, "-l"])
ctl = os.fdopen(3, "rb", buffering=0)
fds = [0, fd, 3]
buf = b""
while True:
    try:
        r, _, _ = select.select(fds, [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 49152)
        except OSError:
            data = b""
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            fds.remove(0)
        else:
            os.write(fd, data)
    if 3 in r:
        data = ctl.read(256)
        if not data:
            fds.remove(3)
        buf += data or b""
        while b"\\n" in buf:
            line, buf = buf.split(b"\\n", 1)
            rows, cols = (int(x) for x in line.split())
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.kill(pid, signal.SIGWINCH)
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

interface Session {
  id: string;
  child: ChildProcess;
  ring: Buffer[];
  ringBytes: number;
  exit: { code: number | null; signal: string | null } | null;
  page: Page | null;
}

interface Page {
  send(msg: object): void;
  close(code: number, reason: string): void;
  session: Session | null;
  sent: number; // decoded output bytes sent
  acked: number;
  pending: Buffer[]; // output waiting for credit
  paused: boolean; // at the high-water mark, until acks bring it to the low one
  replaying: boolean; // the replay is still being sent: live follows it
  exitDue: boolean; // the exit goes once the pending output has
  exited: boolean;
  inBytes: number; // decoded input bytes received
}

const sessions = new Map<string, Session>();
const sockets = new Set<Duplex>(); // the upgraded sockets: server.close() and closeAllConnections() leave them open
let generations = 0;

function ringAppend(s: Session, b: Buffer): void {
  s.ring.push(b);
  s.ringBytes += b.length;
  while (s.ringBytes > MOCK_LIMITS.ring && s.ring.length > 0) {
    const first = s.ring[0]!;
    const over = s.ringBytes - MOCK_LIMITS.ring;
    if (first.length <= over) {
      s.ring.shift();
      s.ringBytes -= first.length;
    } else {
      s.ring[0] = first.subarray(over);
      s.ringBytes -= over;
    }
  }
}

function replayBytes(s: Session): Buffer {
  const all = Buffer.concat(s.ring);
  if (s.ringBytes < MOCK_LIMITS.ring) return all;
  const nl = all.subarray(0, MOCK_LIMITS.replayCut).indexOf(0x0a);
  return nl >= 0 ? all.subarray(nl + 1) : all;
}

function credit(p: Page): number {
  const held = p.sent - p.acked;
  if (held >= MOCK_LIMITS.creditHigh) p.paused = true;
  return p.paused ? 0 : MOCK_LIMITS.creditHigh - held;
}

function pump(p: Page): void {
  while (p.pending.length > 0) {
    const room = Math.min(credit(p), MOCK_LIMITS.outFrame);
    if (room <= 0) return;
    let chunk = p.pending.shift()!;
    if (chunk.length > room) {
      p.pending.unshift(chunk.subarray(room));
      chunk = chunk.subarray(0, room);
    }
    p.sent += chunk.length;
    p.send({ t: "out", b: chunk.toString("base64") });
  }
  if (p.replaying) {
    p.replaying = false;
    p.send({ t: "live" });
  }
  if (p.exitDue && !p.exited && p.session?.exit) {
    p.exited = true;
    p.send({ t: "exit", ...p.session.exit });
  }
}

/**
 * Output credit as the agent has it (DESIGN.md section 4.1): while the attached page is paused (256 KiB unacknowledged,
 * until acks bring it to 64 KiB) the helper's output isn't read, so the PTY fills and the program blocks in write().
 * Nothing goes to the ring only. With no page attached, output is read into the ring (a reattach replays it).
 */
function flow(s: Session): void {
  const p = s.page;
  const stdout = s.child.stdout!;
  if (p && !p.exited && p.paused) stdout.pause();
  else stdout.resume();
}

function output(s: Session, b: Buffer): void {
  ringAppend(s, b);
  const p = s.page;
  if (!p || p.exited) return;
  // (what was read before the pause took hold waits in pending, and is sent as credit allows)
  p.pending.push(b);
  pump(p);
  flow(s);
}

function newSession(rows: number, cols: number): Session {
  const child = spawn("python3", ["-I", "-c", PTY_HELPER], { stdio: ["pipe", "pipe", "inherit", "pipe"] });
  const s: Session = { id: randomBytes(16).toString("base64url"), child, ring: [], ringBytes: 0, exit: null, page: null };
  // (a write to a helper that has exited fails with EPIPE: ignored, its exit is reported by the exit event)
  child.stdin!.on("error", () => {});
  (child.stdio[3] as NodeJS.WritableStream).on("error", () => {});
  (child.stdio[3] as NodeJS.WritableStream).write(`${rows} ${cols}\n`);
  child.stdout!.on("data", (b: Buffer) => output(s, b));
  child.on("exit", (code, signal) => {
    s.exit = { code, signal };
    if (s.page) {
      s.page.exitDue = true;
      pump(s.page);
    }
    setTimeout(() => sessions.delete(s.id), 10 * 60_000).unref();
  });
  sessions.set(s.id, s);
  return s;
}

function size(m: Record<string, unknown>): [number, number] | null {
  const { rows, cols } = m;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return null;
  if ((rows as number) < 1 || (rows as number) > 1000 || (cols as number) < 1 || (cols as number) > 1000) return null;
  return [rows as number, cols as number];
}

function attach(p: Page, s: Session): void {
  if (s.page && s.page !== p) {
    const old = s.page;
    old.session = null;
    old.send({ t: "error", error: "elsewhere" });
    old.close(4009, "the session was opened elsewhere");
  }
  s.page = p;
  p.session = s;
  p.send({ t: "opened", session: s.id });
  p.send({ t: "replay" });
  p.replaying = true;
  p.exitDue = s.exit !== null;
  p.pending.push(Buffer.from("\x1bc"), replayBytes(s));
  // (the helper may still be paused for the page taken over: the replay is at least as long as that page's
  // unacknowledged output, so this page pauses too, and its acks resume the reading)
  pump(p);
}

const SID = /^[A-Za-z0-9_-]{22}$/;

function onMessage(p: Page, text: string): void {
  if (Buffer.byteLength(text) > MOCK_LIMITS.frameMax) return p.close(1009, "too big");
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return p.close(1002, "not a terminal message");
  }
  if (typeof m !== "object" || m === null || Array.isArray(m) || typeof (m as { t?: unknown }).t !== "string") {
    return p.close(1002, "not a terminal message");
  }
  const msg = m as Record<string, unknown>;
  const keys = Object.keys(msg).sort().join(",");
  const s = p.session;
  if (msg.t === "open") {
    if (s) return p.close(1008, "this page already has a terminal");
    const sz = size(msg);
    if (!sz || (keys !== "cols,rows,t" && keys !== "cols,rows,session,t")) return p.close(1008, "terminal open refused (shape)");
    if (msg.session !== undefined) {
      if (typeof msg.session !== "string" || !SID.test(msg.session)) return p.close(1008, "terminal open refused (session)");
      const old = sessions.get(msg.session);
      if (!old) return p.send({ t: "error", error: "unknown_session" });
      attach(p, old);
      if (!old.exit) (old.child.stdio[3] as NodeJS.WritableStream).write(`${sz[0]} ${sz[1]}\n`);
      return;
    }
    const running = [...sessions.values()].filter((x) => !x.exit).length;
    if (running >= MOCK_LIMITS.sessions) return p.send({ t: "error", error: "sessions", limit: MOCK_LIMITS.sessions });
    return attach(p, newSession(sz[0], sz[1]));
  }
  if (!s) return p.send({ t: "error", error: "not_open" });
  if (msg.t !== "in" && Buffer.byteLength(text) > MOCK_LIMITS.message) return p.close(1009, "too big");
  switch (msg.t) {
    case "in": {
      const b = typeof msg.b === "string" && keys === "b,t" ? Buffer.from(msg.b, "base64") : null;
      if (!b || b.toString("base64") !== msg.b || b.length > MOCK_LIMITS.inFrame) {
        return p.close(1008, "a malformed or oversized input frame");
      }
      if (s.exit) return;
      s.child.stdin!.write(b);
      p.inBytes += b.length;
      return p.send({ t: "inack", upto: p.inBytes });
    }
    case "resize": {
      const sz = size(msg);
      if (!sz || keys !== "cols,rows,t") return p.close(1002, "a malformed resize");
      if (!s.exit) (s.child.stdio[3] as NodeJS.WritableStream).write(`${sz[0]} ${sz[1]}\n`);
      return;
    }
    case "ack": {
      const upto = msg.upto;
      if (keys !== "t,upto" || !Number.isInteger(upto) || (upto as number) < p.acked || (upto as number) > p.sent) {
        return p.close(1008, "a bad ack");
      }
      p.acked = upto as number;
      if (p.paused && p.sent - p.acked <= MOCK_LIMITS.creditLow) p.paused = false;
      pump(p);
      return flow(s);
    }
    case "kill": {
      if (keys !== "session,t" || msg.session !== s.id) return p.close(1002, "a kill for another session");
      if (!s.exit) {
        s.child.kill("SIGHUP");
        setTimeout(() => s.exit || s.child.kill("SIGKILL"), 2000).unref();
      }
      return;
    }
    default:
      return p.close(1002, "not a terminal message");
  }
}

// ---- a minimal WebSocket server: text frames, masked from the client, no extensions

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126) {
    head[0] = 0x80 | opcode;
    if (n < 65536) {
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
  }
  return Buffer.concat([head, payload]);
}

function upgrade(req: IncomingMessage, socket: Duplex): void {
  const url = new URL(req.url ?? "/", "http://x");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/api/relay/v1/page" || url.searchParams.get("chan") !== "terminal" || typeof key !== "string") {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

  let hello = false;
  let preHello = 0;
  let closed = false;
  let buf = Buffer.alloc(0);
  // (the relay's accounting toward the page: bytes sent and acknowledged, receipts out, the last ping)
  const rx = { sent: 0, acked: 0, since: 0, tokens: [] as Array<[string, number]> };
  let lastPing = Date.now();
  // The page goes, closed or dropped; the session lives on, for a reattach, and with no page its output is
  // read into the ring again.
  const detach = (): void => {
    if (page.session?.page !== page) return;
    page.session.page = null;
    flow(page.session);
  };
  const write = (text: string): boolean => {
    if (closed) return false;
    const w = Buffer.byteLength(text) + MOCK_LIMITS.overhead;
    if (rx.sent - rx.acked + w > MOCK_LIMITS.window || rx.tokens.length >= MOCK_LIMITS.receipts) {
      page.close(1013, "the page isn't reading");
      return false;
    }
    socket.write(frame(1, Buffer.from(text)));
    rx.sent += w;
    rx.since += w;
    if (rx.since >= MOCK_LIMITS.receiptEvery) {
      const r = randomBytes(16).toString("base64url");
      rx.tokens.push([r, rx.sent]);
      rx.since = 0;
      socket.write(frame(1, Buffer.from(JSON.stringify({ relay: "receipt", r, upto: rx.sent }))));
    }
    return true;
  };
  const relayControl = (text: string): void => {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      m = null;
    }
    const c = m as Record<string, unknown> | null;
    if (c && JSON.stringify(c) === text && c.relay === "ping" && Object.keys(c).length === 1) {
      lastPing = Date.now();
      socket.write(frame(1, Buffer.from('{"relay":"pong"}')));
      return;
    }
    if (c && JSON.stringify(c) === text && c.relay === "ack" && Object.keys(c).join() === "relay,r" && typeof c.r === "string") {
      const i = rx.tokens.findIndex(([t]) => t === c.r);
      if (i < 0) return page.close(1008, "an unknown receipt");
      rx.acked = Math.max(rx.acked, rx.tokens[i]![1]);
      rx.tokens.splice(0, i + 1);
      return;
    }
    page.close(1008, "a malformed control");
  };
  const page: Page = {
    send: (msg) => write(JSON.stringify(msg)),
    close: (code, reason) => {
      if (closed) return;
      closed = true;
      const b = Buffer.alloc(2 + Buffer.byteLength(reason));
      b.writeUInt16BE(code, 0);
      b.write(reason, 2);
      socket.end(frame(8, b));
      detach();
    },
    session: null,
    sent: 0,
    acked: 0,
    pending: [],
    paused: false,
    replaying: false,
    exitDue: false,
    exited: false,
    inBytes: 0,
  };
  const timer = setTimeout(() => hello || page.close(4403, "no hello"), MOCK_LIMITS.helloMs);
  sockets.add(socket);
  const dead = setInterval(() => Date.now() - lastPing > MOCK_LIMITS.deadMs && page.close(1001, "no ping"), 1000);
  dead.unref();
  socket.on("close", () => {
    sockets.delete(socket);
    clearTimeout(timer);
    clearInterval(dead);
    closed = true;
    detach();
  });
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0]! & 0x80) !== 0;
      const op = buf[0]! & 0x0f;
      const masked = (buf[1]! & 0x80) !== 0;
      let len = buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MOCK_LIMITS.frameMax)) return page.close(1009, "frame too big");
        len = Number(big);
        off = 10;
      }
      if (!masked) return page.close(1002, "unmasked");
      if (len > MOCK_LIMITS.frameMax) return page.close(1009, "frame too big");
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i]! ^= mask[i & 3]!;
      buf = buf.subarray(off + 4 + len);
      if (!fin) return page.close(1003, "fragmented frames aren't supported");
      if (op === 8) return page.close(1000, "");
      if (op === 9) {
        socket.write(frame(10, data));
        continue;
      }
      if (op === 10) continue;
      if (op !== 1) return page.close(1003, "text only");
      const text = data.toString("utf8");
      if (!hello) {
        preHello += data.length;
        if (preHello > MOCK_LIMITS.preHelloBytes) return page.close(1009, "too big before hello");
        let m: Record<string, unknown> | null = null;
        try {
          m = JSON.parse(text);
        } catch {
          m = null;
        }
        if (!m || m.t !== "hello" || m.token !== DEV_TOKEN) return page.close(4403, "bad hello");
        hello = true;
        clearTimeout(timer);
        lastPing = Date.now();
        socket.write(frame(1, Buffer.from(JSON.stringify({ relay: "ready", gen: ++generations }))));
        continue;
      }
      if (text.startsWith('{"relay":"')) {
        relayControl(text);
        continue;
      }
      onMessage(page, text);
    }
  });
}

export function startMockTerminal(port: number): Promise<{ port: number; close(): void }> {
  const server = createServer((_req, res) => res.writeHead(426).end("WebSocket only\n"));
  server.on("upgrade", upgrade);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : port,
        close: () => {
          for (const s of sessions.values()) if (!s.exit) s.child.kill("SIGKILL");
          sessions.clear();
          for (const sock of sockets) sock.destroy();
          sockets.clear();
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8790);
  const { port: p } = await startMockTerminal(port);
  console.log(`mock terminal: ws://127.0.0.1:${p}/api/relay/v1/page?machine=mch_dev&chan=terminal (hello token "dev")`);
}
