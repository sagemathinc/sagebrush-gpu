import { test } from "node:test";
import assert from "node:assert/strict";
import type { Offer, OfferQuery, PlacementPolicy, ProviderId } from "@sbgpu/providers";
import { listPlacement, type OfferLister } from "./placement.ts";
import { PROVIDER_CALL_DEADLINE_MS } from "./vm.ts";

function offer(o: Partial<Offer>): Offer {
  return { provider: "runpod", gpuType: "L4", gpuCount: 1, dataCenter: "EU-SE-1", country: "SE", providerCostPerHour: 500_000, stock: "high", observedAt: "2026-11-26T12:00:00.000Z", ...o };
}

const policy: PlacementPolicy = { allowedGpuTypes: ["L4", "RTX-A6000"], allowedProviders: ["runpod", "hyperstack"], locality: "any", maxProviderCostPerHour: 1_000_000 };

/** A lister answering with `offers` (or throwing, or never answering), recording each query. */
function lister(answer: Offer[] | "throws" | "hangs" | "late" | unknown, calls: OfferQuery[] = []): OfferLister {
  return {
    async listOffers(q) {
      calls.push(q);
      if (answer === "throws") throw new Error("down");
      if (answer === "hangs") return new Promise<Offer[]>(() => {});
      if (answer === "late") return new Promise<Offer[]>((r) => setTimeout(() => r([offer({ dataCenter: "late" })]), PROVIDER_CALL_DEADLINE_MS + 200));
      return answer as Offer[];
    },
  };
}

test("listPlacement: allowed providers with a launch path only, each asked once for the count; ranked; one stamp after the reads", async () => {
  const runpodCalls: OfferQuery[] = [];
  const vastCalls: OfferQuery[] = [];
  let t = 1000;
  const p = await listPlacement(
    {
      listers: {
        runpod: lister([offer({ dataCenter: "b", providerCostPerHour: 600_000 }), offer({ dataCenter: "a", gpuType: "RTX-A6000", providerCostPerHour: 400_000 }), offer({ dataCenter: "dear", providerCostPerHour: 2_000_000 })], runpodCalls),
        vast: lister([offer({ provider: "vast", providerCostPerHour: 1 })], vastCalls), // (has a lister, but the policy doesn't allow it)
      },
      clock: () => (t += 1),
    },
    policy,
    1,
    null,
  );
  assert.deepEqual([runpodCalls, vastCalls], [[{ gpuCount: 1 }], []]);
  assert.deepEqual(p.offers.map((x) => x.offer.dataCenter), ["a", "b"]);
  assert.deepEqual(p.offers.map((x) => x.listedAtMs), [1001, 1001]);
  assert.deepEqual(p.unavailableProviders, [], "hyperstack is allowed but has no launch path: not listed, not unavailable");
});

test("listPlacement: a GPU type given ranks that type only; none, every allowed type", async () => {
  const listers = { runpod: lister([offer({ dataCenter: "l4" }), offer({ dataCenter: "a6000", gpuType: "RTX-A6000", providerCostPerHour: 100 })]) };
  const one = await listPlacement({ listers, clock: () => 0 }, policy, 1, "L4");
  assert.deepEqual(one.offers.map((x) => x.offer.dataCenter), ["l4"]);
  const all = await listPlacement({ listers, clock: () => 0 }, policy, 1, null);
  assert.deepEqual(all.offers.map((x) => x.offer.dataCenter), ["a6000", "l4"]);
});

test("listPlacement: a provider that throws, never answers, answers late or answers nonsense is unavailable; the others' offers stand; a late answer changes nothing", async () => {
  for (const bad of ["throws", "hangs", "late", null, { pods: [] }] as const) {
    const p = await listPlacement(
      { listers: { runpod: lister([offer({ dataCenter: "ok" })]), hyperstack: lister(bad) }, clock: () => 7 },
      policy,
      1,
      null,
    );
    assert.deepEqual([p.offers.map((x) => x.offer.dataCenter), p.unavailableProviders], [["ok"], ["hyperstack"]], String(bad));
    if (bad === "late") {
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(p.offers.map((x) => x.offer.dataCenter), ["ok"], "the late list was never added");
    }
  }
});

test("listPlacement: offers a provider returns for another provider are dropped; unavailable providers come in a fixed order", async () => {
  const p = await listPlacement(
    { listers: { runpod: lister([offer({ provider: "hyperstack" as ProviderId, dataCenter: "spoofed", providerCostPerHour: 1 }), offer({ dataCenter: "own" })]) }, clock: () => 0 },
    policy,
    1,
    null,
  );
  assert.deepEqual(p.offers.map((x) => x.offer.dataCenter), ["own"]);
  const both = await listPlacement(
    { listers: { runpod: lister("throws"), hyperstack: lister("throws") }, clock: () => 0 },
    { ...policy, allowedProviders: ["runpod", "hyperstack", "runpod"] },
    1,
    null,
  );
  assert.deepEqual([both.offers, both.unavailableProviders], [[], ["hyperstack", "runpod"]]);
});

test("listPlacement: the requested GPU count is what each provider is asked for, and what is ranked", async () => {
  const calls: OfferQuery[] = [];
  const echo: OfferLister = {
    async listOffers(q) {
      calls.push(q);
      return [offer({ gpuCount: q.gpuCount })];
    },
  };
  const p = await listPlacement({ listers: { runpod: echo }, clock: () => 0 }, policy, 2, null);
  assert.deepEqual(calls, [{ gpuCount: 2 }]);
  assert.deepEqual(p.offers.map((x) => x.offer.gpuCount), [2]);
});

test("listPlacement: every provider is asked before any answers, and the stamp is the clock after the last answer", async () => {
  let now = 100;
  const started: string[] = [];
  const release: Record<string, (v: Offer[]) => void> = {};
  const deferred = (p: ProviderId): OfferLister => ({
    listOffers() {
      started.push(p);
      return new Promise<Offer[]>((r) => (release[p] = r));
    },
  });
  const pending = listPlacement({ listers: { runpod: deferred("runpod"), hyperstack: deferred("hyperstack") }, clock: () => now }, policy, 1, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started.sort(), ["hyperstack", "runpod"], "both asked before either answered");
  now = 500;
  release.runpod!([offer({ dataCenter: "a" })]);
  await new Promise((r) => setImmediate(r));
  now = 700;
  release.hyperstack!([offer({ provider: "hyperstack", dataCenter: "b" })]);
  const p = await pending;
  // (equal price: hyperstack ranks before runpod)
  assert.deepEqual(p.offers.map((x) => [x.offer.dataCenter, x.listedAtMs]), [["b", 700], ["a", 700]]);
});
