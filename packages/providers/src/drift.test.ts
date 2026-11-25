import assert from "node:assert/strict";
import { test } from "node:test";
import { commandShape, driftMarkers, expectedSpec, fieldShape, isDriftMarker, specDrift } from "./drift.ts";
import type { AdapterInfo, LaunchSpec, ProviderMachineStatus } from "./types.ts";

const info: AdapterInfo = { provider: "runpod", selfIdentity: { env: "RUNPOD_POD_ID" }, bootTokenEnv: "SBGPU_BOOT_TOKEN" };
const spec: LaunchSpec = {
  machineId: "mch_a",
  gpuType: "L4",
  gpuCount: 1,
  dataCenter: "EU-SE-1",
  image: "runpod/pytorch:x",
  diskGb: 40,
  bootToken: "tok",
  launcher: ["/bin/sh", "-c", "script"],
  maxProviderCostPerHour: 700_000,
};
const expected = expectedSpec(spec, info, "pod1");

const clean: ProviderMachineStatus = {
  provider: "runpod",
  providerMachineId: "pod1",
  machineId: "mch_a",
  state: "running",
  rawStatus: "RUNNING",
  gpuType: "L4",
  gpuCount: 1,
  dataCenter: "EU-SE-1",
  image: "runpod/pytorch:x",
  diskGb: 40,
  volumeGb: 0,
  envNames: ["SBGPU_BOOT_TOKEN"],
  exposedPorts: [],
  unexpectedSettings: [],
  command: ["/bin/sh", "-c", "script"],
  providerCostPerHour: 690_000,
  observedAt: "2026-11-24T12:00:00.000Z",
};

test("expectedSpec takes everything from the launch spec and the adapter", () => {
  assert.deepEqual(expected, {
    provider: "runpod",
    providerMachineId: "pod1",
    machineId: "mch_a",
    gpuType: "L4",
    gpuCount: 1,
    dataCenter: "EU-SE-1",
    image: "runpod/pytorch:x",
    diskGb: 40,
    envNames: ["SBGPU_BOOT_TOKEN"],
    command: ["/bin/sh", "-c", "script"],
    maxProviderCostPerHour: 700_000,
  });
});

test("a machine as launched has no drift", () => {
  assert.deepEqual(specDrift(expected, clean), []);
  assert.deepEqual(specDrift(expected, { ...clean, providerCostPerHour: 700_000 }), [], "a rate at the cap is fine");
});

const cases: Array<[string, Partial<ProviderMachineStatus>]> = [
  ["provider", { provider: "hyperstack" }],
  ["providerMachineId", { providerMachineId: "pod2" }],
  ["machineId", { machineId: "mch_b" }],
  ["machineId", { machineId: null }],
  ["gpuType", { gpuType: "RTX-4090" }],
  ["gpuType", { gpuType: null }],
  ["gpuCount", { gpuCount: 2 }],
  ["dataCenter", { dataCenter: "EU-RO-1" }],
  ["dataCenter", { dataCenter: null }],
  ["image", { image: "attacker/miner:latest" }],
  ["diskGb", { diskGb: 41 }],
  ["diskGb", { diskGb: 39 }],
  ["volumeGb", { volumeGb: 10 }],
  ["volumeGb", { volumeGb: Number.POSITIVE_INFINITY }],
  ["volumeGb", { volumeGb: Number.NaN }],
  ["diskGb", { diskGb: Number.NaN }],
  ["gpuCount", { gpuCount: Number.NaN }],
  ["exposedPorts", { exposedPorts: ["<unreadable>"] }],
  ["envNames", { envNames: ["<unreadable>"] }],
  ["command", { command: ["<unreadable>"] }],
  ["image", { image: "<unreadable>" }],
  ["envNames", { envNames: ["SBGPU_BOOT_TOKEN", "EXTRA"] }],
  ["envNames", { envNames: [] }],
  ["envNames", { envNames: ["OTHER"] }],
  ["exposedPorts", { exposedPorts: ["22/tcp"] }],
  ["unexpectedSettings", { unexpectedSettings: ["cloud:COMMUNITY"] }],
  ["unexpectedSettings", { unexpectedSettings: ["ssh:proxy"] }],
  ["command", { command: ["/bin/sh", "-c", "other"] }],
  ["command", { command: ["/bin/sh", "-c"] }],
  ["command", { command: [] }],
  ["providerCostPerHour", { providerCostPerHour: 700_001 }],
  ["providerCostPerHour", { providerCostPerHour: null }],
];

for (const [field, change] of cases) {
  test(`drift in ${field}: ${JSON.stringify(change)}`, () => {
    const drift = specDrift(expected, { ...clean, ...change });
    assert.deepEqual(drift.map((d) => d.field), [field]);
  });
}

test("env names are compared as a set", () => {
  const e = expectedSpec(spec, info, "pod1");
  const two = { ...e, envNames: ["B", "A"] };
  assert.deepEqual(specDrift(two, { ...clean, envNames: ["A", "B"] }), []);
});

test("a terminated machine has no drift; other states are checked", () => {
  assert.deepEqual(specDrift(expected, { ...clean, state: "terminated", image: "x" }), []);
  for (const state of ["provisioning", "running", "stopping", "failed", "unknown"] as const) {
    assert.equal(specDrift(expected, { ...clean, state, image: "x" }).length, 1, state);
  }
});

test("drift reports both values", () => {
  assert.deepEqual(specDrift(expected, { ...clean, image: "y" }), [
    { field: "image", expected: '"runpod/pytorch:x"', observed: '"y"' },
  ]);
  assert.deepEqual(specDrift(expected, { ...clean, providerCostPerHour: 900_000 }), [
    { field: "providerCostPerHour", expected: "<= 700000", observed: "900000" },
  ]);
});

test("driftMarkers: field names, and settings in a fixed vocabulary only", () => {
  const d = (field: string) => ({ field, expected: "e", observed: "o" });
  assert.deepEqual(driftMarkers([], clean), []);
  assert.deepEqual(driftMarkers([d("image"), d("command"), d("envNames"), d("providerCostPerHour")], clean), ["image", "command", "envNames", "providerCostPerHour"]);
  for (const f of ["provider", "providerMachineId", "machineId", "gpuType", "gpuCount", "dataCenter", "diskGb", "volumeGb", "exposedPorts"]) {
    assert.deepEqual(driftMarkers([d(f)], clean), [f]);
  }
  // A field specDrift never reports is "other", never its own name.
  assert.deepEqual(driftMarkers([d("MARKER")], clean), ["other"]);
  const withSettings = (unexpectedSettings: string[]) => ({ ...clean, unexpectedSettings });
  assert.deepEqual(
    driftMarkers([d("unexpectedSettings")], withSettings(["cloud:COMMUNITY", "ssh:proxy", "ssh:direct:<unreadable>", "template:MARKER", "globalNetworking:enabled", "ssh:key", "shade_cloud:false", "rental:spot", "template_id:set", "cluster_id:<unreadable>", "commitment_id:set", "MARKER"])),
    [
      "unexpectedSettings:cloud:other", "unexpectedSettings:ssh:proxy", "unexpectedSettings:ssh:direct:unreadable", "unexpectedSettings:template:other",
      "unexpectedSettings:globalNetworking:enabled", "unexpectedSettings:ssh:key", "unexpectedSettings:shade_cloud:false", "unexpectedSettings:rental:other",
      "unexpectedSettings:template_id:set", "unexpectedSettings:cluster_id:unreadable", "unexpectedSettings:commitment_id:set", "unexpectedSettings:other",
    ],
  );
  // The field without any setting to name, and prototype names are not vocabulary.
  assert.deepEqual(driftMarkers([d("unexpectedSettings")], withSettings([])), ["unexpectedSettings"]);
  assert.deepEqual(driftMarkers([d("unexpectedSettings")], withSettings(["constructor:toString"])), ["unexpectedSettings:other:other"]);
  assert.deepEqual(driftMarkers([d("toString")], clean), ["other"]);
});

test("isDriftMarker accepts exactly what driftMarkers can produce", () => {
  // Everything driftMarkers produces passes.
  const d = (field: string) => ({ field, expected: "e", observed: "o" });
  const all = driftMarkers(
    ["provider", "image", "command", "MARKER", "unexpectedSettings"].map(d),
    { ...clean, unexpectedSettings: ["cloud:COMMUNITY", "ssh:direct:<unreadable>", "MARKER:x:y", "shade_cloud:false", "a:b:c:d:e"] },
  );
  for (const m of all) assert.equal(isDriftMarker(m), true, m);
  for (const m of ["SYNTHETICSECRET", "unexpectedSettings:SYNTHETICSECRET", "image:other", "other:other", "", "unexpectedSettings:",
    "unexpectedSettings:ssh:proxy:other:other", "toString", "unexpectedSettings:constructor", "__proto__", "Image", 7, null, undefined]) {
    assert.equal(isDriftMarker(m), false, String(m));
  }
  assert.equal(isDriftMarker("unexpectedSettings:ssh:proxy:other"), true);
  assert.deepEqual(driftMarkers([d("unexpectedSettings")], { ...clean, unexpectedSettings: ["a:b:c:d", "a:b:c"] }), ["unexpectedSettings:other", "unexpectedSettings:other:other:other"]);
});

test("fieldShape gives a field's form and size, never its value", () => {
  assert.deepEqual(fieldShape(undefined), { kind: "absent", length: null });
  assert.deepEqual(fieldShape(null), { kind: "null", length: null });
  assert.deepEqual(fieldShape("abc"), { kind: "string", length: 3 });
  assert.deepEqual(fieldShape(""), { kind: "string", length: 0 });
  assert.deepEqual(fieldShape([1, 2]), { kind: "array", length: 2 });
  assert.deepEqual(fieldShape(0), { kind: "number", length: null });
  assert.deepEqual(fieldShape(false), { kind: "boolean", length: null });
  assert.deepEqual(fieldShape({ a: 1 }), { kind: "object", length: null });
});

test("commandShape compares a provider's command fields with the launcher, without their text", () => {
  const launcher = ["/bin/sh", "-c", "script MARKER"];
  const same = commandShape({ entrypoint: [...launcher], cmd: [] }, launcher);
  assert.deepEqual(same, {
    entrypoint: { kind: "array", length: 3 }, cmd: { kind: "array", length: 0 }, args: { kind: "absent", length: null },
    entrypointItems: [{ length: 7, matches: true, commonPrefix: 7 }, { length: 2, matches: true, commonPrefix: 2 }, { length: 13, matches: true, commonPrefix: 13 }],
    entrypointCmdMatches: true, joinedMatches: false,
  });
  // A split between entrypoint and cmd still matches as a whole.
  assert.equal(commandShape({ entrypoint: ["/bin/sh"], cmd: ["-c", "script MARKER"] }, launcher).entrypointCmdMatches, true);
  // cmd missing or null: no whole match, but the items still say which agree.
  const nullCmd = commandShape({ entrypoint: [...launcher], cmd: null }, launcher);
  assert.equal(nullCmd.entrypointCmdMatches, false);
  assert.deepEqual(nullCmd.cmd, { kind: "null", length: null });
  assert.ok(nullCmd.entrypointItems.every((i) => i.matches));
  // An altered script: where the two first differ, not how.
  const altered = commandShape({ entrypoint: ["/bin/sh", "-c", "script MARKEX trailing"], cmd: [] }, launcher);
  assert.deepEqual(altered.entrypointItems[2], { length: 22, matches: false, commonPrefix: 12 });
  assert.equal(altered.entrypointCmdMatches, false);
  // A joined string, as entrypoint or as args.
  assert.equal(commandShape({ entrypoint: launcher.join(" ") }, launcher).joinedMatches, true);
  assert.equal(commandShape({ args: launcher.join(" ") }, launcher).joinedMatches, true);
  assert.equal(commandShape({ args: launcher.join("  ") }, launcher).joinedMatches, false);
  // Non-string items, extra items, and at most 8 items described.
  const odd = commandShape({ entrypoint: ["/bin/sh", 5, "-c", "x", "a", "b", "c", "d", "e", "f"], cmd: [] }, launcher);
  assert.equal(odd.entrypointItems.length, 8);
  assert.deepEqual(odd.entrypointItems[1], { length: null, matches: false, commonPrefix: 0 });
  assert.deepEqual(odd.entrypointItems[3], { length: 1, matches: false, commonPrefix: 0 });
  assert.equal(odd.entrypointCmdMatches, false);
  assert.equal(commandShape({ entrypoint: [...launcher, "extra"], cmd: [] }, launcher).entrypointCmdMatches, false);
  assert.equal(commandShape({ entrypoint: launcher.slice(0, 2), cmd: [] }, launcher).entrypointCmdMatches, false);
  for (const s of [same, altered, odd]) assert.ok(!JSON.stringify(s).includes("MARKER"));
});
