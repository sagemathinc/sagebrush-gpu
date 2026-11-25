import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "./errors.ts";
import { PRESET_COUNTRIES } from "./locality.ts";
import { priceSplit, DEFAULT_POLICY } from "@sbgpu/api";

const EUROPE = PRESET_COUNTRIES.europe;
import {
  backoffMs,
  launchWithFallback,
  PlacementError,
  placementPolicy,
  providerCapForTotal,
  rankOffers,
  terminateAndConfirm,
  type FallbackOptions,
  type PlacementPolicy,
} from "./placement.ts";
import type { LaunchSpec, Offer, ProviderAdapter, ProviderId, ProviderMachineStatus } from "./types.ts";

function offer(o: Partial<Offer>): Offer {
  return {
    provider: "runpod",
    gpuType: "L4",
    gpuCount: 1,
    dataCenter: "EU-SE-1",
    country: "SE",
    providerCostPerHour: 690_000,
    stock: "high",
    observedAt: "2026-11-24T12:00:00.000Z",
    ...o,
  };
}

const policy: PlacementPolicy = {
  allowedGpuTypes: ["L4", "RTX-A6000"],
  allowedProviders: ["runpod", "hyperstack"],
  locality: EUROPE,
  maxProviderCostPerHour: 1_000_000,
};
const req = { gpuType: "L4", gpuCount: 1 };

test("rankOffers keeps only offers the policy and request allow", () => {
  const ok = offer({ dataCenter: "OK" });
  const offers = [
    ok,
    offer({ dataCenter: "wrong-type", gpuType: "RTX-A6000" }),
    offer({ dataCenter: "wrong-count", gpuCount: 2 }),
    offer({ dataCenter: "provider", provider: "nebius" }),
    offer({ dataCenter: "us", country: "US" }),
    offer({ dataCenter: "too-dear", providerCostPerHour: 1_000_001 }),
    offer({ dataCenter: "at-cap", providerCostPerHour: 1_000_000 }),
    offer({ dataCenter: "no-stock", stock: "none" }),
    offer({ dataCenter: "low-stock", stock: "low" }),
  ];
  assert.deepEqual(
    rankOffers(offers, policy, req).map((o) => o.dataCenter),
    ["OK", "low-stock", "at-cap"],
  );
});

test("rankOffers returns nothing for a GPU type the policy doesn't allow", () => {
  assert.deepEqual(rankOffers([offer({ gpuType: "H100-80GB-SXM" })], policy, { gpuType: "H100-80GB-SXM", gpuCount: 1 }), []);
});

test("rankOffers with locality any keeps every country", () => {
  const r = rankOffers([offer({ country: "US" }), offer({ country: "JP" })], { ...policy, locality: "any" }, req);
  assert.equal(r.length, 2);
});

test("providerCapForTotal is the largest provider cost whose total fits", () => {
  for (const bps of [0, 1, 2500, 3000, 3333, 10_000]) {
    for (const total of [0, 1, 2, 3, 99, 100, 129, 130, 131, 899_999, 900_000, 1_000_000, 2_000_000, 12_345_678]) {
      const p = providerCapForTotal(total, bps);
      assert.ok(priceSplit(p, bps).total <= total, `${bps} ${total} ${p}`);
      assert.ok(priceSplit(p + 1, bps).total > total, `${bps} ${total} ${p}+1`);
    }
  }
  assert.equal(providerCapForTotal(1_300_000, 3000), 1_000_000);
  assert.equal(providerCapForTotal(1_300_000, 0), 1_300_000);
  assert.throws(() => providerCapForTotal(-1, 3000), RangeError);
  assert.throws(() => providerCapForTotal(1.5, 3000), RangeError);
  assert.throws(() => providerCapForTotal(2 ** 53, 3000), RangeError);
  for (const bps of [-1, 1.5, Number.NaN, 1_000_001]) assert.throws(() => providerCapForTotal(100, bps), RangeError, String(bps));
});

/** priceSplit's total in BigInt, as an independent oracle at the safe-integer edges. */
function oracleTotal(p: bigint, bps: bigint): bigint {
  const n = p * bps;
  const q = n / 10_000n;
  return p + (2n * (n - q * 10_000n) >= 10_000n ? q + 1n : q);
}

test("providerCapForTotal is exact at the safe-integer edges", () => {
  const max = Number.MAX_SAFE_INTEGER;
  for (const bps of [0, 1, 3000, 9999, 10_000, 1_000_000]) {
    for (const total of [max, max - 1, max - 3, 9007199254740988, 2 ** 52, 2 ** 52 + 1, 1e15 + 7]) {
      const p = BigInt(providerCapForTotal(total, bps));
      const t = BigInt(total);
      const b = BigInt(bps);
      assert.ok(oracleTotal(p, b) <= t, `${bps} ${total} ${p}`);
      assert.ok(oracleTotal(p + 1n, b) > t, `${bps} ${total} ${p}+1`);
    }
  }
  assert.equal(providerCapForTotal(9007199254740988, 0), 9007199254740988);
  assert.equal(providerCapForTotal(max, 0), max);
});

test("placementPolicy reads the project policy", () => {
  const p = placementPolicy(
    { ...DEFAULT_POLICY, allowedGpuTypes: ["L4"], allowedProviders: ["runpod"], locality: "europe", allowedCountries: ["SE", "US"], maxPricePerHour: 1_300_000 },
    3000,
  );
  assert.deepEqual(p, { allowedGpuTypes: ["L4"], allowedProviders: ["runpod"], locality: ["SE"], maxProviderCostPerHour: 1_000_000 });
});

test("rankOffers orders by price, then stock, then provider and data center", () => {
  const offers = [
    offer({ dataCenter: "D", providerCostPerHour: 700_000 }),
    offer({ dataCenter: "C", providerCostPerHour: 600_000, stock: "unknown" }),
    offer({ dataCenter: "B", providerCostPerHour: 600_000, stock: "low" }),
    offer({ dataCenter: "A", providerCostPerHour: 600_000, stock: "medium" }),
    offer({ dataCenter: "Z", providerCostPerHour: 600_000, stock: "high" }),
    offer({ dataCenter: "Y", providerCostPerHour: 600_000, stock: "high" }),
    offer({ dataCenter: "ZZ", providerCostPerHour: 600_000, stock: "high", provider: "hyperstack" }),
    offer({ dataCenter: "E", providerCostPerHour: 500_000, stock: "low" }),
  ];
  assert.deepEqual(
    rankOffers(offers, policy, req).map((o) => o.dataCenter),
    ["E", "ZZ", "Y", "Z", "A", "B", "C", "D"],
  );
});

function fakeStatus(id: string, state: ProviderMachineStatus["state"] = "provisioning"): ProviderMachineStatus {
  return {
    provider: "runpod", providerMachineId: id, machineId: "mch_a", state, rawStatus: state.toUpperCase(),
    gpuType: "L4", gpuCount: 1, dataCenter: null, image: "img", diskGb: 40, volumeGb: 0, envNames: [],
    exposedPorts: [], unexpectedSettings: [], command: [], providerCostPerHour: 690_000, observedAt: "",
  };
}

type Step = ProviderError | Error | "ok";

interface Script {
  /** Launch replies, per data center, in order. */
  launch: Record<string, Step[]>;
  /** Terminate failure per machine id (default: success). */
  terminate?: Record<string, Error>;
  /** Status replies per machine id, in order (default: terminated). */
  status?: Record<string, Array<ProviderMachineStatus["state"] | Error>>;
  /** Fields that override every status reply for a machine id. */
  statusAs?: Record<string, Partial<ProviderMachineStatus>>;
}

/** A scripted adapter; every call is appended to `log`. */
function scripted(provider: ProviderId, script: Script, log: string[]): ProviderAdapter {
  return {
    info: { provider, selfIdentity: null, bootDelivery: { kind: "env", name: "T" } },
    listOffers: async () => [],
    listMachines: async () => [],
    terminate: async (id) => {
      log.push(`terminate:${id}`);
      const e = script.terminate?.[id];
      if (e) throw e;
    },
    status: async (id) => {
      log.push(`status:${id}`);
      const next = script.status?.[id]?.shift() ?? "terminated";
      if (next instanceof Error) throw next;
      return { ...fakeStatus(id, next), ...script.statusAs?.[id] };
    },
    launch: async (spec: LaunchSpec) => {
      log.push(`launch:${spec.dataCenter}:${spec.bootToken}`);
      const next = script.launch[spec.dataCenter]?.shift();
      if (next === undefined) throw new Error(`unexpected launch in ${spec.dataCenter}`);
      if (next === "ok") return { providerMachineId: `pod-${spec.dataCenter}`, status: fakeStatus(`pod-${spec.dataCenter}`) };
      throw next;
    },
  };
}

const err = (kind: ProviderError["kind"], retryAfter: number | null = null, machine: string | null = null) =>
  new ProviderError("runpod", kind, kind, null, retryAfter, machine);

/** launchWithFallback with test defaults: fresh tokens t1, t2, ...; revocations and sleeps logged. */
function run(
  dcs: string[],
  script: Script,
  extra: Partial<FallbackOptions> = {},
  offers: Offer[] = dcs.map((dc) => offer({ dataCenter: dc })),
) {
  const log: string[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const promise = launchWithFallback({
    offers,
    adapters: { runpod: scripted("runpod", script, log) },
    spec: (o) => ({
      machineId: "mch_a", gpuType: o.gpuType, gpuCount: o.gpuCount, dataCenter: o.dataCenter, image: "img",
      diskGb: 40, bootToken: `t${++n}`, launcher: ["/bin/sh"], maxProviderCostPerHour: 1_000_000,
    }),
    revokeBootToken: async (spec) => { log.push(`revoke:${spec.bootToken}`); },
    sleep: async (ms) => { sleeps.push(ms); },
    ...extra,
  });
  return { promise, log, sleeps };
}

const placementError = (kind: string, attempts?: number) => (e: unknown) =>
  e instanceof PlacementError && e.kind === kind && (attempts === undefined || e.attempts.length === attempts);

test("launchWithFallback moves on after capacity refusals, revoking each failed call's token", async () => {
  const { promise, log, sleeps } = run(["A", "B", "C", "D"], {
    launch: { A: [err("no_capacity")], B: [err("unplaceable")], C: [err("forbidden")], D: ["ok"] },
  });
  const placed = await promise;
  assert.equal(placed.offer.dataCenter, "D");
  assert.equal(placed.result.providerMachineId, "pod-D");
  assert.deepEqual(log, ["launch:A:t1", "revoke:t1", "launch:B:t2", "revoke:t2", "launch:C:t3", "revoke:t3", "launch:D:t4"]);
  assert.deepEqual(placed.attempts.map((a) => a.outcome), ["no_capacity", "unplaceable", "forbidden", "launched"]);
  assert.deepEqual(sleeps, []);
});

test("a pod above the price cap is revoked, terminated and confirmed gone before the next offer", async () => {
  const { promise, log, sleeps } = run(["A", "B"], {
    launch: { A: [err("price_above_cap", null, "podA")], B: ["ok"] },
    status: { podA: ["running", "stopping", "terminated"] },
  });
  assert.equal((await promise).offer.dataCenter, "B");
  assert.deepEqual(log, [
    "launch:A:t1", "revoke:t1", "terminate:podA", "status:podA", "status:podA", "status:podA", "launch:B:t2",
  ]);
  assert.deepEqual(sleeps, [3000, 3000]);
});

test("a pod that doesn't match the spec is cleaned up, then the search stops", async () => {
  const { promise, log } = run(["A", "B"], { launch: { A: [err("spec_mismatch", null, "podA")], B: ["ok"] } });
  await assert.rejects(promise, placementError("spec_mismatch", 1));
  assert.deepEqual(log, ["launch:A:t1", "revoke:t1", "terminate:podA", "status:podA"]);
});

const cleanupFailures: Array<[string, Script["terminate"], Script["status"]]> = [
  ["DELETE 503", { podA: err("transient") }, undefined],
  ["DELETE 429", { podA: err("rate_limited", 5) }, undefined],
  ["DELETE network failure", { podA: err("outcome_unknown") }, undefined],
  ["a status read that fails", undefined, { podA: [new Error("boom")] }],
  ["a pod that never reports terminated", undefined, { podA: Array(10).fill("stopping") }],
];

for (const [what, terminate, status] of cleanupFailures) {
  test(`cleanup with ${what} stops the search: no second launch`, async () => {
    const script: Script = { launch: { A: [err("price_above_cap", null, "podA")], B: ["ok"] } };
    if (terminate) script.terminate = terminate;
    if (status) script.status = status;
    const { promise, log } = run(["A", "B"], script);
    await assert.rejects(promise, placementError("outcome_unknown", 1));
    assert.equal(log.filter((l) => l.startsWith("launch:")).length, 1);
    assert.deepEqual(log.slice(0, 3), ["launch:A:t1", "revoke:t1", "terminate:podA"]);
  });
}

for (const [what, as] of [
  ["another machine id", { providerMachineId: "unrelated-pod" }],
  ["another provider", { provider: "hyperstack" }],
] as const) {
  test(`a termination confirmed for ${what} confirms nothing: the search stops`, async () => {
    const { promise, log } = run(["A", "B"], {
      launch: { A: [err("price_above_cap", null, "podA")], B: ["ok"] },
      statusAs: { podA: as },
    });
    await assert.rejects(promise, placementError("outcome_unknown", 1));
    assert.equal(log.filter((l) => l.startsWith("launch:")).length, 1);
  });
}

test("cleanup confirmation is bounded by confirmPolls", async () => {
  const { promise, log, sleeps } = run(
    ["A"],
    { launch: { A: [err("price_above_cap", null, "podA")] }, status: { podA: ["stopping", "stopping", "terminated"] } },
    { confirmPolls: 2, confirmIntervalMs: 5 },
  );
  await assert.rejects(promise, placementError("outcome_unknown"));
  assert.equal(log.filter((l) => l === "status:podA").length, 2);
  assert.deepEqual(sleeps, [5]);
});

test("a failed revocation stops the search before any cleanup or next launch", async () => {
  const log: string[] = [];
  const { promise } = run(["A", "B"], { launch: { A: [err("price_above_cap", null, "podA")], B: ["ok"] } }, {
    revokeBootToken: async (spec) => { log.push(`revoke:${spec.bootToken}`); throw new Error("D1 down"); },
  });
  await assert.rejects(promise, placementError("outcome_unknown", 1));
  assert.deepEqual(log, ["revoke:t1"]);
});

test("a non-provider error is revoked, then passed through unchanged", async () => {
  const boom = new TypeError("bug");
  const { promise, log } = run(["A"], { launch: { A: [boom] } });
  await assert.rejects(promise, (e: unknown) => e === boom);
  assert.deepEqual(log, ["launch:A:t1", "revoke:t1"]);
});

test("launchWithFallback retries the same offer after rate limits and transient errors, with backoff and fresh tokens", async () => {
  const { promise, log, sleeps } = run(["A", "B"], { launch: { A: [err("rate_limited", 7), err("transient"), "ok"] } });
  assert.equal((await promise).offer.dataCenter, "A");
  assert.deepEqual(log, ["launch:A:t1", "revoke:t1", "launch:A:t2", "revoke:t2", "launch:A:t3"]);
  assert.deepEqual(sleeps, [7000, 2000]);
});

test("launchWithFallback gives up on an offer after maxRetriesPerOffer retries, then tries the next", async () => {
  const { promise, log } = run(["A", "B"], { launch: { A: [err("transient"), err("transient"), err("transient")], B: ["ok"] } }, { maxRetriesPerOffer: 2 });
  assert.equal((await promise).offer.dataCenter, "B");
  assert.equal(log.filter((l) => l.startsWith("launch:A")).length, 3);
});

test("maxRetriesPerOffer 0 never retries", async () => {
  const { promise, log } = run(["A", "B"], { launch: { A: [err("transient")], B: ["ok"] } }, { maxRetriesPerOffer: 0 });
  assert.equal((await promise).offer.dataCenter, "B");
  assert.deepEqual(log.filter((l) => l.startsWith("launch:")), ["launch:A:t1", "launch:B:t2"]);
});

for (const kind of ["outcome_unknown", "auth", "insufficient_funds", "invalid_request", "unknown"] as const) {
  test(`launchWithFallback stops at ${kind}`, async () => {
    const { promise, log } = run(["A", "B"], { launch: { A: [err(kind)], B: ["ok"] } });
    await assert.rejects(promise, placementError(kind, 1));
    assert.deepEqual(log, ["launch:A:t1", "revoke:t1"]);
  });
}

test("launchWithFallback caps the total number of launch calls", async () => {
  const dcs = ["A", "B", "C", "D"];
  const launch: Script["launch"] = {};
  for (const dc of dcs) launch[dc] = [err("no_capacity")];
  const { promise, log } = run(dcs, { launch }, { maxAttempts: 3 });
  await assert.rejects(promise, placementError("no_capacity"));
  assert.equal(log.filter((l) => l.startsWith("launch:")).length, 3);
  const one = run(dcs, { launch: { A: [err("no_capacity")], B: ["ok"] } }, { maxAttempts: 1 });
  await assert.rejects(one.promise, placementError("no_capacity"));
  assert.equal(one.log.filter((l) => l.startsWith("launch:")).length, 1);
});

for (const [name, value] of [
  ["maxAttempts", 0], ["maxAttempts", -1], ["maxAttempts", 1.5], ["maxAttempts", Number.NaN],
  ["maxAttempts", Number.POSITIVE_INFINITY], ["maxAttempts", 21], ["maxAttempts", 2 ** 53],
  ["maxRetriesPerOffer", -1], ["maxRetriesPerOffer", 0.5], ["maxRetriesPerOffer", Number.NaN],
  ["maxRetriesPerOffer", Number.POSITIVE_INFINITY], ["maxRetriesPerOffer", 21],
  ["confirmPolls", 0], ["confirmPolls", Number.NaN], ["confirmPolls", 21],
  ["confirmIntervalMs", -1], ["confirmIntervalMs", 1.5], ["confirmIntervalMs", Number.NaN], ["confirmIntervalMs", 60_001],
] as const) {
  test(`launchWithFallback rejects ${name} = ${value} before any effect`, async () => {
    const { promise, log, sleeps } = run(["A"], { launch: { A: ["ok"] } }, { [name]: value });
    await assert.rejects(promise, RangeError);
    assert.deepEqual(log, []);
    assert.deepEqual(sleeps, []);
  });
}

test("launchWithFallback accepts the bounds' edges", async () => {
  for (const extra of [
    { maxAttempts: 1 }, { maxAttempts: 20 }, { maxRetriesPerOffer: 0 }, { maxRetriesPerOffer: 20 },
    { confirmPolls: 1 }, { confirmPolls: 20 }, { confirmIntervalMs: 0 }, { confirmIntervalMs: 60_000 },
  ]) {
    assert.equal((await run(["A"], { launch: { A: ["ok"] } }, extra).promise).offer.dataCenter, "A", JSON.stringify(extra));
  }
});

test("launchWithFallback reports the last refusal when every offer refuses", async () => {
  const { promise } = run(["A", "B"], { launch: { A: [err("no_capacity")], B: [err("unplaceable")] } });
  await assert.rejects(promise, placementError("unplaceable", 2));
});

test("launchWithFallback skips offers of providers without an adapter, and reports no offers", async () => {
  const offers = [offer({ provider: "nebius", dataCenter: "N" }), offer({ dataCenter: "A" })];
  const placed = await run([], { launch: { A: ["ok"] } }, {}, offers).promise;
  assert.equal(placed.offer.dataCenter, "A");
  assert.equal(placed.attempts[0]!.outcome, "no_adapter");
  await assert.rejects(run([], { launch: {} }, {}, []).promise, placementError("no_offers"));
  await assert.rejects(run([], { launch: {} }, {}, [offer({ provider: "nebius" })]).promise, placementError("no_offers"));
});

test("terminateAndConfirm", async () => {
  const log: string[] = [];
  const a = scripted("runpod", { launch: {}, status: { p: ["running", "terminated"] } }, log);
  assert.equal(await terminateAndConfirm(a, "p", async () => {}, 3, 1), true);
  assert.deepEqual(log, ["terminate:p", "status:p", "status:p"]);
  const b = scripted("runpod", { launch: {}, status: { p: ["running", "running"] } }, []);
  assert.equal(await terminateAndConfirm(b, "p", async () => {}, 2, 1), false);
  const c = scripted("runpod", { launch: {}, terminate: { p: new Error("x") } }, []);
  assert.equal(await terminateAndConfirm(c, "p", async () => {}, 3, 1), false);
  const edges = scripted("runpod", { launch: {} }, []);
  assert.equal(await terminateAndConfirm(edges, "p", async () => {}, 1, 0), true);
  assert.equal(await terminateAndConfirm(edges, "p", async () => {}, 20, 60_000), true);
});

for (const [polls, interval] of [
  [0, 1], [-1, 1], [1.5, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], [21, 1],
  [1, -1], [1, 1.5], [1, Number.NaN], [1, Number.POSITIVE_INFINITY], [1, 60_001],
] as const) {
  test(`terminateAndConfirm rejects polls=${polls} intervalMs=${interval} before any effect`, async () => {
    const log: string[] = [];
    const sleeps: number[] = [];
    const a = scripted("runpod", { launch: {} }, log);
    await assert.rejects(terminateAndConfirm(a, "p", async (ms) => { sleeps.push(ms); }, polls, interval), RangeError);
    assert.deepEqual(log, []);
    assert.deepEqual(sleeps, []);
  });
}

test("backoffMs", () => {
  assert.equal(backoffMs(0, null), 1000);
  assert.equal(backoffMs(1, null), 2000);
  assert.equal(backoffMs(3, null), 8000);
  assert.equal(backoffMs(10, null), 30_000);
  assert.equal(backoffMs(0, 5), 5000);
  assert.equal(backoffMs(0, 0), 0);
  assert.equal(backoffMs(0, 31), 30_000);
  for (const [retry, after] of [[-1, null], [0.5, null], [Number.NaN, null], [0, -1], [0, Number.NaN], [0, Number.POSITIVE_INFINITY]] as const) {
    assert.throws(() => backoffMs(retry, after), RangeError, `${retry} ${after}`);
  }
});
