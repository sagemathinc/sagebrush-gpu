import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateWordsFixture } from "./gate-words.ts";

test("the shared gate-words fixture is exactly what @sbgpu/api's list generates", () => {
  const file = readFileSync(new URL("../fixtures/vm-gate-words.json", import.meta.url), "utf8");
  assert.equal(file, gateWordsFixture(), "stale: run node packages/machine/scripts/gen-gate-words.ts");
  const words = JSON.parse(file) as string[];
  assert.equal(words.length, 22);
  assert.deepEqual(words, [...new Set(words)].sort());
});
