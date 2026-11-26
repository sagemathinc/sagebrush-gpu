// The mock's paused providers: an organization on its own keys (byok) whose key for a provider
// is rejected, revoked or failing has its launches there paused. Offers there are dropped,
// a quote or start with none left refuses "credentialUnusable" naming the provider, and the
// price list says so, with the reason for manager and above only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_STATUS, type ProviderId } from "@sbgpu/api";
import { ApiError, createClient, type Client } from "../client.ts";
import { mockFetch } from "./fetch.ts";
import { seedDemo } from "./seed.ts";

const MIN = 60_000;

function world(billingMode: "byok" | "resold" = "byok") {
  const demo = seedDemo({ billingMode });
  const b = demo.backend;
  const client = createClient({ fetch: mockFetch(b) });
  for (const provider of ["runpod", "hyperstack", "nebius"] as const) {
    b.credentials.set(`${demo.orgId}|${provider}`, { fingerprint: "0badf00d", setBy: demo.emails.owner, setAt: b.now(), lastCheckedAt: b.now(), status: "ok" });
  }
  const as = (email: string): Client => {
    assert.ok(b.signInAs(email), email);
    return client;
  };
  const p = { projectId: demo.projectId };
  const pauses = async (email: string) => (await as(email).call("listGpuTypes", { params: p })).paused;
  const quote = (gpuType: string) => as(demo.emails.member).call("quote", { params: p, body: { gpuType } });
  return { ...demo, b, as, p, pauses, quote };
}

async function rejectsPaused(promise: Promise<unknown>, provider: ProviderId): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ApiError, String(err));
    assert.deepEqual([err.code, err.status, err.provider], ["credentialUnusable", ERROR_STATUS.credentialUnusable, provider]);
    return true;
  });
}

test("a pausing key status pauses the provider; the reason goes to manager and above only", async () => {
  const w = world();
  assert.deepEqual(await w.pauses(w.emails.member), []);
  w.b.advance(MIN);
  w.b.setKeyStatus(w.orgId, "runpod", "revoked");
  const at = new Date(w.b.now()).toISOString();
  w.b.advance(2 * MIN);
  assert.deepEqual(await w.pauses(w.emails.member), [{ provider: "runpod", since: at }]);
  assert.deepEqual(await w.pauses(w.emails.assistant), [{ provider: "runpod", since: at }]);
  for (const email of [w.emails.manager, w.emails.owner]) {
    assert.deepEqual(await w.pauses(email), [{ provider: "runpod", since: at, detail: { status: "revoked", lastCheckedAt: at } }], email);
  }
});

test("a pause keeps its start while the status stays pausing, ends at ok, and starts afresh after", async () => {
  const w = world();
  w.b.setKeyStatus(w.orgId, "runpod", "rejected");
  const first = new Date(w.b.now()).toISOString();
  w.b.advance(5 * MIN);
  w.b.setKeyStatus(w.orgId, "runpod", "error");
  const checked = new Date(w.b.now()).toISOString();
  assert.deepEqual(await w.pauses(w.emails.manager), [{ provider: "runpod", since: first, detail: { status: "error", lastCheckedAt: checked } }]);
  w.b.setKeyStatus(w.orgId, "runpod", "unchecked");
  assert.deepEqual(await w.pauses(w.emails.manager), [], "unchecked doesn't pause");
  w.b.setKeyStatus(w.orgId, "runpod", "ok");
  assert.deepEqual(await w.pauses(w.emails.manager), []);
  w.b.advance(MIN);
  w.b.setKeyStatus(w.orgId, "runpod", "revoked");
  assert.equal((await w.pauses(w.emails.member))[0]?.since, new Date(w.b.now()).toISOString());
  assert.throws(() => w.b.setKeyStatus(w.orgId, "vast", "revoked"), /no vast key/);
});

test("only the project's own providers are listed, in provider order; a resold organization never pauses", async () => {
  const w = world();
  w.b.setKeyStatus(w.orgId, "nebius", "revoked"); // not one of the project's providers
  w.b.setKeyStatus(w.orgId, "hyperstack", "revoked");
  w.b.setKeyStatus(w.orgId, "runpod", "revoked");
  assert.deepEqual((await w.pauses(w.emails.member)).map((x) => x.provider), ["runpod", "hyperstack"]);
  const r = world("resold");
  r.b.setKeyStatus(r.orgId, "runpod", "revoked");
  assert.deepEqual(await r.pauses(r.emails.member), []);
  const l4 = await r.quote("L4"); // (A100 is over the resold price limit)
  assert.deepEqual([l4.canStart, l4.offers[0]?.provider], [true, "runpod"]);
});

test("quotes drop the paused provider's offers; with none left, credentialUnusable names it, after priceCap and before noCapacity", async () => {
  const w = world();
  w.b.setKeyStatus(w.orgId, "runpod", "revoked");
  const l4 = await w.quote("L4");
  assert.equal(l4.canStart, true);
  assert.deepEqual(l4.offers.map((o) => o.provider), ["hyperstack"]);
  const a100 = await w.quote("A100-80GB"); // RunPod only
  assert.deepEqual([a100.canStart, a100.reason, a100.reasonProvider, a100.offers], [false, "credentialUnusable", "runpod", []]);
  const a10 = await w.quote("A10"); // RunPod only, and out of stock: the pause comes first
  assert.deepEqual([a10.reason, a10.reasonProvider], ["credentialUnusable", "runpod"]);
  const a6000 = await w.quote("A6000"); // RunPod paused; Hyperstack's offer is out of stock
  assert.deepEqual([a6000.reason, a6000.reasonProvider, a6000.offers.map((o) => o.provider)], ["noCapacity", undefined, ["hyperstack"]]);
  // Both of L4's providers paused: the first in provider order is named.
  w.b.setKeyStatus(w.orgId, "hyperstack", "error");
  assert.deepEqual([(await w.quote("L4")).reason, (await w.quote("L4")).reasonProvider], ["credentialUnusable", "runpod"]);
  // Over the price limit comes first.
  w.b.projects.get(w.projectId)!.policy.maxPricePerHour = 100_000;
  const dear = await w.quote("L4");
  assert.deepEqual([dear.reason, dear.reasonProvider], ["priceCap", undefined]);
  assert.equal(dear.offers.length, 0, "no paused provider's offer, even over the limit");
});

test("the price list prices a type without the paused provider's offers", async () => {
  const w = world();
  const before = (await w.as(w.emails.member).call("listGpuTypes", { params: w.p })).items.find((i) => i.gpuType === "L4");
  w.b.setKeyStatus(w.orgId, "runpod", "revoked");
  const after = (await w.as(w.emails.member).call("listGpuTypes", { params: w.p })).items;
  assert.equal(before?.pricePerHour?.providerCost, 480_000);
  assert.equal(after.find((i) => i.gpuType === "L4")?.pricePerHour?.providerCost, 550_000);
  assert.equal(after.find((i) => i.gpuType === "A100-80GB")?.pricePerHour, null);
});

test("a start or restart with no offer left is refused credentialUnusable, naming the provider", async () => {
  const w = world();
  const c = w.as(w.emails.member);
  const m = await c.call("startMachine", { params: w.p, body: { gpuType: "A100-80GB" } });
  w.b.advance(3 * MIN);
  await c.call("stopMachine", { params: { machineId: m.id }, body: {} });
  w.b.advance(10 * MIN);
  assert.equal((await c.call("getMachine", { params: { machineId: m.id } })).state, "stopped");
  w.b.setKeyStatus(w.orgId, "runpod", "revoked");
  await rejectsPaused(c.call("startMachine", { params: w.p, body: { gpuType: "A100-80GB" } }), "runpod");
  await rejectsPaused(c.call("restartMachine", { params: { machineId: m.id }, body: {} }), "runpod");
  // Other refusals carry no provider.
  await assert.rejects(c.call("startMachine", { params: w.p, body: { gpuType: "A6000" } }), (e: unknown) => e instanceof ApiError && e.code === "noCapacity" && e.provider === undefined);
});
