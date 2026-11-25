import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ProviderError } from "../errors.ts";
import { failureName, type Fetch, type HttpRequest } from "../http.ts";
import type { LaunchSpec } from "../types.ts";
import { expectedSpec, specDrift } from "../drift.ts";
import { ERROR_PREFIX_BYTES, podStatus, runpodError, RunPodAdapter, UNREADABLE } from "./adapter.ts";
import { gpuFromRunPod, gpuToRunPod, RUNPOD_GPUS, runpodCountry } from "./catalog.ts";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const POD = JSON.parse(fixture("pod-running.json")) as Record<string, unknown>;
const CATALOG = JSON.parse(fixture("catalog-gpus.json")) as { gpus: Array<Record<string, unknown>> };
const KEY = "test-key-not-a-real-key";
const MID = "mch_7f3k9q2m4x8z1c5v6b0n";
const NOW = new Date("2026-11-24T12:00:00.000Z");

/**
 * One reply. `textThrows` makes text() fail, as a cut-off stream does; `streamBytes` replaces the
 * body stream with one of that many bytes ("x"), produced only as it is pulled.
 */
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; textThrows?: boolean; streamBytes?: number } | Error;

/** A body stream of `bytes`, in 1 KiB chunks, that counts how many bytes were pulled from it. */
function countingStream(bytes: Uint8Array, pulled: { n: number }): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (at >= bytes.length) return ctl.close();
      const chunk = bytes.subarray(at, at + 1024);
      at += chunk.length;
      pulled.n += chunk.length;
      ctl.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
}

/** A fetch that answers from a list of replies, in order, and records every request and body read. */
function mockFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: HttpRequest }> = [];
  const reads = { text: 0, pulled: { n: 0 } };
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    // Every request, in every test: a redirect is never followed.
    if (init.redirect !== "manual") throw new Error(`request without redirect: "manual": ${init.method} ${url}`);
    const r = replies.shift();
    if (r === undefined) throw new Error(`unexpected request ${init.method} ${url}`);
    if (r instanceof Error) throw r;
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const bytes = r.streamBytes === undefined ? new TextEncoder().encode(text) : new Uint8Array(r.streamBytes).fill(0x78);
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => {
        reads.text++;
        if (r.textThrows === true) throw new Error(`stream cut ${KEY}`);
        return text;
      },
      body: countingStream(bytes, reads.pulled),
    };
  };
  return { fetch, calls, reads };
}

function adapter(replies: Reply[]) {
  const m = mockFetch(replies);
  return { a: new RunPodAdapter({ apiKey: KEY, fetch: m.fetch, now: () => NOW }), calls: m.calls, reads: m.reads };
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
  ["cmd null", { cmd: null }],
  ["cmd with an item", { cmd: ["x"] }],
  ["cmd as an empty string", { cmd: "" }],
  ["a persistent mount of size 0", { mounts: { persistent: { size: 0, path: "/workspace" } } }],
  ["Community Cloud", { cloud: "COMMUNITY" }],
  ["no cloud", { cloud: undefined }],
  ["an SSH proxy with SSH started", { ssh: { proxy: { host: "ssh.runpod.io", port: 22 }, direct: null }, startSsh: true }],
  ["an SSH proxy with startSsh unreadable", { ssh: { proxy: { host: "ssh.runpod.io", port: 22 }, direct: null }, startSsh: "false" }],
  ["an SSH proxy with direct SSH too", { ssh: { proxy: { host: "ssh.runpod.io", port: 22 }, direct: { host: "1.2.3.4", port: 22 } } }],
  ["direct SSH", { ssh: { proxy: null, direct: { host: "1.2.3.4", port: 22 } } }],
  ["an unknown SSH endpoint kind", { ssh: { proxy: null, direct: null, web: {} } }],
  ["no ssh block", { ssh: undefined }],
  ["an empty ssh block", { ssh: {} }],
  ["an ssh block without direct", { ssh: { proxy: null } }],
  ["an ssh block without proxy", { ssh: { direct: null } }],
  ["a template", { template: "9x4m2p7v" }],
  ["no template field", { template: undefined }],
  ["global networking", { globalNetworking: { enabled: true } }],
  ["no global networking block", { globalNetworking: undefined }],
  ["global networking unreadable", { globalNetworking: { enabled: "no" } }],
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

test("a rejected pod's error says where it drifted, in fixed words, never with RunPod's values", async () => {
  const cases: Array<[Record<string, unknown>, string[]]> = [
    [{ env: { SBGPU_BOOT_TOKEN: "t", PUBLIC_KEY_MARKER: "k" } }, ["envNames"]],
    [{ entrypoint: ["/start-MARKER.sh"] }, ["command"]],
    [{ cost: 0.71 }, ["providerCostPerHour"]],
    [{ cloud: "COMMUNITY_MARKER" }, ["unexpectedSettings:cloud:other"]],
    [{ ssh: undefined }, ["unexpectedSettings:ssh:unreadable"]],
    [{ ssh: { proxy: null } }, ["unexpectedSettings:ssh:direct:unreadable"]],
    [{ ssh: { proxy: "1.2.3.4:22", direct: null, MARKER: null }, startSsh: true }, ["unexpectedSettings:ssh:proxy", "unexpectedSettings:ssh:other"]],
    [{ ssh: { proxy: null, direct: null, MARKER: "x" } }, ["unexpectedSettings:ssh:other"]],
    [{ template: "tmpl_MARKER" }, ["unexpectedSettings:template:other"]],
    [{ globalNetworking: { enabled: true } }, ["unexpectedSettings:globalNetworking:enabled"]],
    [{ globalNetworking: null }, ["unexpectedSettings:globalNetworking:unreadable"]],
    [{ ports: ["22/tcp"], image: "MARKER:latest" }, ["image", "exposedPorts"]],
  ];
  for (const [change, markers] of cases) {
    const { a } = adapter([{ status: 201, body: { ...POD, ...change } }]);
    await assert.rejects(
      a.launch(spec),
      (e: unknown) =>
        e instanceof ProviderError && JSON.stringify(e.drift) === JSON.stringify(markers) && !JSON.stringify(e.drift).includes("MARKER") && Object.isFrozen(e.drift),
      JSON.stringify(change),
    );
  }
  // A command drift also says how RunPod reported the command, never its text.
  const c = adapter([{ status: 201, body: { ...POD, entrypoint: ["/bin/sh", "-c", "MARKER"], cmd: null } }]);
  await assert.rejects(c.a.launch(spec), (e: unknown) => {
    if (!(e instanceof ProviderError) || e.commandShape === null) return false;
    assert.deepEqual(e.commandShape.entrypoint, { kind: "array", length: 3 });
    assert.deepEqual(e.commandShape.cmd, { kind: "null", length: null });
    assert.deepEqual(e.commandShape.entrypointItems.map((i) => i.matches), [true, true, false]);
    assert.equal(e.commandShape.entrypointMatches, false);
    assert.ok(!("args" in e.commandShape));
    assert.ok(!JSON.stringify(e.commandShape).includes("MARKER"));
    return true;
  });
  // Other drift carries no command shape.
  const p = adapter([{ status: 201, body: { ...POD, ports: ["22/tcp"] } }]);
  await assert.rejects(p.a.launch(spec), (e: unknown) => e instanceof ProviderError && e.commandShape === null && e.drift !== null);
  // Errors that aren't about drift carry none.
  const { a } = adapter([{ status: 400, body: "no capacity" }]);
  await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.drift === null);
});

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

test("a fetch failure is named by a fixed word, never by the exception's own name or text", async () => {
  // A fetch that puts the key in both the name and the message.
  const poisoned = Object.assign(new Error(`failed ${KEY}`), { name: `Bearer ${KEY}` });
  const { a } = adapter([poisoned]);
  await assert.rejects(
    a.status("p"),
    (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown" && !e.message.includes(KEY) && e.message.endsWith("no response (error)"),
  );
  for (const name of ["AbortError", "TimeoutError", "TypeError"]) {
    const { a: b } = adapter([Object.assign(new Error(KEY), { name })]);
    await assert.rejects(b.status("p"), (e: unknown) => e instanceof ProviderError && e.message.endsWith(`no response (${name})`) && !e.message.includes(KEY));
  }
  assert.equal(failureName("TypeError"), "error");
  assert.equal(failureName(null), "error");
  assert.equal(failureName(Object.assign(new Error("x"), { name: "SyntaxError" })), "error");
});

test("failureName reads the name once and returns only its own constant", () => {
  // A getter that passes the check on its first read and carries a marker on any later read.
  let reads = 0;
  const twoFaced = new Error("x");
  Object.defineProperty(twoFaced, "name", { get: () => (reads++ === 0 ? "TypeError" : `MARKER ${KEY}`) });
  assert.equal(failureName(twoFaced), "TypeError");
  assert.equal(reads, 1);
  // The control: a getter that carries the marker from its first read.
  const marked = new Error("x");
  Object.defineProperty(marked, "name", { get: () => `MARKER ${KEY}` });
  assert.equal(failureName(marked), "error");
  // A throwing getter, and a proxy that throws on instanceof, give the fixed fallback.
  const throwing = new Error("x");
  Object.defineProperty(throwing, "name", { get: () => { throw new Error(KEY); } });
  assert.equal(failureName(throwing), "error");
  const proxy = new Proxy({}, { getPrototypeOf: () => { throw new Error(KEY); } });
  assert.equal(failureName(proxy), "error");
  // A String object that equals "TypeError" by value is not the constant.
  const boxed = new Error("x");
  Object.defineProperty(boxed, "name", { value: new String("TypeError") });
  assert.equal(failureName(boxed), "error");
});

test("a two-faced error name never reaches a ProviderError message", async () => {
  let reads = 0;
  const twoFaced = new Error(KEY);
  Object.defineProperty(twoFaced, "name", { get: () => (reads++ === 0 ? "TypeError" : `MARKER ${KEY}`) });
  const { a } = adapter([twoFaced]);
  await assert.rejects(a.status("p"), (e: unknown) => e instanceof ProviderError && e.message.endsWith("no response (TypeError)") && !e.message.includes(KEY));
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

test("status refuses an answer about another pod", async () => {
  const { a } = adapter([{ status: 200, body: { ...POD, id: "unrelated-pod" } }]);
  await assert.rejects(a.status("7h9k2m4n6p"), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
});

test("unexpected settings are named", () => {
  const s = podStatus({ ...POD, cloud: "COMMUNITY", ssh: { proxy: {}, direct: null }, startSsh: true, template: "t1", globalNetworking: { enabled: true } }, "t");
  assert.deepEqual(s.unexpectedSettings, ["cloud:COMMUNITY", "ssh:proxy", "template:t1", "globalNetworking:enabled"]);
  assert.deepEqual(podStatus({ id: "p" }, "t").unexpectedSettings, [
    `cloud:${UNREADABLE}`, `ssh:${UNREADABLE}`, `template:${UNREADABLE}`, `globalNetworking:${UNREADABLE}`,
  ]);
  assert.deepEqual(podStatus(POD, "t").unexpectedSettings, []);
  assert.deepEqual(podStatus({ ...POD, ssh: {} }, "t").unexpectedSettings, [`ssh:proxy:${UNREADABLE}`, `ssh:direct:${UNREADABLE}`]);
  assert.deepEqual(podStatus({ ...POD, ssh: { proxy: null } }, "t").unexpectedSettings, [`ssh:direct:${UNREADABLE}`]);
  // SEC (Nov 25): RunPod's proxy route is accepted only with direct null, no ports and SSH not started.
  const proxy = { direct: null, proxy: { host: "h" } };
  assert.deepEqual(podStatus({ ...POD, ssh: proxy }, "t").unexpectedSettings, []);
  assert.deepEqual(podStatus({ ...POD, ssh: proxy, startSsh: false }, "t").unexpectedSettings, []);
  assert.deepEqual(podStatus({ ...POD, ssh: proxy, startSsh: true }, "t").unexpectedSettings, ["ssh:proxy"]);
  assert.deepEqual(podStatus({ ...POD, ssh: proxy, startSsh: null }, "t").unexpectedSettings, ["ssh:proxy"]);
  assert.deepEqual(podStatus({ ...POD, ssh: proxy, ports: ["22/tcp"] }, "t").unexpectedSettings, ["ssh:proxy"]);
  assert.deepEqual(podStatus({ ...POD, ssh: proxy, ports: undefined }, "t").unexpectedSettings, ["ssh:proxy"]);
  assert.deepEqual(podStatus({ ...POD, ssh: proxy, ports: "" }, "t").unexpectedSettings, ["ssh:proxy"]);
  assert.deepEqual(podStatus({ ...POD, ssh: { proxy: "x", direct: "y" } }, "t").unexpectedSettings, ["ssh:proxy", "ssh:direct"]);
  assert.deepEqual(podStatus({ ...POD, ssh: { proxy: "x" } }, "t").unexpectedSettings, [`ssh:direct:${UNREADABLE}`, "ssh:proxy"]);
  assert.deepEqual(podStatus({ ...POD, ssh: { proxy: "x", direct: null, web: "w" } }, "t").unexpectedSettings, ["ssh:web"]);
  // A closed object (SEC H2): any key besides proxy and direct drifts, even null.
  assert.deepEqual(podStatus({ ...POD, ssh: { proxy: null, direct: null, other: null } }, "t").unexpectedSettings, ["ssh:other"]);
  assert.deepEqual(podStatus({ ...POD, ssh: { proxy: { host: "h" }, direct: null, web: null } }, "t").unexpectedSettings, ["ssh:web"]);
});

test("status escapes the pod id", async () => {
  const { a, calls } = adapter([{ status: 200, body: { ...POD, id: "a/../b?c" } }]);
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
    unexpectedSettings: [],
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
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"], cmd: null }, "t").command, [UNREADABLE]);
  // RunPod omits an empty cmd from its reply: absent reads as []. args is never read (SEC, Nov 25).
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"] }, "t").command, ["a"]);
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"], args: "python serve.py" }, "t").command, ["a"]);
  assert.deepEqual(podStatus({ id: "p", args: "/bin/sh -c x" }, "t").command, [UNREADABLE]);
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"], cmd: "" }, "t").command, [UNREADABLE]);
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"], cmd: [1] }, "t").command, [UNREADABLE]);
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"], cmd: [] }, "t").command, ["a"]);
  assert.ok(Number.isNaN(podStatus({ id: "p", mounts: { persistent: { size: 0 } } }, "t").volumeGb));
  // No concatenation: a non-empty cmd is never part of the command, it makes it unreadable.
  assert.deepEqual(podStatus({ id: "p", entrypoint: ["a"], cmd: ["b"] }, "t").command, [UNREADABLE]);
  assert.deepEqual(podStatus({ id: "p", entrypoint: [], cmd: ["a"] }, "t").command, [UNREADABLE]);
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

test("RunPod's reply as run5 saw it (entrypoint echoed, cmd omitted, args a display string, an SSH proxy) is accepted", async () => {
  const reply = { ...POD, cmd: undefined, args: "a display string MARKER", ssh: { proxy: { host: "ssh.runpod.io", port: 22 }, direct: null } };
  delete (reply as Record<string, unknown>)["cmd"];
  const { a } = adapter([{ status: 201, body: reply }]);
  const r = await a.launch(spec);
  assert.deepEqual(r.status.command, spec.launcher);
  assert.deepEqual(r.status.unexpectedSettings, []);
  assert.ok(!JSON.stringify(r.status).includes("MARKER"));
  // The same reply with any one binding broken is rejected with the pod's id.
  for (const [what, change] of [
    ["an entrypoint byte", { entrypoint: ["/bin/sh", "-c", "launcher-scripT"] }],
    ["a cmd item", { cmd: ["x"] }],
    ["a null cmd", { cmd: null }],
    // The launcher moved, whole or in part, from entrypoint into cmd (the same concatenation).
    ["the whole launcher in cmd", { entrypoint: [], cmd: [...spec.launcher] }],
    ["the launcher split after /bin/sh", { entrypoint: spec.launcher.slice(0, 1), cmd: spec.launcher.slice(1) }],
    ["the launcher split before the script", { entrypoint: spec.launcher.slice(0, 2), cmd: spec.launcher.slice(2) }],
    ["no entrypoint and the launcher in cmd", { entrypoint: undefined, cmd: [...spec.launcher] }],
    ["a port", { ports: ["22/tcp"] }],
    ["direct SSH", { ssh: { proxy: { host: "h" }, direct: { host: "1.2.3.4" } } }],
    ["SSH started", { startSsh: true }],
    ["an extra ssh key, even null", { ssh: { proxy: { host: "h" }, direct: null, web: null } }],
  ] as const) {
    const b = adapter([{ status: 201, body: { ...reply, ...change } }]);
    await assert.rejects(b.a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === "spec_mismatch" && e.providerMachineId === POD["id"], what);
  }
});

// ---------------------------------------------------------------- status first, bounded 400 read

test("#call: every request is redirect: manual", async () => {
  const { a, calls } = adapter([{ status: 404 }]);
  await a.status("pod1");
  assert.equal(calls[0]!.init.redirect, "manual");
});

test("#call: a non-400 error is classified with no body read at all", async () => {
  const cases: Array<[number, string, number | null]> = [
    [0, "unknown", null], [199, "unknown", null], [302, "unknown", null], [401, "auth", null], [404, "not_found", null],
    [409, "invalid_request", null], [429, "rate_limited", 7], [500, "transient", null],
  ];
  for (const [status, kind, retry] of cases) {
    const g = adapter([{ status, textThrows: true, body: "no capacity", headers: { "Retry-After": "7" } }]);
    await assert.rejects(g.a.listOffers({ gpuCount: 1 }), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, kind, String(status));
      assert.equal(e.httpStatus, status);
      assert.equal(e.retryAfterSeconds, retry);
      return true;
    });
    assert.equal(g.reads.text, 0, String(status));
    assert.equal(g.reads.pulled.n, 0, String(status));
  }
  const s = adapter([{ status: 404, textThrows: true }]);
  assert.equal((await s.a.status("pod1")).state, "terminated");
  assert.equal(s.reads.text + s.reads.pulled.n, 0);
});

test("#call: a 400 reads at most ERROR_PREFIX_BYTES of its body, never text()", async () => {
  assert.equal(ERROR_PREFIX_BYTES, 4096);
  // A 1 MiB body: only the prefix is pulled.
  const big = adapter([{ status: 400, textThrows: true, streamBytes: 1 << 20 }]);
  await assert.rejects(big.a.listOffers({ gpuCount: 1 }), (e: unknown) => e instanceof ProviderError && e.kind === "unplaceable" && e.httpStatus === 400);
  assert.equal(big.reads.text, 0);
  assert.equal(big.reads.pulled.n, ERROR_PREFIX_BYTES);
  // A problem+json body that fits in the prefix is parsed: no_capacity. Padded to one byte past
  // it, the cut-off JSON can't be parsed (and its detail isn't in the raw first 1000 characters).
  const body = (size: number) => {
    const shell = JSON.stringify({ title: "Bad Request", status: 400, pad: "", detail: "There are no longer any instances available" });
    return shell.replace('"pad":""', `"pad":"${" ".repeat(size - shell.length)}"`);
  };
  assert.equal(body(ERROR_PREFIX_BYTES).length, ERROR_PREFIX_BYTES);
  const inside = adapter([{ status: 400, textThrows: true, body: body(ERROR_PREFIX_BYTES) }]);
  await assert.rejects(inside.a.listOffers({ gpuCount: 1 }), (e: unknown) => e instanceof ProviderError && e.kind === "no_capacity");
  const past = adapter([{ status: 400, textThrows: true, body: body(ERROR_PREFIX_BYTES + 1) }]);
  await assert.rejects(past.a.listOffers({ gpuCount: 1 }), (e: unknown) => e instanceof ProviderError && e.kind === "unplaceable");
  assert.equal(inside.reads.text + past.reads.text, 0);
});

test("#call: a 400 whose stream fails or is missing is unplaceable", async () => {
  const failing: Fetch = async (_url, init) => {
    assert.equal(init.redirect, "manual");
    return {
      status: 400,
      headers: { get: () => null },
      text: async () => { throw new Error("no"); },
      body: new ReadableStream<Uint8Array>({ pull(ctl) { ctl.error(new Error(`cut ${KEY}`)); } }),
    };
  };
  await assert.rejects(new RunPodAdapter({ apiKey: KEY, fetch: failing }).listOffers({ gpuCount: 1 }), (e: unknown) => e instanceof ProviderError && e.kind === "unplaceable" && !e.message.includes(KEY));
  const none: Fetch = async () => ({ status: 400, headers: { get: () => null }, text: async () => "no capacity" });
  await assert.rejects(new RunPodAdapter({ apiKey: KEY, fetch: none }).listOffers({ gpuCount: 1 }), (e: unknown) => e instanceof ProviderError && e.kind === "unplaceable");
});

test("#call: a 2xx body that can't be read is outcome_unknown, naming no key", async () => {
  const g = adapter([{ status: 200, textThrows: true }]);
  await assert.rejects(g.a.listOffers({ gpuCount: 1 }), (e: unknown) => {
    assert.ok(e instanceof ProviderError && e.kind === "outcome_unknown" && e.httpStatus === 200);
    assert.ok(!e.message.includes(KEY) && !e.message.includes("stream cut"));
    return true;
  });
});

test("#call: a 400 whose body stream is locked is still HTTP 400 unplaceable", async () => {
  const locked = new Response("There are no longer any instances available").body!;
  locked.getReader();
  const f: Fetch = async (_url, init) => {
    assert.equal(init.redirect, "manual");
    return { status: 400, headers: { get: () => null }, text: async () => { throw new Error("no"); }, body: locked };
  };
  const a = new RunPodAdapter({ apiKey: KEY, fetch: f });
  for (const call of [() => a.status("pod1"), () => a.listOffers({ gpuCount: 1 })]) {
    await assert.rejects(call(), (e: unknown) => e instanceof ProviderError && e.kind === "unplaceable" && e.httpStatus === 400);
  }
});
