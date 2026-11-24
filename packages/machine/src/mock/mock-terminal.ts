// A mock of the relay's page leg plus the agent's terminal (DESIGN.md section 4.1), for building the UI's terminal
// before the real relay and agent exist.  Local development only: it binds 127.0.0.1, accepts the page token "dev",
// and runs a real shell on this computer in a PTY.  Never deploy it.
//
//   node packages/machine/src/mock/mock-terminal.ts [port]      (default 8790)
//   then: new WebSocket("ws://127.0.0.1:8790/api/relay/v1/page?machine=mch_dev&chan=terminal")
//         first message {"t":"hello","token":"dev"}
//
// What it implements of the protocol: hello; open (new) and open (reattach, with replay); in; resize; ack credit;
// kill; out, inack, opened, replay, live, exit, error; the close codes 4403 (bad hello) and 1009/1003.  No Node
// dependencies: a minimal RFC 6455 server (text frames, no extensions) and a Python PTY helper.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const MOCK_LIMITS = Object.freeze({
  helloMs: 10_000,
  preHelloBytes: 1024,
  message: 8 * 1024, // any page message but `in`
  inFrame: 16 * 1024, // decoded bytes of one `in`
  outFrame: 48 * 1024, // decoded bytes of one `out`
  credit: 1024 * 1024, // output bytes sent beyond the page's last ack
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
  inBytes: number; // decoded input bytes received
}

const sessions = new Map<string, Session>();

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

function pump(p: Page): void {
  while (p.pending.length > 0 && p.sent - p.acked < MOCK_LIMITS.credit) {
    let chunk = p.pending.shift()!;
    if (chunk.length > MOCK_LIMITS.outFrame) {
      p.pending.unshift(chunk.subarray(MOCK_LIMITS.outFrame));
      chunk = chunk.subarray(0, MOCK_LIMITS.outFrame);
    }
    p.sent += chunk.length;
    p.send({ t: "out", b: chunk.toString("base64") });
  }
}

function output(s: Session, b: Buffer): void {
  ringAppend(s, b);
  const p = s.page;
  if (!p) return;
  // Beyond the credit, output goes to the ring only (a reattach replays it): drop what can't be sent.
  const queued = p.pending.reduce((n, x) => n + x.length, 0);
  if (p.sent - p.acked + queued < MOCK_LIMITS.credit) p.pending.push(b);
  pump(p);
}

function newSession(rows: number, cols: number): Session {
  const child = spawn("python3", ["-I", "-c", PTY_HELPER], { stdio: ["pipe", "pipe", "inherit", "pipe"] });
  const s: Session = { id: randomUUID(), child, ring: [], ringBytes: 0, exit: null, page: null };
  (child.stdio[3] as NodeJS.WritableStream).write(`${rows} ${cols}\n`);
  child.stdout!.on("data", (b: Buffer) => output(s, b));
  child.on("exit", (code, signal) => {
    s.exit = { code, signal };
    s.page?.send({ t: "exit", code, signal });
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
  if (s.page && s.page !== p) s.page.close(4009, "replaced");
  s.page = p;
  p.session = s;
  p.send({ t: "opened", session: s.id });
  p.send({ t: "replay" });
  p.pending.push(Buffer.from("\x1bc"), replayBytes(s));
  pump(p);
  p.send({ t: "live" });
  if (s.exit) p.send({ t: "exit", ...s.exit });
}

function onMessage(p: Page, text: string): void {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text);
  } catch {
    p.send({ t: "error", error: "bad-json" });
    return;
  }
  if (m.t !== "in" && text.length > MOCK_LIMITS.message) return p.close(1009, "too big");
  const s = p.session;
  switch (m.t) {
    case "open": {
      const sz = size(m);
      if (!sz) return p.send({ t: "error", error: "bad-size" });
      if (typeof m.session === "string") {
        const old = sessions.get(m.session);
        if (!old) return p.send({ t: "error", error: "no-session" });
        attach(p, old);
        (old.child.stdio[3] as NodeJS.WritableStream).write(`${sz[0]} ${sz[1]}\n`);
        return;
      }
      const running = [...sessions.values()].filter((x) => !x.exit).length;
      if (running >= MOCK_LIMITS.sessions) return p.send({ t: "error", error: "too-many-sessions" });
      return attach(p, newSession(sz[0], sz[1]));
    }
    case "in": {
      if (!s || typeof m.b !== "string") return p.send({ t: "error", error: "no-session" });
      const b = Buffer.from(m.b, "base64");
      if (b.length > MOCK_LIMITS.inFrame) return p.close(1009, "input frame too big");
      s.child.stdin!.write(b);
      p.inBytes += b.length;
      return p.send({ t: "inack", upto: p.inBytes });
    }
    case "resize": {
      const sz = size(m);
      if (!s || !sz) return p.send({ t: "error", error: "bad-size" });
      (s.child.stdio[3] as NodeJS.WritableStream).write(`${sz[0]} ${sz[1]}\n`);
      return;
    }
    case "ack": {
      if (typeof m.upto === "number" && m.upto > p.acked && m.upto <= p.sent) p.acked = m.upto;
      return pump(p);
    }
    case "kill": {
      const k = typeof m.session === "string" ? sessions.get(m.session) : undefined;
      if (!k) return p.send({ t: "error", error: "no-session" });
      k.child.kill("SIGHUP");
      setTimeout(() => k.exit || k.child.kill("SIGKILL"), 2000).unref();
      return;
    }
    default:
      p.send({ t: "error", error: "unknown-message" });
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
  const page: Page = {
    send: (msg) => closed || socket.write(frame(1, Buffer.from(JSON.stringify(msg)))),
    close: (code, reason) => {
      if (closed) return;
      closed = true;
      const b = Buffer.alloc(2 + Buffer.byteLength(reason));
      b.writeUInt16BE(code, 0);
      b.write(reason, 2);
      socket.end(frame(8, b));
      if (page.session?.page === page) page.session.page = null;
    },
    session: null,
    sent: 0,
    acked: 0,
    pending: [],
    inBytes: 0,
  };
  const timer = setTimeout(() => hello || page.close(4403, "no hello"), MOCK_LIMITS.helloMs);
  socket.on("close", () => {
    clearTimeout(timer);
    closed = true;
    if (page.session?.page === page) page.session.page = null; // the session lives on, for a reattach
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
