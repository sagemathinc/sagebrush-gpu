import assert from "node:assert/strict";
import { test } from "node:test";
import { launchErrorAction, ProviderError } from "./errors.ts";
import { retryAfterSeconds } from "./http.ts";
import { countryAllowed, localityFor, PRESET_COUNTRIES } from "./locality.ts";
import { parseProviderJson, usdToMicros } from "./money.ts";
import { GPU_TYPES, isGpuType } from "./gpus.ts";

test("usdToMicros rounds to the nearest micro", () => {
  assert.equal(usdToMicros(0.69), 690_000);
  assert.equal(usdToMicros(0.29), 290_000); // 0.29 * 1e6 is 290000.00000000006 in floats
  assert.equal(usdToMicros(4.39), 4_390_000);
  assert.equal(usdToMicros(0), 0);
  assert.equal(usdToMicros(0.0000004), 0);
  assert.equal(usdToMicros(0.0000005), 1);
  assert.equal(usdToMicros(0.0000015), 2);
});

test("usdToMicros refuses what isn't a USD amount", () => {
  for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, 1e10, "1" as unknown as number]) {
    assert.throws(() => usdToMicros(bad), RangeError, String(bad));
  }
  assert.equal(usdToMicros(9e9), 9e15);
});

const EUROPE = PRESET_COUNTRIES.europe;
const EU_ONLY = PRESET_COUNTRIES.eu;

test("locality presets", () => {
  assert.equal(EU_ONLY.length, 27);
  assert.equal(new Set(EU_ONLY).size, 27);
  assert.equal(EUROPE.length, 31);
  assert.equal(new Set(EUROPE).size, 31);
  for (const c of ["SE", "RO", "IS", "NO", "GB", "LI"]) assert.ok(countryAllowed(EUROPE, c), c);
  for (const c of ["IS", "NO", "GB", "CH", "US"]) assert.ok(!countryAllowed(EU_ONLY, c), c);
  assert.ok(countryAllowed(EU_ONLY, "SE"));
  assert.ok(!countryAllowed(EUROPE, "US"));
  assert.ok(!countryAllowed(EUROPE, "CH"));
  assert.ok(!countryAllowed(EUROPE, null));
  assert.ok(!countryAllowed([], "SE"));
  assert.ok(countryAllowed("any", null));
  assert.ok(countryAllowed("any", "US"));
  assert.deepEqual(PRESET_COUNTRIES.uk, ["GB"]);
  assert.deepEqual(PRESET_COUNTRIES.us, ["US"]);
  assert.deepEqual(PRESET_COUNTRIES.ca, ["CA"]);
});

test("localityFor narrows a preset by the extra country list", () => {
  assert.equal(localityFor("any", null), "any");
  assert.deepEqual(localityFor("any", ["SE"]), ["SE"]);
  assert.deepEqual(localityFor("europe", null), EUROPE);
  assert.deepEqual(localityFor("europe", ["GB", "US", "SE"]), ["SE", "GB"]);
  assert.deepEqual(localityFor("eu", ["GB"]), []);
  assert.deepEqual(localityFor("uk", []), []);
});

test("launch error actions", () => {
  assert.equal(launchErrorAction("no_capacity"), "next");
  assert.equal(launchErrorAction("unplaceable"), "next");
  assert.equal(launchErrorAction("forbidden"), "next");
  assert.equal(launchErrorAction("price_above_cap"), "next");
  assert.equal(launchErrorAction("rate_limited"), "retry");
  assert.equal(launchErrorAction("transient"), "retry");
  for (const k of ["invalid_request", "insufficient_funds", "auth", "not_found", "outcome_unknown", "unknown"] as const) {
    assert.equal(launchErrorAction(k), "stop", k);
  }
  const e = new ProviderError("runpod", "rate_limited", "slow down", 429, 12);
  assert.equal(e.kind, "rate_limited");
  assert.equal(e.httpStatus, 429);
  assert.equal(e.retryAfterSeconds, 12);
  assert.equal(e.provider, "runpod");
  assert.ok(e instanceof Error);
});

test("retryAfterSeconds reads only the delta-seconds form", () => {
  assert.equal(retryAfterSeconds("12"), 12);
  assert.equal(retryAfterSeconds(" 0 "), 0);
  assert.equal(retryAfterSeconds(null), null);
  assert.equal(retryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT"), null);
  assert.equal(retryAfterSeconds("-1"), null);
  assert.equal(retryAfterSeconds("1.5"), null);
});

test("GPU types are unique", () => {
  assert.equal(new Set(GPU_TYPES.map((g) => g.id)).size, GPU_TYPES.length);
  assert.ok(isGpuType("L4"));
  assert.ok(!isGpuType("l4"));
});

test("G02-3: a provider's price is its exact decimal value, rounded once, half up", () => {
  // the exact half rounds up, and one digit either side of it rounds that way
  assert.equal(usdToMicros(0.0000015), 2);
  assert.equal(usdToMicros(0.1234565), 123457);
  assert.equal(usdToMicros(0.1234564), 123456);
  assert.equal(usdToMicros(2.5e-6), 3, "exponent spelling");
  assert.equal(usdToMicros(1.4999995), 1500000, "1499999.5 micros: the half rounds up");
  assert.equal(usdToMicros(1.4999994), 1499999);
  assert.equal(usdToMicros(3002399751.58033), 3002399751580330);
  // (doubles near $9e9 are about 2 micros apart: these two are exactly representable, either side of 2^53 - 1 micros)
  assert.equal(usdToMicros(9007199254.74099), 9007199254740990);
  assert.throws(() => usdToMicros(9007199254.741), /too large/);
});

test("G02-3: parseProviderJson keeps a number only if its double is exactly the token; otherwise NaN, which no price accepts", () => {
  const v = (token: string) => (parseProviderJson(`{"v":${token}}`) as { v: number }).v;
  for (const [token, micros] of [["0.69", 690_000], ["0.29", 290_000], ["4.39", 4_390_000], ["5e-7", 1], ["5E-7", 1], ["0.1234565", 123457], ["1.0", 1_000_000], ["0", 0], ["12", 12_000_000]] as const) {
    assert.equal(usdToMicros(v(token)), micros, token);
  }
  // the audit's two tokens: a double can't hold them, and the float path rounded each a micro high
  for (const token of ["0.00000049999999999999999", "0.1234564999999999999999"]) {
    assert.ok(Number.isNaN(v(token)), token);
    assert.throws(() => usdToMicros(v(token)), /not a USD amount/, token);
  }
  // other numbers pass through unchanged, and the structure is kept
  assert.deepEqual(parseProviderJson('{"a":[1,2,{"b":-3}],"c":"0.1234564999999999999999","d":true,"e":null}'), { a: [1, 2, { b: -3 }], c: "0.1234564999999999999999", d: true, e: null });
  assert.ok(Number.isNaN((parseProviderJson("[12345678901234567890]") as number[])[0]!), "an integer past what a double holds");
  assert.throws(() => parseProviderJson("{"), SyntaxError);
});

