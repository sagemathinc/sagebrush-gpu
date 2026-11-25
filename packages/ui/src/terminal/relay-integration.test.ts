// The UI's terminal session against the machine package's relay-aware mock terminal, end to
// end: the production socket adapter (browserConnect, over Node's WebSocket), the real
// session, the mock's relay page side (hello, ready, receipts to ack, ping) and the agent's
// terminal protocol on a real shell in a PTY. Nothing is faked between the two.
//
// It needs python3 with a PTY (the mock's helper): the first row checks that and fails, by
// name, when either is missing. Every wait has its own deadline and fails by name too.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { startMockTerminal } from "@sbgpu/machine/mock/terminal";
import { REAL_TIMERS } from "../app/polling.ts";
import { browserConnect } from "../app/terminal-panel.ts";
import { TerminalSession, type TerminalStatus } from "./session.ts";

const WAIT_MS = 20_000;

let server: { port: number; close(): void };
before(async () => {
  server = await startMockTerminal(0);
});
after(() => server.close());

/** Every page a row opened: closed after the row, passed or failed (a failed row mustn't leave a shell or socket). */
const pages = new Set<Page>();
afterEach(() => {
  for (const p of pages) {
    if (p.status.kind === "live") p.session.input("\u0003exit 0\r"); // (the mock keeps at most four shells)
    p.session.dispose();
  }
  pages.clear();
});

/** One terminal page: the session, what reached its screen, and its statuses. */
class Page {
  readonly session: TerminalSession;
  text = "";
  bytes = 0;
  resets = 0;
  statuses: TerminalStatus[] = [];
  /** While set, the screen doesn't confirm writes (a slow screen): their done() waits here. */
  held: Array<() => void> | null = null;
  rows = 24;
  cols = 80;
  readonly ids = new Map<string, string>();

  constructor() {
    this.session = new TerminalSession({
      machineId: "mch_dev",
      connect: browserConnect,
      open: async () => ({ token: "dev", url: `ws://127.0.0.1:${server.port}/api/relay/v1/page?machine=mch_dev&chan=terminal` }),
      sink: {
        write: (b, done) => {
          this.bytes += b.length;
          this.text += Buffer.from(b).toString("latin1");
          if (this.held) this.held.push(done);
          else done();
        },
        reset: () => {
          this.resets++;
          this.text = "";
        },
      },
      storage: {
        get: (m) => this.ids.get(m) ?? null,
        set: (m, id) => (id === null ? this.ids.delete(m) : this.ids.set(m, id)),
      },
      timers: REAL_TIMERS,
      size: () => ({ rows: this.rows, cols: this.cols }),
      onStatus: (s) => this.statuses.push(s),
    });
    pages.add(this);
  }

  get status(): TerminalStatus {
    return this.session.status;
  }

  /** Wait for `cond`, or fail naming what was awaited (with the screen's tail). */
  async until(what: string, cond: () => boolean, ms = WAIT_MS): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) {
        throw new Error(`timed out after ${ms} ms waiting for ${what}; status ${JSON.stringify(this.status)}; screen ends ${JSON.stringify(this.text.slice(-300))}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async live(): Promise<void> {
    this.session.start();
    await this.until("the session to be live", () => this.status.kind === "live");
  }

  /** Type a command line. */
  type(line: string): void {
    assert.equal(this.session.input(line), true, `input refused: ${line.slice(0, 40)}`);
  }

  /** End the shell (the mock keeps at most four), and close the page. */
  async finish(): Promise<void> {
    if (this.status.kind === "live") {
      this.type("exit 0\r");
      await this.until("the shell to exit", () => this.status.kind === "exited");
    }
    this.session.dispose();
  }

  /** Statuses that mean the connection failed (as opposed to the shell ending). */
  failures(): TerminalStatus[] {
    return this.statuses.filter((s) => s.kind === "closed" || s.kind === "reconnecting" || s.kind === "elsewhere");
  }
}

test("0. python3 with a PTY is available (the mock terminal's shell needs both)", () => {
  const r = spawnSync("python3", ["-c", "import os, pty; m, s = os.openpty(); print('pty ok')"], { encoding: "utf8" });
  assert.equal(r.error, undefined, `python3 can't be run: ${String(r.error)}`);
  assert.equal(r.status, 0, `python3 has no PTY: ${r.stderr}`);
  assert.match(r.stdout, /pty ok/);
});

test("1. open a shell, see a command's output, and its exit with the code", async () => {
  const p = new Page();
  await p.live();
  p.type("printf 'X%sY\\n' 41\r"); // (the typed line echoes as X%sY; only the output says X41Y)
  await p.until("the command's output", () => p.text.includes("X41Y"));
  p.type("exit 3\r");
  await p.until("the shell's exit", () => p.status.kind === "exited");
  assert.deepEqual(p.status, { kind: "exited", code: 3, signal: null, earlier: false });
  assert.deepEqual(p.failures(), []);
  p.session.dispose();
});

test("2. relay flow control: well over 1 MiB of output all arrives, the page acks every receipt and is never closed", async () => {
  const p = new Page();
  await p.live();
  const n = 3_000_000;
  // (the letter counted, A, is made by tr from octal, so the echoed command line has none)
  p.type(`head -c ${n} /dev/zero | tr '\\0' '\\101'; printf '\\nE%sD\\n' ND\r`);
  await p.until("the end of the large output", () => p.text.includes("\nEND"), 60_000);
  // Every byte before the end mark (the PTY passes 'A' through unchanged).
  const out = p.text.slice(0, p.text.indexOf("\nEND"));
  assert.equal(out.length - out.replace(/A/g, "").length, n);
  // A page that didn't ack the relay's receipts would have been closed 1013 past 1 MiB.
  assert.deepEqual(p.failures(), []);
  assert.equal(p.status.kind, "live");
  await p.finish();
});

test("3. terminal credit: a slow screen pauses the shell's output at the high-water mark, and acks resume it with no loss", async () => {
  const p = new Page();
  await p.live();
  const n = 2_000_000;
  p.held = [];
  const before = p.bytes;
  p.type(`head -c ${n} /dev/zero | tr '\\0' '\\102'; printf '\\nE%sD\\n' ND\r`);
  await p.until("output to start", () => p.bytes - before > 64 * 1024);
  // Nothing is confirmed on screen, so nothing is acked: the agent stops near its 256 KiB mark.
  let last = -1;
  await p.until("the output to stall", () => {
    const now = p.bytes;
    const stalled = now === last;
    last = now;
    return stalled && now - before > 128 * 1024;
  });
  await new Promise((r) => setTimeout(r, 500));
  const stalledAt = p.bytes - before;
  assert.ok(stalledAt < 512 * 1024, `kept sending without acks: ${stalledAt} bytes`);
  assert.equal(p.text.includes("\nEND"), false);
  // The screen catches up: the session acks, and the rest arrives.
  const waiting = p.held;
  p.held = null;
  for (const done of waiting) done();
  await p.until("the end after resuming", () => p.text.includes("\nEND"), 60_000);
  const out = p.text.slice(0, p.text.indexOf("\nEND"));
  assert.equal(out.length - out.replace(/B/g, "").length, n);
  assert.deepEqual(p.failures(), []);
  await p.finish();
});

test("4. input: a paste far larger than one frame reaches the shell whole and in order", async () => {
  const p = new Page();
  await p.live();
  const n = 100 * 1024;
  // Non-canonical, so the line discipline doesn't cut a long line (CR still ends a command line).
  p.type("stty -icanon -echo\r");
  await new Promise((r) => setTimeout(r, 300));
  p.type(`head -c ${n} | tr -d x | wc -c | sed 's/^ *0$/ALLX/'; head -c 0\r`);
  await new Promise((r) => setTimeout(r, 300));
  const before = p.text.length;
  const paste = "x".repeat(n);
  assert.equal(p.session.input(paste), true);
  await p.until("the shell to have read the whole paste", () => p.text.slice(before).includes("ALLX"));
  assert.equal(p.session.pendingInputBytes, 0);
  p.type("stty sane\r");
  assert.deepEqual(p.failures(), []);
  await p.finish();
});

test("5. a resize reaches the shell's terminal", async () => {
  const p = new Page();
  await p.live();
  p.session.resize(37, 91);
  await new Promise((r) => setTimeout(r, 200));
  p.type("stty size | sed 's/ /x/'\r"); // (37x91 can't come from the echoed line)
  await p.until("the new size", () => p.text.includes("37x91"));
  assert.deepEqual(p.failures(), []);
  await p.finish();
});

test("6. reattach: a new connection to the same shell replays its scrollback once and goes on", async () => {
  const p = new Page();
  await p.live();
  p.type("echo P$((40+2))Q\r");
  await p.until("the first output", () => p.text.includes("P42Q"));
  const shell = (s: string) => /S(\d+)T/.exec(s)?.[1];
  p.type("echo S$$T\r");
  await p.until("the shell's pid", () => shell(p.text) !== undefined);
  const pid = shell(p.text);
  const resets = p.resets;
  // A new connection (as after a dropped socket), to the same session id.
  p.session.reconnect();
  await p.until("the session to be live again after a replay", () => p.resets > resets && p.status.kind === "live");
  await p.until("the replay", () => p.text.includes("P42Q"));
  assert.equal(p.text.split("P42Q").length - 1, 1, "replayed once, not doubled");
  // The same shell, not a new one.
  p.type("echo S$$T\r");
  await p.until("the pid again", () => (p.text.match(/S\d+T/g) ?? []).length >= 2);
  assert.deepEqual([...new Set((p.text.match(/S(\d+)T/g) ?? []).map((m) => m.slice(1, -1)))], [pid]);
  assert.deepEqual(p.statuses.filter((s) => s.kind === "closed" || s.kind === "elsewhere"), []);
  await p.finish();
});
