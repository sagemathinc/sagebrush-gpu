import { test } from "node:test";
import assert from "node:assert/strict";

import { FINAL_SAVE_MAX_SECONDS, finalSaveReserveSeconds } from "./reserve.ts";

test("the reserve is 60 s plus the upload time at 20 MB/s, rounded up", () => {
  assert.equal(finalSaveReserveSeconds(0), 60);
  assert.equal(finalSaveReserveSeconds(1), 61);
  assert.equal(finalSaveReserveSeconds(20_000_000), 61);
  assert.equal(finalSaveReserveSeconds(20_000_001), 62);
  assert.equal(finalSaveReserveSeconds(200_000_000), 70); // a LoRA checkpoint or two
  assert.equal(finalSaveReserveSeconds(10e9), 560);
});

test("the reserve is capped at an hour", () => {
  const atCap = (FINAL_SAVE_MAX_SECONDS - 60) * 20_000_000;
  assert.equal(finalSaveReserveSeconds(atCap), 3600);
  assert.equal(finalSaveReserveSeconds(atCap - 20_000_000), 3599);
  assert.equal(finalSaveReserveSeconds(atCap + 1), 3600);
  assert.equal(finalSaveReserveSeconds(1e18), 3600);
});

test("an untrusted figure that isn't a non-negative finite number gets the maximum", () => {
  for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "5" as unknown as number, null as unknown as number]) {
    assert.equal(finalSaveReserveSeconds(bad), 3600, String(bad));
  }
});
