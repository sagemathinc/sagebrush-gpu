// The Worker runtime contract for exact provider money (Codex audit G02-3): parseProviderJson depends on
// JSON.parse's reviver context.source, and without it every provider reply fails closed and no machine can
// launch. So it runs here inside the pinned workerd (Miniflare, at the repo's compatibility date), on a
// fractional price, integers, exponent spellings and the boundary tokens, and must give exactly what Node gives
// and what the rule says. A runtime without the source text fails here, not in production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startWorker, type StartedWorker } from "@sbgpu/testing/worker";
import { readTokens } from "./money-workerd-entry.ts";

const NAN = "RangeError: not a USD amount: NaN";
const TABLE: readonly (readonly [string, number | string])[] = [
  ["0.69", 690_000],
  ["4.39", 4_390_000],
  ["0.1234565", 123_457],
  ["1.4999995", 1_500_000],
  ["0", 0],
  ["12", 12_000_000],
  ["1.0", 1_000_000],
  ["5e-7", 1],
  ["2.5E-6", 3],
  ["9007199254.74099", 9_007_199_254_740_990],
  ["9007199254.741", "RangeError: USD amount too large: 9007199254.741"],
  // tokens a double can't hold: NaN, which no price accepts
  ["0.00000049999999999999999", NAN],
  ["0.1234564999999999999999", NAN],
  ["12345678901234567890", NAN],
];
let w: StartedWorker;

before(async () => {
  w = await startWorker({ entry: "packages/control/src/money-workerd-entry.ts" });
});
after(async () => w?.dispose());

test("G02-3 on workerd: the reviver gets each number's source text, and provider prices read exactly as on Node", async () => {
  const tokens = TABLE.map(([t]) => t);
  const res = await w.mf.dispatchFetch("https://test.invalid/", { method: "POST", body: JSON.stringify(tokens) });
  const got = (await res.json()) as { sources: unknown[]; results: (number | string)[] };
  assert.deepEqual(got.sources, tokens, "context.source is each token's own text");
  assert.deepEqual(got.results, TABLE.map(([, want]) => want));
  assert.deepEqual(got.results, readTokens(tokens), "the same as on Node");
});
