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

/** The fields specDrift can report: every marker starts with one of these. */
const DRIFT_FIELDS: ReadonlySet<string> = new Set([
  "provider", "providerMachineId", "machineId", "gpuType", "gpuCount", "dataCenter", "image", "diskGb",
  "volumeGb", "envNames", "exposedPorts", "unexpectedSettings", "command", "providerCostPerHour",
]);

/** The words an adapter's unexpectedSettings entries are built from; any other word reads "other". */
const SETTING_WORDS: ReadonlySet<string> = new Set([
  // RunPod
  "cloud", "ssh", "proxy", "direct", "template", "globalNetworking", "enabled",
  // Shadeform
  "key", "shade_cloud", "false", "rental", "template_id", "cluster_id", "commitment_id", "set",
]);

/** The token adapters use for a field they couldn't read (their UNREADABLE). */
const UNREADABLE_TOKEN = "<unreadable>";

/**
 * Where a machine drifted, as fixed words only, safe to report anywhere: the drifted fields'
 * names and, for unexpectedSettings, each setting with every word outside a fixed vocabulary
 * replaced by "other" (and an unreadable value by "unreadable"). Never an observed value: those
 * can be provider text, environment names or ids.
 */
export function driftMarkers(drift: readonly Drift[], observed: ProviderMachineStatus): string[] {
  const out: string[] = [];
  for (const d of drift) {
    if (!DRIFT_FIELDS.has(d.field)) {
      out.push("other");
      continue;
    }
    if (d.field !== "unexpectedSettings") {
      out.push(d.field);
      continue;
    }
    const settings = Array.isArray(observed.unexpectedSettings) ? observed.unexpectedSettings : [];
    if (settings.length === 0) out.push("unexpectedSettings");
    for (const s of settings) {
      const words = String(s).split(":").map((w) => (w === UNREADABLE_TOKEN ? "unreadable" : SETTING_WORDS.has(w) ? w : "other"));
      out.push(["unexpectedSettings", ...words].join(":"));
    }
  }
  return out;
}
