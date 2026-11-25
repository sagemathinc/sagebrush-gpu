import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../errors.ts";
import type { Fetch, HttpRequest } from "../http.ts";
import type { LaunchSpec } from "../types.ts";
import {
  hyperstackError,
  HyperstackAdapter,
  isPublicIpv4,
  perLaunchKeypair,
  UNREADABLE,
  VM_COMMAND,
  vmReadbackProblems,
  vmStatus,
} from "./adapter.ts";
import { gpuFromHyperstack, gpuToHyperstack, HYPERSTACK_GPUS, hyperstackCountry } from "./catalog.ts";

const KEY = "test-key-not-a-real-key";
const MID = "mch_7f3k9q2m4x8z1c5v6b0n";
const NOW = new Date("2026-11-25T12:00:00.000Z");
const T = NOW.toISOString();

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
  return { a: new HyperstackAdapter({ apiKey: KEY, fetch: m.fetch, now: () => NOW }), calls: m.calls };
}

/** A VM (InstanceFields) as Hyperstack's API reference describes it, in the VM-mode launch shape. */
function vm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    name: `sbg-${MID}`,
    status: "ACTIVE",
    power_state: "RUNNING",
    vm_state: "active",
    fixed_ip: "10.0.0.5",
    floating_ip: "185.10.20.7",
    floating_ip_status: "ATTACHED",
    port_randomization: false,
    port_randomization_status: "DISABLED",
    security_rules: [],
    enhanced_metrics: { enabled: false },
    volume_attachments: [],
    environment: { id: 1, name: "sbg-canada", region: "CANADA-1" },
    flavor: { id: 9, name: "n3-RTX-A6000x1", cpu: 28, ram: 58, disk: 100, gpu: "RTX-A6000", gpu_count: 1 },
    image: { name: "Ubuntu Server 22.04 LTS" },
    keypair: { name: "sbg-k-4242" },
    labels: [],
    ...over,
  };
}

const WANT = {
  name: `sbg-${MID}`,
  environmentName: "sbg-canada",
  flavorName: "n3-RTX-A6000x1",
  imageName: "Ubuntu Server 22.04 LTS",
  keypairName: "sbg-k-4242",
};

function flavors(fs: Array<Record<string, unknown>>) {
  return { status: true, message: "", data: [{ gpu: "RTX-A6000", region_name: "CANADA-1", flavors: fs }] };
}

function flavor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 9, name: "n3-RTX-A6000x1", gpu: "RTX-A6000", gpu_count: 1, cpu: 28, ram: 58, disk: 100, region_name: "CANADA-1", stock_available: true, ...over };
}

const BOOK = [
  { name: "RTX-A6000", value: 0.5, original_value: 0.5 },
  { name: "H100-80G-PCIe", value: 1.9, original_value: 1.9 },
];

async function rejects(p: Promise<unknown>, kind: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ProviderError && e.kind === kind && e.provider === "hyperstack");
}

// ---------------------------------------------------------------- catalog

test("catalog: every Hyperstack GPU name maps both ways; unknown, inherited and non-string names don't", () => {
  for (const [name, ours] of Object.entries(HYPERSTACK_GPUS)) {
    assert.equal(gpuFromHyperstack(name), ours);
    assert.equal(gpuToHyperstack(ours), name);
  }
  for (const x of ["rtx-a6000", "A100", "toString", "__proto__", "", 7, null, undefined]) assert.equal(gpuFromHyperstack(x), null);
  assert.equal(hyperstackCountry("CANADA-1"), "CA");
  assert.equal(hyperstackCountry("NORWAY-1"), "NO");
  assert.equal(hyperstackCountry("US-1"), "US");
  for (const x of ["canada-1", "EU-1", "toString", 1, null]) assert.equal(hyperstackCountry(x), null);
});

// ---------------------------------------------------------------- errors

test("hyperstackError: status kinds; Retry-After only on 429; the message carries no body", () => {
  const kinds: Array<[number, string]> = [
    [400, "invalid_request"], [405, "invalid_request"], [422, "invalid_request"], [401, "auth"], [402, "insufficient_funds"],
    [403, "forbidden"], [404, "not_found"], [409, "unplaceable"], [429, "rate_limited"], [500, "transient"], [599, "transient"],
    [418, "unknown"], [600, "unknown"], [300, "unknown"],
  ];
  for (const [s, k] of kinds) {
    const e = hyperstackError(s, "7");
    assert.equal(e.kind, k, String(s));
    assert.equal(e.httpStatus, s);
    assert.equal(e.message, `Hyperstack HTTP ${s} (${k})`);
    assert.equal(e.retryAfterSeconds, s === 429 ? 7 : null);
  }
});

test("#call: api_key header carries the key and nothing else does; GETs send no body", async () => {
  const { a, calls } = adapter([{ status: 200, body: { instance: vm() } }]);
  await a.status("4242");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://infrahub-api.nexgencloud.com/v1/core/virtual-machines/4242");
  assert.equal(calls[0]!.init.method, "GET");
  assert.deepEqual(calls[0]!.init.headers, { api_key: KEY, Accept: "application/json" });
  assert.equal(calls[0]!.init.body, undefined);
  assert.ok(!calls[0]!.url.includes(KEY));
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
});

test("#call: network failure is outcome_unknown and names no key; HTTP errors never read the body", async () => {
  const boom = new Error(`connect failed ${KEY}`);
  const { a } = adapter([boom]);
  await assert.rejects(a.status("4242"), (e: unknown) => {
    assert.ok(e instanceof ProviderError && e.kind === "outcome_unknown");
    assert.ok(!e.message.includes(KEY));
    assert.ok(!e.message.includes("connect failed"));
    return true;
  });
  const b = adapter([{ status: 500, body: { message: `secret ${KEY}` } }]);
  await assert.rejects(b.a.status("4242"), (e: unknown) => e instanceof ProviderError && e.kind === "transient" && !e.message.includes(KEY));
});

test("#call: unreadable JSON is unknown on GET, outcome_unknown on POST and DELETE", async () => {
  await rejects(adapter([{ status: 200, body: "{nope" }]).a.status("4242"), "unknown");
  await rejects(adapter([{ status: 200, body: "{nope" }]).a.terminate("4242"), "outcome_unknown");
  const kp = (await perLaunchKeypair()).publicKey;
  await rejects(adapter([{ status: 200, body: "{nope" }]).a.importKeypair("sbg-k-1", "sbg-canada", kp), "outcome_unknown");
});

// ---------------------------------------------------------------- vmStatus

test("vmStatus: the launch-shape VM reads clean, with no env, no ports, the VM marker command", () => {
  const s = vmStatus(vm(), T);
  assert.deepEqual(s, {
    provider: "hyperstack",
    providerMachineId: "4242",
    machineId: MID,
    state: "running",
    rawStatus: "ACTIVE",
    gpuType: "RTX-A6000",
    gpuCount: 1,
    dataCenter: "CANADA-1",
    image: "Ubuntu Server 22.04 LTS",
    diskGb: 100,
    volumeGb: 0,
    envNames: [],
    exposedPorts: [],
    unexpectedSettings: [],
    command: [...VM_COMMAND],
    providerCostPerHour: null,
    observedAt: T,
  });
  assert.ok(Object.isFrozen(VM_COMMAND));
  assert.notEqual(s.command, VM_COMMAND);
});

test("vmStatus: every Hyperstack status maps; unknown and inherited ones are unknown", () => {
  const want: Record<string, string> = {
    CREATING: "provisioning", BUILD: "provisioning", STARTING: "provisioning", RESTORING: "provisioning", REBOOTING: "provisioning",
    ACTIVE: "running", STOPPING: "stopping", SHUTOFF: "stopping", HIBERNATING: "stopping", HIBERNATED: "stopping", DELETING: "stopping",
    ERROR: "failed", DELETED: "terminated",
  };
  for (const [raw, state] of Object.entries(want)) assert.equal(vmStatus(vm({ status: raw }), T).state, state, raw);
  for (const raw of ["active", "toString", "", 3, null]) {
    const s = vmStatus(vm({ status: raw }), T);
    assert.equal(s.state, "unknown");
    assert.equal(s.rawStatus, typeof raw === "string" ? raw : "");
  }
});

test("vmStatus: only a missing or bad id throws", () => {
  for (const id of [undefined, null, "4242", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => vmStatus(vm({ id }), T), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  }
  for (const x of [null, [], "vm", 1]) assert.throws(() => vmStatus(x, T), ProviderError);
});

test("vmStatus: malformed fields stay unreadable, so drift fails closed", () => {
  const s = vmStatus(vm({ flavor: "x", environment: null, image: 5, name: 7, volume_attachments: "x", security_rules: "x", enhanced_metrics: null, port_randomization: "no", floating_ip: "x" }), T);
  assert.equal(s.machineId, null);
  assert.equal(s.gpuType, null);
  assert.ok(Number.isNaN(s.gpuCount));
  assert.ok(Number.isNaN(s.diskGb));
  assert.ok(Number.isNaN(s.volumeGb));
  assert.equal(s.dataCenter, null);
  assert.equal(s.image, UNREADABLE);
  assert.deepEqual(s.exposedPorts, [UNREADABLE]);
  assert.deepEqual(s.unexpectedSettings, [
    `security_rules:${UNREADABLE}`,
    `port_randomization:${UNREADABLE}`,
    `enhanced_metrics:${UNREADABLE}`,
    `floating_ip:${UNREADABLE}`,
  ]);
});

test("vmStatus: settings that differ from the launch shape are named", () => {
  const rules = [
    { direction: "ingress", protocol: "tcp", port_range_min: 22, port_range_max: 22 },
    { direction: "egress", protocol: "tcp", port_range_min: 1, port_range_max: 65535 },
    { direction: "ingress", protocol: "icmp", port_range_min: null, port_range_max: null },
    "junk",
  ];
  const s = vmStatus(vm({ security_rules: rules, port_randomization: true, enhanced_metrics: { enabled: true }, floating_ip: null, volume_attachments: [{ id: 1 }] }), T);
  assert.deepEqual(s.exposedPorts, ["tcp:22-22", "icmp:all", UNREADABLE]);
  assert.deepEqual(s.unexpectedSettings, ["security_rules", "port_randomization:enabled", "enhanced_metrics:enabled", "floating_ip:none"]);
  assert.equal(s.volumeGb, Number.POSITIVE_INFINITY);
  assert.deepEqual(vmStatus(vm({ volume_attachments: null }), T).volumeGb, 0);
  assert.deepEqual(vmStatus(vm({ floating_ip: undefined }), T).unexpectedSettings, ["floating_ip:none"]);
  assert.deepEqual(vmStatus(vm({ floating_ip: "10.1.2.3" }), T).unexpectedSettings, [`floating_ip:${UNREADABLE}`]);
  assert.deepEqual(vmStatus(vm({ security_rules: [{ direction: "ingress", protocol: 6, port_range_min: 1, port_range_max: 2 }] }), T).exposedPorts, [`${UNREADABLE}:1-2`]);
  assert.deepEqual(vmStatus(vm({ security_rules: [{ direction: "ingress", protocol: "tcp", port_range_min: 22, port_range_max: null }] }), T).exposedPorts, ["tcp:all"]);
  assert.deepEqual(vmStatus(vm({ security_rules: [{ direction: "ingress", protocol: "tcp", port_range_min: -1, port_range_max: 22 }] }), T).exposedPorts, ["tcp:all"]);
  const neg = vmStatus(vm({ flavor: { gpu: "RTX-A6000", gpu_count: -1, disk: -1 } }), T);
  assert.ok(Number.isNaN(neg.gpuCount));
  assert.ok(Number.isNaN(neg.diskGb));
});

// ---------------------------------------------------------------- isPublicIpv4

test("isPublicIpv4: routable addresses only", () => {
  for (const ip of ["185.10.20.7", "8.8.8.8", "1.0.0.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "169.253.1.1", "192.1.0.1", "198.17.0.1", "198.20.0.1", "223.255.255.255", "11.0.0.0"]) {
    assert.equal(isPublicIpv4(ip), true, ip);
  }
  for (const ip of [
    "0.1.2.3", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.0.1",
    "192.0.0.1", "198.18.0.1", "198.19.0.1", "224.0.0.1", "255.255.255.255", "256.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4 ", " 1.2.3.4",
    "1.2.3.4\n", "::1", "", null, 1, undefined,
  ]) {
    assert.equal(isPublicIpv4(ip), false, String(ip));
  }
});

// ---------------------------------------------------------------- vmReadbackProblems

test("vmReadbackProblems: the exact launch shape has none", () => {
  assert.deepEqual(vmReadbackProblems(vm(), WANT), []);
  assert.deepEqual(vmReadbackProblems(vm({ volume_attachments: null }), WANT), []);
  assert.deepEqual(vmReadbackProblems(vm({ volume_attachments: undefined }), WANT), []);
});

test("vmReadbackProblems: each difference is named, and only it", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ status: "BUILD" }, "status"],
    [{ floating_ip: null }, "floating_ip"],
    [{ floating_ip: "10.0.0.9" }, "floating_ip"],
    [{ floating_ip_status: "DETACHED" }, "floating_ip_status"],
    [{ floating_ip_status: undefined }, "floating_ip_status"],
    [{ port_randomization: true }, "port_randomization"],
    [{ port_randomization: undefined }, "port_randomization"],
    [{ security_rules: [{ direction: "egress" }] }, "security_rules"],
    [{ security_rules: undefined }, "security_rules"],
    [{ enhanced_metrics: { enabled: true } }, "enhanced_metrics"],
    [{ enhanced_metrics: {} }, "enhanced_metrics"],
    [{ enhanced_metrics: undefined }, "enhanced_metrics"],
    [{ volume_attachments: [{ id: 1 }] }, "volumes"],
    [{ volume_attachments: "none" }, "volumes"],
    [{ name: "sbg-other" }, "name"],
    [{ environment: { name: "other", region: "CANADA-1" } }, "environment"],
    [{ environment: "sbg-canada" }, "environment"],
    [{ flavor: { ...(vm()["flavor"] as object), name: "n3-RTX-A6000x2" } }, "flavor"],
    [{ image: { name: "Ubuntu" } }, "image"],
    [{ keypair: { name: "sbg-k-1" } }, "keypair"],
    [{ keypair: null }, "keypair"],
  ];
  for (const [over, why] of cases) assert.deepEqual(vmReadbackProblems(vm(over), WANT), [why], JSON.stringify(over));
  for (const x of [null, [], "vm"]) assert.deepEqual(vmReadbackProblems(x, WANT), ["unreadable"]);
});

// ---------------------------------------------------------------- perLaunchKeypair

test("perLaunchKeypair: an OpenSSH Ed25519 line over the raw public key; a fresh, non-extractable private key", async () => {
  const k1 = await perLaunchKeypair();
  const k2 = await perLaunchKeypair();
  assert.match(k1.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]{68}$/);
  assert.notEqual(k1.publicKey, k2.publicKey);
  const blob = Buffer.from(k1.publicKey.split(" ")[1]!, "base64");
  assert.equal(blob.length, 51);
  assert.equal(blob.readUInt32BE(0), 11);
  assert.equal(blob.subarray(4, 15).toString(), "ssh-ed25519");
  assert.equal(blob.readUInt32BE(15), 32);
  assert.equal(k1.privateKey.type, "private");
  assert.equal(k1.privateKey.extractable, false);
  assert.equal(k1.privateKey.algorithm.name, "Ed25519");
  await assert.rejects(crypto.subtle.exportKey("pkcs8", k1.privateKey));
  // The line's key is the private key's partner.
  const pub = await crypto.subtle.importKey("raw", blob.subarray(19), { name: "Ed25519" }, false, ["verify"]);
  const msg = new TextEncoder().encode("m");
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, k1.privateKey, msg);
  assert.equal(await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, msg), true);
});

// ---------------------------------------------------------------- offers

test("listOffers: a flavor priced per GPU from the pricebook; stock from stock_available", async () => {
  const { a, calls } = adapter([
    { status: 200, body: flavors([flavor(), flavor({ name: "n3-RTX-A6000x1-b", region_name: "NORWAY-1", stock_available: false })]) },
    { status: 200, body: BOOK },
  ]);
  const offers = await a.listOffers({ gpuCount: 1 });
  assert.deepEqual(calls.map((c) => c.url.slice(HYPERSTACK.length)), ["/core/flavors", "/pricebook"]);
  assert.deepEqual(offers, [
    { provider: "hyperstack", gpuType: "RTX-A6000", gpuCount: 1, dataCenter: "CANADA-1", country: "CA", providerCostPerHour: 500_000, stock: "unknown", observedAt: T },
    { provider: "hyperstack", gpuType: "RTX-A6000", gpuCount: 1, dataCenter: "NORWAY-1", country: "NO", providerCostPerHour: 500_000, stock: "none", observedAt: T },
  ]);
});

const HYPERSTACK = "https://infrahub-api.nexgencloud.com/v1";

test("listOffers: a flavor with another GPU count is no offer", async () => {
  const { a } = adapter([{ status: 200, body: flavors([flavor()]) }, { status: 200, body: BOOK }]);
  assert.deepEqual(await a.listOffers({ gpuCount: 2 }), []);
});

test("listOffers: a non-finite price is no price", async () => {
  const { a } = adapter([{ status: 200, body: flavors([flavor()]) }, { status: 200, body: '[{"name":"RTX-A6000","value":1e400}]' }]);
  assert.deepEqual(await a.listOffers({ gpuCount: 1 }), []);
});

test("listOffers: price scales with the GPU count; other counts are skipped", async () => {
  const { a } = adapter([
    { status: 200, body: flavors([flavor(), flavor({ name: "x2", gpu_count: 2 }), flavor({ name: "x4", gpu_count: 4 })]) },
    { status: 200, body: BOOK },
  ]);
  const offers = await a.listOffers({ gpuCount: 2 });
  assert.equal(offers.length, 1);
  assert.equal(offers[0]!.gpuCount, 2);
  assert.equal(offers[0]!.providerCostPerHour, 1_000_000);
});

test("listOffers: unknown GPUs and regions, unpriced, ambiguous or malformed rows are skipped", async () => {
  const { a } = adapter([
    {
      status: 200,
      body: {
        data: [
          "junk",
          { gpu: "x", flavors: "junk" },
          {
            flavors: [
              "junk",
              flavor({ gpu: "RTX-A9999" }),
              flavor({ region_name: "EU-9" }),
              flavor({ region_name: 3 }),
              flavor({ gpu: "L40" }),
              flavor({ gpu: "A100-80G-PCIe" }),
              flavor({ gpu: "H100-80G-SXM5" }),
              flavor({ gpu: "RTX-A4000" }),
              flavor({ gpu: "RTX-A5000" }),
              flavor({ stock_available: "yes" }),
              flavor({ gpu_count: "1" }),
              flavor({ gpu: 5 }),
            ],
          },
        ],
      },
    },
    {
      status: 200,
      body: [
        { name: "RTX-A6000", value: 0.5 },
        { name: "L40", value: 0 },
        { name: "A100-80G-PCIe", value: "1.0" },
        { name: "H100-80G-SXM5", value: 2.0 },
        { name: "H100-80G-SXM5", value: 2.5 },
        { name: "RTX-A4000", value: Number.NaN },
        { name: "RTX-A5000", value: -1 },
        "junk",
        { value: 1 },
      ],
    },
  ]);
  assert.deepEqual(await a.listOffers({ gpuCount: 1 }), []);
});

test("listOffers: one per GPU type and region, preferring one in stock", async () => {
  const book = [
    { name: "RTX-A6000", value: 0.5 },
    { name: "RTX-6000-Ada", value: 0.9 },
  ];
  const { a } = adapter([
    {
      status: 200,
      body: flavors([
        flavor({ name: "a", stock_available: false }),
        flavor({ name: "b", stock_available: true }),
        flavor({ name: "c", gpu: "RTX-6000-Ada", stock_available: true }),
        flavor({ name: "d", gpu: "RTX-6000-Ada", stock_available: false }),
      ]),
    },
    { status: 200, body: book },
  ]);
  const offers = await a.listOffers({ gpuCount: 1 });
  assert.deepEqual(offers.map((o) => [o.gpuType, o.stock]), [["RTX-A6000", "unknown"], ["RTX-6000-ADA", "unknown"]]);
});

test("listOffers: a pricebook wrapped in data reads too", async () => {
  const { a } = adapter([{ status: 200, body: flavors([flavor()]) }, { status: 200, body: { data: BOOK } }]);
  assert.equal((await a.listOffers({ gpuCount: 1 })).length, 1);
});

test("listOffers: malformed lists fail; a bad count throws before any request", async () => {
  await rejects(adapter([{ status: 200, body: { data: "x" } }, { status: 200, body: BOOK }]).a.listOffers({ gpuCount: 1 }), "unknown");
  await rejects(adapter([{ status: 200, body: [] }, { status: 200, body: BOOK }]).a.listOffers({ gpuCount: 1 }), "unknown");
  await rejects(adapter([{ status: 200, body: flavors([]) }, { status: 200, body: { data: "x" } }]).a.listOffers({ gpuCount: 1 }), "unknown");
  await rejects(adapter([{ status: 200, body: flavors([]) }, { status: 200, body: null }]).a.listOffers({ gpuCount: 1 }), "unknown");
  for (const n of [0, -1, 1.5, Number.NaN]) {
    const { a, calls } = adapter([]);
    await assert.rejects(a.listOffers({ gpuCount: n }), RangeError);
    assert.equal(calls.length, 0);
  }
});

// ---------------------------------------------------------------- launch

test("launch: refused before any request, whatever the spec", async () => {
  const { a, calls } = adapter([]);
  const spec = { machineId: MID } as unknown as LaunchSpec;
  await assert.rejects(a.launch(spec), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request" && e.message === "Hyperstack: VM launch is not enabled");
  assert.equal(calls.length, 0);
  assert.deepEqual(a.info, { provider: "hyperstack", selfIdentity: null, bootTokenEnv: "" });
});

// ---------------------------------------------------------------- status

test("status: reads one VM; 404 is gone; another VM's answer or a bad reply fails", async () => {
  assert.equal((await adapter([{ status: 200, body: { instance: vm() } }]).a.status("4242")).state, "running");
  const gone = await adapter([{ status: 404 }]).a.status("4242");
  assert.deepEqual(gone, {
    provider: "hyperstack", providerMachineId: "4242", machineId: null, state: "terminated", rawStatus: "NOT_FOUND", gpuType: null, gpuCount: 0,
    dataCenter: null, image: "", diskGb: 0, volumeGb: 0, envNames: [], exposedPorts: [], unexpectedSettings: [], command: [], providerCostPerHour: null, observedAt: T,
  });
  await rejects(adapter([{ status: 200, body: { instance: vm({ id: 4243 }) } }]).a.status("4242"), "unknown");
  await rejects(adapter([{ status: 200, body: { vm: vm() } }]).a.status("4242"), "unknown");
  await rejects(adapter([{ status: 200, body: [vm()] }]).a.status("4242"), "unknown");
  await rejects(adapter([{ status: 500 }]).a.status("4242"), "transient");
  await rejects(adapter([{ status: 401 }]).a.status("4242"), "auth");
});

test("status, terminate, instanceFacts: a malformed id throws before any request", async () => {
  for (const id of ["", "0", "042", "-1", "1.5", "a", "12345678901234567", "1/../2", "1?x=1", " 1"]) {
    const { a, calls } = adapter([]);
    await assert.rejects(a.status(id), RangeError, id);
    await assert.rejects(a.terminate(id), RangeError, id);
    await assert.rejects(a.instanceFacts(id), RangeError, id);
    assert.equal(calls.length, 0);
  }
  assert.equal((await adapter([{ status: 404 }]).a.status("1234567890123456")).state, "terminated");
});

// ---------------------------------------------------------------- instanceFacts

test("instanceFacts: the launch shape is active, with its IPv4, exclusive", async () => {
  const { a, calls } = adapter([{ status: 200, body: { instance: vm() } }]);
  assert.deepEqual(await a.instanceFacts("4242"), { state: "active", ipv4: "185.10.20.7", exclusive: true });
  assert.equal(calls[0]!.url, `${HYPERSTACK}/core/virtual-machines/4242`);
  assert.equal(calls[0]!.init.method, "GET");
});

test("instanceFacts: 404 and DELETED are absent; other statuses are other", async () => {
  assert.deepEqual(await adapter([{ status: 404 }]).a.instanceFacts("4242"), { state: "absent", ipv4: null, exclusive: false });
  assert.deepEqual(await adapter([{ status: 200, body: { instance: vm({ status: "DELETED" }) } }]).a.instanceFacts("4242"), { state: "absent", ipv4: null, exclusive: false });
  for (const s of ["DELETING", "SHUTOFF", "BUILD", "ERROR", "active", ""]) {
    assert.deepEqual(await adapter([{ status: 200, body: { instance: vm({ status: s }) } }]).a.instanceFacts("4242"), { state: "other", ipv4: "185.10.20.7", exclusive: true }, s);
  }
});

test("instanceFacts: exclusive needs a public, attached IPv4, randomization off and no rules", async () => {
  const cases: Array<[Record<string, unknown>, string | null]> = [
    [{ floating_ip: null }, null],
    [{ floating_ip: "10.0.0.9" }, null],
    [{ floating_ip_status: "ATTACHING" }, "185.10.20.7"],
    [{ port_randomization: true }, "185.10.20.7"],
    [{ port_randomization: undefined }, "185.10.20.7"],
    [{ security_rules: [{ direction: "egress" }] }, "185.10.20.7"],
    [{ security_rules: null }, "185.10.20.7"],
  ];
  for (const [over, ipv4] of cases) {
    assert.deepEqual(await adapter([{ status: 200, body: { instance: vm(over) } }]).a.instanceFacts("4242"), { state: "active", ipv4, exclusive: false }, JSON.stringify(over));
  }
});

test("instanceFacts: every failure is unavailable, never a throw", async () => {
  const replies: Reply[] = [
    new Error("down"),
    { status: 500 },
    { status: 401 },
    { status: 429 },
    { status: 409 },
    { status: 200, body: "{nope" },
    { status: 200 },
    { status: 200, body: { instance: vm({ id: 4243 }) } },
    { status: 200, body: { instance: vm({ id: "4242" }) } },
    { status: 200, body: { instance: vm({ status: 7 }) } },
    { status: 200, body: { instance: null } },
    { status: 200, body: [vm()] },
  ];
  for (const r of replies) assert.equal(await adapter([r]).a.instanceFacts("4242"), "unavailable", JSON.stringify(r));
});

// ---------------------------------------------------------------- terminate

test("terminate: one DELETE; 404 is done; other errors throw", async () => {
  const { a, calls } = adapter([{ status: 200, body: { status: true, message: "ok" } }]);
  await a.terminate("4242");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.init.method, "DELETE");
  assert.equal(calls[0]!.url, `${HYPERSTACK}/core/virtual-machines/4242`);
  await adapter([{ status: 404 }]).a.terminate("4242");
  await adapter([{ status: 204 }]).a.terminate("4242");
  await rejects(adapter([{ status: 500 }]).a.terminate("4242"), "transient");
  await rejects(adapter([{ status: 400 }]).a.terminate("4242"), "invalid_request");
  await rejects(adapter([new Error("x")]).a.terminate("4242"), "outcome_unknown");
  await rejects(adapter([{ status: 302, body: { status: true } }]).a.terminate("4242"), "unknown");
  await rejects(adapter([{ status: 300, body: { instance: vm() } }]).a.status("4242"), "unknown");
});

test("terminate: a 409 is done only when the VM is DELETING, DELETED or gone", async () => {
  for (const r of [{ status: 200, body: { instance: vm({ status: "DELETING" }) } }, { status: 200, body: { instance: vm({ status: "DELETED" }) } }, { status: 404 }]) {
    const { a, calls } = adapter([{ status: 409 }, r]);
    await a.terminate("4242");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.init.method, "GET");
  }
  await rejects(adapter([{ status: 409 }, { status: 200, body: { instance: vm() } }]).a.terminate("4242"), "unplaceable");
  await rejects(adapter([{ status: 409 }, { status: 200, body: { instance: vm({ status: "STOPPING" }) } }]).a.terminate("4242"), "unplaceable");
  await rejects(adapter([{ status: 409 }, { status: 500 }]).a.terminate("4242"), "transient");
});

// ---------------------------------------------------------------- listMachines

function page(rows: unknown[], count: number, n = 1) {
  return { status: 200, body: { status: true, message: "", count, page: n, page_size: 100, instances: rows } };
}

function vms(from: number, n: number, named = true) {
  return Array.from({ length: n }, (_, i) => vm({ id: from + i, name: named ? `sbg-mch_${String(from + i).padStart(20, "0")}` : "someone-else" }));
}

test("listMachines: ours only, foreign VMs skipped, pages by number", async () => {
  const { a, calls } = adapter([page([...vms(1, 60), ...vms(61, 40, false)], 130), page(vms(101, 30), 130, 2)]);
  const out = await a.listMachines();
  assert.equal(out.length, 90);
  assert.deepEqual(calls.map((c) => c.url.slice(HYPERSTACK.length)), ["/core/virtual-machines?page=1&pageSize=100", "/core/virtual-machines?page=2&pageSize=100"]);
  assert.equal(new Set(out.map((s) => s.providerMachineId)).size, 90);
});

test("listMachines: exactly one full page is one request", async () => {
  const { a, calls } = adapter([page(vms(1, 100), 100)]);
  assert.equal((await a.listMachines()).length, 100);
  assert.equal(calls.length, 1);
});

test("listMachines: an empty account is one request", async () => {
  const { a, calls } = adapter([page([], 0)]);
  assert.deepEqual(await a.listMachines(), []);
  assert.equal(calls.length, 1);
});

test("listMachines: fails closed on a changed count, short or long page, duplicate, nameless or malformed row", async () => {
  await rejects(adapter([page(vms(1, 100), 150), page(vms(101, 51), 151, 2)]).a.listMachines(), "unknown");
  await rejects(adapter([page(vms(1, 99), 150)]).a.listMachines(), "unknown");
  await rejects(adapter([page(vms(1, 3), 2)]).a.listMachines(), "unknown");
  await rejects(adapter([page(vms(1, 1), 0)]).a.listMachines(), "unknown");
  await rejects(adapter([page([...vms(1, 2), ...vms(1, 1)], 3)]).a.listMachines(), "unknown");
  await rejects(adapter([page([...vms(1, 2, false), ...vms(2, 1, false)], 3)]).a.listMachines(), "unknown");
  await rejects(adapter([page([vm({ name: undefined })], 1)]).a.listMachines(), "unknown");
  await rejects(adapter([page([vm({ id: null })], 1)]).a.listMachines(), "unknown");
  for (const body of [null, [], { instances: [] }, { count: 0 }, { count: -1, instances: [] }, { count: 1.5, instances: [] }, { count: "0", instances: [] }]) {
    await rejects(adapter([{ status: 200, body }]).a.listMachines(), "unknown");
  }
});

test("listMachines: more than 50 pages fails", async () => {
  const replies = Array.from({ length: 50 }, (_, i) => page(vms(i * 100 + 1, 100, false), 5001, i + 1));
  const { a, calls } = adapter(replies);
  await rejects(a.listMachines(), "unknown");
  assert.equal(calls.length, 50);
});

// ---------------------------------------------------------------- keypairs

test("importKeypair: posts name, environment and key; returns the id", async () => {
  const { publicKey } = await perLaunchKeypair();
  const { a, calls } = adapter([{ status: 201, body: { status: true, keypair: { id: 77, name: "sbg-k-1", fingerprint: "f", public_key: publicKey } } }]);
  assert.equal(await a.importKeypair("sbg-k-1", "sbg-canada", publicKey), 77);
  assert.equal(calls[0]!.url, `${HYPERSTACK}/core/keypairs`);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.init.body!), { name: "sbg-k-1", environment_name: "sbg-canada", public_key: publicKey });
});

test("importKeypair: a reply without our keypair's id is outcome_unknown", async () => {
  const { publicKey } = await perLaunchKeypair();
  for (const body of [{}, { keypair: null }, { keypair: { id: 0, name: "sbg-k-1" } }, { keypair: { id: "77", name: "sbg-k-1" } }, { keypair: { id: 77, name: "sbg-k-2" } }, { keypair: { id: 77 } }]) {
    await rejects(adapter([{ status: 201, body }]).a.importKeypair("sbg-k-1", "sbg-canada", publicKey), "outcome_unknown");
  }
  await rejects(adapter([{ status: 409 }]).a.importKeypair("sbg-k-1", "sbg-canada", publicKey), "unplaceable");
});

test("importKeypair: only our names and only an Ed25519 public line, checked before any request", async () => {
  const { publicKey } = await perLaunchKeypair();
  const bad: Array<[string, string]> = [
    ["k-1", publicKey],
    ["sbg-", publicKey],
    [`sbg-${"x".repeat(47)}`, publicKey],
    ["sbg-a b", publicKey],
    ["sbg-k-1", publicKey.replace("ssh-ed25519", "ssh-rsa")],
    ["sbg-k-1", `${publicKey} comment`],
    ["sbg-k-1", `${publicKey}\n`],
    ["sbg-k-1", "-----BEGIN PRIVATE KEY-----"],
    ["sbg-k-1", publicKey.slice(0, -1)],
  ];
  for (const [name, key] of bad) {
    const { a, calls } = adapter([]);
    await assert.rejects(a.importKeypair(name, "sbg-canada", key), RangeError, name);
    assert.equal(calls.length, 0);
  }
  const ok = adapter([{ status: 201, body: { keypair: { id: 1, name: `sbg-${"x".repeat(46)}` } } }]);
  assert.equal(await ok.a.importKeypair(`sbg-${"x".repeat(46)}`, "sbg-canada", publicKey), 1);
});

test("deleteKeypair: one DELETE; 404 is done; a bad id throws before any request", async () => {
  const { a, calls } = adapter([{ status: 200, body: { status: true } }]);
  await a.deleteKeypair(77);
  assert.equal(calls[0]!.url, `${HYPERSTACK}/core/keypair/77`);
  assert.equal(calls[0]!.init.method, "DELETE");
  await adapter([{ status: 404 }]).a.deleteKeypair(77);
  await rejects(adapter([{ status: 500 }]).a.deleteKeypair(77), "transient");
  for (const id of [0, -1, 1.5, Number.NaN]) {
    const b = adapter([]);
    await assert.rejects(b.a.deleteKeypair(id), RangeError);
    assert.equal(b.calls.length, 0);
  }
});
