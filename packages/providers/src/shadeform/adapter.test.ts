import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedSpec, specDrift } from "../drift.ts";
import { ProviderError } from "../errors.ts";
import type { Fetch, HttpRequest } from "../http.ts";
import type { LaunchSpec } from "../types.ts";
import { instanceStatus, shadeformError, ShadeformAdapter, UNREADABLE, VM_COMMAND } from "./adapter.ts";
import { gpuFromShadeform, SHADEFORM_GPUS, shadeformCountry, shadeformDataCenter } from "./catalog.ts";

const KEY = "test-key-not-a-real-key";
const MID = "mch_7f3k9q2m4x8z1c5v6b0n";
const NOW = new Date("2026-11-24T12:00:00.000Z");
const IID = "d290f1ee-6c54-4b01-90e6-d701748f0851";

/** One reply; `textThrows` makes reading its body fail, as a cut-off stream does. */
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; textThrows?: boolean } | Error;

/** A fetch that answers from a list of replies, in order, and records every request and body read. */
function mockFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: HttpRequest }> = [];
  const reads = { n: 0 };
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    // Every request, in every test: a redirect is never followed.
    if (init.redirect !== "manual") throw new Error(`request without redirect: "manual": ${init.method} ${url}`);
    const r = replies.shift();
    if (r === undefined) throw new Error(`unexpected request ${init.method} ${url}`);
    if (r instanceof Error) throw r;
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: r.status,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => {
        reads.n++;
        if (r.textThrows === true) throw new Error(`stream cut ${KEY}`);
        return text;
      },
    };
  };
  return { fetch, calls, reads };
}

function adapter(replies: Reply[]) {
  const m = mockFetch(replies);
  return { a: new ShadeformAdapter({ apiKey: KEY, fetch: m.fetch, now: () => NOW }), calls: m.calls, reads: m.reads };
}

/** An instance as Shadeform's API reference describes it, named as one of ours. */
function instance(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: IID,
    name: `sbg-${MID}`,
    status: "active",
    status_details: "",
    cloud: "hyperstack",
    region: "canada-1",
    shade_instance_type: "A6000",
    cloud_instance_type: "gpu_1x_a6000",
    shade_cloud: true,
    hourly_price: 210,
    ssh_key_id: null,
    envs: [{ name: "SBGPU_BOOT_TOKEN", value: "t" }],
    port_forwards: null,
    volume_ids: null,
    template_id: null,
    cluster_id: null,
    commitment_id: null,
    rental_terms: { rental_type: "on_demand", ending_at: null, hourly_price: "2.10" },
    configuration: { gpu_type: "A6000", num_gpus: 1, interconnect: "pcie", os: "ubuntu22.04_cuda12.2", storage_in_gb: 500 },
    launch_configuration: null,
    ...over,
  };
}

function instanceType(over: Record<string, unknown> = {}, conf: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cloud: "hyperstack",
    shade_instance_type: "A6000",
    hourly_price: 50,
    configuration: { gpu_type: "A6000", num_gpus: 1, interconnect: "pcie", ...conf },
    availability: [{ region: "canada-1", available: true, rental_type: "on_demand", hourly_price: "0.50" }],
    ...over,
  };
}

// ---------------------------------------------------------------- catalog

test("gpuFromShadeform: plain names map; A100_80G and H100 only with a known interconnect", () => {
  for (const [name, ours] of Object.entries(SHADEFORM_GPUS)) assert.equal(gpuFromShadeform(name, undefined), ours);
  assert.equal(gpuFromShadeform("A100_80G", "pcie"), "A100-80GB-PCIE");
  assert.equal(gpuFromShadeform("A100_80G", "sxm4"), "A100-80GB-SXM");
  assert.equal(gpuFromShadeform("H100", "pcie"), "H100-80GB-PCIE");
  assert.equal(gpuFromShadeform("H100", "sxm5"), "H100-80GB-SXM");
  for (const [name, ic] of [
    ["A100_80G", undefined], ["A100_80G", "PCIE"], ["A100_80G", "sxm5"], ["H100", "sxm4"], ["H100", null], ["H100", "nvlink"],
    ["A100", "pcie"], ["a6000", undefined], ["", undefined], ["toString", undefined], ["hasOwnProperty", "pcie"], [42, "pcie"],
    // values that only look right once coerced to a string, and inherited names
    [["A6000"], undefined], [["A100_80G"], "pcie"], ["A100_80G", ["pcie"]], ["H100", ["sxm5"]], ["A100_80G", "toString"], ["H100", "__proto__"],
  ] as const) {
    assert.equal(gpuFromShadeform(name, ic), null, `${String(name)} ${String(ic)}`);
  }
});

test("shadeformDataCenter and shadeformCountry: only well-formed names, and only places we know", () => {
  assert.equal(shadeformDataCenter("hyperstack", "canada-1"), "hyperstack/canada-1");
  assert.equal(shadeformDataCenter("datacrunch", "FIN-01"), "datacrunch/FIN-01");
  assert.equal(shadeformDataCenter("a", "b.c_d"), "a/b.c_d");
  assert.equal(shadeformDataCenter("a".repeat(64), "r"), `${"a".repeat(64)}/r`);
  for (const [c, r] of [
    ["hyperstack", "canada/1"], ["hyper stack", "x"], ["", "x"], ["x", ""], ["-x", "y"], ["x", ".y"], [1, "x"], ["x", null],
    [["hyperstack"], "canada-1"], ["hyperstack", ["canada-1"]], ["a".repeat(65), "r"], ["x", "r\n"],
  ] as const) {
    assert.equal(shadeformDataCenter(c, r), null, `${String(c)} ${String(r)}`);
  }
  assert.equal(shadeformCountry("hyperstack/canada-1"), "CA");
  for (const dc of ["hyperstack/CANADA-1", "hyperstack/norway-1", "canada-1", "", "toString", "__proto__"]) assert.equal(shadeformCountry(dc), null, dc);
});

// ---------------------------------------------------------------- errors

test("shadeformError maps statuses to kinds, keeps no body, and reads Retry-After only on 429", () => {
  const cases: Array<[number, string]> = [
    [400, "invalid_request"], [401, "auth"], [402, "insufficient_funds"], [403, "forbidden"], [404, "not_found"],
    [409, "unplaceable"], [422, "invalid_request"], [429, "rate_limited"], [500, "transient"], [503, "transient"],
    [599, "transient"], [418, "unknown"], [600, "unknown"], [300, "unknown"],
  ];
  for (const [status, kind] of cases) {
    const e = shadeformError(status, "7");
    assert.equal(e.kind, kind, String(status));
    assert.equal(e.provider, "shadeform");
    assert.equal(e.httpStatus, status);
    assert.equal(e.message, `Shadeform HTTP ${status} (${kind})`);
    assert.equal(e.retryAfterSeconds, status === 429 ? 7 : null);
  }
});

test("errors never carry the provider's text or the API key", async () => {
  const echo = `bad request: ${KEY} SBGPU_BOOT_TOKEN=secret`;
  for (const status of [400, 409, 500]) {
    const { a } = adapter([{ status, body: echo }]);
    await assert.rejects(a.status(IID), (e: unknown) => e instanceof ProviderError && !e.message.includes("secret") && !e.message.includes(KEY));
  }
  const { a } = adapter([new Error(`connect failed with ${KEY}`)]);
  await assert.rejects(a.listMachines(), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown" && !e.message.includes(KEY));
  // SEC H1: a fetch error with the key in both its name and its message.
  const poisoned = Object.assign(new Error(`failed ${KEY}`), { name: `X-API-KEY ${KEY}` });
  const p = adapter([poisoned]);
  await assert.rejects(
    p.a.status(IID),
    (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown" && !e.message.includes(KEY) && e.message.endsWith("no response (error)"),
  );
  const t = adapter([Object.assign(new Error(KEY), { name: "TimeoutError" })]);
  await assert.rejects(t.a.terminate(IID), (e: unknown) => e instanceof ProviderError && e.message.endsWith("no response (TimeoutError)"));
});

test("the key goes only in the X-API-KEY header, never in the URL", async () => {
  const { a, calls } = adapter([{ status: 200, body: instance() }]);
  await a.status(IID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.headers["X-API-KEY"], KEY);
  assert.deepEqual(Object.keys(calls[0]!.init.headers).sort(), ["Accept", "X-API-KEY"]);
  assert.ok(!calls[0]!.url.includes(KEY));
  assert.equal(calls[0]!.init.body, undefined);
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
});

// ---------------------------------------------------------------- launch

test("launch refuses (VM mode is not supported) and never reaches the network", async () => {
  const { a, calls } = adapter([]);
  const spec: LaunchSpec = {
    machineId: MID, gpuType: "RTX-A6000", gpuCount: 1, dataCenter: "hyperstack/canada-1", image: "ubuntu",
    diskGb: 40, bootToken: "test-token-not-a-secret", launcher: ["/bin/sh", "-c", "x"], maxProviderCostPerHour: 10_000_000,
  };
  await assert.rejects(
    a.launch(spec, { shouldStop: () => false }),
    (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request" && e.providerMachineId === null && /VM mode is not supported/.test(e.message),
  );
  await assert.rejects(a.launch(spec), ProviderError);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- status

test("instanceStatus reads an instance", () => {
  const s = instanceStatus(instance(), "T");
  assert.deepEqual(s, {
    provider: "shadeform",
    providerMachineId: IID,
    machineId: MID,
    state: "running",
    rawStatus: "active",
    gpuType: "RTX-A6000",
    gpuCount: 1,
    dataCenter: "hyperstack/canada-1",
    image: "ubuntu22.04_cuda12.2",
    diskGb: 500,
    volumeGb: 0,
    envNames: ["SBGPU_BOOT_TOKEN"],
    exposedPorts: [],
    unexpectedSettings: [],
    command: [...VM_COMMAND],
    providerCostPerHour: 2_100_000,
    observedAt: "T",
  });
});

test("instanceStatus maps every documented status; anything else is unknown", () => {
  const cases: Array<[unknown, string]> = [
    ["creating", "provisioning"], ["pending_provider", "provisioning"], ["pending", "provisioning"], ["active", "running"],
    ["error", "failed"], ["deleting", "stopping"], ["deleted", "terminated"], ["ACTIVE", "unknown"], ["", "unknown"],
    ["toString", "unknown"], [null, "unknown"], [3, "unknown"],
  ];
  for (const [status, state] of cases) {
    const s = instanceStatus(instance({ status }), "T");
    assert.equal(s.state, state, String(status));
    assert.equal(s.rawStatus, typeof status === "string" ? status : "");
  }
});

test("instanceStatus: only a missing id throws; other bad fields become unreadable values", () => {
  for (const bad of [null, [], "x", { id: "" }, { id: 3 }, {}]) assert.throws(() => instanceStatus(bad, "T"), ProviderError);
  const s = instanceStatus({ id: "i" }, "T");
  assert.deepEqual(
    [s.machineId, s.state, s.gpuType, s.gpuCount, s.dataCenter, s.image, s.diskGb, s.volumeGb, s.envNames, s.exposedPorts, s.providerCostPerHour],
    [null, "unknown", null, Number.NaN, null, UNREADABLE, Number.NaN, 0, [], [], null],
  );
  assert.deepEqual(s.unexpectedSettings, [`shade_cloud:${UNREADABLE}`, `rental:${UNREADABLE}`]);
  assert.equal(instanceStatus(instance({ name: "someone-else" }), "T").machineId, null);
  assert.equal(instanceStatus(instance({ name: 7 }), "T").machineId, null);
  assert.equal(instanceStatus(instance({ name: [`sbg-${MID}`] }), "T").machineId, null);
  const conf = (c: Record<string, unknown>) => instanceStatus(instance({ configuration: c }), "T");
  assert.deepEqual([conf({ num_gpus: -1 }).gpuCount, conf({ num_gpus: 1.5 }).gpuCount, conf({ num_gpus: "1" }).gpuCount], [NaN, NaN, NaN]);
  assert.equal(conf({ num_gpus: 0 }).gpuCount, 0);
  assert.equal(conf({ storage_in_gb: -5 }).diskGb, Number.NaN);
  assert.equal(conf({ os: 3 }).image, UNREADABLE);
  assert.equal(instanceStatus(instance({ configuration: "x" }), "T").gpuType, null);
});

test("instanceStatus: prices are whole cents per hour", () => {
  const price = (p: unknown) => instanceStatus(instance({ hourly_price: p }), "T").providerCostPerHour;
  assert.equal(price(0), 0);
  assert.equal(price(1), 10_000);
  assert.equal(price(210), 2_100_000);
  for (const p of [-1, 2.5, "210", null, undefined, Number.MAX_SAFE_INTEGER, Number.NaN]) assert.equal(price(p), null, String(p));
});

test("instanceStatus: environment names, ports and volumes, with malformed ones unreadable", () => {
  const st = (over: Record<string, unknown>) => instanceStatus(instance(over), "T");
  assert.deepEqual(st({ envs: null }).envNames, []);
  assert.deepEqual(st({ envs: [] }).envNames, []);
  assert.deepEqual(st({ envs: [{ name: "A", value: "1" }, { name: "B", value: "" }] }).envNames, ["A", "B"]);
  for (const envs of ["x", {}, [{ name: "A" }], [{ name: 1, value: "v" }], [null]]) assert.deepEqual(st({ envs }).envNames, [UNREADABLE], JSON.stringify(envs));
  // The container's own environment counts too.
  const docker = (d: Record<string, unknown>) => st({ launch_configuration: { type: "docker", docker_configuration: d } });
  assert.deepEqual(docker({ envs: [{ name: "X", value: "y" }] }).envNames, ["SBGPU_BOOT_TOKEN", "X"]);
  assert.deepEqual(docker({ envs: "bad" }).envNames, [UNREADABLE]);
  assert.deepEqual(docker({ port_mappings: [{ host_port: 80, container_port: 80 }] }).exposedPorts, ["port_mappings:1"]);
  assert.deepEqual(docker({ port_mappings: "x" }).exposedPorts, [UNREADABLE]);
  assert.deepEqual(docker({ port_mappings: [] }).exposedPorts, []);
  assert.deepEqual(st({ port_forwards: [{ external_port: 22, internal_port: 22 }, {}] }).exposedPorts, ["port_forwards:2"]);
  assert.deepEqual(st({ port_forwards: [] }).exposedPorts, []);
  assert.deepEqual(st({ port_forwards: {} }).exposedPorts, [UNREADABLE]);
  assert.equal(st({ volume_ids: [] }).volumeGb, 0);
  assert.equal(st({ volume_ids: ["v1"] }).volumeGb, Number.POSITIVE_INFINITY);
  assert.equal(st({ volume_ids: [1] }).volumeGb, Number.NaN);
  assert.equal(st({ volume_ids: "v1" }).volumeGb, Number.NaN);
});

test("instanceStatus reports SSH keys, Shade Cloud, rental terms and attachments as unexpected settings", () => {
  const settings = (over: Record<string, unknown>) => instanceStatus(instance(over), "T").unexpectedSettings;
  assert.deepEqual(settings({ ssh_key_id: "k1" }), ["ssh:key"]);
  assert.deepEqual(settings({ ssh_key_id: "" }), ["ssh:key"]);
  assert.deepEqual(settings({ ssh_key_id: undefined }), []);
  assert.deepEqual(settings({ shade_cloud: false }), ["shade_cloud:false"]);
  assert.deepEqual(settings({ shade_cloud: "true" }), [`shade_cloud:${UNREADABLE}`]);
  assert.deepEqual(settings({ rental_terms: { rental_type: "spot" } }), ["rental:spot"]);
  assert.deepEqual(settings({ rental_terms: null }), [`rental:${UNREADABLE}`]);
  assert.deepEqual(settings({ rental_terms: { rental_type: 1 } }), [`rental:${UNREADABLE}`]);
  assert.deepEqual(settings({ template_id: "t" }), ["template_id:set"]);
  assert.deepEqual(settings({ cluster_id: "c" }), ["cluster_id:set"]);
  assert.deepEqual(settings({ commitment_id: 4 }), [`commitment_id:${UNREADABLE}`]);
});

test("no Shadeform machine ever matches a launch spec: the command never equals a launcher", () => {
  const spec: LaunchSpec = {
    machineId: MID, gpuType: "RTX-A6000", gpuCount: 1, dataCenter: "hyperstack/canada-1", image: "ubuntu22.04_cuda12.2",
    diskGb: 500, bootToken: "t", launcher: ["/bin/sh", "-c", "x"], maxProviderCostPerHour: 10_000_000,
  };
  const a = new ShadeformAdapter({ apiKey: KEY, fetch: mockFetch([]).fetch });
  const drift = specDrift(expectedSpec(spec, a.info, IID), instanceStatus(instance(), "T"));
  assert.deepEqual(drift.map((d) => d.field), ["command"]);
});

test("status reads one instance; a gone one is terminated; another instance's answer is an error", async () => {
  const ok = adapter([{ status: 200, body: instance() }]);
  assert.equal((await ok.a.status(IID)).state, "running");
  assert.equal(ok.calls[0]!.url, `https://api.shadeform.ai/v1/instances/${IID}/info`);
  assert.equal(ok.calls[0]!.init.method, "GET");
  const gone = adapter([{ status: 404, body: "no such instance" }]);
  const g = await gone.a.status(IID);
  assert.deepEqual([g.state, g.providerMachineId, g.rawStatus, g.observedAt], ["terminated", IID, "NOT_FOUND", NOW.toISOString()]);
  const other = adapter([{ status: 200, body: instance({ id: "other" }) }]);
  await assert.rejects(other.a.status(IID), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  // A redirect is not an answer, even with a well-formed body.
  for (const reply of [{ status: 400 }, { status: 500 }, { status: 200, body: "not json" }, { status: 200 }, { status: 302, body: instance() }, { status: 300, body: instance() }] as Reply[]) {
    const { a } = adapter([reply]);
    await assert.rejects(a.status(IID), ProviderError);
  }
  const enc = adapter([{ status: 404 }]);
  await enc.a.status("a/b?c");
  assert.equal(enc.calls[0]!.url, "https://api.shadeform.ai/v1/instances/a%2Fb%3Fc/info");
});

test("a read with an unreadable reply is unknown; a POST with one is outcome_unknown", async () => {
  const read = adapter([{ status: 200, body: "<html>" }]);
  await assert.rejects(read.a.listMachines(), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && e.httpStatus === 200);
  const post = adapter([{ status: 200, body: "<html>" }]);
  await assert.rejects(post.a.terminate(IID), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown");
});

// ---------------------------------------------------------------- terminate

test("terminate: accepted, already gone, or refused while on its way out are all done", async () => {
  const ok = adapter([{ status: 200 }]);
  await ok.a.terminate(IID);
  assert.equal(ok.calls[0]!.url, `https://api.shadeform.ai/v1/instances/${IID}/delete`);
  assert.equal(ok.calls[0]!.init.method, "POST");
  assert.equal(ok.calls.length, 1);
  await adapter([{ status: 200, body: { ok: true } }]).a.terminate(IID);
  await adapter([{ status: 404, body: "gone" }]).a.terminate(IID);
  for (const status of ["deleting", "deleted"]) {
    const r = adapter([{ status: 409, body: { error: "x", error_code: "y" } }, { status: 200, body: instance({ status }) }]);
    await r.a.terminate(IID);
    assert.equal(r.calls.length, 2);
  }
  await adapter([{ status: 409 }, { status: 404 }]).a.terminate(IID);
});

test("terminate fails on a refusal for a live instance, and on any other error", async () => {
  for (const status of ["active", "pending", "error", "weird"]) {
    const r = adapter([{ status: 409 }, { status: 200, body: instance({ status }) }]);
    await assert.rejects(r.a.terminate(IID), (e: unknown) => e instanceof ProviderError && e.httpStatus === 409, status);
  }
  await assert.rejects(adapter([{ status: 409 }, { status: 500 }]).a.terminate(IID), (e: unknown) => e instanceof ProviderError && e.httpStatus === 500);
  for (const reply of [{ status: 400 }, { status: 401 }, { status: 500 }, new Error("reset")] as Reply[]) {
    const r = adapter([reply]);
    await assert.rejects(r.a.terminate(IID), ProviderError);
    assert.equal(r.calls.length, 1);
  }
  await assert.rejects(adapter([new TypeError("x")]).a.terminate(IID), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown");
});

// ---------------------------------------------------------------- offers

test("listOffers asks for Shade Cloud types with the GPU count and maps them", async () => {
  const { a, calls } = adapter([{ status: 200, body: { instance_types: [instanceType()] } }]);
  assert.deepEqual(await a.listOffers({ gpuCount: 1 }), [
    {
      provider: "shadeform",
      gpuType: "RTX-A6000",
      gpuCount: 1,
      dataCenter: "hyperstack/canada-1",
      country: "CA",
      providerCostPerHour: 500_000,
      stock: "unknown",
      observedAt: NOW.toISOString(),
    },
  ]);
  assert.equal(calls[0]!.url, "https://api.shadeform.ai/v1/instances/types?num_gpus=1&shade_cloud=true");
  assert.equal(calls[0]!.init.method, "GET");
});

test("listOffers skips what it can't offer", async () => {
  const avail = (o: Record<string, unknown>) => ({ region: "canada-1", available: true, rental_type: "on_demand", ...o });
  const types = [
    instanceType({}, { num_gpus: 2 }), // another count than asked
    instanceType({}, { gpu_type: "B200" }), // a GPU we don't map
    instanceType({}, { gpu_type: "H100", interconnect: "mystery" }),
    instanceType({ hourly_price: 0 }),
    instanceType({ hourly_price: "50" }),
    instanceType({ hourly_price: -5 }),
    instanceType({ cloud: "lambda" }), // a place we don't know the country of
    instanceType({ cloud: "bad cloud" }),
    instanceType({ availability: [avail({ rental_type: "spot" }), avail({ available: "yes" }), avail({ region: "norway-1" }), avail({ region: 7 }), null] }),
    instanceType({ availability: "x" }),
    instanceType({ configuration: null }),
    null,
    "x",
  ];
  const { a } = adapter([{ status: 200, body: { instance_types: types } }]);
  assert.deepEqual(await a.listOffers({ gpuCount: 1 }), []);
});

test("listOffers: one offer per GPU and place, the cheapest, preferring one that can launch at a tie", async () => {
  const at = (available: boolean) => [{ region: "canada-1", available, rental_type: "on_demand" }];
  const types = [
    instanceType({ hourly_price: 80, availability: at(true) }),
    instanceType({ hourly_price: 60, availability: at(false) }),
    instanceType({ hourly_price: 60, availability: at(true) }),
    instanceType({ hourly_price: 60, availability: at(false) }),
    instanceType({ hourly_price: 70, availability: at(true) }),
    instanceType({ hourly_price: 40, availability: at(true) }, { gpu_type: "A40" }),
  ];
  const { a } = adapter([{ status: 200, body: { instance_types: types } }]);
  const offers = await a.listOffers({ gpuCount: 1 });
  assert.deepEqual(offers.map((o) => [o.gpuType, o.providerCostPerHour, o.stock]), [["RTX-A6000", 600_000, "unknown"], ["A40", 400_000, "unknown"]]);
  const none = adapter([{ status: 200, body: { instance_types: [instanceType({ availability: at(false) })] } }]);
  assert.equal((await none.a.listOffers({ gpuCount: 1 }))[0]!.stock, "none");
});

test("listOffers: a malformed catalog fails, and so does a bad GPU count, before any request", async () => {
  for (const body of [{}, { instance_types: null }, { instance_types: {} }, [], "x"]) {
    const { a } = adapter([{ status: 200, body }]);
    await assert.rejects(a.listOffers({ gpuCount: 1 }), (e: unknown) => e instanceof ProviderError && e.kind === "unknown", JSON.stringify(body));
  }
  for (const gpuCount of [0, -1, 1.5, Number.NaN]) {
    const { a, calls } = adapter([]);
    await assert.rejects(a.listOffers({ gpuCount }), RangeError);
    assert.equal(calls.length, 0);
  }
  const eight = adapter([{ status: 200, body: { instance_types: [instanceType({}, { num_gpus: 8 })] } }]);
  assert.equal((await eight.a.listOffers({ gpuCount: 8 }))[0]!.gpuCount, 8);
  assert.match(eight.calls[0]!.url, /num_gpus=8/);
});

// ---------------------------------------------------------------- machine list

const page = (instances: unknown[], total: number) => ({ status: 200, body: { instances, total } });
const ours = (i: number) => instance({ id: `i${i}`, name: `sbg-mch_${String(i).padStart(20, "0")}` });

test("listMachines reads every page by offset and keeps only our machines", async () => {
  const first = Array.from({ length: 100 }, (_, i) => (i === 5 ? instance({ id: "x", name: "not-ours" }) : ours(i)));
  const { a, calls } = adapter([page(first, 103), page([ours(100), ours(101), ours(102)], 103)]);
  const list = await a.listMachines();
  assert.equal(list.length, 102);
  assert.ok(list.every((s) => s.machineId !== null));
  assert.deepEqual(calls.map((c) => c.url), [
    "https://api.shadeform.ai/v1/instances?limit=100&offset=0",
    "https://api.shadeform.ai/v1/instances?limit=100&offset=100",
  ]);
  const empty = adapter([page([], 0)]);
  assert.deepEqual(await empty.a.listMachines(), []);
  assert.equal(empty.calls.length, 1);
  const exact = adapter([page(Array.from({ length: 100 }, (_, i) => ours(i)), 100)]);
  assert.equal((await exact.a.listMachines()).length, 100);
  assert.equal(exact.calls.length, 1);
});

test("listMachines fails on a list that is malformed, short, moving or too long", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ours(i));
  const bad: Array<[string, Reply[]]> = [
    ["no instances", [{ status: 200, body: { total: 0 } }]],
    ["no total", [{ status: 200, body: { instances: [] } }]],
    ["a null total", [{ status: 200, body: { instances: [], total: null } }]],
    ["a negative total", [page([], -1)]],
    ["a fractional total", [page([], 0.5)]],
    ["not an object", [{ status: 200, body: [] }]],
    ["a short first page", [page([ours(1)], 2), page([ours(2)], 2)]],
    ["a long page", [page([ours(1), ours(2)], 1)]],
    ["a short last page", [page(full, 103), page([ours(100)], 103), page([ours(101), ours(102)], 103)]],
    // Each page is the right length for the total it reports, but the total moved.
    ["a total that grew", [page(full, 103), page([ours(100), ours(101), ours(102), ours(103)], 104)]],
    ["a total that shrank", [page(full, 103), page([ours(100), ours(101)], 102)]],
    ["an instance without an id", [page([{ name: "x" }], 1)]],
    ["an error on page two", [page(full, 103), { status: 500 }]],
    // LIMITS H1: a repeated instance, within a page or across pages, foreign ones included.
    ["the same full page twice", [page(full, 200), page(full, 200)]],
    ["one row repeated on the next page", [page(full, 101), page([ours(0)], 101)]],
    ["a row twice in one page", [page([ours(1), ours(1)], 2)]],
    ["a foreign row twice", [page([instance({ id: "f", name: "a" }), instance({ id: "f", name: "b" })], 2)]],
    ["a foreign id reused by one of ours", [page([instance({ id: "i1", name: "x" }), ours(1)], 2)]],
    // LIMITS H2: a row whose name doesn't read as a string fails the whole list, even after a good page.
    ["a row without a name", [page([instance({ id: "n", name: undefined })], 1)]],
    ["a row with a null name", [page([instance({ id: "n", name: null })], 1)]],
    ["a row with a numeric name", [page([instance({ id: "n", name: 42 })], 1)]],
    ["a row with an array name", [page([instance({ id: "n", name: [`sbg-${MID}`] })], 1)]],
    ["a nameless row on page two", [page(full, 101), page([instance({ id: "n", name: null })], 101)]],
  ];
  for (const [what, replies] of bad) {
    const { a } = adapter(replies);
    // Every one is our own refusal, not a later request that happened to fail.
    await assert.rejects(a.listMachines(), (e: unknown) => e instanceof ProviderError && e.kind !== "outcome_unknown", what);
  }
  const huge = Array.from({ length: 50 }, (_, p) => page(Array.from({ length: 100 }, (_, i) => ours(p * 100 + i)), 5001));
  const { a, calls } = adapter(huge);
  await assert.rejects(a.listMachines(), (e: unknown) => e instanceof ProviderError && /more than 50 pages/.test(e.message));
  assert.equal(calls.length, 50);
});

test("listMachines: names that read as strings but aren't ours are skipped, not refused", async () => {
  const rows = [instance({ id: "a", name: "" }), instance({ id: "b", name: "web-1" }), instance({ id: "c", name: "sbg-bad" }), ours(1)];
  const { a } = adapter([page(rows, 4)]);
  assert.deepEqual((await a.listMachines()).map((s) => s.providerMachineId), ["i1"]);
});

test("listMachines: a failure on a later page returns nothing, not the earlier pages", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ours(i));
  const { a, calls } = adapter([page(full, 101), page([ours(0)], 101)]);
  let result: unknown = "unset";
  await a.listMachines().then((r) => { result = r; }, () => {});
  assert.equal(result, "unset");
  assert.equal(calls.length, 2);
});

test("listMachines reads exactly 50 full pages when that is the whole list", async () => {
  const pages = Array.from({ length: 50 }, (_, p) => page(Array.from({ length: 100 }, (_, i) => ours(p * 100 + i)), 5000));
  const { a } = adapter(pages);
  assert.equal((await a.listMachines()).length, 5000);
});

// ---------------------------------------------------------------- status first

test("#call: every request is redirect: manual", async () => {
  const { a, calls } = adapter([{ status: 404 }]);
  await a.status(IID);
  assert.equal(calls[0]!.init.redirect, "manual");
});

test("#call: a non-2xx is classified with no body read; status and Retry-After kept", async () => {
  const cases: Array<[number, string, number | null]> = [
    [0, "unknown", null], [199, "unknown", null], [302, "unknown", null], [401, "auth", null],
    [404, "not_found", null], [429, "rate_limited", 7], [500, "transient", null],
  ];
  for (const [status, kind, retry] of cases) {
    const g = adapter([{ status, textThrows: true, headers: { "Retry-After": "7" } }]);
    await assert.rejects(g.a.listOffers({ gpuCount: 1 }), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, kind, String(status));
      assert.equal(e.httpStatus, status);
      assert.equal(e.retryAfterSeconds, retry);
      return true;
    });
    assert.equal(g.reads.n, 0, String(status));
  }
  // A 404 is still gone, unread.
  const s = adapter([{ status: 404, textThrows: true }]);
  assert.equal((await s.a.status(IID)).state, "terminated");
  assert.equal(s.reads.n, 0);
});

test("#call: a 2xx body that can't be read is outcome_unknown, naming no key", async () => {
  const g = adapter([{ status: 200, textThrows: true }]);
  await assert.rejects(g.a.listOffers({ gpuCount: 1 }), (e: unknown) => {
    assert.ok(e instanceof ProviderError && e.kind === "outcome_unknown" && e.httpStatus === 200);
    assert.ok(!e.message.includes(KEY) && !e.message.includes("stream cut"));
    return true;
  });
  assert.equal(g.reads.n, 1);
});
