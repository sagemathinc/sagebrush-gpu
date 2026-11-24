import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ProviderError } from "../errors.ts";
import type { Fetch, HttpRequest } from "../http.ts";
import type { LaunchSpec } from "../types.ts";
import { expectedSpec, specDrift } from "../drift.ts";
import { podStatus, runpodError, RunPodAdapter, UNREADABLE } from "./adapter.ts";
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

test("listOffers rejects a malformed catalog rather than reporting no offers", async () => {
  for (const body of [{}, { gpus: "x" }, [], "<html>"]) {
    await assert.rejects(adapter([{ status: 200, body }]).a.listOffers({ gpuCount: 1 }), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  }
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

// A fresh pod that doesn't match the spec is reported with its id (the caller revokes, then
// terminates and confirms; see placement.test.ts). The adapter itself makes no further call.
const badPods: Array<[string, Record<string, unknown>, string]> = [
  ["ports", { ports: ["22/tcp"] }, "spec_mismatch"],
  ["a volume", { mounts: { persistent: { size: 20, path: "/workspace" } } }, "spec_mismatch"],
  ["a network volume", { mounts: { network: [{ id: "v" }] } }, "spec_mismatch"],
  ["a global volume", { mounts: { global: [{ id: "g" }] } }, "spec_mismatch"],
  ["extra env", { env: { SBGPU_BOOT_TOKEN: "t", PUBLIC_KEY: "k" } }, "spec_mismatch"],
  ["another data center", { dataCenterId: "US-TX-3" }, "spec_mismatch"],
  ["another image", { image: "other:latest" }, "spec_mismatch"],
  ["another command", { entrypoint: ["/start.sh"] }, "spec_mismatch"],
  ["another disk", { disk: 41 }, "spec_mismatch"],
  ["another GPU", { gpu: { id: "NVIDIA RTX A6000", count: 1 } }, "spec_mismatch"],
  ["a higher rate", { cost: 0.71 }, "price_above_cap"],
  ["no rate", { cost: null }, "spec_mismatch"],
  ["a higher rate and ports", { cost: 0.71, ports: ["22/tcp"] }, "spec_mismatch"],
];

// Missing or malformed security-relevant fields: never read as the safe value.
const malformed: Array<[string, Record<string, unknown>]> = [
  ["missing ports", { ports: undefined }],
  ["ports as a string", { ports: "22/tcp" }],
  ["ports as numbers", { ports: [22] }],
  ["ports as objects", { ports: [{ port: 22 }] }],
  ["ports null", { ports: null }],
  ["missing mounts", { mounts: undefined }],
  ["mounts null", { mounts: null }],
  ["mounts as an array", { mounts: [] }],
  ["network volumes not an array", { mounts: { network: "unknown" } }],
  ["network volume as an object", { mounts: { network: { id: "v" } } }],
  ["global volumes not an array", { mounts: { global: { id: "g" } } }],
  ["a persistent size as a string", { mounts: { persistent: { size: "20" } } }],
  ["a persistent mount not an object", { mounts: { persistent: 20 } }],
  ["an unknown mount kind", { mounts: { shared: [] } }],
  ["missing env", { env: undefined }],
  ["env as an array", { env: ["SBGPU_BOOT_TOKEN"] }],
  ["an env value not a string", { env: { SBGPU_BOOT_TOKEN: 5 } }],
  ["missing entrypoint", { entrypoint: undefined }],
  ["an entrypoint with a non-string", { entrypoint: ["/bin/sh", 5, "launcher-script"] }],
  ["cmd not an array", { cmd: "x" }],
  ["missing image", { image: undefined }],
  ["missing disk", { disk: undefined }],
  ["disk as a string", { disk: "40" }],
  ["missing gpu", { gpu: undefined }],
  ["a GPU count as a string", { gpu: { id: "NVIDIA L4", count: "1" } }],
];

for (const [what, change, kind] of badPods) {
  test(`launch reports a new pod with ${what} as ${kind}, with its id`, async () => {
    const { a, calls } = adapter([{ status: 201, body: { ...POD, ...change } }]);
    await assert.rejects(
      a.launch(spec),
      (e: unknown) => e instanceof ProviderError && e.kind === kind && e.providerMachineId === "7h9k2m4n6p",
    );
    assert.deepEqual(calls.map((c) => c.init.method), ["POST"]);
  });
}

for (const [what, change] of malformed) {
  test(`a pod with ${what} is never accepted, and drifts when polled`, async () => {
    const pod = { ...POD, ...change };
    const { a } = adapter([{ status: 201, body: pod }, { status: 200, body: pod }]);
    await assert.rejects(
      a.launch(spec),
      (e: unknown) => e instanceof ProviderError && e.kind === "spec_mismatch" && e.providerMachineId === "7h9k2m4n6p",
    );
    const drift = specDrift(expectedSpec(spec, a.info, "7h9k2m4n6p"), await a.status("7h9k2m4n6p"));
    assert.ok(drift.length > 0);
  });
}

test("a created pod whose response has no id is outcome_unknown", async () => {
  for (const body of [{ ...POD, id: undefined }, { ...POD, id: "" }, "[]", ""]) {
    const { a } = adapter([{ status: 201, body }]);
    await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown", JSON.stringify(body));
  }
});

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

const invalidLists: Array<[string, Reply]> = [
  ["{}", { status: 200, body: {} }],
  ["pods not an array", { status: 200, body: { pods: "invalid", pagination: { nextCursor: null, hasNextPage: false } } }],
  ["no pagination", { status: 200, body: { pods: [] } }],
  ["pagination without hasNextPage", { status: 200, body: { pods: [], pagination: { nextCursor: null } } }],
  ["hasNextPage not a boolean", { status: 200, body: { pods: [], pagination: { nextCursor: null, hasNextPage: "false" } } }],
  ["a next page without a cursor", { status: 200, body: { pods: [], pagination: { nextCursor: null, hasNextPage: true } } }],
  ["a next page with an empty cursor", { status: 200, body: { pods: [], pagination: { nextCursor: "", hasNextPage: true } } }],
  ["a pod row without an id", { status: 200, body: { pods: [{ name: "x" }], pagination: { nextCursor: null, hasNextPage: false } } }],
  ["a pod row that isn't an object", { status: 200, body: { pods: [7], pagination: { nextCursor: null, hasNextPage: false } } }],
  ["not JSON", { status: 200, body: "<html>" }],
  ["an empty body", { status: 200 }],
];

for (const [what, reply] of invalidLists) {
  test(`listMachines rejects ${what}`, async () => {
    await assert.rejects(adapter([reply]).a.listMachines(), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  });
  test(`launch after a 503 with discovery returning ${what} is outcome_unknown`, async () => {
    const { a, calls } = adapter([{ status: 503, body: "" }, reply]);
    await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown");
    assert.deepEqual(calls.map((c) => c.init.method), ["POST", "GET"]);
  });
}

test("launch refuses to pick between two pods of one machine", async () => {
  const { a } = adapter([new TypeError("fetch failed"), listReply([POD, { ...POD, id: "other" }])]);
  await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown" && /2 pods/.test(e.message));
});

test("launch doesn't look for the pod after a definite refusal", async () => {
  const { a, calls } = adapter([{ status: 400, body: fixture("error-no-capacity.json") }]);
  await assert.rejects(a.launch(spec));
  assert.equal(calls.length, 1);
});

test("errors never carry provider text, which can echo the boot token", async () => {
  const echo = { title: "Unprocessable", status: 422, detail: "bad SBGPU_BOOT_TOKEN=test-token-not-a-secret", errors: ["env: test-token-not-a-secret"] };
  for (const reply of [
    { status: 422, body: echo },
    { status: 400, body: { ...echo, status: 400 } },
    { status: 400, body: "no capacity for SBGPU_BOOT_TOKEN=test-token-not-a-secret" },
    { status: 500, body: "test-token-not-a-secret" },
  ]) {
    const { a } = adapter([reply, listReply([])]);
    await assert.rejects(a.launch(spec), (e: unknown) => e instanceof Error && !e.message.includes("test-token") && !e.message.includes("SBGPU"));
  }
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
  assert.deepEqual(s.command, [UNREADABLE]);
  assert.deepEqual(s.envNames, [UNREADABLE]);
  assert.deepEqual(s.exposedPorts, [UNREADABLE]);
  assert.equal(s.image, UNREADABLE);
  assert.ok(Number.isNaN(s.diskGb));
  assert.equal(s.gpuType, null);
  assert.equal(s.providerCostPerHour, null);
  assert.equal(s.volumeGb, Number.POSITIVE_INFINITY);
  assert.equal(s.machineId, null);
  assert.equal(s.state, "unknown");
  assert.equal(podStatus({ id: "p", cost: "0.5" }, "t").providerCostPerHour, null);
  assert.ok(Number.isNaN(podStatus({ id: "p", mounts: { persistent: { size: -1 } } }, "t").volumeGb));
  assert.equal(podStatus({ id: "p", mounts: { persistent: { size: 10 }, network: [] } }, "t").volumeGb, 10);
  assert.equal(podStatus({ id: "p", mounts: { persistent: null, network: null, global: null } }, "t").volumeGb, 0);
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"], cmd: null }, "t").command, ["a"]);
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"] }, "t").command, ["a"]);
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"], cmd: ["b"] }, "t").command, ["a", "b"]);
  assert.throws(() => podStatus({ name: "x" }, "t"), ProviderError);
  assert.throws(() => podStatus(null, "t"), ProviderError);
});

test("runpodError classifies without keeping provider text, and reads Retry-After only for 429", () => {
  const e = runpodError(400, JSON.stringify({ detail: "x".repeat(1000) }), "5");
  assert.equal(e.message, "RunPod HTTP 400 (unplaceable)");
  assert.equal(e.retryAfterSeconds, null);
  assert.equal(runpodError(429, "", "5").retryAfterSeconds, 5);
  assert.equal(runpodError(418, "teapot", null).kind, "unknown");
  assert.equal(runpodError(599, "", null).kind, "transient");
  assert.equal(runpodError(600, "", null).kind, "unknown");
  assert.equal(runpodError(413, "", null).kind, "invalid_request");
  assert.equal(runpodError(404, "", null).kind, "not_found");
  assert.equal(runpodError(400, JSON.stringify({ detail: "No GPU capacity in EU-SE-1" }), null).kind, "no_capacity");
  assert.equal(runpodError(400, "There are no longer any instances available", null).kind, "no_capacity");
  assert.equal(runpodError(400, JSON.stringify({ title: "no capacity", detail: "rule" }), null).kind, "unplaceable");
});
