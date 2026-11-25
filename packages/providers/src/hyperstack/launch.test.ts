// Hyperstack launch, mock-only: the create path's every boundary. No test reaches Hyperstack.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BOOT_SCRIPT_VECTOR, renderBootCommand, renderBootScript } from "@sbgpu/machine";
import { expectedSpec, specDrift } from "../drift.ts";
import { ProviderError } from "../errors.ts";
import type { Fetch, HttpRequest } from "../http.ts";
import type { LaunchSpec } from "../types.ts";
import { createBody, HyperstackAdapter, vmLaunchScript, vmReadbackProblems, type HyperstackLaunchConfig } from "./adapter.ts";

const KEY = "test-key-not-a-real-key";
const NOW = new Date("2026-11-25T12:00:00.000Z");
const MID = BOOT_SCRIPT_VECTOR.values.machineId;
const NAME = `sbg-${MID}`;
const KEY_NAME = `sbg-k-${MID}`;
const SCRIPT = renderBootScript(BOOT_SCRIPT_VECTOR.values);
const ENVS: HyperstackLaunchConfig = { environments: { "CANADA-1": "sbg-canada" } };

const spec: LaunchSpec = {
  machineId: MID,
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
    return { status: r.status, headers: { get: () => null }, text: async () => text };
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
function routes(over: Partial<Record<"flavors" | "import" | "create" | "list" | "get" | "delete", Reply>> = {}): Route {
  return (method, path) => {
    if (method === "GET" && path === "/core/flavors") return over.flavors ?? { status: 200, body: FLAVORS };
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
const HAPPY = ["GET /core/flavors", "POST /core/keypairs", "POST /core/virtual-machines", "GET /core/virtual-machines/4242", "DELETE /core/keypair/77"];

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
    requestSha256: createHash("sha256").update(calls[2]!.init.body!, "utf8").digest("hex"),
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
  assert.deepEqual(trail(refused.calls), ["GET /core/flavors", "POST /core/keypairs"]);
  for (const r of [new Error("reset"), { status: 201, body: { keypair: { id: 77, name: "sbg-k-other" } } }] as Reply[]) {
    const lost = launcher(routes({ import: r }));
    await assert.rejects(lost.a.launch(spec), fails("unknown", { id: null, message: new RegExp(`keypair ${KEY_NAME} import has an unknown outcome; no VM was requested`) }));
    assert.deepEqual(trail(lost.calls), ["GET /core/flavors", "POST /core/keypairs"]);
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
    assert.deepEqual(trail(m.calls), ["GET /core/flavors", "POST /core/keypairs", "POST /core/virtual-machines", "DELETE /core/keypair/77"]);
  }
  // A key that can't be removed is named; the refusal is kept.
  const left = launcher(routes({ create: { status: 409 }, delete: { status: 500 } }));
  await assert.rejects(left.a.launch(spec), fails("unplaceable", { id: null, message: new RegExp(`keypair ${KEY_NAME} could not be removed`) }));
});

test("launch: a key that can't be removed after create fails the launch with the VM's id (it can't enroll)", async () => {
  for (const r of [{ status: 500 }, { status: 403 }, new Error("reset")] as Reply[]) {
    const { a, calls } = launcher(routes({ delete: r }));
    await assert.rejects(a.launch(spec), fails("unknown", { id: "4242", message: new RegExp(`VM 4242 was created, but keypair ${KEY_NAME} could not be removed`) }));
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
    assert.deepEqual(trail(calls), ["GET /core/flavors", "POST /core/keypairs", "POST /core/virtual-machines", "GET /core/virtual-machines"]);
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
  assert.deepEqual(trail(calls), ["GET /core/flavors", "POST /core/keypairs", "POST /core/virtual-machines", "GET /core/virtual-machines", "GET /core/virtual-machines/4242", "DELETE /core/keypair/77"]);
});

test("launch: a recovered VM must pass the same full readback", async () => {
  const listed = { status: 200, body: { count: 1, instances: [vm()] } };
  for (const [over, word] of MISMATCHES) {
    const { a } = launcher(routes({ create: new Error("reset"), list: listed, get: { status: 200, body: { instance: vm(over) } } }));
    await assert.rejects(a.launch(spec), fails("spec_mismatch", { id: "4242", message: new RegExp(`launch shape: ${word}$`) }), JSON.stringify(over));
  }
});

test("launch: a lost create's recovery takes only the VM with our name, not another machine of ours", async () => {
  const other = vm({ id: 4300, name: "sbg-mch_7f3k9q2m4x8z1c5v6b0n" });
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

test("launch: shouldStop is honoured before every request; no request after a stop, not even cleanup", async () => {
  // Stop after n requests: 0 (before the flavor read), 1 (before the key), 2 (before create), 3 (after create).
  const expected: Array<[number, string, string | null, RegExp]> = [
    [0, "unknown", null, /before creating a VM$/],
    [1, "unknown", null, /before creating a VM$/],
    [2, "unknown", null, new RegExp(`before creating a VM; keypair ${KEY_NAME} kept$`)],
    [3, "outcome_unknown", "4242", new RegExp(`after creating VM 4242; keypair ${KEY_NAME} kept$`)],
  ];
  for (const [n, kind, id, message] of expected) {
    const { a, calls } = launcher(routes());
    await assert.rejects(a.launch(spec, { shouldStop: () => calls.length >= n }), fails(kind, { id, message }), String(n));
    assert.equal(calls.length, n);
  }
  // A lost create, then a stop: no recovery list.
  const lost = launcher(routes({ create: new Error("reset") }));
  await assert.rejects(lost.a.launch(spec, { shouldStop: () => lost.calls.length >= 3 }), fails("outcome_unknown", { message: /stopped at the caller's deadline; keypair/ }));
  assert.equal(lost.calls.length, 3);
});
