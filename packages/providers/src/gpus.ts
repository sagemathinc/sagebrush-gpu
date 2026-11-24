// Our canonical GPU types. Each provider adapter maps its own GPU ids onto these; GPU types not
// listed here are never offered.

import type { GpuTypeId } from "./types.ts";

export interface GpuTypeInfo {
  id: GpuTypeId;
  /** The label members see. */
  label: string;
  vramGb: number;
}

export const GPU_TYPES: readonly GpuTypeInfo[] = [
  { id: "L4", label: "L4", vramGb: 24 },
  { id: "RTX-A4000", label: "RTX A4000", vramGb: 16 },
  { id: "RTX-A4500", label: "RTX A4500", vramGb: 20 },
  { id: "RTX-A5000", label: "RTX A5000", vramGb: 24 },
  { id: "RTX-A6000", label: "RTX A6000", vramGb: 48 },
  { id: "RTX-3090", label: "RTX 3090", vramGb: 24 },
  { id: "RTX-4090", label: "RTX 4090", vramGb: 24 },
  { id: "RTX-4000-ADA", label: "RTX 4000 Ada", vramGb: 20 },
  { id: "RTX-6000-ADA", label: "RTX 6000 Ada", vramGb: 48 },
  { id: "A40", label: "A40", vramGb: 48 },
  { id: "L40", label: "L40", vramGb: 48 },
  { id: "L40S", label: "L40S", vramGb: 48 },
  { id: "A100-80GB-PCIE", label: "A100 80 GB PCIe", vramGb: 80 },
  { id: "A100-80GB-SXM", label: "A100 80 GB SXM", vramGb: 80 },
  { id: "H100-80GB-PCIE", label: "H100 80 GB PCIe", vramGb: 80 },
  { id: "H100-80GB-SXM", label: "H100 80 GB SXM", vramGb: 80 },
];

export function isGpuType(id: string): boolean {
  return GPU_TYPES.some((g) => g.id === id);
}
