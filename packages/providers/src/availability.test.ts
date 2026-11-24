import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availabilityReport,
  checkObservation,
  launchOutcomeOf,
  listingObservations,
  MAX_CLOCK_SKEW_MS,
  MAX_REPORT_WINDOW_MS,
  checkReportWindow,
  type AvailabilityObservation,
} from "./availability.ts";
import type { ProviderErrorKind } from "./errors.ts";
import type { Offer } from "./types.ts";

const NOW = 1_800_000_000_000;
const base = { provider: "runpod", gpuType: "L4", gpuCount: 1, dataCenter: "EU-SE-1", country: "SE", observedMs: NOW, quotedCostPerHour: 690_000 } as const;
const listing = (stock: AvailabilityObservation["outcome"], extra: Partial<AvailabilityObservation> = {}) =>
  ({ ...base, source: "listing", outcome: stock, readyMs: null, ...extra }) as AvailabilityObservation;
const launch = (outcome: AvailabilityObservation["outcome"], readyMs: number | null = null, extra: Partial<AvailabilityObservation> = {}) =>
  ({ ...base, source: "launch", outcome, readyMs, ...extra }) as AvailabilityObservation;

// ---------------------------------------------------------------- validation

test("checkObservation accepts well-formed observations, at the edges too", () => {
  for (const o of [
    listing("high"),
    listing("unknown", { country: null, quotedCostPerHour: null }),
    launch("launched", 95_000),
    launch("launched", null),
    launch("launched", 0),
    launch("launched", 86_400_000),
    launch("no_capacity"),
    launch("refused"),
    launch("error"),
    listing("none", { observedMs: NOW + MAX_CLOCK_SKEW_MS }),
    listing("low", { observedMs: 0, gpuCount: 16, quotedCostPerHour: 1_000_000_000, dataCenter: "a".repeat(64) }),
  ]) {
    checkObservation(o, NOW);
  }
});

const bad: Array<[string, AvailabilityObservation]> = [
  ["an unknown provider", listing("high", { provider: "gcp" as "runpod" })],
  ["an unknown GPU type", listing("high", { gpuType: "TPU" })],
  ["0 GPUs", listing("high", { gpuCount: 0 })],
  ["17 GPUs", listing("high", { gpuCount: 17 })],
  ["a fractional GPU count", listing("high", { gpuCount: 1.5 })],
  ["an empty data center", listing("high", { dataCenter: "" })],
  ["a long data center", listing("high", { dataCenter: "a".repeat(65) })],
  ["a data center with a space", listing("high", { dataCenter: "EU SE 1" })],
  ["a lowercase country", listing("high", { country: "se" })],
  ["a three-letter country", listing("high", { country: "SWE" })],
  ["a future time", listing("high", { observedMs: NOW + MAX_CLOCK_SKEW_MS + 1 })],
  ["a negative time", listing("high", { observedMs: -1 })],
  ["a fractional time", listing("high", { observedMs: NOW - 0.5 })],
  ["a negative price", listing("high", { quotedCostPerHour: -1 })],
  ["a price over $1000/h", listing("high", { quotedCostPerHour: 1_000_000_001 })],
  ["a fractional price", listing("high", { quotedCostPerHour: 0.5 })],
  ["a listing with a launch outcome", listing("launched")],
  ["a launch with a stock outcome", launch("high")],
  ["a listing with a time to ready", { ...listing("high"), readyMs: 5 } as AvailabilityObservation],
  ["a failed launch with a time to ready", launch("no_capacity", 5)],
  ["a negative time to ready", launch("launched", -1)],
  ["a time to ready over a day", launch("launched", 86_400_001)],
  ["an unknown source", { ...listing("high"), source: "guess" } as unknown as AvailabilityObservation],
];

for (const [what, o] of bad) {
  test(`checkObservation refuses ${what}`, () => {
    assert.throws(() => checkObservation(o, NOW), RangeError);
  });
}

test("checkObservation refuses a bad clock", () => {
  assert.throws(() => checkObservation(listing("high"), Number.NaN), RangeError);
  assert.throws(() => checkObservation(listing("high"), -1), RangeError);
});

test("launchOutcomeOf: only a capacity refusal is no_capacity", () => {
  const expected: Record<ProviderErrorKind, string> = {
    no_capacity: "no_capacity",
    unplaceable: "refused", forbidden: "refused", price_above_cap: "refused", spec_mismatch: "refused",
    invalid_request: "refused", insufficient_funds: "refused", auth: "refused",
    rate_limited: "error", transient: "error", not_found: "error", outcome_unknown: "error", unknown: "error",
  };
  for (const [kind, outcome] of Object.entries(expected)) assert.equal(launchOutcomeOf(kind as ProviderErrorKind), outcome, kind);
});

test("listingObservations records each offer's stock label and price", () => {
  const offer: Offer = { provider: "runpod", gpuType: "L4", gpuCount: 2, dataCenter: "EU-RO-1", country: "RO", providerCostPerHour: 1_380_000, stock: "low", observedAt: "x" };
  assert.deepEqual(listingObservations([offer], NOW), [
    { provider: "runpod", gpuType: "L4", gpuCount: 2, dataCenter: "EU-RO-1", country: "RO", observedMs: NOW, quotedCostPerHour: 1_380_000, source: "listing", outcome: "low", readyMs: null },
  ]);
});

// ---------------------------------------------------------------- the report

const W = { fromMs: NOW - 3_600_000, toMs: NOW + 1, truncated: false, prunedThroughMs: null as number | null };

test("the report counts listings and launches per group, from observations only", () => {
  const r = availabilityReport(
    [
      listing("high", { observedMs: NOW - 100 }),
      listing("low", { observedMs: NOW - 90 }),
      listing("high", { observedMs: NOW - 80, quotedCostPerHour: 700_000 }),
      launch("launched", 120_000, { observedMs: NOW - 70 }),
      launch("launched", 60_000, { observedMs: NOW - 60, quotedCostPerHour: 650_000 }),
      launch("launched", null, { observedMs: NOW - 55 }),
      launch("no_capacity", null, { observedMs: NOW - 50, quotedCostPerHour: null }),
      launch("refused", null, { observedMs: NOW - 40 }),
      launch("error", null, { observedMs: NOW - 30 }),
    ],
    W,
  );
  assert.equal(r.observations, 9);
  assert.equal(r.truncated, false);
  assert.equal(r.groups.length, 1);
  const g = r.groups[0]!;
  assert.deepEqual(g.listings, { observations: 3, byStock: { high: 2, medium: 0, low: 1, none: 0, unknown: 0 } });
  assert.deepEqual(g.launches, {
    attempts: 6, launched: 3, noCapacity: 1, refused: 1, errors: 1,
    capacity: { launched: 3, of: 4 },
    readyMs: { measured: 2, min: 60_000, median: 60_000, max: 120_000 },
  });
  // Latest is the price of the newest observation that quoted one (NOW - 30, 690000).
  assert.deepEqual(g.quotedCostPerHour, { min: 650_000, max: 700_000, latest: 690_000 });
  assert.equal(g.firstMs, NOW - 100);
  assert.equal(g.lastMs, NOW - 30);
});

test("no launch attempts means no capacity figure (null, not 0%); refusals and errors don't count", () => {
  const r = availabilityReport([listing("none"), launch("refused"), launch("error")], W);
  assert.equal(r.groups[0]!.launches.capacity, null);
  assert.equal(r.groups[0]!.launches.readyMs, null);
  const r2 = availabilityReport([launch("no_capacity"), launch("no_capacity")], W);
  assert.deepEqual(r2.groups[0]!.launches.capacity, { launched: 0, of: 2 });
});

test("the median of times to ready is the lower median of observed values", () => {
  const med = (xs: number[]) =>
    availabilityReport(xs.map((x, i) => launch("launched", x, { observedMs: NOW - 1000 + i })), W).groups[0]!.launches.readyMs!.median;
  assert.equal(med([30]), 30);
  assert.equal(med([40, 10]), 10);
  assert.equal(med([30, 10, 20]), 20);
  assert.equal(med([40, 10, 30, 20]), 20);
});

test("groups split by provider, GPU type, count and data center, sorted", () => {
  const r = availabilityReport(
    [
      listing("high", { dataCenter: "EU-SE-1" }),
      listing("high", { dataCenter: "EU-RO-1" }),
      listing("high", { gpuCount: 2, dataCenter: "AA-1" }),
      listing("high", { gpuType: "RTX-A6000" }),
      listing("high", { provider: "hyperstack" }),
    ],
    W,
  );
  assert.deepEqual(
    r.groups.map((g) => [g.provider, g.gpuType, g.gpuCount, g.dataCenter]),
    [
      ["hyperstack", "L4", 1, "EU-SE-1"],
      ["runpod", "L4", 1, "EU-RO-1"],
      ["runpod", "L4", 1, "EU-SE-1"],
      ["runpod", "L4", 2, "AA-1"],
      ["runpod", "RTX-A6000", 1, "EU-SE-1"],
    ],
  );
});

test("the window is half-open and observations outside it are ignored", () => {
  const r = availabilityReport(
    [listing("high", { observedMs: W.fromMs - 1 }), listing("high", { observedMs: W.fromMs }), listing("high", { observedMs: W.toMs - 1 }), listing("high", { observedMs: W.toMs })],
    W,
  );
  assert.equal(r.observations, 2);
  assert.equal(r.groups[0]!.listings.observations, 2);
});

test("ties at the same time: the later observation in the input wins (country and price)", () => {
  const r = availabilityReport(
    [listing("high", { observedMs: NOW - 10, country: "SE", quotedCostPerHour: 600_000 }), listing("high", { observedMs: NOW - 10, country: null, quotedCostPerHour: 650_000 })],
    W,
  );
  assert.equal(r.groups[0]!.country, null);
  assert.equal(r.groups[0]!.quotedCostPerHour!.latest, 650_000);
});

test("the latest price is the newest observation's, not the first one's", () => {
  const r = availabilityReport(
    [listing("high", { observedMs: NOW - 30, quotedCostPerHour: 500_000 }), listing("high", { observedMs: NOW - 10, quotedCostPerHour: 800_000 }), listing("high", { observedMs: NOW - 20, quotedCostPerHour: 600_000 })],
    W,
  );
  assert.deepEqual(r.groups[0]!.quotedCostPerHour, { min: 500_000, max: 800_000, latest: 800_000 });
});

test("the group's country is its newest observation's; truncation is passed through", () => {
  const r = availabilityReport([listing("high", { observedMs: NOW - 10, country: null }), listing("high", { observedMs: NOW - 20, country: "SE" })], { ...W, truncated: true });
  assert.equal(r.groups[0]!.country, null);
  assert.equal(r.truncated, true);
});

test("report windows are checked", () => {
  for (const w of [
    { fromMs: 10, toMs: 10 }, { fromMs: 10, toMs: 9 }, { fromMs: -1, toMs: 10 }, { fromMs: 0, toMs: Number.NaN },
    { fromMs: 0, toMs: MAX_REPORT_WINDOW_MS + 1 }, { fromMs: 0.5, toMs: 10 },
  ]) {
    assert.throws(() => availabilityReport([], { ...w, truncated: false, prunedThroughMs: null }), RangeError, JSON.stringify(w));
  }
  assert.equal(availabilityReport([], { fromMs: 0, toMs: MAX_REPORT_WINDOW_MS, truncated: false, prunedThroughMs: null }).groups.length, 0);
});

test("one data center with two GPU counts is two groups", () => {
  const r = availabilityReport([launch("launched", 1, { gpuCount: 1 }), launch("no_capacity", null, { gpuCount: 2 })], W);
  assert.deepEqual(r.groups.map((g) => [g.gpuCount, g.launches.capacity]), [[1, { launched: 1, of: 1 }], [2, { launched: 0, of: 1 }]]);
});

test("complete: not truncated, and the window starts after anything pruned", () => {
  const at = (prunedThroughMs: number | null, truncated = false) => availabilityReport([], { ...W, truncated, prunedThroughMs });
  assert.equal(at(null).complete, true);
  assert.equal(at(W.fromMs - 1).complete, true);
  assert.equal(at(W.fromMs).complete, false); // a pruned row at fromMs was in the window
  assert.equal(at(W.toMs + 5).complete, false);
  assert.equal(at(null, true).complete, false);
  assert.equal(at(W.fromMs - 1, true).complete, false);
  assert.equal(at(W.fromMs).prunedThroughMs, W.fromMs);
  for (const bad of [-1, 1.5, Number.NaN]) {
    assert.throws(() => availabilityReport([], { ...W, prunedThroughMs: bad }), RangeError, String(bad));
  }
});

test("checkReportWindow is the shared window check", () => {
  checkReportWindow(0, 1);
  checkReportWindow(0, MAX_REPORT_WINDOW_MS);
  for (const [f, t] of [[1, 1], [2, 1], [-1, 1], [0, Number.NaN], [0, MAX_REPORT_WINDOW_MS + 1], [0.5, 2]]) {
    assert.throws(() => checkReportWindow(f!, t!), RangeError, `${f} ${t}`);
  }
});
