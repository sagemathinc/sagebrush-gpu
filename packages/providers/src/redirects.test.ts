// No provider request ever follows a redirect, so no API key reaches a second origin. These rows
// use Node's own fetch against two local origins: A redirects every request to B, and B must see
// none. A follow-mode control in each row shows the harness would leak without the rule.

import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ProviderError } from "./errors.ts";
import { isSuccess, readPrefix, type Fetch, type HttpResponse } from "./http.ts";
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
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(ctl) {
      pulled++;
      ctl.enqueue(new Uint8Array(1000).fill(0x61));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  assert.equal(await readPrefix(response(endless), 2500), "a".repeat(2500));
  assert.equal(pulled, 3);
  assert.equal(cancelled, true);
  const failing = new ReadableStream<Uint8Array>({ pull(ctl) { ctl.error(new Error("cut")); } });
  assert.equal(await readPrefix(response(failing), 10), "");
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
