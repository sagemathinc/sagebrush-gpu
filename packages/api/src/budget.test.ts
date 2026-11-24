import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEDGER_MINUTE_SECONDS,
  canStartWithin,
  chargeBound,
  hardStopThreshold,
  meterRemaining,
  minuteCharge,
  requiredToStart,
  reserveCharge,
  reserveSeconds,
  shouldHardStop,
  type HardStopInput,
  type MeteredMachine,
  type StartCheckInput,
} from "./budget.ts";
import { entrySplit } from "./money.ts";

const MAX = Number.MAX_SAFE_INTEGER;

// A small deterministic generator, so failures reproduce.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/**
 * The ledger, simulated: machine k runs from startK to endK (seconds from a minute
 * boundary at 0); each minute it overlaps is one entry of entrySplit for its seconds.
 */
function ledgerCharge(machines: Array<MeteredMachine & { start: number; end: number }>): number {
  let total = 0;
  for (const m of machines) {
    for (let b = Math.floor(m.start / 60) * 60; b < m.end; b += 60) {
      const s = Math.min(m.end, b + 60) - Math.max(m.start, b);
      if (s > 0) total += entrySplit(m.providerCostPerHour, s, m.marginBps).total;
    }
  }
  return total;
}

test("minuteCharge is the ledger entry, and never decreases with seconds", () => {
  const r = rng(1);
  for (let i = 0; i < 3000; i++) {
    const m = { providerCostPerHour: int(r, 0, 20_000_000), marginBps: int(r, 0, 20_000) };
    let prev = -1;
    for (let s = 0; s <= 60; s++) {
      const c = minuteCharge(m, s);
      assert.equal(c, entrySplit(m.providerCostPerHour, s, m.marginBps).total);
      assert.ok(c >= prev, `decreased at ${s}s for ${JSON.stringify(m)}`);
      prev = c;
    }
  }
  assert.throws(() => minuteCharge({ providerCostPerHour: 1, marginBps: 0 }, 61), RangeError);
});

test("review counterexamples: the bound is the ledger's own charge", () => {
  // Three machines at 30 micro-$/h, margin 0, one 60 s entry each: the ledger charges 1 each.
  const three = Array.from({ length: 3 }, () => ({ providerCostPerHour: 30, marginBps: 0 }));
  assert.equal(ledgerCharge(three.map((m) => ({ ...m, start: 0, end: 60 }))), 3);
  assert.equal(chargeBound(three, 60), 3);
  const stop3: HardStopInput = { unspent: 2, machines: three, unbilledSeconds: 0, checkIntervalSeconds: 60, safetySeconds: 0, reserveSeconds: 0 };
  assert.equal(hardStopThreshold(stop3), 3);
  assert.equal(shouldHardStop(stop3), true);
  assert.equal(shouldHardStop({ ...stop3, unspent: 3 }), false);
  // One machine at 3 micro-$/h with 30% margin for 1800 s: per-minute entries of 0 each
  // (0.05 micro rounds to 0), so the ledger charges 0, and the bound is >= that.
  const one = [{ providerCostPerHour: 3, marginBps: 3000 }];
  const charged = ledgerCharge(one.map((m) => ({ ...m, start: 0, end: 1800 })));
  assert.ok(chargeBound(one, 1800) >= charged);
  // and a rate whose per-minute entries round up: 31 micro-$/h, 30%: 0.517 -> 1 provider, margin 0.3 -> 0
  const up = [{ providerCostPerHour: 31, marginBps: 3000 }];
  assert.equal(ledgerCharge(up.map((m) => ({ ...m, start: 0, end: 1800 }))), 30);
  assert.equal(chargeBound(up, 1800), 30); // an hourly ceil would say ceil(40.3 * 0.5) = 16
});

test("randomized: the bound is never below what the ledger charges in the window", () => {
  const r = rng(42);
  for (let trial = 0; trial < 4000; trial++) {
    const n = int(r, 1, 5);
    const window = int(r, 0, 3 * 3600);
    const ms = Array.from({ length: n }, () => {
      const tiny = r() < 0.4;
      const providerCostPerHour = tiny ? int(r, 0, 200) : int(r, 0, 50_000_000);
      const marginBps = r() < 0.2 ? 0 : int(r, 0, 15_000);
      // each starts anywhere in the window and runs through it, possibly to the end of
      // the last minute the window overlaps
      const start = int(r, 0, Math.max(0, window - 1));
      const end = Math.max(start, Math.min(Math.ceil(window / 60) * 60, int(r, window, window + 60)));
      return { providerCostPerHour, marginBps, start, end };
    });
    const bound = chargeBound(ms, window);
    const charged = ledgerCharge(ms);
    assert.ok(charged <= bound, `trial ${trial}: ledger ${charged} > bound ${bound}: ${JSON.stringify({ window, ms })}`);
  }
});

test("the bound is exact when every machine runs every minute of the window in full", () => {
  const r = rng(7);
  for (let trial = 0; trial < 2000; trial++) {
    const minutes = int(r, 0, 120);
    const ms = Array.from({ length: int(r, 1, 4) }, () => ({
      providerCostPerHour: int(r, 0, 10_000_000),
      marginBps: int(r, 0, 10_000),
    }));
    const charged = ledgerCharge(ms.map((m) => ({ ...m, start: 0, end: minutes * 60 })));
    assert.equal(chargeBound(ms, minutes * 60), charged);
    // a window ending one second into a minute still pays that whole minute
    if (minutes > 0) assert.equal(chargeBound(ms, minutes * 60 - 59), charged);
  }
});

test("hardStopThreshold counts every period, unbilled time included", () => {
  // $3.60/h at 0%: 60_000 micros per full minute
  const m = [{ providerCostPerHour: 3_600_000, marginBps: 0 }];
  const z = { unspent: 0, machines: m, unbilledSeconds: 0, checkIntervalSeconds: 0, safetySeconds: 0, reserveSeconds: 0 };
  assert.equal(hardStopThreshold(z), 0);
  assert.equal(hardStopThreshold({ ...z, unbilledSeconds: 1 }), 60_000);
  assert.equal(hardStopThreshold({ ...z, checkIntervalSeconds: 60 }), 60_000);
  assert.equal(hardStopThreshold({ ...z, safetySeconds: 61 }), 120_000);
  assert.equal(hardStopThreshold({ ...z, reserveSeconds: 600 }), 600_000);
  assert.equal(hardStopThreshold({ ...z, unbilledSeconds: 30, checkIntervalSeconds: 60, safetySeconds: 30, reserveSeconds: 600 }), 720_000);
  // with margin: 30% of 60_000 = 18_000 per minute on top
  assert.equal(hardStopThreshold({ ...z, machines: [{ providerCostPerHour: 3_600_000, marginBps: 3000 }], checkIntervalSeconds: 60 }), 78_000);
});

test("shouldHardStop at the boundary", () => {
  const m = [{ providerCostPerHour: 3_600_000, marginBps: 0 }];
  const base = { machines: m, unbilledSeconds: 0, checkIntervalSeconds: 60, safetySeconds: 30, reserveSeconds: 600 };
  assert.equal(shouldHardStop({ ...base, unspent: 720_000 }), false);
  assert.equal(shouldHardStop({ ...base, unspent: 719_999 }), true);
  assert.equal(shouldHardStop({ ...base, unspent: -5 }), true);
  assert.equal(shouldHardStop({ ...base, unspent: 10_000_000 }), false);
  // nothing running: nothing to stop
  assert.equal(shouldHardStop({ ...base, machines: [], unspent: -5 }), false);
  // free machines on a spent allocation: the threshold is 0, so 0 unspent keeps them
  assert.equal(shouldHardStop({ ...base, machines: [{ providerCostPerHour: 0, marginBps: 3000 }], unspent: 0 }), false);
  assert.equal(shouldHardStop({ ...base, machines: [{ providerCostPerHour: 0, marginBps: 3000 }], unspent: -1 }), true);
});

test("shouldHardStop fails closed on invalid input", () => {
  const m = [{ providerCostPerHour: 3_600_000, marginBps: 0 }];
  const ok: HardStopInput = { unspent: 10 ** 12, machines: m, unbilledSeconds: 0, checkIntervalSeconds: 60, safetySeconds: 30, reserveSeconds: 600 };
  assert.equal(shouldHardStop(ok), false);
  for (const unspent of [NaN, Infinity, -Infinity, 1.5, MAX + 1]) {
    assert.equal(shouldHardStop({ ...ok, unspent }), true, `unspent ${unspent}`);
  }
  // negative periods can't cancel positive ones
  // (with the negative safety, the window would be 600 s: 10**12 unspent would keep running)
  assert.equal(shouldHardStop({ ...ok, checkIntervalSeconds: 600, safetySeconds: -600 }), true);
  assert.equal(shouldHardStop({ ...ok, unbilledSeconds: -60 }), true);
  assert.equal(shouldHardStop({ ...ok, reserveSeconds: -600 }), true);
  assert.equal(shouldHardStop({ ...ok, unbilledSeconds: NaN }), true);
  assert.equal(shouldHardStop({ ...ok, safetySeconds: 0.5 }), true);
  // negative or broken rates can't cancel another machine's
  assert.equal(shouldHardStop({ ...ok, unspent: 1, machines: [...m, { providerCostPerHour: -3_600_000, marginBps: 0 }] }), true);
  assert.equal(shouldHardStop({ ...ok, machines: [{ providerCostPerHour: NaN, marginBps: 0 }] }), true);
  assert.equal(shouldHardStop({ ...ok, machines: [{ providerCostPerHour: 1, marginBps: -1 }] }), true);
  assert.equal(shouldHardStop({ ...ok, machines: [{ providerCostPerHour: 1, marginBps: NaN }] }), true);
  assert.equal(shouldHardStop({ ...ok, machines: [null as unknown as MeteredMachine] }), true);
  assert.equal(shouldHardStop({ ...ok, machines: "x" as unknown as MeteredMachine[] }), true);
  // overflow: refuse rather than wrap or lose precision
  assert.equal(shouldHardStop({ ...ok, unspent: MAX, checkIntervalSeconds: MAX, safetySeconds: 1 }), true);
  assert.equal(shouldHardStop({ ...ok, unspent: MAX, machines: [{ providerCostPerHour: MAX, marginBps: 0 }] }), true);
});

test("requiredToStart counts each period and every machine on the allocation", () => {
  const m = { providerCostPerHour: 3_600_000, marginBps: 0 }; // 60_000 per minute
  const z: StartCheckInput = { unspent: 0, newMachine: m, running: [], unbilledSeconds: 0, minStartMinutes: 0, checkIntervalSeconds: 0, safetySeconds: 0, reserveSeconds: 0 };
  assert.equal(requiredToStart(z), 0);
  assert.equal(requiredToStart({ ...z, minStartMinutes: 15 }), 900_000);
  assert.equal(requiredToStart({ ...z, unbilledSeconds: 1 }), 60_000);
  assert.equal(requiredToStart({ ...z, checkIntervalSeconds: 60 }), 60_000);
  assert.equal(requiredToStart({ ...z, safetySeconds: 30 }), 60_000);
  assert.equal(requiredToStart({ ...z, reserveSeconds: 600 }), 600_000);
  assert.equal(requiredToStart({ ...z, minStartMinutes: 1, running: [m] }), 120_000);
  assert.equal(requiredToStart({ ...z, minStartMinutes: 1, running: [m, m] }), 180_000);
});

test("canStartWithin at the boundary, and fails closed", () => {
  const m = { providerCostPerHour: 3_600_000, marginBps: 0 };
  const base: StartCheckInput = { unspent: 0, newMachine: m, running: [], unbilledSeconds: 0, minStartMinutes: 15, checkIntervalSeconds: 60, safetySeconds: 30, reserveSeconds: 600 };
  // 15 min + 60 + 30 + 600 s = 1590 s -> 27 minutes
  assert.equal(canStartWithin({ ...base, unspent: 1_620_000 }), true);
  assert.equal(canStartWithin({ ...base, unspent: 1_619_999 }), false);
  for (const unspent of [NaN, Infinity, 1.5, MAX + 2]) assert.equal(canStartWithin({ ...base, unspent }), false, String(unspent));
  assert.equal(canStartWithin({ ...base, unspent: 10 ** 12, minStartMinutes: -15 }), false);
  assert.equal(canStartWithin({ ...base, unspent: 10 ** 12, newMachine: { providerCostPerHour: -1, marginBps: 0 } }), false);
  assert.equal(canStartWithin({ ...base, unspent: 10 ** 12, running: [{ providerCostPerHour: 1, marginBps: 0.5 }] }), false);
  assert.equal(canStartWithin({ ...base, unspent: MAX, minStartMinutes: MAX }), false);
  assert.equal(canStartWithin({ ...base, unspent: 10 ** 12, minStartMinutes: 15, checkIntervalSeconds: 600, safetySeconds: -600 }), false);
  assert.equal(canStartWithin({ ...base, unspent: MAX, reserveSeconds: MAX }), false);
});

test("a machine allowed to start is not stopped at any check during its minimum slice", () => {
  const r = rng(99);
  for (let trial = 0; trial < 2000; trial++) {
    const m = { providerCostPerHour: int(r, 0, 20_000_000), marginBps: int(r, 0, 10_000) };
    const p = { checkIntervalSeconds: int(r, 0, 300), safetySeconds: int(r, 0, 120), reserveSeconds: int(r, 0, 1800) };
    const unbilled = int(r, 0, 59);
    const min = int(r, 0, 60);
    const unspent = requiredToStart({ unspent: 0, newMachine: m, running: [], unbilledSeconds: unbilled, minStartMinutes: min, ...p });
    // After t seconds of running, the ledger has charged at most chargeBound for the
    // billed minutes; the check then sees the rest unbilled.
    for (const t of [0, 1, 59, 60, min * 60]) {
      const elapsed = unbilled + t;
      const billedMinutes = Math.floor(elapsed / 60);
      const charged = chargeBound([m], billedMinutes * 60);
      if (t > min * 60) continue;
      assert.equal(
        shouldHardStop({ unspent: unspent - charged, machines: [m], unbilledSeconds: elapsed - billedMinutes * 60, ...p }),
        false,
        JSON.stringify({ trial, m, p, unbilled, min, t }),
      );
    }
  }
});

test("reserveSeconds is the longer of the policy floor and the estimate, checked", () => {
  assert.equal(reserveSeconds(10, 0), 600);
  assert.equal(reserveSeconds(10, 599), 600);
  assert.equal(reserveSeconds(10, 601), 601);
  assert.equal(reserveSeconds(0, 30), 30);
  assert.throws(() => reserveSeconds(-1, 0), RangeError);
  assert.throws(() => reserveSeconds(1, 1.5), RangeError);
  assert.throws(() => reserveSeconds(NaN, 1), RangeError);
  assert.throws(() => reserveSeconds(1, NaN), RangeError);
  assert.throws(() => reserveSeconds(Math.floor(MAX / 60) + 1, 0), RangeError); // MAX*60 refused
  assert.equal(reserveSeconds(Math.floor(MAX / 60), 0), Math.floor(MAX / 60) * 60);
});

test("reserveCharge covers a final save starting anywhere in a minute", () => {
  const m = [{ providerCostPerHour: 3_600_000, marginBps: 0 }];
  assert.equal(reserveCharge(m, 600), 660_000);
  assert.equal(reserveCharge(m, 0), 60_000);
  assert.equal(reserveCharge([], 600), 0);
  assert.throws(() => reserveCharge(m, -1), RangeError);
  assert.throws(() => reserveCharge(m, MAX), RangeError);
});

test("chargeBound refuses bad input and overflow", () => {
  const m = { providerCostPerHour: 1_000_000, marginBps: 3000 };
  assert.throws(() => chargeBound([m], -60), RangeError);
  assert.throws(() => chargeBound([m], NaN), RangeError);
  assert.throws(() => chargeBound([{ providerCostPerHour: -1, marginBps: 0 }], 60), RangeError);
  assert.throws(() => chargeBound([{ providerCostPerHour: MAX, marginBps: 0 }], 60), RangeError);
  assert.throws(() => chargeBound([m], MAX), RangeError);
  // many machines whose sum overflows
  const big = { providerCostPerHour: 2 ** 40, marginBps: 0 }; // 2^40/60 per minute
  assert.throws(() => chargeBound(Array.from({ length: 2 ** 12 }, () => big), 3600 * 24 * 30), RangeError);
  assert.equal(chargeBound([], MAX - 60), 0);
  // machines are validated even when the window is empty
  assert.equal(chargeBound([m], 0), 0);
  assert.throws(() => chargeBound([{ providerCostPerHour: -1, marginBps: 0 }], 0), RangeError);
  assert.throws(() => chargeBound([{ providerCostPerHour: 1, marginBps: 1_000_001 }], 0), RangeError);
  assert.throws(() => chargeBound([{ providerCostPerHour: 1.5, marginBps: 0 }], 0), RangeError);
  assert.equal(LEDGER_MINUTE_SECONDS, 60);
});

test("meterRemaining clamps at zero and refuses bad input", () => {
  assert.equal(meterRemaining(100, 30, 20), 50);
  assert.equal(meterRemaining(100, 80, 20), 0);
  assert.equal(meterRemaining(100, 81, 20), 0);
  assert.equal(meterRemaining(100, 79, 20), 1);
  assert.equal(meterRemaining(100, 0, 0), 100);
  assert.throws(() => meterRemaining(NaN, 0, 0), RangeError);
  assert.throws(() => meterRemaining(100, -50, 0), RangeError); // can't cancel the reserve
  assert.throws(() => meterRemaining(100, 0, -50), RangeError);
  assert.throws(() => meterRemaining(MAX, MAX, 1), RangeError);
});
