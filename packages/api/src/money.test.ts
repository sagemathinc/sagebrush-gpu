import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addSplits,
  checkedAdd,
  checkedMul,
  costForSeconds,
  divRoundHalfUp,
  entrySplit,
  formatUsd,
  isBasisPoints,
  isMicros,
  isNonNegativeMicros,
  isPriceSplit,
  marginOn,
  priceSplit,
} from "./money.ts";

test("divRoundHalfUp rounds halves up and everything else to nearest", () => {
  assert.equal(divRoundHalfUp(0, 7), 0);
  assert.equal(divRoundHalfUp(6, 3), 2);
  assert.equal(divRoundHalfUp(4, 3), 1); // 1.33
  assert.equal(divRoundHalfUp(5, 3), 2); // 1.67
  assert.equal(divRoundHalfUp(5, 2), 3); // 2.5 -> 3
  assert.equal(divRoundHalfUp(7, 2), 4); // 3.5 -> 4
  assert.equal(divRoundHalfUp(1, 2), 1);
  assert.equal(divRoundHalfUp(1, 3), 0);
  assert.equal(divRoundHalfUp(14999, 10000), 1);
  assert.equal(divRoundHalfUp(15000, 10000), 2);
});

test("divRoundHalfUp is exact near the top of the safe range", () => {
  const n = Number.MAX_SAFE_INTEGER; // 2^53 - 1, odd
  assert.equal(divRoundHalfUp(n, 2), (n + 1) / 2);
  assert.equal(divRoundHalfUp(n - 1, 2), (n - 1) / 2);
  // 2^53 - 1 = 3 * 3002399751580331; check the remainder path against BigInt
  for (const d of [3, 7, 3600, 10000, 999983]) {
    const big = BigInt(n);
    const D = BigInt(d);
    const expect = Number((2n * big + D) / (2n * D));
    assert.equal(divRoundHalfUp(n, d), expect, `d=${d}`);
  }
});

test("divRoundHalfUp agrees with BigInt half-up on random large inputs", () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 20000; i++) {
    const n = Math.floor(rand() * Number.MAX_SAFE_INTEGER);
    const d = 1 + Math.floor(rand() * (i % 2 ? 10_000 : 2 ** 31));
    const expect = Number((2n * BigInt(n) + BigInt(d)) / (2n * BigInt(d)));
    assert.equal(divRoundHalfUp(n, d), expect, `${n}/${d}`);
  }
});

test("divRoundHalfUp refuses bad input", () => {
  assert.throws(() => divRoundHalfUp(-1, 2), RangeError);
  assert.throws(() => divRoundHalfUp(1.5, 2), RangeError);
  assert.throws(() => divRoundHalfUp(1, 0), RangeError);
  assert.throws(() => divRoundHalfUp(1, -2), RangeError);
  assert.throws(() => divRoundHalfUp(2 ** 53, 2), RangeError);
});

test("marginOn applies basis points, rounding once half-up", () => {
  assert.equal(marginOn(480_000, 3000), 144_000); // $0.48/h at 30% -> $0.144
  assert.equal(marginOn(5, 1000), 1); // 0.5 -> 1
  assert.equal(marginOn(4, 1000), 0); // 0.4 -> 0
  assert.equal(marginOn(15, 1000), 2); // 1.5 -> 2
  assert.equal(marginOn(1_000_000, 0), 0);
  assert.equal(marginOn(1_000_000, 10_000), 1_000_000);
  assert.equal(marginOn(0, 3000), 0);
  assert.throws(() => marginOn(-1, 3000), RangeError);
  assert.throws(() => marginOn(1, -1), RangeError);
  assert.throws(() => marginOn(1, 1_000_001), RangeError);
  assert.throws(() => marginOn(1, 0.5), RangeError);
  assert.throws(() => marginOn(2 ** 50, 10_000), RangeError);
});

test("priceSplit keeps the parts and their sum", () => {
  assert.deepEqual(priceSplit(480_000, 3000), { providerCost: 480_000, margin: 144_000, total: 624_000 });
  assert.deepEqual(priceSplit(7, 5000), { providerCost: 7, margin: 4, total: 11 }); // 3.5 -> 4
});

test("costForSeconds prorates an hourly rate, half-up to the micro", () => {
  assert.equal(costForSeconds(3_600_000, 60), 60_000); // $3.60/h for a minute = 6 cents
  assert.equal(costForSeconds(3_600_000, 3600), 3_600_000);
  assert.equal(costForSeconds(1, 1800), 1); // 0.5 -> 1
  assert.equal(costForSeconds(1, 1799), 0);
  assert.equal(costForSeconds(480_000, 60), 8_000);
  assert.equal(costForSeconds(500_000, 7), 972); // 972.2
  assert.equal(costForSeconds(500_000, 25), 3472); // 3472.2
  assert.equal(costForSeconds(100, 18), 1); // exactly 0.5
  assert.equal(costForSeconds(0, 60), 0);
  assert.equal(costForSeconds(123, 0), 0);
  assert.throws(() => costForSeconds(-1, 60), RangeError);
  assert.throws(() => costForSeconds(1, -60), RangeError);
  assert.throws(() => costForSeconds(1, 0.5), RangeError);
});

test("entrySplit rounds the provider cost first, then the margin on it", () => {
  // 7 micros/h for 1800 s = 3.5 -> 4 provider; 30% of 4 = 1.2 -> 1
  assert.deepEqual(entrySplit(7, 1800, 3000), { providerCost: 4, margin: 1, total: 5 });
  // the margin on the unrounded cost (3.5 * 0.3 = 1.05) would also give 1, so check one that differs:
  // 5 micros/h for 1800 s = 2.5 -> 3 provider; 50% of 3 = 1.5 -> 2 (unrounded: 1.25 -> 1)
  assert.deepEqual(entrySplit(5, 1800, 5000), { providerCost: 3, margin: 2, total: 5 });
  assert.deepEqual(entrySplit(480_000, 60, 3000), { providerCost: 8_000, margin: 2_400, total: 10_400 });
});

test("addSplits sums part by part", () => {
  assert.deepEqual(addSplits(), { providerCost: 0, margin: 0, total: 0 });
  assert.deepEqual(addSplits(priceSplit(10, 5000), priceSplit(20, 1000)), { providerCost: 30, margin: 7, total: 37 });
});

test("checked arithmetic refuses results past the safe range", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  assert.equal(checkedAdd(MAX - 1, 1), MAX);
  assert.throws(() => checkedAdd(MAX, 1), RangeError);
  assert.throws(() => checkedAdd(-MAX, -1), RangeError);
  assert.throws(() => checkedAdd(NaN, 1), RangeError);
  assert.throws(() => checkedAdd(1, 0.5), RangeError);
  assert.equal(checkedMul(2 ** 26, 2 ** 26), 2 ** 52);
  assert.throws(() => checkedMul(2 ** 27, 2 ** 26), RangeError);
  assert.throws(() => checkedMul(Infinity, 0), RangeError);
  assert.equal(checkedMul(-3, 4), -12);
  // addSplits: MAX + 2 used to lose precision silently
  assert.throws(() => addSplits({ providerCost: MAX, margin: 0, total: MAX }, { providerCost: 2, margin: 0, total: 2 }), RangeError);
  assert.throws(() => addSplits({ providerCost: MAX - 1, margin: 0, total: MAX - 1 }, { providerCost: 0, margin: 2, total: 2 }), RangeError);
  assert.throws(() => addSplits({ providerCost: 1, margin: 1, total: 3 }), RangeError);
  assert.throws(() => addSplits({ providerCost: NaN, margin: 0, total: NaN }), RangeError);
  assert.deepEqual(addSplits({ providerCost: MAX - 1, margin: 0, total: MAX - 1 }, { providerCost: 1, margin: 0, total: 1 }), { providerCost: MAX, margin: 0, total: MAX });
  assert.equal(isPriceSplit({ providerCost: MAX, margin: 1, total: MAX + 1 }), false);
  // priceSplit's total is checked too
  assert.throws(() => priceSplit(MAX, 10_000), RangeError);
});

test("validators", () => {
  assert.equal(isMicros(0), true);
  assert.equal(isMicros(-5), true);
  assert.equal(isMicros(1.5), false);
  assert.equal(isMicros("1"), false);
  assert.equal(isMicros(2 ** 53), false);
  assert.equal(isNonNegativeMicros(0), true);
  assert.equal(isNonNegativeMicros(-1), false);
  assert.equal(isBasisPoints(0), true);
  assert.equal(isBasisPoints(1_000_000), true);
  assert.equal(isBasisPoints(1_000_001), false);
  assert.equal(isBasisPoints(-1), false);
  assert.equal(isPriceSplit({ providerCost: 1, margin: 2, total: 3 }), true);
  assert.equal(isPriceSplit({ providerCost: 1, margin: 2, total: 4 }), false);
  assert.equal(isPriceSplit({ providerCost: 1.5, margin: 1.5, total: 3 }), false);
  assert.equal(isPriceSplit({ providerCost: 1, margin: 2 }), false);
  assert.equal(isPriceSplit(null), false);
});

test("formatUsd", () => {
  assert.equal(formatUsd(620_000), "$0.62");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(5_000), "$0.01"); // half a cent rounds up
  assert.equal(formatUsd(4_999), "$0.00");
  assert.equal(formatUsd(12_345_678_900), "$12345.68");
  assert.equal(formatUsd(-1_500_000), "-$1.50");
  assert.equal(formatUsd(-4_999), "$0.00"); // no "-$0.00"
  assert.equal(formatUsd(100_000_000), "$100.00");
  assert.throws(() => formatUsd(0.5), RangeError);
});
