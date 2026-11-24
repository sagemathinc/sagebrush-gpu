// RunPod's GPU ids and data centers, mapped to ours.

import type { GpuTypeId } from "../types.ts";

/** RunPod GPU id -> our GPU type. RunPod GPU types not listed here are never offered. */
export const RUNPOD_GPUS: Readonly<Record<string, GpuTypeId>> = {
  "NVIDIA L4": "L4",
  "NVIDIA RTX A4000": "RTX-A4000",
  "NVIDIA RTX A4500": "RTX-A4500",
  "NVIDIA RTX A5000": "RTX-A5000",
  "NVIDIA RTX A6000": "RTX-A6000",
  "NVIDIA GeForce RTX 3090": "RTX-3090",
  "NVIDIA GeForce RTX 4090": "RTX-4090",
  "NVIDIA RTX 4000 Ada Generation": "RTX-4000-ADA",
  "NVIDIA RTX 6000 Ada Generation": "RTX-6000-ADA",
  "NVIDIA A40": "A40",
  "NVIDIA L40": "L40",
  "NVIDIA L40S": "L40S",
  "NVIDIA A100 80GB PCIe": "A100-80GB-PCIE",
  "NVIDIA A100-SXM4-80GB": "A100-80GB-SXM",
  "NVIDIA H100 PCIe": "H100-80GB-PCIE",
  "NVIDIA H100 80GB HBM3": "H100-80GB-SXM",
};

export function gpuFromRunPod(runpodId: string): GpuTypeId | null {
  return Object.hasOwn(RUNPOD_GPUS, runpodId) ? RUNPOD_GPUS[runpodId]! : null;
}

export function gpuToRunPod(gpuType: GpuTypeId): string | null {
  for (const [runpodId, ours] of Object.entries(RUNPOD_GPUS)) if (ours === gpuType) return runpodId;
  return null;
}

/**
 * The country of a RunPod data center id. The id's second part is a country only under the
 * European prefixes: "US-DE-1" is Delaware and "US-CA-1" California, not Germany or Canada.
 * Ids of an unknown shape give null, which no locality preset matches.
 */
export function runpodCountry(dataCenterId: string): string | null {
  const parts = dataCenterId.split("-");
  if (parts.length !== 3 || !/^[0-9]+$/.test(parts[2]!)) return null;
  const [prefix, second] = parts as [string, string, string];
  if (prefix === "US") return "US";
  if (prefix === "CA" && second === "MTL") return "CA";
  if ((prefix === "EU" || prefix === "EUR") && /^[A-Z]{2}$/.test(second)) return second;
  return null;
}
