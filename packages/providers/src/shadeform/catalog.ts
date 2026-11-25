// Shadeform's GPU types and regions, mapped to ours.
//
// Shadeform is one API over many clouds: a place is a cloud and one of its regions, written as
// our data center id "<cloud>/<region>". Region names belong to each cloud and Shadeform doesn't
// document them, so a region is offered only once it is in SHADEFORM_REGIONS with its country,
// each entry checked against a real catalog read. Unknown places are never offered.

import type { CountryCode, GpuTypeId } from "../types.ts";

/**
 * Shadeform gpu_type -> our GPU type, for the types that need nothing else to tell them apart.
 * The 80 GB A100 and the H100 come as PCIe and SXM under one name: see gpuFromShadeform.
 */
export const SHADEFORM_GPUS: Readonly<Record<string, GpuTypeId>> = {
  L4: "L4",
  A4000: "RTX-A4000",
  A5000: "RTX-A5000",
  A6000: "RTX-A6000",
  A40: "A40",
  L40: "L40",
  L40S: "L40S",
};

/**
 * gpu_type -> our type per interconnect, for the names that cover both forms. Shadeform doesn't
 * document the interconnect values: these are to be confirmed against a real catalog read, and
 * any other value is never offered.
 */
const BY_INTERCONNECT: Readonly<Record<string, Readonly<Record<string, GpuTypeId>>>> = {
  A100_80G: { pcie: "A100-80GB-PCIE", sxm4: "A100-80GB-SXM" },
  H100: { pcie: "H100-80GB-PCIE", sxm5: "H100-80GB-SXM" },
};

/** Our GPU type for a Shadeform configuration, or null (never offered). */
export function gpuFromShadeform(gpuType: unknown, interconnect: unknown): GpuTypeId | null {
  if (typeof gpuType !== "string") return null;
  if (Object.hasOwn(SHADEFORM_GPUS, gpuType)) return SHADEFORM_GPUS[gpuType]!;
  if (!Object.hasOwn(BY_INTERCONNECT, gpuType) || typeof interconnect !== "string") return null;
  const forms = BY_INTERCONNECT[gpuType]!;
  return Object.hasOwn(forms, interconnect) ? forms[interconnect]! : null;
}

/** A cloud or region name as Shadeform writes them; anything else is never a place of ours. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Our data center id for a Shadeform cloud and region, or null when either is malformed. */
export function shadeformDataCenter(cloud: unknown, region: unknown): string | null {
  return typeof cloud === "string" && typeof region === "string" && NAME.test(cloud) && NAME.test(region)
    ? `${cloud}/${region}`
    : null;
}

/** Places we know the country of: "<cloud>/<region>" -> ISO country. */
export const SHADEFORM_REGIONS: Readonly<Record<string, CountryCode>> = {
  // Shadeform's API reference (the instance info example).
  "hyperstack/canada-1": "CA",
};

export function shadeformCountry(dataCenter: string): CountryCode | null {
  return Object.hasOwn(SHADEFORM_REGIONS, dataCenter) ? SHADEFORM_REGIONS[dataCenter]! : null;
}
