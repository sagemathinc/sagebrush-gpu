import assert from "node:assert/strict";
import { test } from "node:test";
import { driftMarkers, expectedSpec, specDrift } from "./drift.ts";
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
