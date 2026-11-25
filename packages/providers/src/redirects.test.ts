// No provider request ever follows a redirect, so no API key reaches a second origin. These rows
// use Node's own fetch against two local origins: A redirects every request to B, and B must see
// none. A follow-mode control in each row shows the harness would leak without the rule.

import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ProviderError } from "./errors.ts";
import { isSuccess, readBody, readPrefix, type Fetch, type HttpResponse } from "./http.ts";
import { accountSpendPerHr, podAction, readLogs } from "./probes/cli.ts";
import { RunPodAdapter } from "./runpod/adapter.ts";
import { ShadeformAdapter } from "./shadeform/adapter.ts";

const KEY = "test-key-not-a-real-key";

/** A local HTTP server that records each request and answers with `reply`. */
async function origin(reply: (method: string, path: string) => { status: number; headers?: Record<string, string>; body?: string }) {
  const seen: Array<{ method: string; path: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers });
    const r = reply(req.method ?? "", req.url ?? "");
    res.writeHead(r.status, r.headers ?? {});
    res.end(r.body ?? "");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** Origin B answers 200 to anything; origin A redirects everything to B (307 for POST, else 302). */
async function pair() {
  const b = await origin(() => ({ status: 200, headers: { "Content-Type": "application/json" }, body: "{}" }));
  const a = await origin((method, path) => ({ status: method === "POST" ? 307 : 302, headers: { Location: `${b.url}${path}` } }));
  return {
    a,
    b,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}

/** Node's fetch, with every URL moved onto `base` (keeping the path and the init as given). */
function onto(base: string): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    return globalThis.fetch(`${base}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
}

/**
 * The follow-mode control: a plain fetch through A does reach B, so the rows' "B saw nothing" can't
 * pass by the harness never redirecting. A custom key header (api_key, X-API-KEY) arrives at B
 * as sent. Node's fetch drops Authorization on a cross-origin redirect (the Fetch standard does),
 * but no rule here relies on that: under "manual" B gets no request at all.
 */
async function assertFollowReaches(p: Awaited<ReturnType<typeof pair>>, header: string, value: string) {
  const before = p.b.seen.length;
  const res = await globalThis.fetch(`${p.a.url}/control`, { headers: { [header]: value, "X-Probe": "follow" } });
  assert.equal(res.status, 200);
  assert.equal(p.b.seen.length, before + 1);
  assert.equal(p.b.seen.at(-1)!.headers["x-probe"], "follow");
  if (header.toLowerCase() !== "authorization") assert.equal(p.b.seen.at(-1)!.headers[header.toLowerCase()], value);
}

const refused = (status: number) => (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && e.httpStatus === status;

// ---------------------------------------------------------------- helpers

test("isSuccess: exactly 200-299", () => {
  for (const s of [200, 201, 204, 299]) assert.equal(isSuccess(s), true, String(s));
  for (const s of [0, 1, 100, 199, 300, 302, 307, 400, 404, 500, 599, -1, Number.NaN]) assert.equal(isSuccess(s), false, String(s));
});

function response(body: ReadableStream<Uint8Array> | null | undefined): HttpResponse {
  const r: HttpResponse = { status: 400, headers: { get: () => null }, text: async () => { throw new Error("text() must not be called"); } };
  if (body !== undefined) r.body = body;
  return r;
}

test("readPrefix: at most maxBytes, the stream cancelled; '' without a stream or on a failure", async () => {
  assert.equal(await readPrefix(response(new Response("hello").body), 100), "hello");
  assert.equal(await readPrefix(response(new Response("hello world").body), 5), "hello");
  assert.equal(await readPrefix(response(new Response("").body), 5), "");
  assert.equal(await readPrefix(response(null), 5), "");
  assert.equal(await readPrefix(response(undefined), 5), "");
  // A finite source of 8 KiB (8 chunks of 1000): a prefix pulls only the chunks it needs, then
  // cancels. Finite, so a reader that never stops fails by assertion, not by a timeout.
  const eight = chunks(Array.from({ length: 8 }, () => fill(1000, "a")));
  assert.equal(await readPrefix(response(eight.stream), 2500), "a".repeat(2500));
  assert.equal(eight.stats.pulls, 3);
  assert.equal(eight.stats.cancelled, true);
  const failing = new ReadableStream<Uint8Array>({ pull(ctl) { ctl.error(new Error("cut")); } });
  assert.equal(await readPrefix(response(failing), 10), "");
});

/**
 * Runs `f` with the global Uint8Array replaced by a subclass that records the length of every
 * new buffer the helper allocates (one built from a length; views onto existing memory, such as
 * subarray(), allocate nothing and aren't counted; source chunks keep their own class). Returns
 * f's result and the largest allocation seen.
 */
async function withAllocationSpy<T>(f: () => Promise<T>): Promise<{ result: T; largest: number; count: number }> {
  const Real = globalThis.Uint8Array;
  const seen: number[] = [];
  class Spy extends Real {
    constructor(...args: unknown[]) {
      super(...(args as unknown as [number]));
      if (typeof args[0] === "number") seen.push(this.length);
    }
  }
  globalThis.Uint8Array = Spy as unknown as typeof Uint8Array;
  try {
    const result = await f();
    return { result, largest: Math.max(0, ...seen), count: seen.length };
  } finally {
    globalThis.Uint8Array = Real;
  }
}

/** A stream of the given chunks (made before any spy), one per pull, counting pulls and cancels. */
function chunks(parts: Uint8Array[]) {
  const stats = { pulls: 0, cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctl) {
      stats.pulls++;
      if (i >= parts.length) return ctl.close();
      ctl.enqueue(parts[i++]!);
    },
    cancel() {
      stats.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, stats };
}

const fill = (n: number, c: string) => new Uint8Array(n).fill(c.charCodeAt(0));

test("readPrefix: one oversized chunk: 4096 bytes back, nothing larger allocated, one read, cancelled", async () => {
  const { stream, stats } = chunks([fill(1 << 20, "a")]);
  const { result, largest } = await withAllocationSpy(() => readPrefix(response(stream), 4096));
  assert.equal(result, "a".repeat(4096));
  assert.ok(largest <= 4096, `allocated ${largest}`);
  assert.equal(stats.pulls, 1);
  assert.equal(stats.cancelled, true);
});

test("readPrefix: chunks crossing the limit: only what's needed is copied; the third is never pulled", async () => {
  const { stream, stats } = chunks([fill(3000, "a"), fill(3000, "b"), fill(3000, "c")]);
  const { result, largest } = await withAllocationSpy(() => readPrefix(response(stream), 4096));
  assert.equal(result, "a".repeat(3000) + "b".repeat(1096));
  assert.ok(largest <= 4096, `allocated ${largest}`);
  assert.equal(stats.pulls, 2);
  assert.equal(stats.cancelled, true);
});

test("readPrefix: exactly 4096, 4097 and 4095 bytes", async () => {
  const exact = chunks([fill(4096, "a")]);
  assert.equal(await readPrefix(response(exact.stream), 4096), "a".repeat(4096));
  assert.equal(exact.stats.cancelled, true);
  const over = chunks([new Uint8Array([...fill(4096, "a"), "z".charCodeAt(0)])]);
  const o = await withAllocationSpy(() => readPrefix(response(over.stream), 4096));
  assert.equal(o.result, "a".repeat(4096));
  assert.ok(o.largest <= 4096, `allocated ${o.largest}`);
  const under = chunks([fill(4095, "a")]);
  assert.equal(await readPrefix(response(under.stream), 4096), "a".repeat(4095));
  assert.equal(under.stats.pulls, 2);
});

test("readPrefix: a locked stream gives '' (it would throw on getReader)", async () => {
  const locked = new Response("no capacity").body!;
  locked.getReader();
  // Control: a second reader really is refused.
  assert.throws(() => locked.getReader(), TypeError);
  assert.equal(await readPrefix(response(locked), 4096), "");
  assert.equal(await readPrefix(response({ getReader: () => { throw new Error("not a stream"); } } as unknown as ReadableStream<Uint8Array>), 4096), "");
});

test("readPrefix: the spy sees an allocation as large as the chunk when one is made (control)", async () => {
  const { largest } = await withAllocationSpy(async () => new Uint8Array(1 << 20).length);
  assert.equal(largest, 1 << 20);
});

// ---------------------------------------------------------------- readBody

const LATER = () => Date.now() + 5_000;

test("readBody: a whole body up to the cap; one byte over is too_large; text() never called", async () => {
  const exact = chunks([fill(3000, "a"), fill(1096, "b")]);
  assert.deepEqual(await readBody(response(exact.stream), 4096, LATER()), { ok: true, text: "a".repeat(3000) + "b".repeat(1096) });
  assert.equal(exact.stats.pulls, 3, "read to the end");
  const over = chunks([fill(3000, "a"), fill(1097, "b"), fill(10, "c")]);
  assert.deepEqual(await readBody(response(over.stream), 4096, LATER()), { ok: false, why: "too_large" });
  assert.equal(over.stats.pulls, 2, "the read stops at the chunk that crosses the cap");
  assert.equal(over.stats.cancelled, true);
  assert.deepEqual(await readBody(response(new Response("").body), 4096, LATER()), { ok: true, text: "" });
});

test("readBody: an oversized single chunk is refused without keeping or copying it", async () => {
  const { stream, stats } = chunks([fill(1 << 20, "a")]);
  const { result, largest, count } = await withAllocationSpy(() => readBody(response(stream), 4096, LATER()));
  assert.deepEqual(result, { ok: false, why: "too_large" });
  assert.equal(count, 0, `allocated ${largest}`);
  assert.equal(stats.pulls, 1);
  assert.equal(stats.cancelled, true);
  // Control: an accepted body is copied into one buffer of our own, never larger than the cap.
  const ok = chunks([fill(2000, "a"), fill(2000, "b")]);
  const r = await withAllocationSpy(() => readBody(response(ok.stream), 4096, LATER()));
  assert.equal(r.count, 1);
  assert.equal(r.largest, 4096);
});

test("readBody: a stalled body ends at the deadline, cancelled", async () => {
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  // Raced against 2 s so a read that ignores its deadline fails here by name, not by a test timeout.
  const hung = new Promise<"hung">((ok) => setTimeout(() => ok("hung"), 2_000).unref());
  assert.deepEqual(await Promise.race([readBody(response(stalled), 4096, Date.now() + 50), hung]), { ok: false, why: "timeout" });
  assert.equal(cancelled, true);
  // A deadline already past gives the read no time, even for a body that is ready at once.
  const ready = chunks([fill(10, "a")]);
  assert.deepEqual(await readBody(response(ready.stream), 4096, Date.now() - 1), { ok: false, why: "timeout" });
  assert.equal(ready.stats.pulls, 0);
  // An endless trickle of ready chunks under the cap stops at the deadline.
  let pulls = 0;
  const trickle = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      pulls++;
      await new Promise((ok) => setTimeout(ok, 5));
      ctl.enqueue(new Uint8Array(1).fill(0x61));
    },
  }, { highWaterMark: 0 });
  assert.deepEqual(await readBody(response(trickle), 1 << 20, Date.now() + 60), { ok: false, why: "timeout" });
  assert.ok(pulls < 100, `pulls ${pulls}`);
});

test("readBody: an answer that arrives after the deadline is refused, a late end of stream included", async () => {
  // "null" at once, then the end of the stream only after the deadline.
  const lateEnd = (closeAfterMs: number) => {
    let first = true;
    return new ReadableStream<Uint8Array>({
      async pull(ctl) {
        if (first) {
          first = false;
          ctl.enqueue(new TextEncoder().encode("null"));
          return;
        }
        await new Promise((ok) => setTimeout(ok, closeAfterMs));
        ctl.close();
      },
    }, { highWaterMark: 0 });
  };
  assert.deepEqual(await readBody(response(lateEnd(50)), 4096, Date.now() + 30), { ok: false, why: "timeout" });
  // Control: the same end before the deadline is a whole body.
  assert.deepEqual(await readBody(response(lateEnd(1)), 4096, Date.now() + 1_000), { ok: true, text: "null" });
  // An empty body whose end comes late, and a late chunk, the same.
  const lateEmpty = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      await new Promise((ok) => setTimeout(ok, 50));
      ctl.close();
    },
  }, { highWaterMark: 0 });
  assert.deepEqual(await readBody(response(lateEmpty), 4096, Date.now() + 30), { ok: false, why: "timeout" });
  // A busy event loop at the end: a chunk in time, then the end of the stream produced while the
  // event loop is blocked past the deadline, so the end is ready before the timer can fire. The
  // check on the answer refuses it.
  const blockedEnd = (blockMs: number) => {
    let first = true;
    return new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (first) {
          first = false;
          ctl.enqueue(new TextEncoder().encode("null"));
          return;
        }
        const until = Date.now() + blockMs;
        while (Date.now() < until) {
          // the event loop is blocked
        }
        ctl.close();
      },
    }, { highWaterMark: 0 });
  };
  assert.deepEqual(await readBody(response(blockedEnd(40)), 4096, Date.now() + 20), { ok: false, why: "timeout" });
  // Control: blocked for less than the deadline, the same body is whole.
  assert.deepEqual(await readBody(response(blockedEnd(1)), 4096, Date.now() + 1_000), { ok: true, text: "null" });
  // The same with a first chunk produced while blocked past the deadline.
  const busy = new ReadableStream<Uint8Array>({
    pull(ctl) {
      const until = Date.now() + 40;
      while (Date.now() < until) {
        // the event loop is blocked past the deadline
      }
      ctl.enqueue(new TextEncoder().encode("{}"));
      ctl.close();
    },
  }, { highWaterMark: 0 });
  assert.deepEqual(await readBody(response(busy), 4096, Date.now() + 20), { ok: false, why: "timeout" });
});

test("readBody: storage depends on the cap, not on how many chunks arrive or what they view", async () => {
  const empty = new Uint8Array(0);
  const one = new Uint8Array([0x78]);
  // 10000 empty chunks, then one byte, with a cap of 1: accepted, and one buffer of our own.
  const parts: Uint8Array[] = [...Array.from({ length: 10_000 }, () => empty), one];
  const many = chunks(parts);
  const r = await withAllocationSpy(() => readBody(response(many.stream), 1, LATER()));
  assert.deepEqual(r.result, { ok: true, text: "x" });
  assert.equal(r.count, 1);
  assert.equal(r.largest, 1);
  // Only empty chunks: nothing is allocated at all.
  const none = chunks(Array.from({ length: 1_000 }, () => empty));
  const n = await withAllocationSpy(() => readBody(response(none.stream), 4096, LATER()));
  assert.deepEqual(n.result, { ok: true, text: "" });
  assert.equal(n.count, 0);
  // A tiny view of a large backing buffer: its bytes are copied into a buffer of at most the cap,
  // so nothing holds on to the 1 MiB behind the view.
  const backing = new Uint8Array(1 << 20).fill(0x61);
  const views = chunks([backing.subarray(0, 3), backing.subarray(10, 13)]);
  const v = await withAllocationSpy(() => readBody(response(views.stream), 16, LATER()));
  assert.deepEqual(v.result, { ok: true, text: "aaaaaa" });
  assert.equal(v.count, 1);
  assert.equal(v.largest, 16);
  // Many 1-byte chunks: copied into one growing buffer, not kept one object each.
  const bytes = chunks(Array.from({ length: 5_000 }, () => one));
  const b = await withAllocationSpy(() => readBody(response(bytes.stream), 1 << 20, LATER()));
  assert.deepEqual(b.result, { ok: true, text: "x".repeat(5_000) });
  assert.equal(b.count, 1);
  assert.ok(b.largest <= 1 << 20);
  // Growth past the first block doubles, each allocation within the cap.
  const big = chunks(Array.from({ length: 5 }, () => new Uint8Array(40_000).fill(0x79)));
  const g = await withAllocationSpy(() => readBody(response(big.stream), 150_000, LATER()));
  assert.deepEqual(g.result, { ok: false, why: "too_large" });
  const three = chunks(Array.from({ length: 3 }, () => new Uint8Array(40_000).fill(0x79)));
  const g2 = await withAllocationSpy(() => readBody(response(three.stream), 150_000, LATER()));
  assert.deepEqual(g2.result, { ok: true, text: "y".repeat(120_000) });
  assert.equal(g2.count, 2);
  assert.equal(g2.largest, 131_072);
});

test("readBody: waiting for the deadline costs one race, however many chunks are read", async () => {
  // Every Promise.race registers a reaction on each promise it races, and a reaction on a promise
  // that is still pending can't be removed: racing one deadline promise per read would keep one
  // per read. So the whole read is one race.
  const race = Promise.race.bind(Promise);
  let races = 0;
  Promise.race = ((values: Iterable<unknown>) => {
    races++;
    return race(values);
  }) as typeof Promise.race;
  try {
    const empty = new Uint8Array(0);
    const parts = [...Array.from({ length: 1_000 }, () => empty), new Uint8Array([0x78])];
    const { stream, stats } = chunks(parts);
    assert.deepEqual(await readBody(response(stream), 1, LATER()), { ok: true, text: "x" });
    assert.equal(stats.pulls, 1_002);
    assert.equal(races, 1);
    // The same for a body cut off at the deadline after many reads.
    races = 0;
    let pulls = 0;
    const trickle = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        pulls++;
        await new Promise((ok) => setTimeout(ok, 1));
        ctl.enqueue(empty);
      },
    }, { highWaterMark: 0 });
    assert.deepEqual(await readBody(response(trickle), 1, Date.now() + 40), { ok: false, why: "timeout" });
    assert.ok(pulls > 3, `pulls ${pulls}`);
    assert.equal(races, 1);
  } finally {
    Promise.race = race;
  }
});

test("readBody: a failing, locked, missing or non-UTF-8 body is unreadable", async () => {
  const failing = new ReadableStream<Uint8Array>({ pull(ctl) { ctl.error(new Error("cut")); } });
  assert.deepEqual(await readBody(response(failing), 4096, LATER()), { ok: false, why: "unreadable" });
  const locked = new Response("x").body!;
  locked.getReader();
  assert.deepEqual(await readBody(response(locked), 4096, LATER()), { ok: false, why: "unreadable" });
  assert.deepEqual(await readBody(response(null), 4096, LATER()), { ok: false, why: "unreadable" });
  assert.deepEqual(await readBody(response(undefined), 4096, LATER()), { ok: false, why: "unreadable" });
  const bad = chunks([new Uint8Array([0x7b, 0xff, 0x7d])]);
  assert.deepEqual(await readBody(response(bad.stream), 4096, LATER()), { ok: false, why: "unreadable" });
});

// ---------------------------------------------------------------- adapters, natively

test("redirects: the Shadeform adapter never follows one; its key never reaches the second origin", async () => {
  const p = await pair();
  try {
    const a = new ShadeformAdapter({ apiKey: KEY, fetch: globalThis.fetch as unknown as Fetch, baseUrl: `${p.a.url}/v1` });
    await assert.rejects(a.status("d290f1ee-6c54-4b01-90e6-d701748f0851"), refused(302));
    await assert.rejects(a.listOffers({ gpuCount: 1 }), refused(302));
    await assert.rejects(a.terminate("d290f1ee-6c54-4b01-90e6-d701748f0851"), refused(307));
    assert.ok(p.a.seen.length >= 3);
    for (const r of p.a.seen) assert.equal(r.headers["x-api-key"], KEY);
    assert.equal(p.b.seen.length, 0);
    await assertFollowReaches(p, "X-API-KEY", KEY);
  } finally {
    await p.close();
  }
});

test("redirects: the RunPod adapter never follows one; its key never reaches the second origin", async () => {
  const p = await pair();
  try {
    const a = new RunPodAdapter({ apiKey: KEY, fetch: globalThis.fetch as unknown as Fetch, baseUrl: p.a.url });
    await assert.rejects(a.status("pod1"), refused(302));
    await assert.rejects(a.listOffers({ gpuCount: 1 }), refused(302));
    await assert.rejects(a.terminate("pod1"), (e: unknown) => e instanceof ProviderError && e.httpStatus !== null && e.httpStatus >= 300 && e.httpStatus < 400);
    assert.ok(p.a.seen.length >= 3);
    for (const r of p.a.seen) assert.equal(r.headers["authorization"], `Bearer ${KEY}`);
    assert.equal(p.b.seen.length, 0);
    await assertFollowReaches(p, "Authorization", `Bearer ${KEY}`);
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------- the probe CLI's own calls, natively

test("redirects: the probe CLI's spend read, log read and pod action never follow one", async () => {
  const p = await pair();
  try {
    const f = onto(p.a.url);
    await assert.rejects(accountSpendPerHr(KEY, f), /spend read: HTTP 307/);
    await assert.rejects(readLogs(KEY, "pod1", "t", { fetch: f }), /logs HTTP 302/);
    await assert.rejects(podAction(KEY, "pod1", "stop", f), /action stop HTTP 307/);
    assert.equal(p.a.seen.length, 3);
    for (const r of p.a.seen) assert.equal(r.headers["authorization"], `Bearer ${KEY}`);
    assert.equal(p.b.seen.length, 0);
    await assertFollowReaches(p, "Authorization", `Bearer ${KEY}`);
  } finally {
    await p.close();
  }
});

test("probe CLI: an error status is refused before any body read; a 2xx action is read", async () => {
  const replies: Array<{ status: number }> = [];
  let reads = 0;
  const seen: RequestInit[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    seen.push(init ?? {});
    const r = replies.shift()!;
    return { status: r.status, text: async () => { reads++; return "{}"; } } as unknown as Response;
  }) as unknown as typeof fetch;
  for (const status of [0, 199, 302, 404, 500]) {
    replies.push({ status }, { status });
    await assert.rejects(accountSpendPerHr(KEY, f), new RegExp(`HTTP ${status}`));
    await assert.rejects(podAction(KEY, "pod1", "stop", f), new RegExp(`HTTP ${status}`));
  }
  assert.equal(reads, 0);
  replies.push({ status: 200 });
  await podAction(KEY, "pod1", "stop", f);
  assert.equal(reads, 1);
  for (const init of seen) assert.equal(init.redirect, "manual");
});
