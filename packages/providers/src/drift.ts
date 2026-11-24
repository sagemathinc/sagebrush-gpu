// The immutable expected specification of a launched machine, and the check the watchdog runs
// against every status poll. Any drift means the machine was changed after launch (for example
// with a provider credential readable inside it), so the watchdog terminates it.

import type { AdapterInfo, GpuTypeId, LaunchSpec, Micros, ProviderId, ProviderMachineStatus } from "./types.ts";

export interface ExpectedSpec {
  provider: ProviderId;
  providerMachineId: string;
  machineId: string;
  gpuType: GpuTypeId;
  gpuCount: number;
  dataCenter: string;
  image: string;
  diskGb: number;
  envNames: readonly string[];
  command: readonly string[];
  maxProviderCostPerHour: Micros;
}

export function expectedSpec(spec: LaunchSpec, info: AdapterInfo, providerMachineId: string): ExpectedSpec {
  return {
    provider: info.provider,
    providerMachineId,
    machineId: spec.machineId,
    gpuType: spec.gpuType,
    gpuCount: spec.gpuCount,
    dataCenter: spec.dataCenter,
    image: spec.image,
    diskGb: spec.diskGb,
    envNames: [info.bootTokenEnv],
    command: [...spec.launcher],
    maxProviderCostPerHour: spec.maxProviderCostPerHour,
  };
}

export interface Drift {
  field: string;
  expected: string;
  observed: string;
}

/**
 * Every way `observed` differs from `expected`. A terminated machine has nothing left to drift.
 * Unknown values (a null GPU type, data center or rate) count as drift: fail closed.
 */
export function specDrift(expected: ExpectedSpec, observed: ProviderMachineStatus): Drift[] {
  if (observed.state === "terminated") return [];
  const out: Drift[] = [];
  const check = (field: string, e: unknown, o: unknown) => {
    const es = JSON.stringify(e);
    const os = JSON.stringify(o);
    if (es !== os) out.push({ field, expected: es, observed: os });
  };
  check("provider", expected.provider, observed.provider);
  check("providerMachineId", expected.providerMachineId, observed.providerMachineId);
  check("machineId", expected.machineId, observed.machineId);
  check("gpuType", expected.gpuType, observed.gpuType);
  check("gpuCount", expected.gpuCount, observed.gpuCount);
  check("dataCenter", expected.dataCenter, observed.dataCenter);
  check("image", expected.image, observed.image);
  check("diskGb", expected.diskGb, observed.diskGb);
  check("volumeGb", 0, observed.volumeGb);
  check("envNames", [...expected.envNames].sort(), [...observed.envNames].sort());
  check("exposedPorts", [], observed.exposedPorts);
  check("unexpectedSettings", [], observed.unexpectedSettings);
  check("command", expected.command, observed.command);
  const rate = observed.providerCostPerHour;
  if (rate === null || rate > expected.maxProviderCostPerHour) {
    out.push({
      field: "providerCostPerHour",
      expected: `<= ${expected.maxProviderCostPerHour}`,
      observed: JSON.stringify(rate),
    });
  }
  return out;
}
