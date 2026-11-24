import { test } from "node:test";
import assert from "node:assert/strict";
import { isIsoTime, minuteStart, toIso } from "./time.ts";

test("isIsoTime accepts only Date.toISOString's spelling", () => {
  assert.equal(isIsoTime("2027-02-01T09:00:00.000Z"), true);
  assert.equal(isIsoTime("2028-02-29T23:59:59.999Z"), true);
  assert.equal(isIsoTime("2027-02-29T00:00:00.000Z"), false); // not a leap year
  assert.equal(isIsoTime("2027-02-30T00:00:00.000Z"), false);
  assert.equal(isIsoTime("2027-02-01T09:00:00Z"), false);
  assert.equal(isIsoTime("2027-02-01T09:00:00.000+00:00"), false);
  assert.equal(isIsoTime("2027-02-01 09:00:00.000Z"), false);
  assert.equal(isIsoTime("2027-02-01T24:00:00.000Z"), false);
  assert.equal(isIsoTime("x2027-02-01T09:00:00.000Z"), false);
  assert.equal(isIsoTime(0), false);
});

test("toIso and minuteStart", () => {
  const t = Date.UTC(2027, 1, 1, 9, 30, 45, 123);
  assert.equal(toIso(t), "2027-02-01T09:30:45.123Z");
  assert.equal(toIso(minuteStart(t)), "2027-02-01T09:30:00.000Z");
  assert.equal(minuteStart(Date.UTC(2027, 1, 1, 9, 30)), Date.UTC(2027, 1, 1, 9, 30));
  assert.equal(minuteStart(Date.UTC(2027, 1, 1, 9, 30) - 1), Date.UTC(2027, 1, 1, 9, 29));
});
