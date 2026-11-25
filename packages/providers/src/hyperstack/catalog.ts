// Hyperstack's GPU names and regions, mapped to ours.
//
// Hyperstack is a VM provider (OpenStack underneath): a place is one of its regions, and a GPU
// offer is a flavor (a GPU model and count) in a region. Names not in these tables are never
// offered. The tables follow Hyperstack's public docs and SDK models; each entry is to be checked
// against a real catalog read before it is relied on.

import type { CountryCode, GpuTypeId } from "../types.ts";

/** Hyperstack flavor `gpu` -> our GPU type. */
export const HYPERSTACK_GPUS: Readonly<Record<string, GpuTypeId>> = {
  "RTX-A4000": "RTX-A4000",
  "RTX-A5000": "RTX-A5000",
  "RTX-A6000": "RTX-A6000",
  "RTX-6000-Ada": "RTX-6000-ADA",
  "L40": "L40",
  "A100-80G-PCIe": "A100-80GB-PCIE",
  "A100-80G-SXM4": "A100-80GB-SXM",
  "H100-80G-PCIe": "H100-80GB-PCIE",
  "H100-80G-SXM5": "H100-80GB-SXM",
};

export function gpuFromHyperstack(gpu: unknown): GpuTypeId | null {
  return typeof gpu === "string" && Object.hasOwn(HYPERSTACK_GPUS, gpu) ? HYPERSTACK_GPUS[gpu]! : null;
}

export function gpuToHyperstack(gpuType: GpuTypeId): string | null {
  for (const [name, ours] of Object.entries(HYPERSTACK_GPUS)) if (ours === gpuType) return name;
  return null;
}

/** Hyperstack region -> ISO country. Unknown regions are never offered. */
export const HYPERSTACK_REGIONS: Readonly<Record<string, CountryCode>> = {
  "CANADA-1": "CA",
  "NORWAY-1": "NO",
  "US-1": "US",
};

export function hyperstackCountry(region: unknown): CountryCode | null {
  return typeof region === "string" && Object.hasOwn(HYPERSTACK_REGIONS, region) ? HYPERSTACK_REGIONS[region]! : null;
}
