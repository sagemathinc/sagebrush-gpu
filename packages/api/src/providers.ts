// The provider-facing data shapes that the control plane, the watchdog and the UI all
// read. The ProviderAdapter interface itself, launch specs and the per-provider
// mappings live in @sbgpu/providers. Offers carry the provider's cost only: our
// margin is applied by the control plane in a Quote.

import type { Micros } from "./money.ts";
import type { MachineId } from "./ids.ts";
import type { IsoTime } from "./time.ts";

export const PROVIDER_IDS = ["runpod", "shadeform", "hyperstack", "nebius"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(x: unknown): x is ProviderId {
  return typeof x === "string" && (PROVIDER_IDS as readonly string[]).includes(x);
}

/** Our canonical GPU type id, e.g. "L4", "A6000", "A100-80GB"; mapped per provider. */
export type GpuTypeId = string;

const GPU_TYPE_ID = /^[A-Z0-9][A-Za-z0-9-]{0,31}$/;
export function isGpuTypeId(x: unknown): x is GpuTypeId {
  return typeof x === "string" && GPU_TYPE_ID.test(x);
}

/** ISO 3166-1 alpha-2, e.g. "SE". Locality presets are sets of countries. */
export type CountryCode = string;

export const STOCK_LEVELS = ["high", "medium", "low", "none", "unknown"] as const;
/** A hint from the provider; placement never trusts it. */
export type StockLevel = (typeof STOCK_LEVELS)[number];

export interface Offer {
  provider: ProviderId;
  gpuType: GpuTypeId;
  gpuCount: number;
  /** The provider's data center id, e.g. "EU-SE-1". */
  dataCenter: string;
  country: CountryCode;
  providerCostPerHour: Micros;
  stock: StockLevel;
  observedAt: IsoTime;
}

export const PROVIDER_MACHINE_STATES = [
  "provisioning",
  "running",
  "stopping",
  "terminated",
  "failed",
  "unknown",
] as const;
export type ProviderMachineState = (typeof PROVIDER_MACHINE_STATES)[number];

/** What a provider says about one of its machines: the watchdog's input. */
export interface ProviderMachineStatus {
  provider: ProviderId;
  providerMachineId: string;
  /** Parsed from our name tag; null when the machine isn't ours or the tag is unparseable. */
  machineId: MachineId | null;
  state: ProviderMachineState;
  /** The provider's own status string, for logs. */
  rawStatus: string;
  gpuType: GpuTypeId | null;
  gpuCount: number;
  dataCenter: string | null;
  image: string;
  diskGb: number;
  volumeGb: number;
  /** As the provider lists them, e.g. "8888/http". */
  exposedPorts: string[];
  /** The start command as the provider reports it. */
  command: string[];
  /** Environment variable names only, never values. */
  envNames: string[];
  /**
   * Provider settings outside our launch shape, as "name:value" (e.g. "ssh:proxy",
   * "cloud:COMMUNITY"); expected empty. Unreadable values are listed too.
   */
  unexpectedSettings: string[];
  providerCostPerHour: Micros | null;
  observedAt: IsoTime;
}
