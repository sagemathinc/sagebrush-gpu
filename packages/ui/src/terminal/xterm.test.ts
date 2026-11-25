// The REAL xterm.js adapter, in happy-dom: bytes written reach xterm's buffer, and the
// write callback (which acks the agent) fires only once xterm has parsed them.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createXterm } from "./xterm.ts";

let win: Window;
before(() => {
  win = new Window({ url: "http://localhost/" });
  // What xterm reads from the page (Node's own navigator stays).
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    self: win,
    HTMLElement: win.HTMLElement,
    getComputedStyle: win.getComputedStyle.bind(win),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  });
});
after(async () => {
  await win.happyDOM.close();
});

async function mounted() {
  const term = await createXterm();
  const el = win.document.createElement("div");
  win.document.body.appendChild(el);
  term.open(el as unknown as HTMLElement);
  return term;
}

const bytes = (s: string) => new TextEncoder().encode(s);

test("written bytes reach the screen, and done() fires only after xterm has them", async () => {
  const term = await mounted();
  let done = 0;
  term.write(bytes("hello \x1b[1mworld\x1b[0m\r\nline 2"), () => done++);
  assert.equal(done, 0); // not before the write is processed
  assert.equal(term.bufferText(), ""); // nothing yet: the write is asynchronous
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, 1);
  assert.equal(term.bufferText(), "hello world\nline 2");
  term.dispose();
});

test("UTF-8 split across writes still renders once, in order", async () => {
  const term = await mounted();
  const all = bytes("é → ✓\r\n");
  const order: number[] = [];
  term.write(all.subarray(0, 1), () => order.push(1));
  term.write(all.subarray(1), () => order.push(2));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, [1, 2]);
  assert.equal(term.bufferText(), "é → ✓");
  term.dispose();
});

test("reset clears the screen (a replay starts from nothing)", async () => {
  const term = await mounted();
  term.write(bytes("old output"), () => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(term.bufferText(), "old output");
  term.reset();
  term.write(bytes("replayed"), () => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(term.bufferText(), "replayed");
  term.dispose();
});

test("typed data comes out of onData; input can be switched off", async () => {
  const term = await mounted();
  const typed: string[] = [];
  const sub = term.onData((d) => typed.push(d));
  (term as unknown as { focus(): void }).focus();
  assert.deepEqual([term.rows > 0, term.cols > 0], [true, true]);
  term.setInputEnabled(false);
  term.setInputEnabled(true);
  sub.dispose();
  assert.deepEqual(typed, []);
  term.dispose();
});
