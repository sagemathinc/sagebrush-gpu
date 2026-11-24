import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedgerEntry } from "@sbgpu/api";
import { bucketStartMs, parseIsoUtc, reconcile, tolerance, type MachineBinding, type ProviderBillingRecord, type ReconcileOptions } from "./reconcile.ts";

const M1 = "mch_0000000000000000000a";
const M2 = "mch_0000000000000000000b";
const H0 = "2026-11-24T10:00:00.000Z";
const H1 = "2026-11-24T11:00:00.000Z";
const H2 = "2026-11-24T12:00:00.000Z";

function bill(pm: string, start: string, total: number, end?: string): ProviderBillingRecord {
  const e = end ?? new Date(Date.parse(start) + 3_600_000).toISOString();
  return { provider: "runpod", providerMachineId: pm, bucketStart: start, bucketEnd: e, total, gpu: total, cpu: 0, disk: 0 };
}

let n = 0;
function entry(machineId: string | null, periodStart: string, providerCost: number, kind: LedgerEntry["kind"] = "compute"): LedgerEntry {
  n++;
  return {
    id: `led_${String(n).padStart(20, "0")}`, orgId: "org_x", projectId: "prj_x", allocationId: "alc_x", kind,
    machineId, provider: machineId === null ? null : "runpod", periodStart, seconds: 60, providerCostPerHour: 690_000,
    marginBps: 3000, amount: { providerCost, margin: Math.round(providerCost * 0.3), total: providerCost + Math.round(providerCost * 0.3) }, note: null, createdAt: periodStart,
  };
}

const bindings: MachineBinding[] = [
  { machineId: M1, provider: "runpod", providerMachineId: "podA" },
  { machineId: M1, provider: "runpod", providerMachineId: "podA2" },
  { machineId: M2, provider: "runpod", providerMachineId: "podB" },
];
const opts: ReconcileOptions = { bucket: "hour", closedBefore: H2, toleranceMicros: 100, toleranceBps: 0 };

/** 60 minutes of ledger at `perMinute` micros, from `start`. */
function hour(machineId: string, start: string, perMinute: number): LedgerEntry[] {
  return Array.from({ length: 60 }, (_, i) => entry(machineId, new Date(Date.parse(start) + i * 60_000).toISOString(), perMinute));
}

test("matching bill and ledger reconcile ok, per machine and bucket, sorted", () => {
  const rows = reconcile(
    [bill("podB", H0, 600_000), bill("podA", H1, 690_000), bill("podA", H0, 690_000)],
    [...hour(M1, H0, 11_500), ...hour(M1, H1, 11_500), ...hour(M2, H0, 10_000)],
    bindings,
    opts,
  );
  assert.deepEqual(
    rows.map((r) => [r.bucketStart, r.machineId, r.billed, r.ledger, r.difference, r.status]),
    [
      [H0, M1, 690_000, 690_000, 0, "ok"],
      [H0, M2, 600_000, 600_000, 0, "ok"],
      [H1, M1, 690_000, 690_000, 0, "ok"],
    ],
  );
  assert.deepEqual(rows[0]!.providerMachineIds, ["podA"]);
  assert.equal(rows[0]!.provider, "runpod");
});

test("two provider machines of one machine in a bucket are summed", () => {
  const [row] = reconcile([bill("podA2", H0, 300_000), bill("podA", H0, 390_000)], hour(M1, H0, 11_500), bindings, opts);
  assert.deepEqual(row!.providerMachineIds, ["podA", "podA2"]);
  assert.equal(row!.billed, 690_000);
  assert.equal(row!.status, "ok");
});

test("tolerance: absolute, relative, and its edges", () => {
  const ledger = hour(M1, H0, 10_000); // 600_000
  const at = (billed: number, o: Partial<ReconcileOptions> = {}) =>
    reconcile([bill("podA", H0, billed)], ledger, bindings, { ...opts, ...o })[0]!.status;
  assert.equal(at(600_100), "ok");
  assert.equal(at(600_101), "over");
  assert.equal(at(599_900), "ok");
  assert.equal(at(599_899), "under");
  assert.equal(at(606_000, { toleranceMicros: 0, toleranceBps: 100 }), "ok");
  assert.equal(at(606_001, { toleranceMicros: 0, toleranceBps: 100 }), "over");
  assert.equal(at(594_000, { toleranceMicros: 0, toleranceBps: 100 }), "ok");
  assert.equal(at(593_999, { toleranceMicros: 0, toleranceBps: 100 }), "under");
  assert.equal(tolerance(600_000, { toleranceMicros: 5000, toleranceBps: 100 }), 6000);
  assert.equal(tolerance(600_000, { toleranceMicros: 7000, toleranceBps: 100 }), 7000);
  assert.equal(tolerance(199, { toleranceMicros: 0, toleranceBps: 50 }), 0);
});

test("a bill with no ledger is over; a ledger with no bill is under", () => {
  const rows = reconcile([bill("podB", H0, 5000)], hour(M1, H0, 10_000), bindings, opts);
  assert.deepEqual(rows.map((r) => [r.machineId, r.status, r.difference]), [[M1, "under", -600_000], [M2, "over", 5000]]);
  assert.deepEqual(rows[0]!.providerMachineIds, []);
});

test("a billed machine we have no binding for is unknown_machine, one row per provider machine", () => {
  const rows = reconcile([bill("rogue2", H0, 1), bill("rogue1", H0, 2)], [], bindings, opts);
  assert.deepEqual(rows.map((r) => [r.machineId, r.providerMachineIds, r.billed, r.status]), [
    [null, ["rogue1"], 2, "unknown_machine"],
    [null, ["rogue2"], 1, "unknown_machine"],
  ]);
  assert.equal(reconcile([bill("rogue", H0, 0)], [], bindings, opts)[0]!.status, "unknown_machine");
});

test("buckets that aren't closed are pending, whatever the amounts", () => {
  const rows = reconcile([bill("podA", H1, 1), bill("rogue", H1, 1)], [], bindings, { ...opts, closedBefore: "2026-11-24T11:59:59.000Z" });
  assert.deepEqual(rows.map((r) => r.status), ["pending", "pending"]);
  assert.equal(reconcile([bill("podA", H1, 1000)], [], bindings, { ...opts, closedBefore: H2 })[0]!.status, "over");
});

test("only compute entries count; a compute entry without a machine is an error", () => {
  const rows = reconcile([bill("podA", H0, 0)], [entry(M1, H0, 0), entry(M1, H0, 999, "storage"), entry(null, H0, 5, "adjustment")], bindings, opts);
  assert.deepEqual(rows.map((r) => [r.ledger, r.status]), [[0, "ok"]]);
  assert.throws(() => reconcile([], [entry(null, H0, 5)], bindings, opts), RangeError);
  assert.throws(() => reconcile([], [{ ...entry(M1, H0, 5), provider: null }], bindings, opts), RangeError);
});

test("ledger minutes land in the bucket containing them; day buckets", () => {
  const late = entry(M1, "2026-11-24T10:59:00.000Z", 7);
  const next = entry(M1, H1, 11);
  const rows = reconcile([], [late, next], bindings, opts);
  assert.deepEqual(rows.map((r) => [r.bucketStart, r.ledger]), [[H0, 7], [H1, 11]]);
  const day = reconcile(
    [bill("podA", "2026-11-23T00:00:00.000Z", 18, "2026-11-24T00:00:00.000Z")],
    [entry(M1, "2026-11-23T00:00:00.000Z", 7), entry(M1, "2026-11-23T23:59:00.000Z", 11)],
    bindings,
    { ...opts, bucket: "day", closedBefore: "2026-11-24T00:00:00.000Z" },
  );
  assert.deepEqual(day.map((r) => [r.bucketStart, r.billed, r.ledger, r.status]), [["2026-11-23T00:00:00.000Z", 18, 18, "ok"]]);
  assert.equal(bucketStartMs(Date.parse("2026-11-24T10:59:59.999Z"), "hour"), Date.parse(H0));
  assert.equal(bucketStartMs(Date.parse(H1), "hour"), Date.parse(H1));
});

test("inputs that can't be reconciled are errors", () => {
  const bad: Array<() => unknown> = [
    () => reconcile([bill("podA", "2026-11-24T10:30:00.000Z", 1)], [], bindings, opts),
    () => reconcile([bill("podA", H0, 1, H2)], [], bindings, opts),
    () => reconcile([bill("podA", "yesterday", 1)], [], bindings, opts),
    () => reconcile([bill("podA", "2026-11-24T10:00:00+01:00", 1)], [], bindings, opts),
    () => reconcile([bill("podA", H0, -1)], [], bindings, opts),
    () => reconcile([bill("podA", H0, 1.5)], [], bindings, opts),
    () => reconcile([], [entry(M1, "nope", 1)], bindings, opts),
    () => reconcile([], [entry(M1, H0, -1)], bindings, opts),
    () => reconcile([], [], [...bindings, { machineId: M2, provider: "runpod", providerMachineId: "podA" }], opts),
    () => reconcile([], [], bindings, { ...opts, closedBefore: "soon" }),
    () => reconcile([], [], bindings, { ...opts, toleranceMicros: -1 }),
    () => reconcile([], [], bindings, { ...opts, toleranceMicros: 0.5 }),
    () => reconcile([], [], bindings, { ...opts, toleranceBps: -1 }),
    () => reconcile([], [], bindings, { ...opts, toleranceBps: 10_001 }),
    () => reconcile([], [], bindings, { ...opts, toleranceBps: 1.5 }),
    () => reconcile([], [], bindings, { ...opts, bucket: "week" as "day" }),
    () => reconcile([bill("podA", H0, Number.MAX_SAFE_INTEGER), bill("podA2", H0, 1)], [], bindings, opts),
  ];
  bad.forEach((f, i) => assert.throws(f, RangeError, `case ${i}`));
  // the same binding twice is fine
  assert.equal(reconcile([], [], [...bindings, bindings[0]!], opts).length, 0);
});

test("the same provider machine id at another provider is not that machine", () => {
  const rows = reconcile([{ ...bill("podA", H0, 5), provider: "hyperstack" }], [], bindings, opts);
  assert.deepEqual(rows.map((r) => [r.machineId, r.provider, r.status]), [[null, "hyperstack", "unknown_machine"]]);
  const both = [...bindings, { machineId: M2, provider: "hyperstack" as const, providerMachineId: "podA" }];
  const rows2 = reconcile([{ ...bill("podA", H0, 5), provider: "hyperstack" }, bill("podA", H0, 7)], [], both, { ...opts, toleranceMicros: 0 });
  assert.deepEqual(rows2.map((r) => [r.machineId, r.provider, r.billed]), [[M2, "hyperstack", 5], [M1, "runpod", 7]]);
});

test("the ledger side is the provider cost, not the price with margin", () => {
  const [row] = reconcile([bill("podA", H0, 600_000)], hour(M1, H0, 10_000), bindings, opts);
  assert.equal(row!.ledger, 600_000);
  assert.equal(row!.status, "ok");
});

// ---------------------------------------------------------------- exact tolerance (LIMITS H1, TESTS T1)

const exactTol = (ledger: number, bps: number, abs: number) => {
  const rel = (BigInt(ledger) * BigInt(bps)) / 10_000n;
  return Number(rel > BigInt(abs) ? rel : BigInt(abs));
};

test("tolerance is exact near the top of the safe range", () => {
  const cases: Array<[number, number]> = [
    [9007199254740909, 33], [2 ** 52, 9999], [Number.MAX_SAFE_INTEGER, 10_000], [Number.MAX_SAFE_INTEGER, 1],
    [Number.MAX_SAFE_INTEGER, 9999], [Number.MAX_SAFE_INTEGER - 7, 3333], [2 ** 52 + 1, 7], [1e15 + 3, 1234],
  ];
  for (const [ledger, bps] of cases) {
    assert.equal(tolerance(ledger, { toleranceMicros: 0, toleranceBps: bps }), exactTol(ledger, bps, 0), `${ledger} ${bps}`);
  }
  assert.equal(tolerance(9007199254740909, { toleranceMicros: 0, toleranceBps: 33 }), 29723757540644);
  assert.equal(tolerance(2 ** 52, { toleranceMicros: 0, toleranceBps: 9999 }), 4503149267407758);
});

test("statuses at exactly the tolerance and one past it, high in the safe range", () => {
  const ledgerAmount = 2 ** 52;
  const bps = 9999;
  const tol = exactTol(ledgerAmount, bps, 0);
  const big: LedgerEntry = { ...entry(M1, H0, 1), amount: { providerCost: ledgerAmount, margin: 0, total: ledgerAmount } };
  const at = (billed: number) => reconcile([bill("podA", H0, billed)], [big], bindings, { ...opts, toleranceMicros: 0, toleranceBps: bps })[0]!.status;
  assert.equal(at(ledgerAmount - tol), "ok");
  assert.equal(at(ledgerAmount - tol - 1), "under");
  assert.equal(at(ledgerAmount + tol), "ok");
  assert.equal(at(ledgerAmount + tol + 1), "over");
  const l2 = 9007199254740909;
  const t2 = exactTol(l2, 33, 0);
  const big2: LedgerEntry = { ...entry(M1, H0, 1), amount: { providerCost: l2, margin: 0, total: l2 } };
  const at2 = (billed: number) => reconcile([bill("podA", H0, billed)], [big2], bindings, { ...opts, toleranceMicros: 0, toleranceBps: 33 })[0]!.status;
  assert.equal(at2(l2 - t2), "ok");
  assert.equal(at2(l2 - t2 - 1), "under");
});

test("tolerance validates its own inputs", () => {
  for (const [ledger, abs, bps] of [[-1, 0, 0], [1.5, 0, 0], [2 ** 53, 0, 0], [1, -1, 0], [1, 0.5, 0], [1, 0, -1], [1, 0, 10_001], [1, 0, 0.5], [1, 0, Number.NaN]]) {
    assert.throws(() => tolerance(ledger!, { toleranceMicros: abs!, toleranceBps: bps! }), RangeError, `${ledger} ${abs} ${bps}`);
  }
  assert.equal(tolerance(0, { toleranceMicros: 0, toleranceBps: 10_000 }), 0);
  assert.equal(tolerance(Number.MAX_SAFE_INTEGER, { toleranceMicros: Number.MAX_SAFE_INTEGER, toleranceBps: 0 }), Number.MAX_SAFE_INTEGER);
});

// ---------------------------------------------------------------- calendar (TESTS T2)

test("parseIsoUtc accepts real UTC times only", () => {
  assert.equal(parseIsoUtc("2026-11-24T10:00Z"), Date.parse(H0));
  assert.equal(parseIsoUtc("2026-11-24T10:00:00Z"), Date.parse(H0));
  assert.equal(parseIsoUtc("2026-11-24T10:00:00.000Z"), Date.parse(H0));
  assert.equal(parseIsoUtc("2026-11-24T10:00:00.5Z"), Date.parse(H0) + 500);
  assert.equal(parseIsoUtc("2024-02-29T00:00:00Z"), Date.parse("2024-02-29T00:00:00Z"));
  for (const bad of [
    "2026-02-30T10:00Z", "2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-11-31T00:00:00Z",
    "2026-11-24T24:00:00Z", "2026-11-24T23:60:00Z", "2026-11-24T23:59:60Z", "2026-11-24T10:60:00Z", "2026-11-24T10:00:60Z",
    "2026-11-24T10:00:00Zjunk", "x2026-11-24T10:00:00Z", "2026-11-24T10:00:00+00:00", "2026-11-24T10:00:00z",
    "2026-11-24T10:00:00.0000Z", "2026-11-24 10:00:00Z", "2026-11-24", "", 7, null,
  ]) {
    assert.equal(parseIsoUtc(bad), null, String(bad));
  }
});

test("reconcile refuses nonexistent dates instead of rolling them over", () => {
  assert.throws(() => reconcile([], [entry(M1, "2026-02-30T10:00Z", 1)], bindings, opts), RangeError);
  assert.throws(() => reconcile([bill("podA", "2026-02-30T10:00:00Z", 1, "2026-02-30T11:00:00Z")], [], bindings, opts), RangeError);
  assert.throws(() => reconcile([], [], bindings, { ...opts, closedBefore: "2026-02-30T00:00:00Z" }), RangeError);
});
