import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ProviderError } from "../errors.ts";
import type { Fetch, HttpRequest } from "../http.ts";
import type { LaunchSpec } from "../types.ts";
import { podStatus, runpodError, RunPodAdapter } from "./adapter.ts";
import { gpuFromRunPod, gpuToRunPod, RUNPOD_GPUS, runpodCountry } from "./catalog.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const POD = JSON.parse(fixture("pod-running.json")) as Record<string, unknown>;
const CATALOG = JSON.parse(fixture("catalog-gpus.json")) as { gpus: Array<Record<string, unknown>> };
const KEY = "test-key-not-a-real-key";
const MID = "mch_7f3k9q2m4x8z1c5v6b0n";
const NOW = new Date("2026-11-24T12:00:00.000Z");

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that answers from a list of replies, in order, and records every request. */
function mockFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: HttpRequest }> = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (r === undefined) throw new Error(`unexpected request ${init.method} ${url}`);
    if (r instanceof Error) throw r;
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => text };
  };
  return { fetch, calls };
}

function adapter(replies: Reply[]) {
  const m = mockFetch(replies);
  return { a: new RunPodAdapter({ apiKey: KEY, fetch: m.fetch, now: () => NOW }), calls: m.calls };
}

const spec: LaunchSpec = {
  machineId: MID,
  gpuType: "L4",
  gpuCount: 1,
  dataCenter: "EU-SE-1",
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  diskGb: 40,
  bootToken: "test-token-not-a-secret",
  launcher: ["/bin/sh", "-c", "launcher-script"],
  maxProviderCostPerHour: 700_000,
};

// ---------------------------------------------------------------- catalog

test("runpodCountry reads only the shapes it knows", () => {
  const cases: Array<[string, string | null]> = [
    ["EU-SE-1", "SE"], ["EU-RO-1", "RO"], ["EU-CZ-1", "CZ"], ["EUR-IS-1", "IS"], ["EUR-NO-2", "NO"],
    ["US-DE-1", "US"], ["US-CA-2", "US"], ["US-TX-3", "US"], ["CA-MTL-1", "CA"],
    ["AP-JP-1", null], ["OC-AU-1", null], ["SEA-SG-1", null], ["EU-SE", null], ["EU-SE-1a", null],
    ["EU-se-1", null], ["EU-SWE-1", null], ["CA-TOR-1", null], ["EU-SE-1-2", null], ["", null],
  ];
  for (const [id, country] of cases) assert.equal(runpodCountry(id), country, id);
});

test("GPU mapping is one-to-one and round-trips", () => {
  const ours = Object.values(RUNPOD_GPUS);
  assert.equal(new Set(ours).size, ours.length);
  for (const [rp, g] of Object.entries(RUNPOD_GPUS)) {
    assert.equal(gpuFromRunPod(rp), g);
    assert.equal(gpuToRunPod(g), rp);
  }
  assert.equal(gpuFromRunPod("AMD Instinct MI300X OAM"), null);
  assert.equal(gpuFromRunPod("toString"), null);
  assert.equal(gpuToRunPod("NOPE"), null);
});

// ---------------------------------------------------------------- offers

test("listOffers asks for Secure Cloud pod availability and maps every data center", async () => {
  const { a, calls } = adapter([{ status: 200, body: CATALOG }]);
  const offers = await a.listOffers({ gpuCount: 1 });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, "https://api.runpod.io/v2/catalog/gpus");
  assert.deepEqual(Object.fromEntries(url.searchParams), { include: "AVAILABILITY", product: "POD", cloud: "SECURE", count: "1" });
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.headers["Authorization"], `Bearer ${KEY}`);
  assert.equal(calls[0]!.init.body, undefined);
  const rows = offers.map((o) => [o.gpuType, o.dataCenter, o.country, o.providerCostPerHour, o.stock].join(" "));
  assert.deepEqual(rows.sort(), [
    "H100-80GB-SXM EUR-NO-1 NO 4390000 low",
    "L4 EU-RO-1 RO 690000 high",
    "L4 EU-SE-1 SE 690000 low",
    "L4 US-DE-1 US 690000 high",
    "RTX-A5000 CA-MTL-1 CA 270000 high",
    "RTX-A5000 EU-CZ-1 CZ 270000 high",
    "RTX-A6000 EU-SE-1 SE 690000 medium",
    "RTX-A6000 EUR-IS-1 IS 690000 none",
  ]);
  for (const o of offers) {
    assert.equal(o.provider, "runpod");
    assert.equal(o.gpuCount, 1);
    assert.equal(o.observedAt, NOW.toISOString());
  }
});

test("listOffers multiplies the per-GPU price by the GPU count", async () => {
  const { a, calls } = adapter([{ status: 200, body: CATALOG }]);
  const offers = await a.listOffers({ gpuCount: 2 });
  assert.equal(new URL(calls[0]!.url).searchParams.get("count"), "2");
  const l4 = offers.find((o) => o.gpuType === "L4" && o.dataCenter === "EU-RO-1")!;
  assert.equal(l4.providerCostPerHour, 1_380_000);
  assert.equal(l4.gpuCount, 2);
});

test("listOffers skips what it can't offer safely", async () => {
  const dc = (id: string, availability: unknown = "HIGH") => ({ id, name: id, availability });
  const gpu = (id: string, extra: Record<string, unknown>) => ({
    id, name: id, secure: true, price: { secure: 0.5, community: 0.3 }, dataCenters: [dc("EU-SE-1")], ...extra,
  });
  const { a } = adapter([{
    status: 200,
    body: {
      gpus: [
        gpu("NVIDIA L4", { secure: false }),
        gpu("NVIDIA L40", { price: { secure: 0, community: 0.3 } }),
        gpu("NVIDIA L40S", { price: {} }),
        gpu("NVIDIA A40", { dataCenters: [dc("AP-JP-1"), dc("EU-FR-1", "PLENTY"), { name: "no id" }, null] }),
        gpu("NVIDIA RTX A4000", { dataCenters: undefined }),
        gpu("Some New GPU", {}),
        "junk",
      ],
    },
  }]);
  const offers = await a.listOffers({ gpuCount: 1 });
  assert.deepEqual(offers.map((o) => [o.gpuType, o.dataCenter, o.stock]), [["A40", "EU-FR-1", "unknown"]]);
  await assert.rejects(a.listOffers({ gpuCount: 0 }), RangeError);
  await assert.rejects(a.listOffers({ gpuCount: 1.5 }), RangeError);
});

// ---------------------------------------------------------------- launch

test("the create body is exactly our launch shape", () => {
  const { a } = adapter([]);
  assert.deepEqual(a.createBody(spec), {
    name: `sbg-${MID}`,
    cloud: "SECURE",
    gpu: { id: "NVIDIA L4", count: 1 },
    dataCenterIds: ["EU-SE-1"],
    image: spec.image,
    disk: 40,
    mounts: {},
    env: { SBGPU_BOOT_TOKEN: "test-token-not-a-secret" },
    entrypoint: ["/bin/sh", "-c", "launcher-script"],
    cmd: [],
    ports: [],
    startSsh: false,
    startJupyter: false,
  });
  assert.throws(() => a.createBody({ ...spec, gpuType: "NOPE" }), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request");
  assert.throws(() => a.createBody({ ...spec, launcher: [] }), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request");
  assert.throws(() => a.createBody({ ...spec, bootToken: "" }), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request");
  assert.throws(() => a.createBody({ ...spec, machineId: "mch_bad" }), RangeError);
});

test("launch posts the body and returns the pod", async () => {
  const { a, calls } = adapter([{ status: 201, body: POD }]);
  const r = await a.launch(spec);
  assert.equal(r.providerMachineId, "7h9k2m4n6p");
  assert.equal(r.status.state, "running");
  assert.equal(r.status.machineId, MID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.runpod.io/v2/pods");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.init.body!), a.createBody(spec));
});

test("launch accepts a pod whose data center isn't assigned yet", async () => {
  const { a } = adapter([{ status: 201, body: { ...POD, status: "PROVISIONING", dataCenterId: null } }]);
  const r = await a.launch(spec);
  assert.equal(r.status.state, "provisioning");
  assert.equal(r.status.dataCenter, null);
});

const badPods: Array<[string, Record<string, unknown>, string]> = [
  ["ports", { ports: ["22/tcp"] }, "invalid_request"],
  ["a volume", { mounts: { persistent: { size: 20, path: "/workspace" } } }, "invalid_request"],
  ["a network volume", { mounts: { network: [{ id: "v" }] } }, "invalid_request"],
  ["extra env", { env: { SBGPU_BOOT_TOKEN: "t", PUBLIC_KEY: "k" } }, "invalid_request"],
  ["another data center", { dataCenterId: "US-TX-3" }, "invalid_request"],
  ["another image", { image: "other:latest" }, "invalid_request"],
  ["another command", { entrypoint: ["/start.sh"] }, "invalid_request"],
  ["a higher rate", { cost: 0.71 }, "price_above_cap"],
  ["no rate", { cost: null }, "invalid_request"],
];

for (const [what, change, kind] of badPods) {
  test(`launch terminates a new pod with ${what}`, async () => {
    const { a, calls } = adapter([{ status: 201, body: { ...POD, ...change } }, { status: 204 }]);
    await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === kind);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.init.method, "DELETE");
    assert.equal(calls[1]!.url, "https://api.runpod.io/v2/pods/7h9k2m4n6p");
  });
}

test("a rate at the cap is accepted", async () => {
  const { a } = adapter([{ status: 201, body: { ...POD, cost: 0.7 } }]);
  assert.equal((await a.launch(spec)).status.providerCostPerHour, 700_000);
});

test("launch maps RunPod's refusals", async () => {
  const cases: Array<[Reply, string, number | null]> = [
    [{ status: 400, body: fixture("error-no-capacity.json") }, "no_capacity", null],
    [{ status: 400, body: { title: "Bad Request", status: 400, detail: "gpu.count exceeds maxCount" } }, "unplaceable", null],
    [{ status: 401, body: { title: "Unauthorized", status: 401, detail: "missing bearer token" } }, "auth", null],
    [{ status: 402, body: { title: "Payment Required", status: 402, detail: "insufficient balance" } }, "insufficient_funds", null],
    [{ status: 403, body: { title: "Forbidden", status: 403, detail: "pool" } }, "forbidden", null],
    [{ status: 422, body: { title: "Unprocessable", status: 422, detail: "bad", errors: ["$: x"] } }, "invalid_request", null],
    [{ status: 429, body: { title: "Too Many Requests", status: 429, detail: "slow" }, headers: { "Retry-After": "12" } }, "rate_limited", 12],
  ];
  for (const [reply, kind, retryAfter] of cases) {
    const { a, calls } = adapter([reply]);
    await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === kind && e.retryAfterSeconds === retryAfter, kind);
    assert.equal(calls.length, 1, kind);
  }
});

const listReply = (pods: unknown[]): Reply => ({ status: 200, body: { pods, pagination: { nextCursor: null, hasNextPage: false } } });

test("launch after a lost response finds the pod by name", async () => {
  const { a, calls } = adapter([new TypeError("fetch failed"), listReply([{ ...POD, name: "someone-else" }, POD])]);
  const r = await a.launch(spec);
  assert.equal(r.providerMachineId, "7h9k2m4n6p");
  assert.equal(calls[1]!.init.method, "GET");
  assert.ok(calls[1]!.url.startsWith("https://api.runpod.io/v2/pods?"));
});

test("launch after a lost response with no pod found is outcome_unknown", async () => {
  const { a } = adapter([new TypeError("fetch failed"), listReply([{ ...POD, status: "TERMINATED" }])]);
  await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown");
});

test("launch after a 5xx with no pod found is transient; with the list unreadable it is outcome_unknown", async () => {
  const five = { status: 503, body: { title: "Unavailable", status: 503, detail: "try later" } };
  const { a } = adapter([five, listReply([])]);
  await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === "transient");
  const b = adapter([five, five]);
  await assert.rejects(b.a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown");
});

test("launch refuses to pick between two pods of one machine", async () => {
  const { a } = adapter([new TypeError("fetch failed"), listReply([POD, { ...POD, id: "other" }])]);
  await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown" && /2 pods/.test(e.message));
});

test("launch doesn't look for the pod after a definite refusal", async () => {
  const { a, calls } = adapter([{ status: 400, body: fixture("error-no-capacity.json") }]);
  await assert.rejects(a.launch(spec));
  assert.equal(calls.length, 1);
});

test("errors never carry the API key", async () => {
  const { a } = adapter([new TypeError(`connect failed Bearer ${KEY}`), { status: 500, body: "" }]);
  await assert.rejects(a.launch(spec), (e: unknown) => e instanceof Error && !e.message.includes(KEY));
});

test("a non-JSON success body is an error", async () => {
  const { a } = adapter([{ status: 200, body: "<html>" }]);
  await assert.rejects(a.status("p"), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
});

// ---------------------------------------------------------------- status, terminate, list

test("status maps RunPod's pod states", async () => {
  const expected: Record<string, string> = {
    PROVISIONING: "provisioning", STARTING: "provisioning", RUNNING: "running", EXITED: "failed",
    ERROR: "failed", TERMINATED: "terminated", SOMETHING_NEW: "unknown",
  };
  for (const [raw, state] of Object.entries(expected)) {
    const { a, calls } = adapter([{ status: 200, body: { ...POD, status: raw } }]);
    const s = await a.status("7h9k2m4n6p");
    assert.equal(s.state, state, raw);
    assert.equal(s.rawStatus, raw);
    assert.equal(calls[0]!.url, "https://api.runpod.io/v2/pods/7h9k2m4n6p");
  }
});

test("status of a pod RunPod doesn't know is terminated", async () => {
  const { a } = adapter([{ status: 404, body: { title: "Not Found", status: 404, detail: "pod not found" } }]);
  const s = await a.status("gone");
  assert.equal(s.state, "terminated");
  assert.equal(s.providerMachineId, "gone");
});

test("status escapes the pod id", async () => {
  const { a, calls } = adapter([{ status: 200, body: POD }]);
  await a.status("a/../b?c");
  assert.equal(calls[0]!.url, "https://api.runpod.io/v2/pods/a%2F..%2Fb%3Fc");
});

test("terminate is idempotent and reports other failures", async () => {
  const ok = adapter([{ status: 204 }]);
  await ok.a.terminate("p1");
  assert.equal(ok.calls[0]!.init.method, "DELETE");
  assert.equal(ok.calls[0]!.url, "https://api.runpod.io/v2/pods/p1");
  await adapter([{ status: 404, body: { title: "Not Found", status: 404, detail: "x" } }]).a.terminate("p1");
  await assert.rejects(
    adapter([{ status: 500, body: "oops" }]).a.terminate("p1"),
    (e: unknown) => e instanceof ProviderError && e.kind === "transient",
  );
  await assert.rejects(
    adapter([{ status: 409, body: { title: "Conflict", status: 409, detail: "cluster" } }]).a.terminate("p1"),
    (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request",
  );
});

test("listMachines walks every page and keeps only our pods", async () => {
  const p2 = { ...POD, id: "p2", name: "sbg-mch_0000000000000000000a" };
  const { a, calls } = adapter([
    { status: 200, body: { pods: [POD, { ...POD, id: "x", name: "not-ours" }], pagination: { nextCursor: "c1", hasNextPage: true } } },
    { status: 200, body: { pods: [p2], pagination: { nextCursor: null, hasNextPage: false } } },
  ]);
  const ms = await a.listMachines();
  assert.deepEqual(ms.map((m) => [m.providerMachineId, m.machineId]), [["7h9k2m4n6p", MID], ["p2", "mch_0000000000000000000a"]]);
  assert.equal(new URL(calls[0]!.url).searchParams.get("cursor"), null);
  assert.equal(new URL(calls[1]!.url).searchParams.get("cursor"), "c1");
  assert.equal(new URL(calls[1]!.url).searchParams.get("limit"), "1000");
});

test("listMachines fails rather than returning a partial list", async () => {
  await assert.rejects(
    adapter([{ status: 200, body: { pods: [], pagination: { nextCursor: null, hasNextPage: true } } }]).a.listMachines(),
    (e: unknown) => e instanceof ProviderError && e.kind === "unknown",
  );
  const pages: Reply[] = [];
  for (let i = 0; i < 50; i++) pages.push({ status: 200, body: { pods: [], pagination: { nextCursor: `c${i}`, hasNextPage: true } } });
  const { a, calls } = adapter(pages);
  await assert.rejects(a.listMachines(), (e: unknown) => e instanceof ProviderError && /50 pages/.test(e.message));
  assert.equal(calls.length, 50);
});

// ---------------------------------------------------------------- parsing

test("podStatus reads the fixture pod", () => {
  assert.deepEqual(podStatus(POD, "t"), {
    provider: "runpod",
    providerMachineId: "7h9k2m4n6p",
    machineId: MID,
    state: "running",
    rawStatus: "RUNNING",
    gpuType: "L4",
    gpuCount: 1,
    dataCenter: "EU-SE-1",
    image: spec.image,
    diskGb: 40,
    volumeGb: 0,
    envNames: ["SBGPU_BOOT_TOKEN"],
    exposedPorts: [],
    command: ["/bin/sh", "-c", "launcher-script"],
    providerCostPerHour: 690_000,
    observedAt: "t",
  });
});

test("podStatus keeps unknowns visible", () => {
  const s = podStatus({ id: "p", args: "python serve.py", gpu: { id: "Some New GPU", count: 1 }, cost: -1, mounts: { global: [{}] } }, "t");
  assert.deepEqual(s.command, ["args:python serve.py"]);
  assert.equal(s.gpuType, null);
  assert.equal(s.providerCostPerHour, null);
  assert.equal(s.volumeGb, Number.POSITIVE_INFINITY);
  assert.equal(s.machineId, null);
  assert.equal(s.state, "unknown");
  assert.equal(podStatus({ id: "p", cost: "0.5" }, "t").providerCostPerHour, null);
  assert.throws(() => podStatus({ name: "x" }, "t"), ProviderError);
  assert.throws(() => podStatus(null, "t"), ProviderError);
});

test("runpodError keeps the detail short and reads Retry-After only for 429", () => {
  const e = runpodError(400, JSON.stringify({ detail: "x".repeat(1000) }), "5");
  assert.equal(e.message.length, "RunPod 400: ".length + 300);
  assert.equal(e.retryAfterSeconds, null);
  assert.equal(runpodError(418, "teapot", null).kind, "unknown");
  assert.equal(runpodError(599, "", null).kind, "transient");
  assert.equal(runpodError(600, "", null).kind, "unknown");
  assert.equal(runpodError(413, "", null).kind, "invalid_request");
  assert.equal(runpodError(404, "", null).kind, "not_found");
  assert.equal(runpodError(400, JSON.stringify({ detail: "No GPU capacity in EU-SE-1" }), null).kind, "no_capacity");
  assert.equal(runpodError(400, "not json", null).message, "RunPod 400: not json");
});
