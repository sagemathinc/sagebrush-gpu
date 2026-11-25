// Vast.ai's GPU names and locations, mapped to ours. From Vast's public docs only, not yet checked
// against a real offer list: a name we have wrong offers nothing (it fails closed).

import { GPU_TYPES } from "../gpus.ts";
import type { GpuTypeId } from "../types.ts";

/**
 * Vast GPU name, as offers and instances report it -> our GPU type. Search filters take the same
 * name with underscores for spaces. One Vast name can cover several memory sizes (an A100 PCIE
 * is 40 or 80 GB), so an offer also has to carry our type's memory: see gpuFromVast.
 */
export const VAST_GPUS: Readonly<Record<string, GpuTypeId>> = {
  "L4": "L4",
  "RTX A4000": "RTX-A4000",
  "RTX A4500": "RTX-A4500",
  "RTX A5000": "RTX-A5000",
  "RTX A6000": "RTX-A6000",
  "RTX 3090": "RTX-3090",
  "RTX 4090": "RTX-4090",
  "RTX 4000Ada": "RTX-4000-ADA",
  "RTX 6000Ada": "RTX-6000-ADA",
  "A40": "A40",
  "L40": "L40",
  "L40S": "L40S",
  "A100 PCIE": "A100-80GB-PCIE",
  "A100 SXM4": "A100-80GB-SXM",
  "H100 PCIE": "H100-80GB-PCIE",
  "H100 SXM": "H100-80GB-SXM",
};

/** A GPU with less than this share of our type's memory is a smaller variant: never that type. */
const MIN_RAM_SHARE = 0.95;

/**
 * Our GPU type for a Vast GPU name and its per-GPU memory in MB (`gpu_ram`), or null: an unknown
 * name, or less memory than our type has (a 40 GB A100 is never an 80 GB one).
 */
export function gpuFromVast(vastName: string, gpuRamMb: unknown): GpuTypeId | null {
  if (!Object.hasOwn(VAST_GPUS, vastName)) return null;
  const ours = VAST_GPUS[vastName]!;
  const type = GPU_TYPES.find((g) => g.id === ours);
  if (type === undefined || typeof gpuRamMb !== "number" || !Number.isFinite(gpuRamMb)) return null;
  return gpuRamMb >= type.vramGb * 1000 * MIN_RAM_SHARE ? ours : null;
}

export function gpuToVast(gpuType: GpuTypeId): string | null {
  for (const [vastName, ours] of Object.entries(VAST_GPUS)) if (ours === gpuType) return vastName;
  return null;
}

/** A Vast GPU name in search-filter form: spaces become underscores. */
export function vastFilterName(vastName: string): string {
  return vastName.replaceAll(" ", "_");
}

/**
 * The country of a Vast `geolocation`, "<place>, <CC>" (e.g. "California, US"): the two letters
 * after the last comma. Any other shape gives null, which no locality preset matches.
 */
export function vastCountry(geolocation: unknown): string | null {
  if (typeof geolocation !== "string") return null;
  const m = /,\s*([A-Z]{2})$/.exec(geolocation);
  return m === null ? null : m[1]!;
}

/** Our data-center id for one Vast host machine: offers are per machine, and a launch goes back to it. */
export function vastDataCenter(machineId: unknown): string | null {
  return typeof machineId === "number" && Number.isSafeInteger(machineId) && machineId > 0 ? `machine-${machineId}` : null;
}

/** The Vast machine id in one of our data-center ids, or null. */
export function vastMachineId(dataCenter: string): number | null {
  const m = /^machine-([1-9][0-9]{0,15})$/.exec(dataCenter);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}
