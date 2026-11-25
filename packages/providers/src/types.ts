// Provider-facing types.
//
// The data shapes (Offer, ProviderMachineStatus, ...) come from the contract, @sbgpu/api. The
// ProviderAdapter interface and LaunchSpec belong to this package: only the control plane
// calls launch.

import type { GpuTypeId, Micros, Offer, ProviderId, ProviderMachineStatus } from "@sbgpu/api";

export type {
  CountryCode,
  GpuTypeId,
  Micros,
  Offer,
  ProviderId,
  ProviderMachineState as MachineState,
  ProviderMachineStatus,
  StockLevel,
} from "@sbgpu/api";

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

/**
 * How a machine gets its boot token, a closed choice per adapter.
 * - env: a container's provider-side environment carries LaunchSpec.bootToken in this variable.
 * - announce: a VM gets no provider-side environment at all; its launcher announces itself with
 *   public values and receives the token in the reply (VM mode). LaunchSpec.bootToken is "".
 */
export type BootDelivery = { readonly kind: "env"; readonly name: string } | { readonly kind: "announce" };

export interface AdapterInfo {
  provider: ProviderId;
  selfIdentity: SelfIdentity;
  bootDelivery: BootDelivery;
}

/** The environment names a machine launched by this adapter must show: the token's variable, or none. */
export function bootEnvNames(delivery: BootDelivery): string[] {
  return delivery.kind === "env" ? [delivery.name] : [];
}

export interface LaunchOptions {
  /**
   * Checked before every provider request the launch makes, including any recovery after a
   * lost response. Once it returns true, the launch stops: before the create request it fails
   * with kind "unknown" (nothing was created); after it, with "outcome_unknown".
   */
  shouldStop?: () => boolean;
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
  launch(spec: LaunchSpec, opts?: LaunchOptions): Promise<LaunchResult>;
  /** A machine the provider no longer knows reports state "terminated". */
  status(providerMachineId: string): Promise<ProviderMachineStatus>;
  /** Idempotent: terminating a machine that is already gone succeeds. */
  terminate(providerMachineId: string): Promise<void>;
  /** Every machine of ours (by name) the provider knows, in any state. */
  listMachines(): Promise<ProviderMachineStatus[]>;
}
