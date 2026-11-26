import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { driftMarkers, expectedSpec, isDriftMarker, specDrift } from "../drift.ts";
import { ProviderError } from "../errors.ts";
import type { Fetch, HttpRequest } from "../http.ts";
import { launchWithFallback } from "../placement.ts";
import type { LaunchSpec, Offer } from "../types.ts";
import {
  allowedRequest,
  instanceStatus,
  MAX_ARGS,
  MAX_COMMAND_CHARS,
  MAX_ENV,
  MAX_IMAGE_CHARS,
  MAX_LIST_CHARS,
  MAX_PAGES,
  MAX_PORTS,
  OFFER_DISK_GB,
  retainedChars,
  UNREADABLE,
  VastAdapter,
  vastError,
  vastState,
} from "./adapter.ts";
import { gpuFromVast, gpuToVast, VAST_GPUS, vastCountry, vastDataCenter, vastFilterName, vastMachineId } from "./catalog.ts";

const KEY = "test-key-not-a-real-key";
const MID = "mch_7f3k9q2m4x8z1c5v6b0n";
const NOW = new Date("2026-11-25T12:00:00.000Z");
const T = NOW.toISOString();
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";

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
    const bytes = new TextEncoder().encode(text);
    let sent = false;
    return {
      status: r.status,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => {
        throw new Error("text() must not be called: bodies are read as bounded streams");
      },
      body: new ReadableStream<Uint8Array>({
        pull(ctl) {
          if (!sent) reads.n++;
          if (r.textThrows === true) return ctl.error(new Error(`stream cut ${KEY}`));
          if (sent) return ctl.close();
          sent = true;
          if (bytes.length > 0) ctl.enqueue(bytes);
          else ctl.close();
        },
      }, { highWaterMark: 0 }),
    };
  };
  return { fetch, calls, reads };
}

function adapter(replies: Reply[]) {
  const m = mockFetch(replies);
  return { a: new VastAdapter({ apiKey: KEY, fetch: m.fetch, now: () => NOW }), calls: m.calls, reads: m.reads };
}

/** An offer as Vast's search reference describes it. */
function offer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    ask_contract_id: 9001,
    machine_id: 4242,
    host_id: 77,
    gpu_name: "RTX 4090",
    gpu_ram: 24564,
    num_gpus: 1,
    geolocation: "Stockholm, SE",
    dph_total: 0.45,
    reliability: 0.995,
    rentable: true,
    rented: false,
    is_bid: false,
    verification: "verified",
    datacenter: true,
    ...over,
  };
}

const SPEC: LaunchSpec = {
  machineId: MID,
  gpuType: "RTX-4090",
  gpuCount: 1,
  dataCenter: "machine-4242",
  image: "ghcr.io/sagemathinc/sbg-runtime@sha256:" + "a".repeat(64),
  diskGb: 40,
  bootToken: TOKEN,
  launcher: ["/sbg/launcher", "--boot"],
  maxProviderCostPerHour: 600_000,
};

/** An instance as Vast's show-instance reference describes it, in our launch shape. */
function inst(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 31337,
    label: `sbg-${MID}`,
    actual_status: "running",
    intended_status: "running",
    machine_id: 4242,
    gpu_name: "RTX 4090",
    gpu_ram: 24564,
    num_gpus: 1,
    image_uuid: SPEC.image,
    image_runtype: "args",
    image_args: [...SPEC.launcher],
    extra_env: [`SBGPU_BOOT_TOKEN=${TOKEN}`],
    onstart: null,
    jupyter_token: null,
    template_id: null,
    template_hash_id: null,
    disk_space: 40,
    volume_info: null,
    is_bid: false,
    verification: "verified",
    dph_total: 0.47,
    ...over,
  };
}

const ok = (body: unknown): Reply => ({ status: 200, body });

// ---------------------------------------------------------------- catalog

test("catalog: GPU names with their memory, filter names, countries, machine ids", () => {
  assert.equal(gpuFromVast("RTX 4090", 24564), "RTX-4090");
  // One Vast name, two sizes: the 40 GB A100 is never our 80 GB type
  assert.equal(gpuFromVast("A100 PCIE", 40960), null);
  assert.equal(gpuFromVast("A100 PCIE", 81920), "A100-80GB-PCIE");
  for (const ram of [undefined, null, "24564", Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(gpuFromVast("RTX 4090", ram), null);
  assert.equal(gpuFromVast("RTX 9999", 99999), null);
  assert.equal(gpuFromVast("constructor", 99999), null);
  assert.equal(gpuToVast("H100-80GB-SXM"), "H100 SXM");
  assert.equal(gpuToVast("B200"), null);
  for (const [name, ours] of Object.entries(VAST_GPUS)) assert.equal(gpuToVast(ours), name);
  assert.equal(vastFilterName("RTX 6000Ada"), "RTX_6000Ada");
  assert.equal(vastCountry("California, US"), "US");
  assert.equal(vastCountry("Stockholm, SE"), "SE");
  for (const bad of ["US", "Somewhere", "x, usa", "x, U", 7, null]) assert.equal(vastCountry(bad), null);
  assert.equal(vastDataCenter(4242), "machine-4242");
  for (const bad of [0, -1, 1.5, "4242", null, Number.MAX_SAFE_INTEGER + 1]) assert.equal(vastDataCenter(bad), null);
  assert.equal(vastMachineId("machine-4242"), 4242);
  for (const bad of ["machine-0", "machine-042", "machine-", "EU-SE-1", "machine-4242 ", "machine-1e3"]) assert.equal(vastMachineId(bad), null);
});

// ---------------------------------------------------------------- errors and states

test("errors: a 404 means a bad key on a search, a gone offer on a create, a gone instance elsewhere", () => {
  assert.equal(vastError(404, null, "offers").kind, "auth");
  assert.equal(vastError(404, null, "create").kind, "no_capacity");
  assert.equal(vastError(410, null, "create").kind, "no_capacity");
  assert.equal(vastError(404, null, "instance").kind, "not_found");
  assert.equal(vastError(410, null, "instance").kind, "unknown");
  assert.equal(vastError(401, null, "instance").kind, "auth");
  assert.equal(vastError(402, null, "create").kind, "insufficient_funds");
  assert.equal(vastError(403, null, "create").kind, "forbidden");
  assert.equal(vastError(400, null, "create").kind, "invalid_request");
  assert.equal(vastError(409, null, "create").kind, "unplaceable");
  assert.equal(vastError(503, null, "instance").kind, "transient");
  assert.equal(vastError(302, null, "instance").kind, "unknown");
  assert.equal(vastError(0, null, "instance").kind, "unknown");
  const rl = vastError(429, "7", "offers");
  assert.equal(rl.kind, "rate_limited");
  assert.equal(rl.retryAfterSeconds, 7);
  assert.equal(rl.message, "Vast HTTP 429 (rate_limited)");
});

test("states: running only when both statuses say so; stopped, exited, offline are failed", () => {
  assert.equal(vastState("running", "running"), "running");
  for (const a of [null, "created", "loading", "scheduling"]) assert.equal(vastState(a, "running"), "provisioning");
  for (const a of ["exited", "unknown", "offline"]) assert.equal(vastState(a, "running"), "failed");
  assert.equal(vastState("running", "stopped"), "failed");
  assert.equal(vastState("stopped", "running"), "failed");
  assert.equal(vastState("running", undefined), "unknown");
  assert.equal(vastState("weird", "running"), "unknown");
});

// ---------------------------------------------------------------- the instance shape

test("an instance in our launch shape has no drift", () => {
  const s = instanceStatus(inst(), T);
  assert.deepEqual(s, {
    provider: "vast",
    providerMachineId: "31337",
    machineId: MID,
    state: "running",
    rawStatus: "running/running",
    gpuType: "RTX-4090",
    gpuCount: 1,
    dataCenter: "machine-4242",
    image: SPEC.image,
    diskGb: 40,
    volumeGb: 0,
    envNames: ["SBGPU_BOOT_TOKEN"],
    exposedPorts: [],
    unexpectedSettings: [],
    command: [...SPEC.launcher],
    providerCostPerHour: 470_000,
    observedAt: T,
  });
  const a = new VastAdapter({ apiKey: KEY, fetch: mockFetch([]).fetch });
  assert.deepEqual(specDrift(expectedSpec(SPEC, a.info, "31337"), s), []);
  // never a value of an environment variable
  assert.ok(!JSON.stringify(s).includes(TOKEN));
  // the env pair form reads the same
  assert.deepEqual(instanceStatus(inst({ extra_env: [["SBGPU_BOOT_TOKEN", TOKEN]] }), T).envNames, ["SBGPU_BOOT_TOKEN"]);
});

test("every way out of our launch shape drifts, and unreadable fields fail closed", () => {
  const settings = (over: Record<string, unknown>) => instanceStatus(inst(over), T).unexpectedSettings;
  assert.deepEqual(settings({ image_runtype: "ssh" }), ["runtype:ssh"]);
  assert.deepEqual(settings({ image_runtype: undefined }), [`runtype:${UNREADABLE}`]);
  assert.deepEqual(settings({ is_bid: true }), ["bid:true"]);
  assert.deepEqual(settings({ is_bid: undefined }), [`bid:${UNREADABLE}`]);
  assert.deepEqual(settings({ onstart: "curl x | sh" }), ["onstart:set"]);
  assert.deepEqual(settings({ onstart: 7 }), [`onstart:${UNREADABLE}`]);
  assert.deepEqual(settings({ onstart: "" }), []);
  assert.deepEqual(settings({ jupyter_token: "tok" }), ["jupyter:set"]);
  assert.deepEqual(settings({ template_hash_id: "abc" }), ["template:template_hash_id"]);
  assert.deepEqual(settings({ verification: "unverified" }), ["verification:unverified"]);
  assert.deepEqual(settings({ verification: undefined }), [`verification:${UNREADABLE}`]);
  // settings values are never echoed beyond a short word
  assert.ok(!JSON.stringify(settings({ onstart: "secret-onstart-text" })).includes("secret"));
  const s = (over: Record<string, unknown>) => instanceStatus(inst(over), T);
  assert.deepEqual(s({ ports: { "22/tcp": [{ HostPort: "40022" }] } }).exposedPorts, ["22/tcp"]);
  assert.deepEqual(s({ ports: "22" }).exposedPorts, [UNREADABLE]);
  assert.equal(s({ volume_info: { volume_id: 1 } }).volumeGb, Number.POSITIVE_INFINITY);
  for (const env of ["SBGPU_BOOT_TOKEN=x", [7], ["-p 22:22"], ["NOEQUALS"], [["A"]], [["A", 1]]]) assert.deepEqual(s({ extra_env: env }).envNames, [UNREADABLE], JSON.stringify(env));
  assert.deepEqual(s({ extra_env: ["A=1", "SBGPU_BOOT_TOKEN=x"] }).envNames, ["A", "SBGPU_BOOT_TOKEN"]);
  // a name that isn't a variable name is unreadable, with or without "="
  for (const env of [["1A=x"], ["A B=x"], ["=x"], [`${"N".repeat(129)}=x`], [["1A", "x"]]]) assert.deepEqual(s({ extra_env: env }).envNames, [UNREADABLE], JSON.stringify(env));
  assert.deepEqual(s({ extra_env: [`${"N".repeat(128)}=x`] }).envNames, ["N".repeat(128)]);
  assert.deepEqual(s({ image_args: [1] }).command, [UNREADABLE]);
  assert.deepEqual(s({ image_args: null }).command, [UNREADABLE]);
  assert.ok(Number.isNaN(s({ disk_space: 40.5 }).diskGb));
  assert.equal(s({ dph_total: -1 }).providerCostPerHour, null);
  assert.equal(s({ gpu_ram: 1000 }).gpuType, null);
  assert.equal(s({ label: "someone-else" }).machineId, null);
  assert.equal(s({ machine_id: "4242" }).dataCenter, null);
  const a = new VastAdapter({ apiKey: KEY, fetch: mockFetch([]).fetch });
  for (const over of [{ image_runtype: "ssh" }, { extra_env: [] }, { image_args: ["/bin/sh"] }, { ports: { "8080/tcp": [] } }, { dph_total: 0.61 }, { volume_info: {} }]) {
    assert.ok(specDrift(expectedSpec(SPEC, a.info, "31337"), s(over)).length > 0, JSON.stringify(over));
  }
  assert.throws(() => instanceStatus(inst({ id: "31337" }), T), ProviderError);
  assert.throws(() => instanceStatus(null, T), ProviderError);
});

// ---------------------------------------------------------------- offers

test("offers: one search with every hard rule, each checked again on the reply", async () => {
  const offers = [
    offer(),
    offer({ id: 9002, dph_total: 0.41 }), // the same machine, cheaper: kept instead
    offer({ id: 9003, machine_id: 5000, geolocation: "Oregon, US", dph_total: 0.5 }),
    offer({ id: 9004, machine_id: 5001, gpu_name: "A100 PCIE", gpu_ram: 40960 }), // a 40 GB A100
    offer({ id: 9005, machine_id: 5002, is_bid: true }),
    offer({ id: 9006, machine_id: 5003, verification: "unverified" }),
    offer({ id: 9007, machine_id: 5004, rented: true }),
    offer({ id: 9008, machine_id: 5005, reliability: 0.9 }),
    offer({ id: 9009, machine_id: 5006, num_gpus: 2 }),
    offer({ id: 9010, machine_id: 5007, geolocation: "Nowhere" }),
    offer({ id: 9011, machine_id: 5008, rentable: false }),
    offer({ id: 9012, machine_id: 5009, dph_total: 0 }),
    offer({ id: "9013", machine_id: 5010 }),
    "not an offer",
  ];
  const { a, calls, reads } = adapter([ok({ offers })]);
  const got = await a.listOffers({ gpuCount: 1 });
  assert.deepEqual(got, [
    { provider: "vast", gpuType: "RTX-4090", gpuCount: 1, dataCenter: "machine-4242", country: "SE", providerCostPerHour: 410_000, stock: "unknown", observedAt: T },
    { provider: "vast", gpuType: "RTX-4090", gpuCount: 1, dataCenter: "machine-5000", country: "US", providerCostPerHour: 500_000, stock: "unknown", observedAt: T },
  ]);
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.url, "https://console.vast.ai/api/v0/bundles");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers["Authorization"], `Bearer ${KEY}`);
  const body = JSON.parse(c.init.body!);
  assert.deepEqual(body, {
    limit: 1000,
    type: "ondemand",
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    datacenter: { eq: true },
    reliability: { gte: 0.98 },
    num_gpus: { eq: 1 },
    gpu_name: { in: Object.keys(VAST_GPUS).map(vastFilterName) },
    allocated_storage: OFFER_DISK_GB,
    order: [["dph_total", "asc"]],
  });
  assert.equal(reads.n, 1);
  await assert.rejects(a.listOffers({ gpuCount: 0 }), RangeError);
});

test("offers: rented must be exactly false and datacenter exactly true in the reply, for listing and for launch", async () => {
  // hosting evidence and rental state are read from each reply, never assumed from the request
  const bad = [
    { rented: undefined },
    { rented: null },
    { rented: "false" },
    { rented: 0 },
    { rented: true },
    { datacenter: undefined },
    { datacenter: null },
    { datacenter: "true" },
    { datacenter: 1 },
    { datacenter: false },
    { datacenter: false, hosting_type: 0 },
  ];
  for (const over of bad) {
    const { a } = adapter([ok({ offers: [offer(over)] })]);
    assert.deepEqual(await a.listOffers({ gpuCount: 1 }), [], JSON.stringify(over));
    const l = adapter([ok({ offers: [offer(over)] })]);
    await assert.rejects(l.a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "no_capacity", JSON.stringify(over));
    assert.equal(l.calls.length, 1, "no create");
  }
  // the permanent positive: exact false and exact true
  const { a } = adapter([ok({ offers: [offer({ rented: false, datacenter: true })] })]);
  assert.equal((await a.listOffers({ gpuCount: 1 })).length, 1);
});

test("retainedChars counts every kept text field", () => {
  const s = instanceStatus(inst({ image_uuid: "img", image_args: ["ab", "c"], extra_env: ["A=1", "BB=2"], ports: { "1/tcp": [] }, image_runtype: "ssh" }), T);
  const want =
    "31337".length + MID.length + "running/running".length + "RTX-4090".length + "machine-4242".length + "img".length + "A".length + "BB".length + "1/tcp".length + "runtype:ssh".length + "ab".length + "c".length + T.length;
  assert.equal(retainedChars(s), want);
});

test("offers: a malformed reply fails; a bad key (Vast's 404 on a search) is auth, its body never read", async () => {
  for (const body of [{ offers: offer() }, {}, [], "x"]) {
    const { a } = adapter([ok(body)]);
    await assert.rejects(a.listOffers({ gpuCount: 1 }), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  }
  for (const status of [404, 401]) {
    const { a, reads } = adapter([{ status, body: { error: `echo ${KEY}` } }]);
    await assert.rejects(a.listOffers({ gpuCount: 1 }), (e: unknown) => e instanceof ProviderError && e.kind === "auth" && !e.message.includes(KEY));
    assert.equal(reads.n, 0);
  }
});

// ---------------------------------------------------------------- launch

test("launch: the machine's offer again, then the create, then the readback", async () => {
  const { a, calls } = adapter([ok({ offers: [offer({ id: 9100 })] }), ok({ success: true, new_contract: 31337 }), ok({ instances: inst() })]);
  const r = await a.launch(SPEC);
  assert.equal(r.providerMachineId, "31337");
  assert.equal(r.status.state, "running");
  assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url}`), [
    "POST https://console.vast.ai/api/v0/bundles",
    "PUT https://console.vast.ai/api/v0/asks/9100",
    "GET https://console.vast.ai/api/v0/instances/31337",
  ]);
  // the search: this machine, this GPU, this launch's disk
  const search = JSON.parse(calls[0]!.init.body!);
  assert.deepEqual([search.machine_id, search.gpu_name, search.allocated_storage, search.limit], [{ eq: 4242 }, { eq: "RTX_4090" }, 40, 10]);
  // the create body: exactly our launch shape, nothing else
  assert.deepEqual(JSON.parse(calls[1]!.init.body!), {
    image: SPEC.image,
    label: `sbg-${MID}`,
    disk: 40,
    runtype: "args",
    args: [...SPEC.launcher],
    env: `-e SBGPU_BOOT_TOKEN=${TOKEN}`,
    target_state: "running",
    cancel_unavail: true,
    vm: false,
  });
  for (const c of calls) assert.equal(c.init.headers["Authorization"], `Bearer ${KEY}`);
});

test("launch: no usable offer now, or one above the cap: nothing is created", async () => {
  for (const offers of [[], [offer({ machine_id: 5000 })], [offer({ gpu_ram: 1000 })], [offer({ is_bid: true })]]) {
    const { a, calls } = adapter([ok({ offers })]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "no_capacity");
    assert.equal(calls.length, 1);
  }
  const { a, calls } = adapter([ok({ offers: [offer({ dph_total: 0.61 })] })]);
  await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "unplaceable" && e.providerMachineId === null);
  assert.equal(calls.length, 1);
});

test("launch: the offer gone at create (404, 410) is no capacity; a refusal passes through", async () => {
  for (const [status, kind] of [[404, "no_capacity"], [410, "no_capacity"], [403, "forbidden"], [400, "invalid_request"], [402, "insufficient_funds"]] as const) {
    const { a, calls } = adapter([ok({ offers: [offer()] }), { status }]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === kind && e.providerMachineId === null);
    assert.equal(calls.length, 2, String(status));
  }
});

test("launch: a lost create reply is recovered by exact label, or stays unknown", async () => {
  const listed = (instances: unknown[]) => ok({ success: true, instances, next_token: null });
  // found once: accepted
  {
    const { a, calls } = adapter([ok({ offers: [offer()] }), new TypeError("fetch failed"), listed([inst()]), ok({ instances: inst() })]);
    assert.equal((await a.launch(SPEC)).providerMachineId, "31337");
    const u = new URL(calls[2]!.url);
    assert.equal(u.pathname, "/api/v1/instances");
    assert.deepEqual(JSON.parse(u.searchParams.get("select_filters")!), { label: { eq: `sbg-${MID}` } });
  }
  // a 200 without new_contract may have created one: the same recovery
  {
    const { a } = adapter([ok({ offers: [offer()] }), ok({ success: false }), listed([inst()]), ok({ instances: inst() })]);
    assert.equal((await a.launch(SPEC)).providerMachineId, "31337");
  }
  // a 5xx: the same recovery
  {
    const { a } = adapter([ok({ offers: [offer()] }), { status: 502 }, listed([inst()]), ok({ instances: inst() })]);
    assert.equal((await a.launch(SPEC)).providerMachineId, "31337");
  }
  // none yet: the unknown outcome stands
  {
    const { a } = adapter([ok({ offers: [offer()] }), new TypeError("fetch failed"), listed([])]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown" && e.providerMachineId === null);
  }
  // a filter Vast ignored: other labels never count
  {
    const { a } = adapter([ok({ offers: [offer()] }), new TypeError("fetch failed"), listed([inst({ id: 1, label: "sbg-mch_00000000000000000000" })])]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown");
  }
  // two: unknown, with an id to clean up
  {
    const { a } = adapter([ok({ offers: [offer()] }), new TypeError("fetch failed"), listed([inst({ id: 1 }), inst({ id: 2 })])]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown" && e.providerMachineId === "1");
  }
  // the list can't be read: unknown
  {
    const { a } = adapter([ok({ offers: [offer()] }), new TypeError("fetch failed"), { status: 500 }]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown");
  }
});

test("launch: a created instance that can't be read back, or drifts, is reported with its id", async () => {
  {
    const { a } = adapter([ok({ offers: [offer()] }), ok({ success: true, new_contract: 31337 }), { status: 500 }]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && e.providerMachineId === "31337");
  }
  {
    // another instance's answer, or none
    for (const body of [{ instances: inst({ id: 1 }) }, { instances: null }, {}]) {
      const { a } = adapter([ok({ offers: [offer()] }), ok({ success: true, new_contract: 31337 }), ok(body)]);
      await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.providerMachineId === "31337");
    }
  }
  {
    const { a } = adapter([ok({ offers: [offer()] }), ok({ success: true, new_contract: 31337 }), ok({ instances: inst({ image_runtype: "ssh" }) })]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "spec_mismatch" && e.providerMachineId === "31337");
  }
  {
    const { a } = adapter([ok({ offers: [offer()] }), ok({ success: true, new_contract: 31337 }), ok({ instances: inst({ dph_total: 0.61 }) })]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "price_above_cap" && e.providerMachineId === "31337");
  }
});

test("launch: a stop before any request sends nothing; a stop after the create keeps its id", async () => {
  {
    const { a, calls } = adapter([]);
    await assert.rejects(a.launch(SPEC, { shouldStop: () => true }), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
    assert.equal(calls.length, 0);
  }
  {
    let n = 0;
    // false before the search, its request, the create check and the create request; true after
    const { a, calls } = adapter([ok({ offers: [offer()] }), ok({ success: true, new_contract: 31337 })]);
    await assert.rejects(a.launch(SPEC, { shouldStop: () => ++n > 4 }), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown" && e.providerMachineId === "31337");
    assert.equal(calls.length, 2);
  }
  {
    // stopped between the search and the create: no create
    let n = 0;
    const { a, calls } = adapter([ok({ offers: [offer()] })]);
    await assert.rejects(a.launch(SPEC, { shouldStop: () => ++n > 2 }), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
    assert.equal(calls.length, 1);
  }
});

test("launch: a bad spec is refused before any request", async () => {
  const bad: Array<Partial<LaunchSpec>> = [
    { gpuType: "B200" },
    { dataCenter: "EU-SE-1" },
    { gpuCount: 0 },
    { diskGb: 0 },
    { diskGb: 1.5 },
    { image: "UPPER/case" },
    { image: "x y" },
    { launcher: [] },
    { bootToken: "" },
    { bootToken: `${TOKEN} -p 22:22` },
    { bootToken: "short" },
    { bootToken: `${TOKEN}=` },
  ];
  for (const over of bad) {
    const { a, calls } = adapter([]);
    await assert.rejects(a.launch({ ...SPEC, ...over }), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request", JSON.stringify(over));
    assert.equal(calls.length, 0);
  }
});

// ---------------------------------------------------------------- status, terminate, list

test("status: one instance; a 404 is gone; anything else that isn't this instance is an error", async () => {
  {
    const { a, calls } = adapter([ok({ instances: inst() })]);
    assert.equal((await a.status("31337")).state, "running");
    assert.equal(calls[0]!.url, "https://console.vast.ai/api/v0/instances/31337");
  }
  {
    const { a } = adapter([{ status: 404 }]);
    const s = await a.status("31337");
    assert.deepEqual([s.state, s.providerMachineId, s.rawStatus], ["terminated", "31337", "NOT_FOUND"]);
  }
  for (const r of [ok({ instances: inst({ id: 1 }) }), ok({ instances: null }), { status: 400 }, { status: 500 }] as Reply[]) {
    const { a } = adapter([r]);
    await assert.rejects(a.status("31337"), ProviderError);
  }
  for (const id of ["", "0", "abc", "1/../2", "12345678901234567"]) {
    const { a, calls } = adapter([]);
    await assert.rejects(a.status(id), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request");
    assert.equal(calls.length, 0);
  }
});

test("terminate: destroy, never stop; gone is done; an unconfirmed destroy is an unknown outcome", async () => {
  {
    const { a, calls } = adapter([ok({ success: true, msg: "Instance destroyed successfully" })]);
    await a.terminate("31337");
    assert.deepEqual([calls[0]!.init.method, calls[0]!.url], ["DELETE", "https://console.vast.ai/api/v0/instances/31337"]);
  }
  {
    const { a } = adapter([{ status: 404 }]);
    await a.terminate("31337");
  }
  for (const [r, kind] of [[ok({ success: false }), "outcome_unknown"], [ok(null), "outcome_unknown"], [{ status: 503 }, "transient"], [new TypeError("x"), "outcome_unknown"], [{ status: 200, body: "{", }, "outcome_unknown"]] as const) {
    const { a } = adapter([r as Reply]);
    await assert.rejects(a.terminate("31337"), (e: unknown) => e instanceof ProviderError && e.kind === kind, JSON.stringify(r));
  }
  {
    const { a, calls } = adapter([]);
    await assert.rejects(a.terminate("31337?x=1"), ProviderError);
    assert.equal(calls.length, 0);
  }
});

test("listMachines: every page by next_token; only our names; a malformed or endless list fails", async () => {
  {
    const { a, calls } = adapter([
      ok({ success: true, instances: [inst({ id: 1 }), inst({ id: 2, label: null })], next_token: "t1" }),
      ok({ success: true, instances: [inst({ id: 3, label: "sbg-mch_aaaaaaaaaaaaaaaaaaaa" })], next_token: null }),
    ]);
    const got = await a.listMachines();
    assert.deepEqual(got.map((s) => s.providerMachineId), ["1", "3"]);
    assert.equal(new URL(calls[0]!.url).searchParams.get("limit"), "25");
    assert.equal(new URL(calls[0]!.url).searchParams.get("after_token"), null);
    assert.equal(new URL(calls[1]!.url).searchParams.get("after_token"), "t1");
  }
  for (const body of [{ instances: [] }, { instances: {}, next_token: null }, { instances: [], next_token: "" }, { instances: [], next_token: 5 }, { instances: [{ label: `sbg-${MID}` }], next_token: null }]) {
    const { a } = adapter([ok(body)]);
    await assert.rejects(a.listMachines(), ProviderError, JSON.stringify(body));
  }
  {
    const pages: Reply[] = Array.from({ length: MAX_PAGES }, (_, i) => ok({ success: true, instances: [], next_token: `t${i}` }));
    const { a, calls } = adapter(pages);
    await assert.rejects(a.listMachines(), /more than 100 pages/);
    assert.equal(calls.length, MAX_PAGES);
  }
  {
    // a stop before a page: nothing more is asked
    const { a, calls } = adapter([]);
    await assert.rejects(a.listMachines({ shouldStop: () => true }), (e: unknown) => e instanceof ProviderError && e.kind === "outcome_unknown");
    assert.equal(calls.length, 0);
  }
});

test("a status keeps bounded fields: at each bound copied, one over unreadable", () => {
  const s = (over: Record<string, unknown>) => instanceStatus(inst(over), T);
  assert.equal(s({ image_uuid: "a".repeat(MAX_IMAGE_CHARS) }).image.length, MAX_IMAGE_CHARS);
  assert.equal(s({ image_uuid: "a".repeat(MAX_IMAGE_CHARS + 1) }).image, UNREADABLE);
  assert.equal(s({ image_args: Array(MAX_ARGS).fill("x") }).command.length, MAX_ARGS);
  assert.deepEqual(s({ image_args: Array(MAX_ARGS + 1).fill("x") }).command, [UNREADABLE]);
  assert.equal(s({ image_args: ["a".repeat(MAX_COMMAND_CHARS - 1), "b"] }).command.length, 2);
  assert.deepEqual(s({ image_args: ["a".repeat(MAX_COMMAND_CHARS), "b"] }).command, [UNREADABLE]);
  assert.equal(s({ extra_env: Array.from({ length: MAX_ENV }, (_, i) => `E${i}=1`) }).envNames.length, MAX_ENV);
  assert.deepEqual(s({ extra_env: Array.from({ length: MAX_ENV + 1 }, (_, i) => `E${i}=1`) }).envNames, [UNREADABLE]);
  assert.deepEqual(s({ extra_env: [`A=${"v".repeat(9000)}`] }).envNames, [UNREADABLE]);
  // the entry bound, exactly: 8192 characters in all kept, 8193 unreadable
  assert.deepEqual(s({ extra_env: [`A=${"v".repeat(8190)}`] }).envNames, ["A"]);
  assert.deepEqual(s({ extra_env: [`A=${"v".repeat(8191)}`] }).envNames, [UNREADABLE]);
  const ports = (n: number, len = 6) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${String(i).padStart(len - 4, "0")}/tcp`, []]));
  assert.equal(s({ ports: ports(MAX_PORTS) }).exposedPorts.length, MAX_PORTS);
  assert.deepEqual(s({ ports: ports(MAX_PORTS + 1) }).exposedPorts, [UNREADABLE]);
  assert.equal(s({ ports: ports(1, 32) }).exposedPorts[0]!.length, 32);
  assert.deepEqual(s({ ports: ports(1, 33) }).exposedPorts, [UNREADABLE]);
});

test("listMachines: a page longer than asked is refused, not kept", async () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => inst({ id: i + 1 }));
  {
    const { a } = adapter([ok({ success: true, instances: rows(25), next_token: null })]);
    assert.equal((await a.listMachines()).length, 25);
  }
  {
    const { a } = adapter([ok({ success: true, instances: rows(26), next_token: null })]);
    await assert.rejects(a.listMachines(), /more than 25 rows/);
  }
});

test("listMachines: the whole list's retained text is bounded: exactly at the bound kept, one over refused", async () => {
  // rows whose only free text is one command arg: each row's own base (its id's length varies),
  // plus its arg's length
  const baseOf = (i: number) => retainedChars(instanceStatus(inst({ id: i + 1, image_args: [""] }), T));
  const n = Math.ceil(MAX_LIST_CHARS / (baseOf(0) + MAX_COMMAND_CHARS)) + 1;
  const extra = MAX_LIST_CHARS - Array.from({ length: n }, (_, i) => baseOf(i)).reduce((a, b) => a + b, 0);
  const lens = Array.from({ length: n }, (_, i) => Math.floor(extra / n) + (i < extra % n ? 1 : 0));
  assert.ok(lens.every((l) => l >= 0 && l <= MAX_COMMAND_CHARS));
  const pagesOf = (ls: number[]) => {
    const all = ls.map((l, i) => inst({ id: i + 1, image_args: ["x".repeat(l)] }));
    const out: Reply[] = [];
    for (let i = 0; i < all.length; i += 25) out.push(ok({ success: true, instances: all.slice(i, i + 25), next_token: i + 25 < all.length ? `t${i}` : null }));
    return out;
  };
  {
    const { a } = adapter(pagesOf(lens));
    const got = await a.listMachines();
    assert.equal(got.reduce((t, x) => t + retainedChars(x), 0), MAX_LIST_CHARS);
  }
  {
    const over = [...lens];
    over[n - 1]! += 1;
    assert.ok(over[n - 1]! <= MAX_COMMAND_CHARS);
    const { a } = adapter(pagesOf(over));
    await assert.rejects(a.listMachines(), /too large to keep/);
  }
});

test("listMachines: 100 full pages of 64 KiB commands keep only bounded text", async () => {
  const pages: Reply[] = Array.from({ length: MAX_PAGES }, (_, p) =>
    ok({ success: true, instances: Array.from({ length: 25 }, (_, i) => inst({ id: p * 25 + i + 1, image_args: ["c".repeat(65536)] })), next_token: p + 1 < MAX_PAGES ? `t${p}` : null }),
  );
  const { a } = adapter(pages);
  const got = await a.listMachines();
  assert.equal(got.length, MAX_PAGES * 25);
  assert.ok(got.every((x) => x.command.length === 1 && x.command[0] === UNREADABLE));
  assert.ok(got.reduce((t, x) => t + retainedChars(x), 0) <= MAX_LIST_CHARS);
});

test("kept text holds no long strings alive: short slices of large replies are never kept (heap, after GC)", async () => {
  // A short slice (or a template over one) of a long string keeps the whole long string alive,
  // which retainedChars can't see. A child Node with --expose-gc drives the real adapter over mock
  // JSON pages and reports how much heap the returned lists keep after a collection.
  const { spawnSync } = await import("node:child_process");
  const child = `
    const { VastAdapter } = await import(process.env.ADAPTER);
    const MID = "mch_7f3k9q2m4x8z1c5v6b0n";
    const row = (id, over) => ({ id, label: "sbg-" + MID, actual_status: "running", intended_status: "running", machine_id: 4242,
      gpu_name: "RTX 4090", gpu_ram: 24564, num_gpus: 1, image_uuid: "img", image_runtype: "args", image_args: ["/l"],
      extra_env: ["SBGPU_BOOT_TOKEN=x"], is_bid: false, verification: "verified", dph_total: 0.4, disk_space: 40, ...over });
    const big = (n, id) => String(id).padEnd(n, "x");
    const adapterFor = (pages) => {
      let i = 0;
      const fetch = async () => new Response(JSON.stringify(pages[i++]), { status: 200 });
      return new VastAdapter({ apiKey: "k", fetch, now: () => new Date(0) });
    };
    const pagesOf = (rows, per) => {
      const out = [];
      for (let i = 0; i < rows.length; i += per) out.push({ success: true, instances: rows.slice(i, i + per), next_token: i + per < rows.length ? "t" + i : null });
      return out;
    };
    const kept = [];
    async function measure(make) {
      gc(); gc();
      const before = process.memoryUsage().heapUsed;
      const got = await make();
      kept.push(got);
      gc(); gc();
      return { delta: process.memoryUsage().heapUsed - before, n: got.length };
    }
    const MIB = 1 << 20;
    const out = {
      actual_status: await measure(() => adapterFor(pagesOf(Array.from({ length: 12 }, (_, i) => row(i + 1, { actual_status: big(2 * MIB, i) })), 1)).listMachines()),
      intended_status: await measure(() => adapterFor(pagesOf(Array.from({ length: 12 }, (_, i) => row(i + 1, { intended_status: big(2 * MIB, i) })), 1)).listMachines()),
      image_runtype: await measure(() => adapterFor(pagesOf(Array.from({ length: 100 }, (_, i) => row(i + 1, { image_runtype: big(256 * 1024, i) })), 10)).listMachines()),
      verification: await measure(() => adapterFor(pagesOf(Array.from({ length: 100 }, (_, i) => row(i + 1, { verification: big(256 * 1024, i) })), 10)).listMachines()),
      extra_env: await measure(() => adapterFor(pagesOf(Array.from({ length: 100 }, (_, i) => row(i + 1, { extra_env: Array.from({ length: 32 }, (_, k) => ("E" + k).padEnd(100, "N") + "=" + big(8000, i * 100 + k)) })), 10)).listMachines()),
      geolocation: await measure(() => adapterFor([{ offers: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, machine_id: 4242 + i, gpu_name: "RTX 4090", gpu_ram: 24564, num_gpus: 1, geolocation: big(300 * 1024, i) + ", SE", dph_total: 0.4, reliability: 0.99, rentable: true, rented: false, is_bid: false, verification: "verified", datacenter: true })) }]).listOffers({ gpuCount: 1 })),
    };
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", child], {
    env: { ...process.env, ADAPTER: new URL("./adapter.ts", import.meta.url).href },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1 << 20,
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout) as Record<string, { delta: number; n: number }>;
  // every row is kept (its long fields unreadable), and the lists keep well under 4 MiB, against the
  // ~25 MiB a slice of each long field would hold
  assert.deepEqual(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.n])), { actual_status: 12, intended_status: 12, image_runtype: 100, verification: 100, extra_env: 100, geolocation: 0 });
  for (const [k, v] of Object.entries(got)) assert.ok(v.delta < 4 * 1024 * 1024, `${k}: ${v.delta} bytes kept`);
});

test("the key never reaches a message, whatever fails", async () => {
  const failures: Reply[] = [new Error(`boom ${KEY}`), { status: 500, body: KEY }, { status: 200, textThrows: true }, { status: 200, body: `not json ${KEY}` }];
  for (const f of failures) {
    const { a } = adapter([f]);
    await assert.rejects(a.status("31337"), (e: unknown) => e instanceof ProviderError && !e.message.includes(KEY));
  }
});

// ---------------------------------------------------------------- no SSH, ever (SEC ruling); the create reply's key

test("every request is one of the fixed set: no SSH path, no SSH field in any body, whatever the adapter does", async () => {
  const listed = (instances: unknown[]) => ok({ success: true, instances, next_token: null });
  const { a, calls } = adapter([
    ok({ offers: [offer()] }),
    ok({ offers: [offer()] }), ok({ success: true, new_contract: 31337 }), ok({ instances: inst() }),
    ok({ offers: [offer()] }), new TypeError("fetch failed"), listed([inst()]), ok({ instances: inst() }),
    ok({ instances: inst() }),
    ok({ success: true, msg: "Instance destroyed successfully" }),
    listed([inst()]),
  ]);
  await a.listOffers({ gpuCount: 1 } as Parameters<VastAdapter["listOffers"]>[0]);
  await a.launch(SPEC);
  await a.launch(SPEC);
  await a.status("31337");
  await a.terminate("31337");
  await a.listMachines();
  assert.equal(calls.length, 11);
  for (const c of calls) {
    const path = c.url.slice("https://console.vast.ai".length);
    const body = c.init.body === undefined ? undefined : (JSON.parse(String(c.init.body)) as unknown);
    assert.ok(allowedRequest(c.init.method, path, body), `${c.init.method} ${path}`);
    assert.doesNotMatch(c.url, /ssh/i);
    assert.doesNotMatch(String(c.init.body ?? ""), /ssh/i);
  }
  // the create's body: the args runtype, and no SSH or Jupyter of any kind
  const create = calls.find((c) => c.init.method === "PUT")!;
  assert.equal((JSON.parse(String(create.init.body)) as Record<string, unknown>)["runtype"], "args");
});

test("the fixed request set: each route's exact method, path and query shape; any other method, path, query key or body is refused", () => {
  const B = { image: "x", runtype: "args" };
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const sel = (label: unknown) => JSON.stringify({ label: { eq: label } });
  // the real requests, slashed or not
  for (const [m, p, b] of [
    ["POST", "/api/v0/bundles", B], ["POST", "/api/v0/bundles/", B],
    ["PUT", "/api/v0/asks/9001", B], ["PUT", "/api/v0/asks/9001/", B],
    ["GET", "/api/v0/instances/31337", undefined], ["GET", "/api/v0/instances/31337/", undefined],
    ["DELETE", "/api/v0/instances/31337", undefined], ["DELETE", "/api/v0/instances/31337/", undefined],
    ["GET", `/api/v1/instances?${q({ limit: "25" })}`, undefined],
    ["GET", `/api/v1/instances/?${q({ limit: "25", select_filters: sel(`sbg-${MID}`), after_token: "eyJpZCI6IDQyfQ==" })}`, undefined],
  ] as Array<[string, string, unknown]>) {
    assert.ok(allowedRequest(m, p, b), `${m} ${p}`);
  }
  // a wrong method on every route
  for (const [p, ok] of [["/api/v0/bundles/", "POST"], ["/api/v0/asks/9001/", "PUT"], ["/api/v0/instances/31337/", "GET DELETE"], ["/api/v1/instances?limit=25", "GET"]] as const) {
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "get"]) {
      if (ok.split(" ").includes(m)) continue;
      assert.equal(allowedRequest(m, p, m === "POST" || m === "PUT" ? B : undefined), false, `${m} ${p}`);
      assert.equal(allowedRequest(m, p, B), false, `${m} ${p} with a body`);
    }
  }
  // SSH and other paths
  for (const p of ["/api/v0/instances/31337/ssh/", "/api/v0/instances/31337/ssh", "/api/v0/ssh/", "/api/v0/users/current/", "/api/v0/instances/31337/attach/", "/api/v0/instances/", "/api/v0/instances/x/", "/api/v0/bundles/../ssh", "/API/v0/bundles", "/api/v0/instances/31337?ssh=1"]) {
    for (const m of ["GET", "POST", "PUT", "DELETE"]) assert.equal(allowedRequest(m, p, m === "POST" || m === "PUT" ? B : undefined), false, `${m} ${p}`);
  }
  // the list's query: exactly its keys, decoded, each once, each in its shape
  for (const query of [
    "%73%73%68=1", "%53%53%48=1", "x=%2f%73%73%68", "limit=25&%73%73%68=1", "limit=25&ssh=1", "limit=25&x=1", "",
    "limit=25&limit=25", "limit=0", "limit=x", "limit=1000", "limit=%32%35%26ssh%3D1",
    `limit=25&${q({ select_filters: JSON.stringify({ label: { eq: `sbg-${MID}` }, ssh: 1 }) })}`,
    `limit=25&${q({ select_filters: JSON.stringify({ label: { eq: `sbg-${MID}`, ssh: 1 } }) })}`,
    `limit=25&${q({ select_filters: sel("ssh") })}`, `limit=25&${q({ select_filters: sel(1) })}`, "limit=25&select_filters=%7B",
    `${q({ select_filters: sel(`sbg-${MID}`) })}`, "limit=25&after_token=", "limit=25&after_token=%20", "limit=25&after_token=a/b", "limit=25&a%66ter_token=x&after_token=y",
  ]) {
    assert.equal(allowedRequest("GET", `/api/v1/instances?${query}`, undefined), false, query);
  }
  // a value may hold the letters s, s, h: a machine id can (they are in its alphabet), and so can a page token
  const sshId = "mch_0ssh0000000000000000";
  assert.equal(sshId.length, MID.length);
  assert.ok(allowedRequest("GET", `/api/v1/instances?${q({ limit: "25", select_filters: sel(`sbg-${sshId}`), after_token: "ssh" })}`, undefined));
  assert.ok(allowedRequest("PUT", "/api/v0/asks/9001/", { ...B, label: `sbg-${sshId}`, env: "-e A=ssh" }));
  // bodies: exactly where the route has one, never naming SSH
  assert.equal(allowedRequest("PUT", "/api/v0/asks/9001/", undefined), false);
  assert.equal(allowedRequest("POST", "/api/v0/bundles/", "ssh"), false);
  assert.equal(allowedRequest("GET", "/api/v0/instances/31337/", {}), false);
  for (const body of [{ ssh_key: "ssh-ed25519 AAAA" }, { image: "x", SSH_KEY: "k" }, { a: { b: [{ sshKey: 1 }] } }, { runtype: "args", extra: { ssh: true } }]) {
    assert.equal(allowedRequest("PUT", "/api/v0/asks/9001/", body), false, JSON.stringify(body));
  }
});

test("readback: any SSH sign refuses the launch (its id kept, so it is ended): a host, a port, key material, any SSH field set", async () => {
  const settings = (over: Record<string, unknown>) => instanceStatus(inst(over), T).unexpectedSettings;
  assert.deepEqual(settings({ ssh_host: "ssh4.vast.ai" }), ["ssh:host"]);
  assert.deepEqual(settings({ ssh_port: 22 }), ["ssh:port"]);
  assert.deepEqual(settings({ ssh_port: 0 }), ["ssh:port"]);
  assert.deepEqual(settings({ ssh_key: "ssh-ed25519 AAAAC3Nz" }), ["ssh:key"]);
  assert.deepEqual(settings({ ssh_keys: ["ssh-ed25519 AAAAC3Nz"] }), ["ssh:key"]);
  assert.deepEqual(settings({ SSH_PUBLIC_KEY: "x" }), ["ssh:key"]);
  assert.deepEqual(settings({ ssh_idx: "3" }), ["ssh:set"]);
  assert.deepEqual(settings({ use_ssh: true }), ["ssh:set"]);
  assert.deepEqual(settings({ ssh_host: "h", ssh_port: 2222, ssh_key: "k" }), ["ssh:host", "ssh:port", "ssh:key"]);
  assert.deepEqual(settings({ ssh_key: "k", ssh_keys: ["k"], ssh_idx: 1, use_ssh: true }), ["ssh:key", "ssh:set"], "each kind once");
  // nothing set: no SSH (what an args instance showed: no host, a null port)
  assert.deepEqual(settings({ ssh_host: null, ssh_port: null, ssh_key: "", ssh_keys: [], use_ssh: false }), []);
  // the report's markers are fixed words
  const s = instanceStatus(inst({ ssh_host: "h", ssh_port: 22, ssh_key: "k", ssh_idx: 1 }), T);
  const markers = driftMarkers(specDrift(expectedSpec(SPEC, new VastAdapter({ apiKey: KEY, fetch: mockFetch([]).fetch }).info, "31337"), s), s);
  assert.deepEqual(markers.filter((m) => m.startsWith("unexpectedSettings")), ["unexpectedSettings:ssh:host", "unexpectedSettings:ssh:port", "unexpectedSettings:ssh:key", "unexpectedSettings:ssh:set"]);
  assert.ok(markers.every(isDriftMarker));
  // and a launch whose readback shows any of them is refused with the instance's id
  for (const over of [{ ssh_host: "ssh4.vast.ai" }, { ssh_port: 41234 }, { ssh_key: "ssh-ed25519 AAAAC3Nz" }, { ssh_idx: "3" }]) {
    const { a } = adapter([ok({ offers: [offer()] }), ok({ success: true, new_contract: 31337 }), ok({ instances: inst(over) })]);
    await assert.rejects(a.launch(SPEC), (e: unknown) => e instanceof ProviderError && e.kind === "spec_mismatch" && e.providerMachineId === "31337", JSON.stringify(over));
  }
});

test("the create reply's instance_api_key is never read, kept or shown: not in a result, an error, a status or any console output", async () => {
  const SECRET = "c0ffee11c0ffee22c0ffee33c0ffee44c0ffee55c0ffee66c0ffee77c0ffee88";
  const created = (over: Record<string, unknown> = {}) => ok({ success: true, new_contract: 31337, instance_api_key: SECRET, ...over });
  const printed: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(saved) as Array<keyof typeof saved>) console[k] = (...xs: unknown[]) => void printed.push(inspect(xs, { depth: null }));
  const seen: unknown[] = [];
  try {
    const listed = (instances: unknown[]) => ok({ success: true, instances, next_token: null });
    const runs: Reply[][] = [
      [ok({ offers: [offer()] }), created(), ok({ instances: inst() })], // accepted
      [ok({ offers: [offer()] }), created(), ok({ instances: inst({ ssh_host: "h" }) })], // drift
      [ok({ offers: [offer()] }), created(), { status: 500 }], // no readback
      [ok({ offers: [offer()] }), created({ success: false }), listed([])], // a reply that proves no instance
      [ok({ offers: [offer()] }), created({ new_contract: "x" }), listed([inst()]), ok({ instances: inst() })], // recovered by its label
    ];
    for (const r of runs) {
      const { a } = adapter(r);
      try {
        seen.push(await a.launch(SPEC));
      } catch (e) {
        seen.push(e);
      }
      seen.push(a);
    }
  } finally {
    Object.assign(console, saved);
  }
  assert.equal(seen.length, 10);
  for (const x of seen) {
    const shown = inspect(x, { depth: null, showHidden: true, getters: true });
    assert.ok(!shown.includes(SECRET), shown.slice(0, 200));
    if (x instanceof Error) assert.ok(!String(x.stack).includes(SECRET) && !JSON.stringify(x).includes(SECRET));
    else assert.ok(!JSON.stringify(x).includes(SECRET));
  }
  assert.ok(!printed.join("\n").includes(SECRET));
});

// ---------------------------------------------------------------- 'vast' in the contract, unwired

test("a policy that allows 'vast' still can't launch there: no adapter is wired", async () => {
  // The control plane constructs no adapters yet; placement with none for Vast never launches on it.
  const vastOffer: Offer = { provider: "vast", gpuType: "RTX-4090", gpuCount: 1, dataCenter: "machine-4242", country: "SE", providerCostPerHour: 410_000, stock: "unknown", observedAt: T };
  let specs = 0;
  await assert.rejects(
    launchWithFallback({
      offers: [vastOffer],
      adapters: {},
      spec: () => {
        specs++;
        return SPEC;
      },
      revokeBootToken: async () => {},
      sleep: async () => {},
    }),
    (e: unknown) => e instanceof Error && "attempts" in e && JSON.stringify((e as { attempts: unknown }).attempts).includes("no_adapter"),
  );
  assert.equal(specs, 0, "no launch spec (so no boot token) is even made");
});
