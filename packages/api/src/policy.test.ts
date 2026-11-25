import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY } from "./objects.ts";
import { MAX_LABEL_LENGTH, MAX_POLICY_LIST, MAX_SETUP_SCRIPT_LENGTH, POLICY_BOUNDS, mergePolicy, validateLabels, validatePolicyPatch } from "./policy.ts";

const ok = (x: unknown) => validatePolicyPatch(x).ok;
const why = (x: unknown) => {
  const r = validatePolicyPatch(x);
  return r.ok ? "ok" : r.reason;
};

test("the default policy is a valid patch, and so is an empty one", () => {
  assert.equal(why({ ...DEFAULT_POLICY }), "ok");
  assert.equal(why({}), "ok");
});

test("the bounds are the documented ones", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(POLICY_BOUNDS)), {
    maxPricePerHour: [0, 1_000_000_000],
    maxConcurrentMachines: [0, 1000],
    maxMachinesPerMember: [0, 16],
    idleStopMinutes: [5, 1440],
    maxSessionMinutes: [15, 10080],
    minStartMinutes: [1, 1440],
    finalSaveReserveMinutes: [0, 1440],
    storageQuotaBytesPerMember: [0, 1024 ** 4],
    storageQuotaBytesPerTeam: [0, 1024 ** 4],
  });
});

test("numeric fields: whole numbers within their bounds", () => {
  for (const [k, [lo, hi]] of Object.entries(POLICY_BOUNDS)) {
    assert.equal(ok({ [k]: lo }), true, `${k} at ${lo}`);
    assert.equal(ok({ [k]: hi }), true, `${k} at ${hi}`);
    assert.equal(ok({ [k]: lo - 1 }), false, `${k} at ${lo - 1}`);
    assert.equal(ok({ [k]: hi + 1 }), false, `${k} at ${hi + 1}`);
    assert.equal(ok({ [k]: lo + 0.5 }), false, `${k} fraction`);
    assert.equal(ok({ [k]: String(lo) }), false, `${k} string`);
    assert.equal(ok({ [k]: null }), false, `${k} null`);
  }
  // the default sits within every bound
  for (const [k, [lo, hi]] of Object.entries(POLICY_BOUNDS)) {
    const v = (DEFAULT_POLICY as unknown as Record<string, number>)[k]!;
    assert.ok(v >= lo && v <= hi, k);
  }
});

test("lists: distinct, known, bounded", () => {
  assert.equal(why({ allowedGpuTypes: ["L4", "A100-80GB"] }), "ok");
  assert.equal(ok({ allowedGpuTypes: ["L4", "L4"] }), false);
  assert.equal(ok({ allowedGpuTypes: ["l4"] }), false);
  assert.equal(ok({ allowedGpuTypes: "L4" }), false);
  assert.equal(ok({ allowedGpuTypes: Array.from({ length: MAX_POLICY_LIST }, (_, i) => `G${i}`) }), true);
  assert.equal(ok({ allowedGpuTypes: Array.from({ length: MAX_POLICY_LIST + 1 }, (_, i) => `G${i}`) }), false);
  assert.equal(why({ allowedProviders: ["runpod", "nebius"] }), "ok");
  assert.equal(ok({ allowedProviders: ["runpod", "runpod"] }), false);
  assert.equal(ok({ allowedProviders: ["gcp"] }), false);
  assert.equal(ok({ allowedProviders: ["runpod", "shadeform", "hyperstack", "nebius"] }), true);
  // "vast" is a known provider (a mock-only adapter); allowing it launches nothing until it's wired
  // and the database accepts it (control's vast-unwired test)
  assert.equal(ok({ allowedProviders: ["runpod", "shadeform", "hyperstack", "nebius", "vast"] }), true);
  assert.equal(ok({ allowedProviders: ["vast", "vast"] }), false);
  assert.equal(why({ allowedCountries: null }), "ok");
  assert.equal(why({ allowedCountries: ["GB", "SE"] }), "ok");
  assert.equal(ok({ allowedCountries: ["gb"] }), false);
  assert.equal(ok({ allowedCountries: ["GBR"] }), false);
  assert.equal(ok({ allowedCountries: ["GB", "GB"] }), false);
  assert.equal(ok({ allowedCountries: [] }), true);
  assert.equal(ok({ allowedCountries: Array.from({ length: MAX_POLICY_LIST + 1 }, (_, i) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26))) }), false);
});

test("locality, setup script, and unknown fields", () => {
  assert.equal(why({ locality: "europe" }), "ok");
  assert.equal(ok({ locality: "mars" }), false);
  assert.equal(ok({ locality: 1 }), false);
  assert.equal(why({ setupScript: null }), "ok");
  assert.equal(why({ setupScript: "x".repeat(MAX_SETUP_SCRIPT_LENGTH) }), "ok");
  assert.equal(ok({ setupScript: "x".repeat(MAX_SETUP_SCRIPT_LENGTH + 1) }), false);
  assert.equal(ok({ setupScript: 5 }), false);
  assert.match(why({ maxGpus: 3 }), /unknown policy field/);
  for (const x of [null, [], "x", 5, new Date(), Object.create({ idleStopMinutes: 1 })]) assert.equal(ok(x), false);
});

test("mergePolicy lays a patch over a base", () => {
  const p = mergePolicy(DEFAULT_POLICY, { idleStopMinutes: 60, allowedGpuTypes: ["L4"] });
  assert.equal(p.idleStopMinutes, 60);
  assert.deepEqual(p.allowedGpuTypes, ["L4"]);
  assert.equal(p.maxSessionMinutes, DEFAULT_POLICY.maxSessionMinutes);
});

test("labels: null, or exactly the five words", () => {
  const good = { project: "Course", member: "Student", manager: "Instructor", assistant: "TA", team: "Group" };
  assert.deepEqual(validateLabels(null), { ok: true, value: null });
  assert.equal(validateLabels(good).ok, true);
  assert.equal(validateLabels({ ...good, member: "x".repeat(MAX_LABEL_LENGTH) }).ok, true);
  for (const bad of [
    { ...good, member: "x".repeat(MAX_LABEL_LENGTH + 1) },
    { ...good, member: "" },
    { ...good, member: " Student" },
    { ...good, member: 5 },
    { ...good, extra: "x" },
    (({ team: _t, ...rest }) => rest)(good),
    { ...(({ team: _t, ...rest }) => rest)(good), group: "Group" }, // five keys, one of them wrong
    Object.assign(Object.create({ x: 1 }), good),
    [],
    "Course",
  ]) {
    assert.equal(validateLabels(bad).ok, false, JSON.stringify(bad));
  }
});
