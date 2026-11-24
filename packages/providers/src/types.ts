// Provider-facing types.
//
// The data shapes (Offer, ProviderMachineStatus, ...) come from the contract, @sbgpu/api. The
// ProviderAdapter interface and LaunchSpec belong to this package: only the control plane
// calls launch.

import type {
  GpuTypeId,
  Micros,
  Offer,
  ProviderId,
  ProviderMachineStatus as ContractMachineStatus,
} from "@sbgpu/api";

export type {
  CountryCode,
  GpuTypeId,
  Micros,
  Offer,
  ProviderId,
  ProviderMachineState as MachineState,
  StockLevel,
} from "@sbgpu/api";

/**
 * The contract's ProviderMachineStatus plus `unexpectedSettings` (proposed for the contract;
 * this becomes a plain re-export once it has it).
 */
export interface ProviderMachineStatus extends ContractMachineStatus {
  /**
   * Provider settings outside our launch shape, as "name:value" (e.g. "cloud:COMMUNITY",
   * "ssh:proxy"), including settings the provider reported unreadably. Expected empty.
   */
  unexpectedSettings: string[];
}

/** Everything the control plane asks a provider to launch. There is no free-form environment. */
export interface LaunchSpec {
  machineId: string;
  gpuType: GpuTypeId;
  gpuCount: number;
  /** One data center, chosen by placement. */
  dataCenter: string;
  /** A provider stock image, from that provider's allowlist. */
  image: string;
  diskGb: number;
  /**
   * The one-time boot token: the only value placed in the machine's provider-side environment,
   * which is provider metadata readable through the provider's API.
   */
  bootToken: string;
  /** The launcher argv from @sbgpu/machine; it becomes the container entrypoint (PID 1). */
  launcher: readonly string[];
  /** The launch is undone (terminated) if the provider bills more than this. */
  maxProviderCostPerHour: Micros;
}

export interface LaunchResult {
  providerMachineId: string;
  status: ProviderMachineStatus;
}

/** How a machine learns its own provider id (a cross-check at enrollment, not a secret). */
export type SelfIdentity = { env: string } | { metadataUrl: string } | null;

export interface AdapterInfo {
  provider: ProviderId;
  selfIdentity: SelfIdentity;
  /** The environment variable that carries LaunchSpec.bootToken. */
  bootTokenEnv: string;
}

export interface OfferQuery {
  gpuCount: number;
}

export interface ProviderAdapter {
  readonly info: AdapterInfo;
  /** Current offers: GPU types we map, per data center, with the provider's list price. */
  listOffers(query: OfferQuery): Promise<Offer[]>;
  /**
   * Launch one machine. Throws ProviderError: kind "outcome_unknown" means a machine may exist;
   * an error with providerMachineId set means a machine exists that was rejected (it doesn't
   * match the spec), and the caller must revoke its boot token and terminate it.
   */
  launch(spec: LaunchSpec): Promise<LaunchResult>;
  /** A machine the provider no longer knows reports state "terminated". */
  status(providerMachineId: string): Promise<ProviderMachineStatus>;
  /** Idempotent: terminating a machine that is already gone succeeds. */
  terminate(providerMachineId: string): Promise<void>;
  /** Every machine of ours (by name) the provider knows, in any state. */
  listMachines(): Promise<ProviderMachineStatus[]>;
}
