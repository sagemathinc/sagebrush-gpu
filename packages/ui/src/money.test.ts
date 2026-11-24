import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPriceSplit, formatRate, formatUsd, parseUsd, priceText, splitDecimals } from "./money.ts";

test("formatUsd formats and groups", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(1_234_560_000), "$1,234.56");
  assert.equal(formatUsd(1_000_000_000_000), "$1,000,000.00");
  assert.equal(formatUsd(999_000_000), "$999.00");
  assert.equal(formatUsd(70_000), "$0.07");
});

test("formatUsd rounds half away from zero, with carry", () => {
  assert.equal(formatUsd(5_000), "$0.01");
  assert.equal(formatUsd(4_999), "$0.00");
  assert.equal(formatUsd(-5_000), "-$0.01");
  assert.equal(formatUsd(-4_999), "$0.00"); // never "-$0.00"
  assert.equal(formatUsd(999_995_000), "$1,000.00");
  assert.equal(formatUsd(500_000, 0), "$1");
  assert.equal(formatUsd(499_999, 0), "$0");
  assert.equal(formatUsd(1, 6), "$0.000001");
  assert.equal(formatUsd(1_234_567, 3), "$1.235");
});

test("formatUsd rejects non-integers and bad decimals", () => {
  assert.throws(() => formatUsd(1.5), RangeError);
  assert.throws(() => formatUsd(Number.NaN), RangeError);
  assert.throws(() => formatUsd(2 ** 53), RangeError);
  assert.throws(() => formatUsd(1, 7), RangeError);
  assert.throws(() => formatUsd(1, -1), RangeError);
  assert.throws(() => formatUsd(1, 1.5), RangeError);
  assert.equal(formatUsd(1, 0), "$0");
});

test("formatRate shows sub-cent prices with 4 decimals", () => {
  assert.equal(formatRate(480_000), "$0.48/h");
  assert.equal(formatRate(0), "$0.00/h");
  assert.equal(formatRate(10_000), "$0.01/h");
  assert.equal(formatRate(9_999), "$0.0100/h");
  assert.equal(formatRate(5_000), "$0.0050/h");
  assert.equal(formatRate(-5_000), "-$0.0050/h");
  assert.throws(() => formatRate(0.5), RangeError);
});

test("formatPriceSplit shows provider, service and total", () => {
  assert.equal(
    formatPriceSplit(480_000, 140_000),
    "provider $0.48/h + service $0.14/h = $0.62/h",
  );
});

test("parseUsd accepts plain amounts exactly", () => {
  assert.equal(parseUsd("12"), 12_000_000);
  assert.equal(parseUsd("$1,234.5"), 1_234_500_000);
  assert.equal(parseUsd("1,234,567"), 1_234_567_000_000);
  assert.equal(parseUsd("0.000001"), 1);
  assert.equal(parseUsd(" 3.25 "), 3_250_000);
  assert.equal(parseUsd("0.1"), 100_000);
  assert.equal(parseUsd("0"), 0);
});

test("parseUsd rejects everything else", () => {
  for (const bad of [
    "", "$", "-1", "1.", ".5", "1.1234567", "1,23", "12,3456", "1,2345",
    "1e3", "abc", "1 000", "$-1", "1.2.3", "9007199254740991",
  ]) {
    assert.equal(parseUsd(bad), null, bad);
  }
});

test("price splits are rounded alike so the parts add up", () => {
  assert.equal(splitDecimals(480_000, 144_000), 2);
  assert.equal(splitDecimals(125_000, 125_000), 3); // $0.13 + $0.13 != $0.25
  assert.equal(formatPriceSplit(125_000, 125_000), "provider $0.125/h + service $0.125/h = $0.250/h");
  assert.equal(splitDecimals(5_000, 1_500), 4);
  assert.equal(splitDecimals(1, 1), 6);
  assert.equal(splitDecimals(0, 0), 2);
  assert.equal(splitDecimals(4_995, 4_995), 4); // sub-cent parts start at 4 places
  assert.equal(splitDecimals(125_500, 125_500), 4); // .126 + .126 != .251
  assert.equal(splitDecimals(1_234_567, 370_371), 2);
  assert.equal(splitDecimals(10_000, 40), 5); // $0.0000 would hide the margin
  assert.equal(splitDecimals(-480_000, 144_000), 2); // refunds round symmetrically: -0.48 + 0.14 = -0.34
  assert.equal(splitDecimals(-125_000, -125_000), 3);
  assert.equal(splitDecimals(-480_000, 0), 2);
  assert.deepEqual(priceText(480_000, 144_000), { total: "$0.62/h", parts: "provider $0.48 + service $0.14" });
  assert.deepEqual(priceText(1_890_000, 567_000), { total: "$2.46/h", parts: "provider $1.89 + service $0.57" });
  assert.deepEqual(priceText(125_000, 125_000), { total: "$0.250/h", parts: "provider $0.125 + service $0.125" });
  assert.throws(() => splitDecimals(0.5, 1), RangeError);
});
