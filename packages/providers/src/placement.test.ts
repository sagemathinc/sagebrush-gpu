import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "./errors.ts";
import { PRESET_COUNTRIES } from "./locality.ts";
import { priceSplit, DEFAULT_POLICY } from "@sbgpu/api";

const EUROPE = PRESET_COUNTRIES["eu-uk"];
import {
  backoffMs,
  launchWithFallback,
  PlacementError,
  placementPolicy,
  providerCapForTotal,
  rankOffers,
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
});

test("placementPolicy reads the project policy", () => {
  const p = placementPolicy(
    { ...DEFAULT_POLICY, allowedGpuTypes: ["L4"], allowedProviders: ["runpod"], locality: "eu-uk", allowedCountries: ["SE", "US"], maxPricePerHour: 1_300_000 },
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

function fakeStatus(id: string): ProviderMachineStatus {
  return {
    provider: "runpod", providerMachineId: id, machineId: "mch_a", state: "provisioning", rawStatus: "PROVISIONING",
    gpuType: "L4", gpuCount: 1, dataCenter: null, image: "img", diskGb: 40, volumeGb: 0, envNames: [],
    exposedPorts: [], command: [], providerCostPerHour: 690_000, observedAt: "",
  };
}

/** An adapter whose launch answers from a script, one entry per call, keyed by data center. */
function scripted(provider: ProviderId, script: Record<string, Array<ProviderError | "ok">>, calls: string[]): ProviderAdapter {
  return {
    info: { provider, selfIdentity: null, bootTokenEnv: "T" },
    listOffers: async () => [],
    status: async (id) => fakeStatus(id),
    terminate: async () => {},
    listMachines: async () => [],
    launch: async (spec: LaunchSpec) => {
      calls.push(`${provider}:${spec.dataCenter}`);
      const next = script[spec.dataCenter]?.shift();
      if (next === undefined) throw new Error(`unexpected launch in ${spec.dataCenter}`);
      if (next === "ok") return { providerMachineId: `pod-${spec.dataCenter}`, status: fakeStatus(`pod-${spec.dataCenter}`) };
      throw next;
    },
  };
}

const err = (kind: ProviderError["kind"], retryAfter: number | null = null) =>
  new ProviderError("runpod", kind, kind, null, retryAfter);

function specFor(o: Offer): LaunchSpec {
  return {
    machineId: "mch_a", gpuType: o.gpuType, gpuCount: o.gpuCount, dataCenter: o.dataCenter, image: "img",
    diskGb: 40, bootToken: "t", launcher: ["/bin/sh"], maxProviderCostPerHour: 1_000_000,
  };
}

test("launchWithFallback moves on after capacity refusals", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const adapter = scripted("runpod", { A: [err("no_capacity")], B: [err("unplaceable")], C: [err("forbidden")], D: [err("price_above_cap")], E: ["ok"] }, calls);
  const placed = await launchWithFallback({
    offers: ["A", "B", "C", "D", "E"].map((dc) => offer({ dataCenter: dc })),
    adapters: { runpod: adapter },
    spec: specFor,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(placed.offer.dataCenter, "E");
  assert.equal(placed.result.providerMachineId, "pod-E");
  assert.deepEqual(calls, ["runpod:A", "runpod:B", "runpod:C", "runpod:D", "runpod:E"]);
  assert.deepEqual(placed.attempts.map((a) => a.outcome), ["no_capacity", "unplaceable", "forbidden", "price_above_cap", "launched"]);
  assert.deepEqual(sleeps, []);
});

test("launchWithFallback retries the same offer after rate limits and transient errors, with backoff", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const adapter = scripted("runpod", { A: [err("rate_limited", 7), err("transient"), "ok"] }, calls);
  const placed = await launchWithFallback({
    offers: [offer({ dataCenter: "A" }), offer({ dataCenter: "B" })],
    adapters: { runpod: adapter },
    spec: specFor,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(placed.offer.dataCenter, "A");
  assert.deepEqual(calls, ["runpod:A", "runpod:A", "runpod:A"]);
  assert.deepEqual(sleeps, [7000, 2000]);
});

test("launchWithFallback gives up on an offer after maxRetriesPerOffer retries, then tries the next", async () => {
  const calls: string[] = [];
  const adapter = scripted("runpod", { A: [err("transient"), err("transient"), err("transient")], B: ["ok"] }, calls);
  const placed = await launchWithFallback({
    offers: [offer({ dataCenter: "A" }), offer({ dataCenter: "B" })],
    adapters: { runpod: adapter },
    spec: specFor,
    sleep: async () => {},
    maxRetriesPerOffer: 2,
  });
  assert.equal(placed.offer.dataCenter, "B");
  assert.deepEqual(calls, ["runpod:A", "runpod:A", "runpod:A", "runpod:B"]);
});

for (const kind of ["outcome_unknown", "auth", "insufficient_funds", "invalid_request", "unknown"] as const) {
  test(`launchWithFallback stops at ${kind}`, async () => {
    const calls: string[] = [];
    const adapter = scripted("runpod", { A: [err(kind)], B: ["ok"] }, calls);
    await assert.rejects(
      launchWithFallback({ offers: [offer({ dataCenter: "A" }), offer({ dataCenter: "B" })], adapters: { runpod: adapter }, spec: specFor, sleep: async () => {} }),
      (e: unknown) => e instanceof PlacementError && e.kind === kind && e.attempts.length === 1,
    );
    assert.deepEqual(calls, ["runpod:A"]);
  });
}

test("launchWithFallback caps the total number of launch calls", async () => {
  const calls: string[] = [];
  const script: Record<string, Array<ProviderError | "ok">> = {};
  const dcs = ["A", "B", "C", "D"];
  for (const dc of dcs) script[dc] = [err("no_capacity")];
  await assert.rejects(
    launchWithFallback({ offers: dcs.map((dc) => offer({ dataCenter: dc })), adapters: { runpod: scripted("runpod", script, calls) }, spec: specFor, sleep: async () => {}, maxAttempts: 3 }),
    (e: unknown) => e instanceof PlacementError && e.kind === "no_capacity",
  );
  assert.deepEqual(calls, ["runpod:A", "runpod:B", "runpod:C"]);
});

test("launchWithFallback reports the last refusal when every offer refuses", async () => {
  const calls: string[] = [];
  const adapter = scripted("runpod", { A: [err("no_capacity")], B: [err("unplaceable")] }, calls);
  await assert.rejects(
    launchWithFallback({ offers: [offer({ dataCenter: "A" }), offer({ dataCenter: "B" })], adapters: { runpod: adapter }, spec: specFor, sleep: async () => {} }),
    (e: unknown) => e instanceof PlacementError && e.kind === "unplaceable" && e.attempts.length === 2,
  );
});

test("launchWithFallback skips offers of providers without an adapter, and reports no offers", async () => {
  const calls: string[] = [];
  const placed = await launchWithFallback({
    offers: [offer({ provider: "nebius", dataCenter: "N" }), offer({ dataCenter: "A" })],
    adapters: { runpod: scripted("runpod", { A: ["ok"] }, calls) },
    spec: specFor,
    sleep: async () => {},
  });
  assert.equal(placed.offer.dataCenter, "A");
  assert.equal(placed.attempts[0]!.outcome, "no_adapter");
  await assert.rejects(
    launchWithFallback({ offers: [], adapters: {}, spec: specFor, sleep: async () => {} }),
    (e: unknown) => e instanceof PlacementError && e.kind === "no_offers",
  );
  await assert.rejects(
    launchWithFallback({ offers: [offer({ provider: "nebius" })], adapters: {}, spec: specFor, sleep: async () => {} }),
    (e: unknown) => e instanceof PlacementError && e.kind === "no_offers",
  );
});

test("launchWithFallback lets non-provider errors through unchanged", async () => {
  const boom = new TypeError("bug");
  const adapter = scripted("runpod", { A: [] }, []);
  adapter.launch = async () => { throw boom; };
  await assert.rejects(
    launchWithFallback({ offers: [offer({ dataCenter: "A" })], adapters: { runpod: adapter }, spec: specFor, sleep: async () => {} }),
    (e: unknown) => e === boom,
  );
});

test("backoffMs", () => {
  assert.equal(backoffMs(0, null), 1000);
  assert.equal(backoffMs(1, null), 2000);
  assert.equal(backoffMs(3, null), 8000);
  assert.equal(backoffMs(10, null), 30_000);
  assert.equal(backoffMs(0, 5), 5000);
  assert.equal(backoffMs(0, 0), 0);
  assert.equal(backoffMs(0, 31), 30_000);
});
