// LIMITS H2 (launch path): the real RunPodAdapter behind a mocked fetch that advances a fake
// clock. The whole launch, recovery included, must stop within the probe's budget, and a launch
// whose outcome is unknown must be reported as exposure, never as "nothing exists".

import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../errors.ts";
import type { Fetch, HttpRequest } from "../http.ts";
import { machineName } from "../machine-name.ts";
import { RunPodAdapter } from "../runpod/adapter.ts";
import type { LaunchSpec } from "../types.ts";
import { probeLauncher, RESERVE_MS, runEradicationProbe, type ProbePlan, type ProbeProviderApi } from "./eradication.ts";

const agent = { agentUrl: "https://cdn.example.test/probe-agent.tar.gz", agentSha256: "a".repeat(64), controlUrl: "https://control.example.test" };
const MID = "mch_pr0bepr0bepr0bepr0be";
const spec: LaunchSpec = {
  machineId: MID, gpuType: "RTX-A4000", gpuCount: 1, dataCenter: "EU-SE-1", image: "img", diskGb: 40,
  bootToken: "A".repeat(43), launcher: probeLauncher(agent), maxProviderCostPerHour: 3_600_000,
};
// At 3.6M micro-USD per hour one millisecond costs one micro. Budget: elapsed + 387 s reserve
// must stay within min(600 s lifetime, 500000 micro), so calls stop after 113 s.
const plan: ProbePlan = { approval: "William, msg 123", agent, spec, maxSpendMicros: 500_000, maxMinutes: 10, stageMinutes: 1, pollSeconds: 10 };

type Reply = { status: number; body?: unknown } | "network-error";

/** A RunPod behind a fake network: every request takes `latencyMs` of fake time. */
function world(reply: (method: string, url: string, n: number) => Reply, latencyMs = 29_000) {
  let t = 1_800_000_000_000;
  const calls: string[] = [];
  const fetch: Fetch = async (url: string, init: HttpRequest) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    t += latencyMs;
    const r = reply(init.method, url, calls.length);
    if (r === "network-error") throw new TypeError("fetch failed");
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    return { status: r.status, headers: { get: () => null }, text: async () => text };
  };
  const adapter = new RunPodAdapter({ apiKey: "test-key", fetch, now: () => new Date(t) });
  const api: ProbeProviderApi = {
    action: async () => { throw new Error("no action expected"); },
    logs: async () => { throw new Error("no logs expected"); },
  };
  const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
  return { adapter, api, clock, calls, elapsed: () => t - 1_800_000_000_000 };
}

const page = (pods: unknown[], next: string | null) => ({ pods, pagination: { nextCursor: next, hasNextPage: next !== null } });
const pod = (id: string) => ({ id, name: machineName(MID), status: "RUNNING" });
const unavailable = { status: 503, body: { title: "Unavailable", status: 503, detail: "try later" } };

/** The report for a launch whose outcome is unknown: exposure by name, nothing confirmed. */
function assertUnknownExposure(r: Awaited<ReturnType<typeof runEradicationProbe>>) {
  assert.deepEqual(r.aborts, ["launch-failed"]);
  assert.equal(r.providerMachineId, null);
  assert.equal(r.terminatedConfirmed, false);
  assert.deepEqual(r.exposure, { providerMachineId: null, machineName: machineName(MID), ratePerHour: 3_600_000 });
  assert.equal(r.outcome, "aborted");
}

test("an endless recovery listing stops at the probe's budget and reports exposure", async () => {
  let cursor = 0;
  const w = world((method) => (method === "POST" ? unavailable : { status: 200, body: page([], `c${++cursor}`) }));
  const r = await runEradicationProbe(plan, w.adapter, w.api, w.clock);
  assertUnknownExposure(r);
  // POST at 0 s; listing pages start at 29, 58 and 87 s; at 116 s the budget (113 s) is gone.
  assert.deepEqual(w.calls, ["POST /v2/pods", "GET /v2/pods", "GET /v2/pods", "GET /v2/pods"]);
  assert.equal(w.elapsed(), 116_000);
  assert.ok(w.elapsed() + RESERVE_MS <= 10 * 60_000);
  assert.ok(r.estimatedSpendMicros <= 500_000, String(r.estimatedSpendMicros));
  assert.equal(r.withinCap, true);
});

test("a failed recovery listing reports exposure", async () => {
  const w = world((method) => (method === "POST" ? unavailable : { status: 500, body: "oops" }));
  assertUnknownExposure(await runEradicationProbe(plan, w.adapter, w.api, w.clock));
  assert.deepEqual(w.calls, ["POST /v2/pods", "GET /v2/pods"]);
});

test("a malformed recovery listing reports exposure", async () => {
  const w = world((method) => (method === "POST" ? "network-error" : { status: 200, body: {} }));
  assertUnknownExposure(await runEradicationProbe(plan, w.adapter, w.api, w.clock));
});

test("two pods for the machine after a lost response report exposure", async () => {
  const w = world((method) => (method === "POST" ? "network-error" : { status: 200, body: page([pod("p1"), pod("p2")], null) }));
  assertUnknownExposure(await runEradicationProbe(plan, w.adapter, w.api, w.clock));
});

test("a create response without an id reports exposure", async () => {
  const w = world(() => ({ status: 201, body: {} }));
  assertUnknownExposure(await runEradicationProbe(plan, w.adapter, w.api, w.clock));
  assert.deepEqual(w.calls, ["POST /v2/pods"]);
});

test("a lost response with no listing time left reports exposure without listing", async () => {
  // The POST takes 120 s: past the 113 s budget, so the recovery listing never starts.
  const w = world(() => "network-error", 120_000);
  assertUnknownExposure(await runEradicationProbe(plan, w.adapter, w.api, w.clock));
  assert.deepEqual(w.calls, ["POST /v2/pods"]);
});

test("a definite refusal leaves nothing to clean up", async () => {
  const w = world(() => ({ status: 400, body: { title: "Bad Request", status: 400, detail: "There are no longer any instances available" } }));
  const r = await runEradicationProbe(plan, w.adapter, w.api, w.clock);
  assert.deepEqual(r.aborts, ["launch-failed"]);
  assert.equal(r.terminatedConfirmed, true);
  assert.equal(r.exposure, null);
});

test("a 5xx followed by a complete, empty listing is a refusal, not exposure", async () => {
  const w = world((method) => (method === "POST" ? unavailable : { status: 200, body: page([], null) }));
  const r = await runEradicationProbe(plan, w.adapter, w.api, w.clock);
  assert.equal(r.exposure, null);
  assert.equal(r.terminatedConfirmed, true);
});

test("RunPodAdapter.launch: shouldStop before the create request sends nothing", async () => {
  const w = world(() => ({ status: 201, body: {} }));
  await assert.rejects(
    w.adapter.launch(spec, { shouldStop: () => true }),
    (e: unknown) => e instanceof ProviderError && e.kind === "unknown",
  );
  assert.deepEqual(w.calls, []);
});

test("RunPodAdapter.listMachines: shouldStop ends the pagination as outcome_unknown", async () => {
  let n = 0;
  const w = world(() => ({ status: 200, body: page([], `c${n}`) }), 0);
  await assert.rejects(
    w.adapter.listMachines({ shouldStop: () => ++n > 2 }),
    (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown",
  );
  assert.equal(w.calls.length, 2);
});

test("a unique recovery (one live pod by name) is cleaned up and confirmed, not exposure", async () => {
  // The recovered pod doesn't match the spec (minimal fields), so the adapter reports it with its
  // id; the driver terminates it and confirms it is gone.
  const w = world((method, url) => {
    const path = new URL(url).pathname;
    if (method === "POST") return "network-error";
    if (method === "GET" && path === "/v2/pods") return { status: 200, body: page([pod("p1"), { ...pod("old"), status: "TERMINATED" }], null) };
    if (method === "DELETE" && path === "/v2/pods/p1") return { status: 204 };
    if (method === "GET" && path === "/v2/pods/p1") return { status: 404, body: { title: "Not Found", status: 404, detail: "gone" } };
    throw new Error(`unexpected ${method} ${path}`);
  }, 1000);
  const r = await runEradicationProbe(plan, w.adapter, w.api, w.clock);
  assert.deepEqual(r.aborts, ["launch-failed"]);
  assert.equal(r.providerMachineId, "p1");
  assert.equal(r.terminatedConfirmed, true);
  assert.equal(r.exposure, null);
  assert.deepEqual(w.calls, ["POST /v2/pods", "GET /v2/pods", "DELETE /v2/pods/p1", "GET /v2/pods/p1"]);
});

test("a unique recovery whose termination can't be confirmed is exposure with its id", async () => {
  const w = world((method, url) => {
    const path = new URL(url).pathname;
    if (method === "POST") return "network-error";
    if (method === "GET" && path === "/v2/pods") return { status: 200, body: page([pod("p1")], null) };
    return { status: 500, body: "oops" };
  }, 1000);
  const r = await runEradicationProbe(plan, w.adapter, w.api, w.clock);
  assert.equal(r.terminatedConfirmed, false);
  assert.deepEqual(r.exposure, { providerMachineId: "p1", machineName: machineName(MID), ratePerHour: 3_600_000 });
});
