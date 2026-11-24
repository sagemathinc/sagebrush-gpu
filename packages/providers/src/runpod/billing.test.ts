import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../errors.ts";
import type { Fetch, HttpRequest } from "../http.ts";
import type { BillingQuery } from "../reconcile.ts";
import { MAX_BILLING_BUCKETS, parsePodBilling, RunPodAdapter } from "./adapter.ts";

const Q: BillingQuery = { start: "2026-11-24T10:00:00Z", end: "2026-11-24T12:00:00Z", bucket: "hour" };

function record(podId: string, startTime: string, endTime: string, total: number, extra: Record<string, unknown> = {}) {
  return { podId, startTime, endTime, totalAmount: total, gpuAmount: total, cpuAmount: 0, diskAmount: 0, ...extra };
}

/** A response in the shape of RunPod's ListPodBillingResponse (OpenAPI v2). */
function response(records: unknown[], over: Record<string, unknown> = {}, totalAmount?: number) {
  const sum = records.reduce((s: number, r) => s + ((r as { totalAmount?: number }).totalAmount ?? 0), 0);
  return {
    records,
    metadata: {
      query: { startTime: "2026-11-24T10:00:00Z", endTime: "2026-11-24T12:00:00Z", bucketSize: "hour", podId: null },
      recordCount: records.length,
      uniquePodCount: new Set(records.map((r) => (r as { podId?: string }).podId)).size,
      totals: { totalAmount: totalAmount ?? sum, gpuAmount: sum, cpuAmount: 0, diskAmount: 0 },
      ...over,
    },
  };
}

const R1 = record("podA", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z", 0.69);
const R2 = record("podB", "2026-11-24T11:00:00Z", "2026-11-24T12:00:00Z", 0.123456, { gpuAmount: 0.1, cpuAmount: 0.02, diskAmount: 0.003456 });

test("parsePodBilling reads records as micros", () => {
  assert.deepEqual(parsePodBilling(response([R1, R2]), Q), [
    { provider: "runpod", providerMachineId: "podA", bucketStart: "2026-11-24T10:00:00.000Z", bucketEnd: "2026-11-24T11:00:00.000Z", total: 690_000, gpu: 690_000, cpu: 0, disk: 0 },
    { provider: "runpod", providerMachineId: "podB", bucketStart: "2026-11-24T11:00:00.000Z", bucketEnd: "2026-11-24T12:00:00.000Z", total: 123_456, gpu: 100_000, cpu: 20_000, disk: 3456 },
  ]);
  assert.deepEqual(parsePodBilling(response([]), Q), []);
});

test("parsePodBilling allows a micro of rounding per record against the totals", () => {
  const a = record("p1", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z", 0.0000004);
  const b = record("p2", "2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z", 0.0000004);
  assert.equal(parsePodBilling(response([a, b], {}, 0.0000018), Q).length, 2); // 0 + 0 vs 2: within 2
  assert.throws(() => parsePodBilling(response([a, b], {}, 0.0000026), Q), ProviderError); // vs 3
  assert.throws(() => parsePodBilling(response([R1], {}, 0.70), Q), ProviderError);
  assert.throws(() => parsePodBilling(response([R1], {}, 0.68), Q), ProviderError);
});

const incomplete: Array<[string, unknown]> = [
  ["not an object", []],
  ["no records", { metadata: response([]).metadata }],
  ["records not an array", { ...response([]), records: {} }],
  ["no metadata", { records: [] }],
  ["no query", response([], { query: undefined })],
  ["another bucket size", response([], { query: { ...response([]).metadata.query, bucketSize: "day" } })],
  ["a later start", response([], { query: { ...response([]).metadata.query, startTime: "2026-11-24T11:00:00Z" } })],
  ["an earlier end", response([], { query: { ...response([]).metadata.query, endTime: "2026-11-24T11:00:00Z" } })],
  ["no start", response([], { query: { ...response([]).metadata.query, startTime: undefined } })],
  ["filtered to one pod", response([], { query: { ...response([]).metadata.query, podId: "podA" } })],
  ["no totals", response([], { totals: undefined })],
  ["totals without totalAmount", response([], { totals: {} })],
  ["a record count that doesn't match", response([R1], { recordCount: 2 })],
  ["a record without a pod", response([{ ...R1, podId: undefined }])],
  ["a record with an empty pod", response([{ ...R1, podId: "" }])],
  ["a record that isn't an object", response([7])],
  ["a record of two buckets", response([record("p", "2026-11-24T10:00:00Z", "2026-11-24T12:00:00Z", 1)])],
  ["a record before the window", response([record("p", "2026-11-24T09:00:00Z", "2026-11-24T10:00:00Z", 1)])],
  ["a record after the window", response([record("p", "2026-11-24T12:00:00Z", "2026-11-24T13:00:00Z", 1)])],
  ["a record off the bucket grid", response([record("p", "2026-11-24T10:30:00Z", "2026-11-24T11:30:00Z", 1)])],
  ["a record without times", response([{ ...R1, startTime: undefined }])],
  ["a negative amount", response([{ ...R1, totalAmount: -1 }], {}, 0)],
  ["a string amount", response([{ ...R1, totalAmount: "0.69" }], {}, 0.69)],
  ["a missing gpuAmount", response([{ ...R1, gpuAmount: undefined }])],
  ["a missing cpuAmount", response([{ ...R1, cpuAmount: undefined }])],
  ["a missing diskAmount", response([{ ...R1, diskAmount: undefined }])],
];

for (const [what, json] of incomplete) {
  test(`parsePodBilling rejects ${what}`, () => {
    assert.throws(() => parsePodBilling(json, Q), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  });
}

function adapter(body: unknown) {
  const calls: Array<{ url: string; init: HttpRequest }> = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { a: new RunPodAdapter({ apiKey: "test-key", fetch }), calls };
}

test("billing asks for exactly the window, bucket and all pods", async () => {
  const { a, calls } = adapter(response([R1]));
  const records = await a.billing({ start: "2026-11-24T10:00:00.000Z", end: "2026-11-24T12:00:00.000Z", bucket: "hour" });
  assert.equal(records.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/v2/billing/pods");
  assert.deepEqual(Object.fromEntries(url.searchParams), { startTime: "2026-11-24T10:00:00Z", endTime: "2026-11-24T12:00:00Z", bucketSize: "hour" });
  assert.equal(calls[0]!.init.method, "GET");
});

test("billing refuses windows that aren't whole buckets, before any request", async () => {
  const bad: BillingQuery[] = [
    { ...Q, start: "2026-11-24T10:30:00Z" },
    { ...Q, end: "2026-11-24T11:59:59Z" },
    { ...Q, end: Q.start },
    { ...Q, start: Q.end, end: Q.start },
    { ...Q, start: "today" },
    { ...Q, bucket: "week" as "hour" },
    { ...Q, bucket: "day" },
    { start: "2026-01-01T00:00:00Z", end: new Date(Date.parse("2026-01-01T00:00:00Z") + (MAX_BILLING_BUCKETS + 1) * 3_600_000).toISOString(), bucket: "hour" },
  ];
  for (const q of bad) {
    const { a, calls } = adapter(response([]));
    await assert.rejects(a.billing(q), RangeError, JSON.stringify(q));
    assert.equal(calls.length, 0);
  }
  const edge = adapter({ ...response([]), metadata: { ...response([]).metadata, query: { startTime: "2026-01-01T00:00:00Z", endTime: new Date(Date.parse("2026-01-01T00:00:00Z") + MAX_BILLING_BUCKETS * 3_600_000).toISOString(), bucketSize: "hour" } } });
  await edge.a.billing({ start: "2026-01-01T00:00:00Z", end: new Date(Date.parse("2026-01-01T00:00:00Z") + MAX_BILLING_BUCKETS * 3_600_000).toISOString(), bucket: "hour" });
  assert.equal(edge.calls.length, 1);
});
