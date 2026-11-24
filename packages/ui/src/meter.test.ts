import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMeter, formatDuration } from "./meter.ts";

test("computeMeter subtracts spent and the reserve", () => {
  assert.deepEqual(
    computeMeter({ allocation: 10_000_000, spent: 2_000_000, reserved: 1_000_000, ratePerHour: 3_500_000 }),
    { remaining: 7_000_000, fractionLeft: 0.7, band: "ok", secondsLeft: 7200 },
  );
});

test("computeMeter floors time left", () => {
  const m = computeMeter({ allocation: 1000, spent: 0, reserved: 0, ratePerHour: 7 });
  assert.equal(m.secondsLeft, 514_285);
});

test("computeMeter: overspent is empty, never negative", () => {
  const m = computeMeter({ allocation: 100, spent: 90, reserved: 20, ratePerHour: 10 });
  assert.equal(m.remaining, 0);
  assert.equal(m.fractionLeft, 0);
  assert.equal(m.band, "empty");
  assert.equal(m.secondsLeft, 0);
});

test("computeMeter: nothing running means no time left estimate", () => {
  assert.equal(computeMeter({ allocation: 100, spent: 0, reserved: 0, ratePerHour: 0 }).secondsLeft, null);
});

test("computeMeter: zero allocation", () => {
  const m = computeMeter({ allocation: 0, spent: 0, reserved: 0, ratePerHour: 0 });
  assert.equal(m.fractionLeft, 0);
  assert.equal(m.band, "empty");
});

test("computeMeter: a refund never shows more than 100%", () => {
  const m = computeMeter({ allocation: 100, spent: -10, reserved: 0, ratePerHour: 0 });
  assert.equal(m.remaining, 110);
  assert.equal(m.fractionLeft, 1);
});

test("computeMeter band boundaries", () => {
  const band = (remaining: number) =>
    computeMeter({ allocation: 100, spent: 100 - remaining, reserved: 0, ratePerHour: 0 }).band;
  assert.equal(band(100), "ok");
  assert.equal(band(20), "ok");
  assert.equal(band(19), "low");
  assert.equal(band(5), "low");
  assert.equal(band(4), "critical");
  assert.equal(band(1), "critical");
  assert.equal(band(0), "empty");
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "under 1 min");
  assert.equal(formatDuration(59), "under 1 min");
  assert.equal(formatDuration(Number.NaN), "under 1 min");
  assert.equal(formatDuration(60), "1 min");
  assert.equal(formatDuration(119), "1 min");
  assert.equal(formatDuration(3599), "59 min");
  assert.equal(formatDuration(3600), "1 h");
  assert.equal(formatDuration(3660), "1 h 1 min");
  assert.equal(formatDuration(12_000), "3 h 20 min");
  assert.equal(formatDuration(86_399), "23 h 59 min");
  assert.equal(formatDuration(86_400), "1 d");
  assert.equal(formatDuration(86_400 + 4 * 3600 + 59 * 60), "1 d 4 h");
  assert.equal(formatDuration(3 * 86_400 + 3600), "3 d 1 h");
});
