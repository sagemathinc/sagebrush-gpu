// Hyperstack launch, mock-only: the create path's every boundary. No test reaches Hyperstack.

import assert from "node:assert/strict";
import { machineName } from "../machine-name.ts";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BOOT_SCRIPT_VECTOR, renderBootCommand, renderBootScript } from "@sbgpu/machine";
import { expectedSpec, specDrift } from "../drift.ts";
import { ProviderError } from "../errors.ts";
import type { Fetch, HttpRequest } from "../http.ts";
import type { LaunchSpec } from "../types.ts";
import { createBody, HyperstackAdapter, launchKeypairName, MAX_REPLY_BYTES, parseKeypairName, MAX_SCRIPT_BYTES, vmLaunchScript, vmReadbackProblems, type HyperstackLaunchConfig } from "./adapter.ts";

const KEY = "test-key-not-a-real-key";
const NOW = new Date("2026-11-25T12:00:00.000Z");
const MID = BOOT_SCRIPT_VECTOR.values.machineId;
const NAME = machineName("test", MID, 1);
const KEY_NAME = `sbg-k-${MID}-1`;
const SCRIPT = renderBootScript(BOOT_SCRIPT_VECTOR.values);
const ENVS: HyperstackLaunchConfig = { environments: { "CANADA-1": "sbg-canada" } };

const spec: LaunchSpec = {
  machineId: MID, incarnation: 1, name: NAME,
  gpuType: "RTX-A6000",
  gpuCount: 1,
  dataCenter: "CANADA-1",
  image: "Ubuntu Server 22.04 LTS",
  diskGb: 100,
  bootToken: "",
  launcher: ["/bin/sh", "-c", SCRIPT],
  maxProviderCostPerHour: 1_000_000,
};

type Reply = { status: number; body?: unknown } | Error;
type Route = (method: string, path: string, n: number) => Reply;

/** A fetch that answers by route and records every request; every request must be redirect: manual. */
function mockFetch(route: Route) {
  const calls: Array<{ method: string; path: string; init: HttpRequest }> = [];
  const fetch: Fetch = async (url, init) => {
    if (init.redirect !== "manual") throw new Error(`request without redirect: "manual": ${init.method} ${url}`);
    const path = url.slice("https://infrahub-api.nexgencloud.com/v1".length);
    calls.push({ method: init.method, path, init });
    const r = route(init.method, path, calls.length);
    if (r instanceof Error) throw r;
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { status: r.status, headers: { get: () => null }, text: async () => { throw new Error("text() must not be called"); }, body: new Response(text).body };
  };
  return { fetch, calls };
}

function vm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    name: NAME,
    status: "BUILD",
    floating_ip: null,
    floating_ip_status: "ATTACHING",
    port_randomization: false,
    security_rules: [],
    enhanced_metrics: { enabled: false },
    volume_attachments: [],
    labels: [],
    callback_url: null,
    environment: { id: 1, name: "sbg-canada", region: "CANADA-1" },
    flavor: { id: 9, name: "n3-RTX-A6000x1", gpu: "RTX-A6000", gpu_count: 1, disk: 100 },
    image: { name: "Ubuntu Server 22.04 LTS" },
    keypair: { name: KEY_NAME },
    ...over,
  };
}

function flavor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 9, name: "n3-RTX-A6000x1", gpu: "RTX-A6000", gpu_count: 1, disk: 100, region_name: "CANADA-1", stock_available: true, ...over };
}

const FLAVORS = { data: [{ gpu: "RTX-A6000", region_name: "CANADA-1", flavors: [flavor(), flavor({ id: 10, name: "n3-RTX-A6000x2", gpu_count: 2 })] }] };

/** The happy path's replies, each replaceable. */
function routes(over: Partial<Record<"flavors" | "keys" | "import" | "create" | "list" | "get" | "delete", Reply>> = {}): Route {
  return (method, path) => {
    if (method === "GET" && path === "/core/flavors") return over.flavors ?? { status: 200, body: FLAVORS };
    if (method === "GET" && path.startsWith("/core/keypairs?")) return over.keys ?? { status: 200, body: { count: 0, keypairs: [] } };
    if (method === "POST" && path === "/core/keypairs") return over.import ?? { status: 201, body: { keypair: { id: 77, name: KEY_NAME } } };
    if (method === "POST" && path === "/core/virtual-machines") return over.create ?? { status: 200, body: { status: true, instances: [vm()] } };
    if (method === "GET" && path.startsWith("/core/virtual-machines?")) return over.list ?? { status: 200, body: { count: 0, instances: [] } };
    if (method === "GET" && path === "/core/virtual-machines/4242") return over.get ?? { status: 200, body: { instance: vm() } };
    if (method === "DELETE" && path === "/core/keypair/77") return over.delete ?? { status: 200, body: { status: true } };
    throw new Error(`unexpected request ${method} ${path}`);
  };
}

/** An adapter over `route`; `launch` null means built without a launch config (as in production). */
function launcher(route: Route, launch: HyperstackLaunchConfig | null = ENVS) {
  const m = mockFetch(route);
  const opts = { apiKey: KEY, fetch: m.fetch, now: () => NOW, ...(launch === null ? {} : { launch }) };
  return { a: new HyperstackAdapter(opts), calls: m.calls };
}

const trail = (calls: Array<{ method: string; path: string }>) => calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
const HAPPY = ["GET /core/flavors", "GET /core/keypairs", "POST /core/keypairs", "POST /core/virtual-machines", "GET /core/virtual-machines/4242", "DELETE /core/keypair/77"];

function fails(kind: string, opts: { id?: string | null; message?: RegExp } = {}) {
  return (e: unknown) => {
    assert.ok(e instanceof ProviderError, String(e));
    assert.equal(e.provider, "hyperstack");
    assert.equal(e.kind, kind, e.message);
    if (opts.id !== undefined) assert.equal(e.providerMachineId, opts.id, e.message);
    if (opts.message !== undefined) assert.match(e.message, opts.message);
    assert.ok(!e.message.includes(KEY));
    return true;
  };
}

// ---------------------------------------------------------------- the happy path and its hashes

test("launch: flavor, key, create, readback, key removed; the VM and the integrity record", async () => {
  const { a, calls } = launcher(routes());
  const r = await a.launch(spec);
  assert.deepEqual(trail(calls), HAPPY);
  assert.equal(r.providerMachineId, "4242");
  assert.equal(r.status.machineId, MID);
  assert.equal(r.status.state, "provisioning");
  assert.deepEqual(r.integrity, {
    bootScriptSha256: BOOT_SCRIPT_VECTOR.sha256,
    requestSha256: createHash("sha256").update(calls[3]!.init.body!, "utf8").digest("hex"),
    echo: "unobservable",
  });
  // The machine as launched shows no drift: no environment, the command unobservable on both sides.
  assert.deepEqual(specDrift(expectedSpec(spec, a.info, "4242"), { ...r.status, providerCostPerHour: 1_000_000 }), []);
});

test("launch: the hashes are of the exact bytes sent; user_data is exactly the script's bytes", async () => {
  const { a, calls } = launcher(routes());
  const r = await a.launch(spec);
  const sent = calls.find((c) => c.method === "POST" && c.path === "/core/virtual-machines")!.init.body!;
  assert.equal(r.integrity!.requestSha256, createHash("sha256").update(Buffer.from(sent, "utf8")).digest("hex"));
  const userData = Buffer.from((JSON.parse(sent) as { user_data: string }).user_data, "base64");
  assert.deepEqual(userData, Buffer.from(SCRIPT, "utf8"));
  assert.equal(createHash("sha256").update(userData).digest("hex"), BOOT_SCRIPT_VECTOR.sha256);
  assert.equal(r.integrity!.bootScriptSha256, BOOT_SCRIPT_VECTOR.sha256);
  // The shared rendering: the VM command's user data is this script.
  assert.deepEqual(renderBootCommand(BOOT_SCRIPT_VECTOR.values), { userData: SCRIPT });
});

test("createBody: exactly the reviewed fields, in a fixed order, and deterministic", () => {
  const req = { name: NAME, environmentName: "sbg-canada", imageName: "Ubuntu Server 22.04 LTS", flavorName: "n3-RTX-A6000x1", keyName: KEY_NAME, script: SCRIPT };
  const text = createBody(req);
  assert.equal(createBody({ ...req }), text);
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), [
    "name", "environment_name", "image_name", "flavor_name", "key_name", "count", "assign_floating_ip",
    "enable_port_randomization", "enhanced_monitoring_enabled", "security_rules", "user_data",
  ]);
  assert.deepEqual(body, {
    name: NAME,
    environment_name: "sbg-canada",
    image_name: "Ubuntu Server 22.04 LTS",
    flavor_name: "n3-RTX-A6000x1",
    key_name: KEY_NAME,
    count: 1,
    assign_floating_ip: true,
    enable_port_randomization: false,
    enhanced_monitoring_enabled: false,
    security_rules: [],
    user_data: Buffer.from(SCRIPT, "utf8").toString("base64"),
  });
  // user_data's limit is 65535 base64 characters: 49149 bytes (65532 characters) fit; 49150 (65536) don't.
  assert.equal(JSON.parse(createBody({ ...req, script: "a".repeat(49_149) })).user_data.length, 65_532);
  assert.throws(() => createBody({ ...req, script: "a".repeat(49_150) }), fails("invalid_request"));
});

// ---------------------------------------------------------------- refused before any request

test("launch: no launch config refuses before any request", async () => {
  const { a, calls } = launcher(routes(), null);
  await assert.rejects(a.launch(spec), fails("invalid_request", { message: /^Hyperstack: VM launch is not enabled$/ }));
  assert.equal(calls.length, 0);
});

test("launch: a missing, inherited or malformed environment refuses before any request", async () => {
  const inherited = Object.create({ "CANADA-1": "sbg-canada" }) as Record<string, string>;
  const configs: HyperstackLaunchConfig[] = [
    { environments: {} },
    { environments: { "US-1": "sbg-us" } },
    { environments: inherited },
    { environments: { "CANADA-1": "" } },
    { environments: { "CANADA-1": "bad name" } },
    { environments: { "CANADA-1": "-lead" } },
    { environments: { "CANADA-1": "x".repeat(51) } },
    { environments: { "CANADA-1": 5 as unknown as string } },
  ];
  for (const cfg of configs) {
    const { a, calls } = launcher(routes(), cfg);
    await assert.rejects(a.launch(spec), fails("unplaceable"));
    assert.equal(calls.length, 0);
  }
  for (const dataCenter of ["toString", "__proto__", "constructor", "canada-1"]) {
    const { a, calls } = launcher(routes());
    await assert.rejects(a.launch({ ...spec, dataCenter }), fails("unplaceable"), dataCenter);
    assert.equal(calls.length, 0);
  }
  // The longest accepted environment name.
  const ok = launcher(routes({ flavors: { status: 500 } }), { environments: { "CANADA-1": `a${"x".repeat(49)}` } });
  await assert.rejects(ok.a.launch(spec), fails("transient"));
  assert.equal(ok.calls.length, 1);
});

test("launch: any other launcher shape, or a boot token, refuses before any request", async () => {
  const launchers: unknown[] = [
    [],
    ["/bin/sh", "-c"],
    ["/bin/sh", "-c", SCRIPT, "extra"],
    ["/bin/bash", "-c", SCRIPT],
    ["/bin/sh", "-x", SCRIPT],
    ["sh", "-c", SCRIPT],
    ["/bin/sh", "-c", ""],
    ["/bin/sh", "-c", 5],
    "/bin/sh -c script",
  ];
  for (const l of launchers) {
    const { a, calls } = launcher(routes());
    await assert.rejects(a.launch({ ...spec, launcher: l as string[] }), fails("invalid_request"), JSON.stringify(l));
    assert.equal(calls.length, 0);
  }
  for (const bootToken of ["t", "A".repeat(43)]) {
    const { a, calls } = launcher(routes());
    await assert.rejects(a.launch({ ...spec, bootToken }), fails("invalid_request", { message: /no boot token/ }));
    assert.equal(calls.length, 0);
  }
  assert.equal(vmLaunchScript(spec), SCRIPT);
});

test("launch: a bad machine id, GPU, count, disk or image refuses before any request", async () => {
  const bad: Array<Partial<LaunchSpec>> = [
    { machineId: "mch_short" },
    { machineId: "pod1" },
    { gpuType: "L4" },
    { gpuCount: 0 },
    { gpuCount: 1.5 },
    { gpuCount: 2 ** 53 },
    { diskGb: 0 },
    { diskGb: 100.5 },
    { image: "" },
    { image: "a/b" },
    { image: "ubuntu;rm" },
    { image: ` ${spec.image}` },
    { image: "x".repeat(101) },
  ];
  for (const over of bad) {
    const { a, calls } = launcher(routes());
    await assert.rejects(a.launch({ ...spec, ...over }), fails("invalid_request"), JSON.stringify(over));
    assert.equal(calls.length, 0);
  }
});

// ---------------------------------------------------------------- flavor

test("launch: zero or several matching flavors refuse after the one flavor read", async () => {
  const lists: Array<Array<Record<string, unknown>>> = [
    [],
    [flavor({ gpu_count: 2 })],
    [flavor({ region_name: "NORWAY-1" })],
    [flavor({ disk: 200 })],
    [flavor({ gpu: "L40" })],
    [flavor(), flavor({ id: 11, name: "n3-RTX-A6000x1-b" })],
  ];
  for (const fs of lists) {
    const { a, calls } = launcher(routes({ flavors: { status: 200, body: { data: [{ flavors: fs }] } } }));
    await assert.rejects(a.launch(spec), fails("unplaceable"), JSON.stringify(fs));
    assert.deepEqual(trail(calls), ["GET /core/flavors"]);
  }
});

test("launch: an out-of-stock, badly named or malformed flavor list refuses before any key", async () => {
  const cases: Array<[unknown, string]> = [
    [{ data: [{ flavors: [flavor({ stock_available: false })] }] }, "no_capacity"],
    [{ data: [{ flavors: [flavor({ stock_available: "yes" })] }] }, "no_capacity"],
    [{ data: [{ flavors: [flavor({ name: "bad name" })] }] }, "unknown"],
    [{ data: [{ flavors: [flavor({ name: 7 })] }] }, "unknown"],
    [{ data: "x" }, "unknown"],
    [[], "unknown"],
  ];
  for (const [body, kind] of cases) {
    const { a, calls } = launcher(routes({ flavors: { status: 200, body } }));
    await assert.rejects(a.launch(spec), fails(kind), JSON.stringify(body));
    assert.deepEqual(trail(calls), ["GET /core/flavors"]);
  }
});

// ---------------------------------------------------------------- the key

test("launch: a refused key import stops with no VM requested; an unknown import is unknown, not 'a VM may exist'", async () => {
  const refused = launcher(routes({ import: { status: 409 } }));
  await assert.rejects(refused.a.launch(spec), fails("unplaceable", { id: null }));
  assert.deepEqual(trail(refused.calls), ["GET /core/flavors", "GET /core/keypairs", "POST /core/keypairs"]);
  for (const r of [new Error("reset"), { status: 201, body: { keypair: { id: 77, name: "sbg-k-other" } } }] as Reply[]) {
    const lost = launcher(routes({ import: r }));
    await assert.rejects(lost.a.launch(spec), fails("unknown", { id: null, message: new RegExp(`keypair ${KEY_NAME} import has an unknown outcome; no VM was requested`) }));
    // (and the key it may have left is looked up by its exact name: none here)
    assert.deepEqual(trail(lost.calls), ["GET /core/flavors", "GET /core/keypairs", "POST /core/keypairs", "GET /core/keypairs"]);
  }
});

test("launch: a definite create refusal removes the key and keeps the provider's kind and Retry-After", async () => {
  for (const [status, kind] of [[400, "invalid_request"], [402, "insufficient_funds"], [409, "unplaceable"], [429, "rate_limited"]] as const) {
    const m = mockFetch(routes({ create: { status } }));
    const a = new HyperstackAdapter({ apiKey: KEY, fetch: m.fetch, launch: ENVS });
    await assert.rejects(a.launch(spec), (e: unknown) => {
      assert.ok(e instanceof ProviderError && e.kind === kind && e.httpStatus === status && e.providerMachineId === null);
      return true;
    });
    assert.deepEqual(trail(m.calls), ["GET /core/flavors", "GET /core/keypairs", "POST /core/keypairs", "POST /core/virtual-machines", "DELETE /core/keypair/77"]);
  }
  // A key that can't be removed is named; the refusal is kept.
  const left = launcher(routes({ create: { status: 409 }, delete: { status: 500 } }));
  await assert.rejects(left.a.launch(spec), fails("unplaceable", { id: null, message: new RegExp(`keypair ${KEY_NAME} could not be removed`) }));
});

test("launch: a key that can't be removed after create fails the launch with the VM's id (it can't enroll)", async () => {
  for (const r of [{ status: 500 }, { status: 403 }, new Error("reset")] as Reply[]) {
    const { a, calls } = launcher(routes({ delete: r }));
    await assert.rejects(a.launch(spec), fails("unknown", { id: "4242", message: new RegExp(`VM 4242 was created; keypair ${KEY_NAME} could not be removed$`) }));
    assert.deepEqual(trail(calls), HAPPY);
  }
  // A key already gone (404) is removed.
  const gone = launcher(routes({ delete: { status: 404 } }));
  assert.equal((await gone.a.launch(spec)).providerMachineId, "4242");
});

// ---------------------------------------------------------------- readback

test("launch: a readback that fails throws with the VM's id, after removing the key", async () => {
  for (const r of [{ status: 500 }, { status: 404 }, new Error("reset"), { status: 200, body: { instance: vm({ id: 4243 }) } }, { status: 200, body: "{" }] as Reply[]) {
    const { a, calls } = launcher(routes({ get: r }));
    await assert.rejects(a.launch(spec), fails("unknown", { id: "4242", message: /could not be read back$/ }));
    assert.deepEqual(trail(calls), HAPPY);
  }
  const left = launcher(routes({ get: { status: 500 }, delete: { status: 500 } }));
  await assert.rejects(left.a.launch(spec), fails("unknown", { id: "4242", message: new RegExp(`read back; keypair ${KEY_NAME} could not be removed`) }));
});

const MISMATCHES: Array<[Record<string, unknown>, string]> = [
  [{ status: "ERROR" }, "status"],
  [{ status: "DELETING" }, "status"],
  [{ floating_ip: "10.0.0.5" }, "floating_ip"],
  [{ floating_ip: "198.51.100.7" }, "floating_ip"],
  [{ port_randomization: true }, "port_randomization"],
  [{ port_randomization: undefined }, "port_randomization"],
  [{ security_rules: [{ direction: "ingress", protocol: "tcp", port_range_min: 22, port_range_max: 22 }] }, "security_rules"],
  [{ security_rules: [{ direction: "egress" }] }, "security_rules"],
  [{ security_rules: undefined }, "security_rules"],
  [{ enhanced_metrics: { enabled: true } }, "enhanced_metrics"],
  [{ enhanced_metrics: undefined }, "enhanced_metrics"],
  [{ volume_attachments: [{ id: 1 }] }, "volumes"],
  [{ labels: ["x"] }, "labels"],
  [{ labels: "x" }, "labels"],
  [{ callback_url: "https://example.com/hook" }, "callback_url"],
  [{ name: "sbg-mch_other0000000000000" }, "name"],
  [{ environment: { name: "other", region: "CANADA-1" } }, "environment"],
  [{ flavor: { name: "n3-RTX-A6000x2" } }, "flavor"],
  [{ image: { name: "Ubuntu" } }, "image"],
  [{ keypair: { name: "sbg-k-other" } }, "keypair"],
  [{ keypair: null }, "keypair"],
];

test("launch: every security and identity field is read back; any difference fails with the VM's id", async () => {
  for (const [over, word] of MISMATCHES) {
    const { a, calls } = launcher(routes({ get: { status: 200, body: { instance: vm(over) } } }));
    await assert.rejects(a.launch(spec), fails("spec_mismatch", { id: "4242", message: new RegExp(`launch shape: ${word}$`) }), JSON.stringify(over));
    assert.deepEqual(trail(calls), HAPPY, JSON.stringify(over));
  }
});

test("launch: only availability may be pending at readback (CREATING/BUILD, no IP yet)", async () => {
  for (const over of [{ status: "CREATING" }, { status: "BUILD", floating_ip: undefined }, { status: "ACTIVE", floating_ip: "185.10.20.7", floating_ip_status: "ATTACHED" }, { floating_ip: "185.10.20.7" }, { volume_attachments: null, labels: null, callback_url: "" }]) {
    const { a } = launcher(routes({ get: { status: 200, body: { instance: vm(over) } } }));
    assert.equal((await a.launch(spec)).providerMachineId, "4242", JSON.stringify(over));
  }
});

test("launch: an ACTIVE VM at readback must have its public IPv4, attached", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ status: "ACTIVE", floating_ip: null, floating_ip_status: "ATTACHED" }, "floating_ip"],
    [{ status: "ACTIVE", floating_ip: undefined }, "floating_ip, floating_ip_status"],
    [{ status: "ACTIVE", floating_ip: "185.10.20.7", floating_ip_status: "DETACHED" }, "floating_ip_status"],
    [{ status: "ACTIVE", floating_ip: "185.10.20.7", floating_ip_status: "ATTACHING" }, "floating_ip_status"],
    [{ status: "ACTIVE", floating_ip: "10.0.0.5", floating_ip_status: "ATTACHED" }, "floating_ip"],
  ];
  for (const [over, words] of cases) {
    const { a, calls } = launcher(routes({ get: { status: 200, body: { instance: vm(over) } } }));
    await assert.rejects(a.launch(spec), fails("spec_mismatch", { id: "4242", message: new RegExp(`launch shape: ${words}$`) }), JSON.stringify(over));
    assert.deepEqual(trail(calls), HAPPY);
  }
  // Beside them, still building: the IP may be pending.
  for (const over of [{ status: "BUILD", floating_ip: null, floating_ip_status: "DETACHED" }, { status: "CREATING", floating_ip: "185.10.20.7", floating_ip_status: "ATTACHING" }]) {
    const { a } = launcher(routes({ get: { status: 200, body: { instance: vm(over) } } }));
    assert.equal((await a.launch(spec)).providerMachineId, "4242", JSON.stringify(over));
  }
});

test("vmReadbackProblems: 'starting' relaxes status and IP availability only", () => {
  const want = { name: NAME, environmentName: "sbg-canada", flavorName: "n3-RTX-A6000x1", imageName: "Ubuntu Server 22.04 LTS", keypairName: KEY_NAME };
  assert.deepEqual(vmReadbackProblems(vm(), want, { starting: true }), []);
  assert.deepEqual(vmReadbackProblems(vm(), want), ["status", "floating_ip", "floating_ip_status"]);
  for (const [over, word] of MISMATCHES) assert.ok(vmReadbackProblems(vm(over), want, { starting: true }).includes(word), JSON.stringify(over));
});

// ---------------------------------------------------------------- a lost create response

test("launch: a lost create with no VM by that name stays outcome_unknown and keeps the key", async () => {
  for (const create of [new Error("reset"), { status: 502 }, { status: 200, body: "{" }, { status: 200, body: { instances: [] } }, { status: 200, body: { instances: [vm({ name: "sbg-other" })] } }] as Reply[]) {
    const { a, calls } = launcher(routes({ create }));
    await assert.rejects(a.launch(spec), fails("outcome_unknown", { id: null, message: new RegExp(`no VM named ${NAME} yet; keypair ${KEY_NAME} kept for reconciliation`) }));
    assert.deepEqual(trail(calls), ["GET /core/flavors", "GET /core/keypairs", "POST /core/keypairs", "POST /core/virtual-machines", "GET /core/virtual-machines"]);
  }
});

test("launch: a lost create whose list can't be read stays outcome_unknown and keeps the key", async () => {
  const { a, calls } = launcher(routes({ create: new Error("reset"), list: { status: 500 } }));
  await assert.rejects(a.launch(spec), fails("outcome_unknown", { id: null, message: new RegExp(`the VM list could not be read; keypair ${KEY_NAME} kept`) }));
  assert.ok(!trail(calls).some((c) => c.startsWith("DELETE")));
});

test("launch: a lost create with exactly one VM by that name reads it back and accepts it", async () => {
  const listed = { status: 200, body: { count: 2, instances: [vm(), vm({ id: 5000, name: "someone-else" })] } };
  const { a, calls } = launcher(routes({ create: new Error("reset"), list: listed }));
  const r = await a.launch(spec);
  assert.equal(r.providerMachineId, "4242");
  assert.equal(r.integrity!.bootScriptSha256, BOOT_SCRIPT_VECTOR.sha256);
  assert.deepEqual(trail(calls), ["GET /core/flavors", "GET /core/keypairs", "POST /core/keypairs", "POST /core/virtual-machines", "GET /core/virtual-machines", "GET /core/virtual-machines/4242", "DELETE /core/keypair/77"]);
});

test("launch: a recovered VM must pass the same full readback", async () => {
  const listed = { status: 200, body: { count: 1, instances: [vm()] } };
  for (const [over, word] of MISMATCHES) {
    const { a } = launcher(routes({ create: new Error("reset"), list: listed, get: { status: 200, body: { instance: vm(over) } } }));
    await assert.rejects(a.launch(spec), fails("spec_mismatch", { id: "4242", message: new RegExp(`launch shape: ${word}$`) }), JSON.stringify(over));
  }
});

test("launch: a spec whose name isn't exactly its own machine and incarnation is refused before any request", async () => {
  for (const over of [{ incarnation: 2 }, { name: `sbg-${MID}` }, { name: machineName("test", "mch_7f3k9q2m4x8z1c5v6b0n", 1) }]) {
    const { a, calls } = launcher(routes());
    await assert.rejects(a.launch({ ...spec, ...over }), fails("invalid_request"), JSON.stringify(over));
    assert.equal(calls.length, 0);
  }
});

test("launch: a lost create's recovery never takes a VM of this machine named for another installation or incarnation", async () => {
  for (const name of [machineName("othr", MID, 1), machineName("test", MID, 2)]) {
    const { a, calls } = launcher(routes({ create: new Error("reset"), list: { status: 200, body: { count: 1, instances: [vm({ id: 4300, name })] } } }));
    await assert.rejects(a.launch(spec), fails("outcome_unknown", { id: null, message: /no VM named/ }), name);
    assert.ok(!trail(calls).includes("GET /core/virtual-machines/4300"), name);
  }
});

test("launch: a lost create's recovery takes only the VM with our name, not another machine of ours", async () => {
  const other = vm({ id: 4300, name: machineName("test", "mch_7f3k9q2m4x8z1c5v6b0n", 1) });
  const listed = { status: 200, body: { count: 2, instances: [other, vm()] } };
  const { a, calls } = launcher(routes({ create: new Error("reset"), list: listed }));
  assert.equal((await a.launch(spec)).providerMachineId, "4242");
  assert.ok(trail(calls).includes("GET /core/virtual-machines/4242"));
  const onlyOther = launcher(routes({ create: new Error("reset"), list: { status: 200, body: { count: 1, instances: [other] } } }));
  await assert.rejects(onlyOther.a.launch(spec), fails("outcome_unknown", { message: /no VM named/ }));
});

test("launch: a create reply that isn't exactly one VM of ours is a lost response", async () => {
  const two = { status: 200, body: { instances: [vm(), vm({ id: 4243 })] } };
  const { a, calls } = launcher(routes({ create: two }));
  await assert.rejects(a.launch(spec), fails("outcome_unknown", { message: /no VM named/ }));
  assert.deepEqual(trail(calls).slice(-1), ["GET /core/virtual-machines"]);
});

test("launch: a lost create with several VMs by that name fails with their ids and keeps the key", async () => {
  const listed = { status: 200, body: { count: 2, instances: [vm(), vm({ id: 4243 })] } };
  const { a, calls } = launcher(routes({ create: new Error("reset"), list: listed }));
  await assert.rejects(a.launch(spec), fails("outcome_unknown", { id: "4242", message: new RegExp(`2 VMs are named ${NAME}: 4242, 4243; keypair ${KEY_NAME} kept`) }));
  assert.ok(!trail(calls).some((c) => c.startsWith("DELETE")));
});

// ---------------------------------------------------------------- the caller's deadline

test("launch: shouldStop is honoured before every request, on every path, cleanup and recovery included", async () => {
  type Row = [string, Partial<Record<"flavors" | "keys" | "import" | "create" | "list" | "get" | "delete", Reply>>, number, string, string | null, RegExp];
  const kept = `keypair ${KEY_NAME} kept`;
  const lost = { create: new Error("reset"), list: { status: 200, body: { count: 1, instances: [vm()] } } };
  const rows: Row[] = [
    // The happy path: flavors, the key lookup, import, create, readback, delete.
    ["happy", {}, 0, "unknown", null, /before creating a VM$/],
    ["happy", {}, 1, "unknown", null, /before creating a VM$/],
    ["happy", {}, 2, "unknown", null, /before creating a VM$/],
    ["happy", {}, 3, "unknown", null, new RegExp(`before creating a VM; ${kept}$`)],
    ["happy", {}, 4, "outcome_unknown", "4242", new RegExp(`after creating VM 4242; ${kept}$`)],
    ["happy", {}, 5, "unknown", "4242", new RegExp(`VM 4242 was created; stopped at the caller's deadline; ${kept}$`)],
    // A lost import: ..., import (lost), and its key not looked up after the stop.
    ["lost import", { import: new Error("reset") }, 3, "unknown", null, new RegExp(`no VM was requested; stopped at the caller's deadline; ${kept}$`)],
    // A definite refusal: flavors, the key lookup, import, create (409), delete.
    ["refused", { create: { status: 409 } }, 4, "unplaceable", null, new RegExp(`\\(unplaceable\\); stopped at the caller's deadline; ${kept}$`)],
    // A failed readback: ..., readback (500), delete.
    ["readback fails", { get: { status: 500 } }, 5, "unknown", "4242", new RegExp(`could not be read back; stopped at the caller's deadline; ${kept}$`)],
    // A readback mismatch: ..., readback, delete.
    ["mismatch", { get: { status: 200, body: { instance: vm({ labels: ["x"] }) } } }, 5, "spec_mismatch", "4242", new RegExp(`labels; stopped at the caller's deadline; ${kept}$`)],
    // A lost create: ..., create (lost), list, readback, delete.
    ["lost", lost, 4, "outcome_unknown", null, new RegExp(`stopped at the caller's deadline; ${kept} for reconciliation$`)],
    ["lost", lost, 5, "outcome_unknown", "4242", new RegExp(`after creating VM 4242; ${kept}$`)],
    ["lost", lost, 6, "unknown", "4242", new RegExp(`VM 4242 was created; stopped at the caller's deadline; ${kept}$`)],
  ];
  for (const [what, over, n, kind, id, message] of rows) {
    const { a, calls } = launcher(routes(over));
    await assert.rejects(a.launch(spec, { shouldStop: () => calls.length >= n }), fails(kind, { id, message }), `${what} ${n}`);
    assert.equal(calls.length, n, `${what} ${n}: no request after the stop`);
  }
  // Controls: with no stop, each path makes one more request than its last stop row allows.
  for (const [over, count] of [[{}, 6], [{ create: { status: 409 } }, 5], [{ get: { status: 500 } }, 6], [lost, 7], [{ import: new Error("reset") }, 4]] as const) {
    const { a, calls } = launcher(routes(over));
    await a.launch(spec, { shouldStop: () => false }).catch(() => {});
    assert.equal(calls.length, count);
  }
});

test("launch: recovery checks the stop before every page; a stop during page 1 requests no page 2", async () => {
  const page = (n: number) => ({ status: 200, body: { count: 200, instances: Array.from({ length: 100 }, (_, i) => vm({ id: 10_000 + n * 100 + i, name: `other-${n}-${i}` })) } });
  let pages = 0;
  const route: Route = (method, path, n) => {
    if (method === "GET" && path.startsWith("/core/virtual-machines?")) {
      pages++;
      return page(pages);
    }
    return routes({ create: new Error("reset") })(method, path, n);
  };
  const stopped = launcher(route);
  await assert.rejects(stopped.a.launch(spec, { shouldStop: () => pages >= 1 }), fails("outcome_unknown", { message: /stopped at the caller's deadline; keypair/ }));
  assert.equal(pages, 1);
  // Control: without the stop, page 2 is read (and no VM is ours).
  pages = 0;
  const control = launcher(route);
  await assert.rejects(control.a.launch(spec), fails("outcome_unknown", { message: /no VM named/ }));
  assert.equal(pages, 2);
});

test("launch: recovery reads at most 5 pages; a longer list proves nothing", async () => {
  let pages = 0;
  const route: Route = (method, path, n) => {
    if (method === "GET" && path.startsWith("/core/virtual-machines?")) {
      pages++;
      return { status: 200, body: { count: 600, instances: Array.from({ length: 100 }, (_, i) => vm({ id: 20_000 + pages * 100 + i, name: `other-${i}` })) } };
    }
    return routes({ create: new Error("reset") })(method, path, n);
  };
  const { a } = launcher(route);
  await assert.rejects(a.launch(spec), fails("outcome_unknown", { message: /the VM list could not be read; keypair/ }));
  assert.equal(pages, 5);
  // The full list (the watchdog's) still reads past 5 pages.
  pages = 0;
  const m = mockFetch(route);
  assert.deepEqual(await new HyperstackAdapter({ apiKey: KEY, fetch: m.fetch }).listMachines(), []);
  assert.equal(pages, 6);
});

// ---------------------------------------------------------------- the script, admitted before any work

test("launch: the script is admitted by its UTF-8 size before any hash, encoding or request", async () => {
  const at = (script: string) => ({ ...spec, launcher: ["/bin/sh", "-c", script] });
  const ok = [
    "a".repeat(MAX_SCRIPT_BYTES),
    `${"\u00e9".repeat((MAX_SCRIPT_BYTES - 1) / 2)}a`, // 2-byte characters
    "\u20ac".repeat(MAX_SCRIPT_BYTES / 3), // 3-byte characters
    `${"\u{1F600}".repeat((MAX_SCRIPT_BYTES - 1) / 4)}a`, // 4-byte characters
  ];
  for (const script of ok) {
    assert.equal(Buffer.byteLength(script, "utf8"), MAX_SCRIPT_BYTES);
    const { a, calls } = launcher(routes());
    const r = await a.launch(at(script));
    assert.equal(r.integrity!.bootScriptSha256, createHash("sha256").update(script, "utf8").digest("hex"));
    assert.deepEqual(trail(calls), HAPPY);
  }
  const tooLong = [
    "a".repeat(MAX_SCRIPT_BYTES + 1),
    "\u00e9".repeat((MAX_SCRIPT_BYTES + 1) / 2), // 49150 bytes, 24575 characters
    `${"\u20ac".repeat(MAX_SCRIPT_BYTES / 3)}a`,
    "\u{1F600}".repeat((MAX_SCRIPT_BYTES + 3) / 4),
    "a".repeat(1 << 20),
    "ok\uD800", // a lone surrogate has no UTF-8 form
    "\uDC00ok",
  ];
  for (const script of tooLong) {
    const { a, calls } = launcher(routes());
    await assert.rejects(a.launch(at(script)), fails("invalid_request", { message: /too long for user_data, or not text/ }));
    assert.equal(calls.length, 0);
  }
});

test("launch: an oversized script does no encoding or hashing at all", async () => {
  const Encoder = globalThis.TextEncoder;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let encodes = 0;
  let digests = 0;
  globalThis.TextEncoder = class extends Encoder {
    override encode(input?: string) {
      encodes++;
      return super.encode(input);
    }
  } as typeof TextEncoder;
  crypto.subtle.digest = (async (...args: Parameters<typeof digest>) => {
    digests++;
    return digest(...args);
  }) as typeof crypto.subtle.digest;
  try {
    const { a, calls } = launcher(routes());
    await assert.rejects(a.launch({ ...spec, launcher: ["/bin/sh", "-c", "a".repeat(1 << 20)] }), fails("invalid_request"));
    assert.equal(calls.length, 0);
    assert.equal(encodes, 0);
    assert.equal(digests, 0);
    // Control: an admitted script is encoded and hashed.
    const ok = launcher(routes());
    await ok.a.launch(spec);
    assert.ok(encodes > 0 && digests > 0);
  } finally {
    globalThis.TextEncoder = Encoder;
    crypto.subtle.digest = digest;
  }
});

// ---------------------------------------------------------------- reply bodies, bounded

test("launch: a create reply over MAX_REPLY_BYTES is a lost response: recovery by name, key kept", async () => {
  const big = JSON.stringify({ status: true, instances: [vm()], pad: "x".repeat(MAX_REPLY_BYTES) });
  const { a, calls } = launcher(routes({ create: { status: 200, body: big } }));
  await assert.rejects(a.launch(spec), fails("outcome_unknown", { message: /no VM named/ }));
  assert.deepEqual(trail(calls).slice(-1), ["GET /core/virtual-machines"]);
  // The same reply over the cap but recovered by name is read back like any other.
  const found = launcher(routes({ create: { status: 200, body: big }, list: { status: 200, body: { count: 1, instances: [vm()] } } }));
  assert.equal((await found.a.launch(spec)).providerMachineId, "4242");
});

test("launch: a stop that arrives during key generation or hashing stops the very next request", async () => {
  // Every async crypto step of a launch is hooked; the stop flag flips when the k-th one completes.
  const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const names = ["digest", "generateKey", "exportKey"] as const;
  const real = Object.fromEntries(names.map((n) => [n, subtle[n]!.bind(crypto.subtle)]));
  let done = 0;
  let flipAt = Number.POSITIVE_INFINITY;
  let stopped = false;
  // The requests made so far, when the stop flips: no request may follow it.
  let current: unknown[] = [];
  let atFlip = -1;
  for (const n of names) {
    subtle[n] = async (...args: unknown[]) => {
      const r = await real[n]!(...args);
      if (++done === flipAt) {
        stopped = true;
        atFlip = current.length;
      }
      return r;
    };
  }
  try {
    // How many crypto steps a whole launch takes, unstopped.
    const control = launcher(routes());
    await control.a.launch(spec);
    const steps = done;
    assert.ok(steps >= 4, `crypto steps ${steps}`);
    for (let k = 1; k <= steps; k++) {
      done = 0;
      flipAt = k;
      stopped = false;
      const { a, calls } = launcher(routes());
      current = calls;
      atFlip = -1;
      const outcome = await a.launch(spec, { shouldStop: () => stopped }).then(() => "launched", (e: unknown) => e);
      assert.ok(outcome instanceof ProviderError, `step ${k}: ${String(outcome)}`);
      assert.ok(atFlip >= 0, `step ${k}: the stop never flipped`);
      assert.equal(calls.length, atFlip, `step ${k}: a request after the stop (${trail(calls).join(", ")})`);
    }
  } finally {
    for (const n of names) subtle[n] = real[n]!;
  }
});

test("launch: a stop during key generation sends no key; a stop during the request hash sends no key either", async () => {
  const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const hook of ["generateKey", "digest"] as const) {
    const real = subtle[hook]!.bind(crypto.subtle);
    let stopped = false;
    let n = 0;
    subtle[hook] = async (...args: unknown[]) => {
      const r = await real(...args);
      // generateKey: the per-launch key. digest: the second one, the request body's hash.
      if (hook === "generateKey" || ++n === 2) stopped = true;
      return r;
    };
    try {
      const { a, calls } = launcher(routes());
      await assert.rejects(a.launch(spec, { shouldStop: () => stopped }), fails("unknown", { id: null, message: /before creating a VM$/ }), hook);
      assert.deepEqual(trail(calls), ["GET /core/flavors"], hook);
    } finally {
      subtle[hook] = real;
    }
  }
});

// ---------------------------------------------------------------- keypairs (Codex audit G03-3)

const keys = (rows: Array<{ id: number; name: string }>, count = rows.length) => ({ status: 200, body: { status: true, count, keypairs: rows } });
const OTHER_INCARNATION = `sbg-k-${MID}-2`;

test("G03-3: a launch's keypair is named for its machine and incarnation, and parsed back", () => {
  assert.equal(launchKeypairName(MID, 1), KEY_NAME);
  assert.deepEqual(parseKeypairName(launchKeypairName(MID, 999_999_999_999)), { machineId: MID, incarnation: 999_999_999_999 });
  assert.ok(launchKeypairName(MID, 999_999_999_999).length <= 50);
  for (const n of [0, -1, 1.5, 1_000_000_000_000]) assert.throws(() => launchKeypairName(MID, n), RangeError, String(n));
  assert.throws(() => launchKeypairName("mch_short", 1), RangeError);
  for (const name of [`sbg-k-${MID}`, `sbg-k-${MID}-0`, `sbg-k-${MID}-01`, `x${KEY_NAME}`, `${KEY_NAME}x`, "my-laptop"]) assert.equal(parseKeypairName(name), null, name);
});

test("G03-3: a key an earlier attempt of this launch left is removed by its id before the import; another incarnation's is not touched", async () => {
  const route = routes({ keys: keys([{ id: 55, name: OTHER_INCARNATION }, { id: 56, name: KEY_NAME }, { id: 57, name: "my-laptop" }]) });
  const withDelete: Route = (method, path, n) => (method === "DELETE" && path === "/core/keypair/56" ? { status: 200, body: { status: true } } : route(method, path, n));
  const b = launcher(withDelete);
  assert.equal((await b.a.launch(spec)).providerMachineId, "4242");
  assert.deepEqual(trail(b.calls).slice(0, 4), ["GET /core/flavors", "GET /core/keypairs", "DELETE /core/keypair/56", "POST /core/keypairs"]);
  assert.ok(!trail(b.calls).includes("DELETE /core/keypair/55") && !trail(b.calls).includes("DELETE /core/keypair/57"));
});

test("G03-3: several keys with this launch's name, or a list that can't be read, stop the launch before any import", async () => {
  const two = launcher(routes({ keys: keys([{ id: 56, name: KEY_NAME }, { id: 58, name: KEY_NAME }]) }));
  await assert.rejects(two.a.launch(spec), fails("unknown", { id: null, message: new RegExp(`2 keypairs are named ${KEY_NAME} \\(56, 58\\); none removed`) }));
  assert.deepEqual(trail(two.calls), ["GET /core/flavors", "GET /core/keypairs"]);
  const down = launcher(routes({ keys: { status: 500 } }));
  await assert.rejects(down.a.launch(spec), fails("unknown", { message: /the keypair list could not be read/ }));
  assert.ok(!trail(down.calls).includes("POST /core/keypairs"));
});

test("G03-3: a lost import's key is found by its exact name and removed; several are refused; a failed delete is named", async () => {
  let listed = 0;
  const after = (rows: Array<{ id: number; name: string }>, del: Reply = { status: 200, body: { status: true } }): Route => {
    const base = routes({ import: new Error("reset") });
    return (method, path, n) => {
      if (method === "GET" && path.startsWith("/core/keypairs?")) return listed++ === 0 ? keys([]) : keys(rows);
      if (method === "DELETE" && path.startsWith("/core/keypair/")) return del;
      return base(method, path, n);
    };
  };
  listed = 0;
  const one = launcher(after([{ id: 88, name: KEY_NAME }, { id: 89, name: OTHER_INCARNATION }]));
  await assert.rejects(one.a.launch(spec), fails("unknown", { id: null, message: /import has an unknown outcome; no VM was requested$/ }));
  assert.deepEqual(trail(one.calls), ["GET /core/flavors", "GET /core/keypairs", "POST /core/keypairs", "GET /core/keypairs", "DELETE /core/keypair/88"]);
  listed = 0;
  const two = launcher(after([{ id: 88, name: KEY_NAME }, { id: 90, name: KEY_NAME }]));
  await assert.rejects(two.a.launch(spec), fails("unknown", { message: new RegExp(`2 keypairs are named ${KEY_NAME} \\(88, 90\\); none removed$`) }));
  assert.ok(!trail(two.calls).some((c) => c.startsWith("DELETE")));
  listed = 0;
  const stuck = launcher(after([{ id: 88, name: KEY_NAME }], { status: 500 }));
  await assert.rejects(stuck.a.launch(spec), fails("unknown", { message: new RegExp(`keypair ${KEY_NAME} could not be removed$`) }));
});

test("G03-3: the keypair list is read whole and checked: paging, count, length, duplicates, rows, a page cap", async () => {
  const pageOf = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, name: `k${from + i}` }));
  const paged = (pages: Reply[]): Route => {
    let i = 0;
    return (method, path) => {
      if (method === "GET" && path.startsWith("/core/keypairs?")) return pages[i++] ?? { status: 500 };
      throw new Error(`unexpected ${method} ${path}`);
    };
  };
  const two = launcher(paged([keys(pageOf(1, 100), 150), keys(pageOf(101, 50), 150)]));
  assert.equal((await two.a.listKeypairs()).length, 150);
  assert.deepEqual(two.calls.map((c) => new URL(`https://x${c.path}`).searchParams.toString()), ["page=1&pageSize=100", "page=2&pageSize=100"]);
  const bad: Array<[string, Reply[]]> = [
    ["no count", [{ status: 200, body: { keypairs: [] } }]],
    ["not an array", [{ status: 200, body: { count: 0, keypairs: {} } }]],
    ["a short page", [keys(pageOf(1, 99), 150)]],
    ["a long page", [keys(pageOf(1, 3), 2)]],
    ["the count changed", [keys(pageOf(1, 100), 150), keys(pageOf(101, 50), 151)]],
    // (a page of the length the new count says: only the count check sees it)
    ["the count fell", [keys(pageOf(1, 100), 150), keys(pageOf(101, 49), 149)]],
    ["a key twice", [keys([{ id: 1, name: "a" }, { id: 1, name: "b" }])]],
    ["a row without an id", [keys([{ id: 0, name: "a" }])]],
    ["a row without a name", [{ status: 200, body: { count: 1, keypairs: [{ id: 1 }] } }]],
    ["more than 20 pages", Array.from({ length: 21 }, (_, i) => keys(pageOf(1 + i * 100, 100), 2100))],
  ];
  for (const [what, pages] of bad) await assert.rejects(launcher(paged(pages)).a.listKeypairs(), fails("unknown"), what);
  await assert.rejects(launcher(paged([{ status: 500 }])).a.listKeypairs(), fails("transient"), "a list that fails");
  // a stop before a page requests none
  const stopped = launcher(paged([keys(pageOf(1, 100), 150)]));
  await assert.rejects(stopped.a.listKeypairs(() => stopped.calls.length >= 1), fails("unknown"));
  assert.equal(stopped.calls.length, 1);
});

test("G03-3: the keypair sweep deletes launch keys whose launch isn't kept; refuses a shared name and a failed delete; never touches other keys", async () => {
  const del: string[] = [];
  const M2 = "mch_aaaaaaaaaaaaaaaaaaaa";
  const listing = keys([
    { id: 1, name: KEY_NAME }, // kept
    { id: 2, name: OTHER_INCARNATION }, // not kept: deleted
    { id: 3, name: `sbg-k-${M2}-1` }, { id: 4, name: `sbg-k-${M2}-1` }, // one name, two keys: refused
    { id: 5, name: `sbg-k-${M2}-3` }, // its delete fails: refused
    { id: 6, name: "my-laptop" }, { id: 7, name: `sbg-k-${MID}` }, // not launch keys: never touched
  ]);
  const route: Route = (method, path) => {
    if (method === "GET" && path.startsWith("/core/keypairs?")) return listing;
    if (method === "DELETE") {
      del.push(path);
      return path === "/core/keypair/5" ? { status: 500 } : { status: 200, body: { status: true } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const asked: string[] = [];
  const { a } = launcher(route);
  const r = await a.sweepKeypairs(async (m, i) => {
    asked.push(`${m}-${i}`);
    return m === MID && i === 1;
  });
  assert.deepEqual(r, { deleted: [OTHER_INCARNATION], refused: [`sbg-k-${M2}-1`, `sbg-k-${M2}-3`] });
  assert.deepEqual(del, ["/core/keypair/2", "/core/keypair/5"]);
  assert.deepEqual(asked, [`${MID}-1`, `${MID}-2`, `${M2}-1`, `${M2}-3`]);
  // a list that can't be read deletes nothing
  const none: string[] = [];
  const down = launcher((method, path) => {
    if (method === "DELETE") none.push(path);
    return { status: 500 };
  });
  await assert.rejects(down.a.sweepKeypairs(async () => false), fails("transient"));
  assert.deepEqual(none, []);
  // the caller's stop ends the sweep before the next key
  const stopAfterOne = launcher(route);
  del.length = 0;
  let n = 0;
  let kept = 0;
  const s = await stopAfterOne.a.sweepKeypairs(async () => (kept++, false), () => del.length >= 1 && ++n > 0);
  assert.deepEqual(s.deleted, [KEY_NAME]);
  assert.deepEqual(del, ["/core/keypair/1"]);
  assert.equal(kept, 1, "no launch is even looked up after the stop");
});

test("G03-3: no request after the caller's stop in the key lookup: a stop during the list sends no delete, before the import or after a lost one", async () => {
  let stopNow = false;
  const stale = keys([{ id: 56, name: KEY_NAME }]);
  const base = routes({ keys: stale });
  const route: Route = (method, path, n) => {
    if (method === "GET" && path.startsWith("/core/keypairs?")) stopNow = true; // (the stop comes while the list is read)
    return base(method, path, n);
  };
  const pre = launcher(route);
  await assert.rejects(pre.a.launch(spec, { shouldStop: () => stopNow }), fails("unknown", { id: null, message: new RegExp(`stopped at the caller's deadline; keypair ${KEY_NAME} may be left$`) }));
  assert.deepEqual(trail(pre.calls), ["GET /core/flavors", "GET /core/keypairs"]);
  // after a lost import: the lookup's own stop, then no delete
  let lists = 0;
  stopNow = false;
  const lostBase = routes({ import: new Error("reset") });
  const lost: Route = (method, path, n) => {
    if (method === "GET" && path.startsWith("/core/keypairs?")) {
      if (lists++ === 0) return keys([]);
      stopNow = true;
      return stale;
    }
    return lostBase(method, path, n);
  };
  const after = launcher(lost);
  await assert.rejects(after.a.launch(spec, { shouldStop: () => stopNow }), fails("unknown", { message: /may be left$/ }));
  assert.deepEqual(trail(after.calls), ["GET /core/flavors", "GET /core/keypairs", "POST /core/keypairs", "GET /core/keypairs"]);
  // a stop between pages: no next page
  let pages = 0;
  const pageOf = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, name: `k${from + i}` }));
  const paged: Route = (method, path, n) => {
    if (method === "GET" && path.startsWith("/core/keypairs?")) return pages++ === 0 ? keys(pageOf(1, 100), 150) : keys(pageOf(101, 50), 150);
    return routes()(method, path, n);
  };
  const two = launcher(paged);
  await assert.rejects(two.a.launch(spec, { shouldStop: () => pages >= 1 }), fails("unknown", { message: new RegExp(`stopped at the caller's deadline; keypair ${KEY_NAME} may be left$`) }));
  assert.equal(pages, 1);
});

test("G03-3: the keypair sweep sends no delete after a stop that came while keep was deciding", async () => {
  const del: string[] = [];
  const route: Route = (method, path) => {
    if (method === "GET" && path.startsWith("/core/keypairs?")) return keys([{ id: 77, name: OTHER_INCARNATION }]);
    if (method === "DELETE") {
      del.push(path);
      return { status: 200, body: { status: true } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  let stopNow = false;
  const { a } = launcher(route);
  const r = await a.sweepKeypairs(async () => {
    stopNow = true;
    return false;
  }, () => stopNow);
  assert.deepEqual(r, { deleted: [], refused: [] });
  assert.deepEqual(del, []);
});
