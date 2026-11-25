import type { ProviderId } from "./types.ts";

/**
 * Why a provider call failed, as far as placement needs to know:
 * - no_capacity: the provider said it has no machine for this offer;
 * - unplaceable: the provider refused this offer without saying why it was capacity (RunPod's
 *   400 covers both capacity and cross-field rule violations);
 * - forbidden: this account can't use this offer (e.g. a pool it has no access to);
 * - price_above_cap: a machine was created but bills above the spec's cap (it exists:
 *   providerMachineId is set, and the caller must revoke its boot token and terminate it);
 * - spec_mismatch: a machine was created but doesn't match the spec in another way (likewise);
 * - rate_limited, transient: retry the same offer after a wait;
 * - invalid_request: our request is wrong; no offer will work;
 * - insufficient_funds, auth: the provider account can't launch anything;
 * - not_found: the machine doesn't exist;
 * - outcome_unknown: the request may have reached the provider (a timeout or a lost response),
 *   so a machine may exist; find it by name before anything else;
 * - unknown: anything else.
 */
export type ProviderErrorKind =
  | "no_capacity"
  | "unplaceable"
  | "forbidden"
  | "price_above_cap"
  | "spec_mismatch"
  | "rate_limited"
  | "transient"
  | "invalid_request"
  | "insufficient_funds"
  | "auth"
  | "not_found"
  | "outcome_unknown"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: ProviderId;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;
  /** Set when the failed call left a machine behind that the caller must clean up. */
  readonly providerMachineId: string | null;
  /** For a machine that didn't match its spec: where, as drift.ts's driftMarkers (fixed words only). */
  readonly drift: readonly string[] | null;

  constructor(
    provider: ProviderId,
    kind: ProviderErrorKind,
    message: string,
    httpStatus: number | null = null,
    retryAfterSeconds: number | null = null,
    providerMachineId: string | null = null,
    drift: readonly string[] | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.retryAfterSeconds = retryAfterSeconds;
    this.providerMachineId = providerMachineId;
    this.drift = drift === null ? null : Object.freeze([...drift]);
  }
}

/** What a launch loop does after an error: try the next offer, retry this one, or give up. */
export type LaunchErrorAction = "next" | "retry" | "stop";

export function launchErrorAction(kind: ProviderErrorKind): LaunchErrorAction {
  switch (kind) {
    case "no_capacity":
    case "unplaceable":
    case "forbidden":
    case "price_above_cap":
      return "next";
    case "rate_limited":
    case "transient":
      return "retry";
    case "spec_mismatch":
    case "invalid_request":
    case "insufficient_funds":
    case "auth":
    case "not_found":
    case "outcome_unknown":
    case "unknown":
      return "stop";
  }
}
