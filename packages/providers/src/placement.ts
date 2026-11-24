import { isBasisPoints, type BasisPoints, type ProjectPolicy } from "@sbgpu/api";
import { ProviderError, launchErrorAction, type ProviderErrorKind } from "./errors.ts";
import { countryAllowed, localityFor, type Locality } from "./locality.ts";
import type {
  GpuTypeId,
  LaunchResult,
  LaunchSpec,
  Micros,
  Offer,
  ProviderAdapter,
  ProviderId,
  StockLevel,
} from "./types.ts";

/** The parts of a project's policy that placement reads. */
export interface PlacementPolicy {
  allowedGpuTypes: readonly GpuTypeId[];
  allowedProviders: readonly ProviderId[];
  locality: Locality;
  /** The cap on the provider's price (before margin) for the whole machine, per hour. */
  maxProviderCostPerHour: Micros;
}

/** priceSplit's total in exact integer arithmetic: p + round-half-up(p * bps / 10_000). */
function exactTotal(p: bigint, bps: bigint): bigint {
  return p + (2n * p * bps + 10_000n) / 20_000n;
}

/**
 * The largest provider cost per hour whose total with our margin (priceSplit's rounding) is at
 * most `maxTotal`. Exact for every safe integer `maxTotal` and every valid margin: a binary
 * search in BigInt over [0, maxTotal], using that the total never decreases as the cost grows.
 */
export function providerCapForTotal(maxTotal: Micros, marginBps: BasisPoints): Micros {
  if (!Number.isSafeInteger(maxTotal) || maxTotal < 0) throw new RangeError(`not a price: ${maxTotal}`);
  if (!isBasisPoints(marginBps)) throw new RangeError(`not a margin in basis points: ${marginBps}`);
  const max = BigInt(maxTotal);
  const bps = BigInt(marginBps);
  let lo = 0n; // exactTotal(lo) <= max always holds
  let hi = max + 1n; // exactTotal(hi) > max always holds (the total is at least the cost)
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (exactTotal(mid, bps) <= max) lo = mid;
    else hi = mid;
  }
  return Number(lo);
}

/** A project's policy as placement reads it, at the organization's or project's margin. */
export function placementPolicy(policy: ProjectPolicy, marginBps: BasisPoints): PlacementPolicy {
  return {
    allowedGpuTypes: policy.allowedGpuTypes,
    allowedProviders: policy.allowedProviders,
    locality: localityFor(policy.locality, policy.allowedCountries),
    maxProviderCostPerHour: providerCapForTotal(policy.maxPricePerHour, marginBps),
  };
}

export interface PlacementRequest {
  gpuType: GpuTypeId;
  gpuCount: number;
}

const STOCK_ORDER: Record<StockLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
  unknown: 3,
  none: 4,
};

/**
 * The offers a request may use, best first: cheapest, then the better stock label, then a fixed
 * order (provider, data center) so the same inputs always give the same order. Offers whose
 * stock is "none" are dropped; other labels only order offers of equal price.
 */
export function rankOffers(
  offers: readonly Offer[],
  policy: PlacementPolicy,
  request: PlacementRequest,
): Offer[] {
  if (!policy.allowedGpuTypes.includes(request.gpuType)) return [];
  return offers
    .filter(
      (o) =>
        o.gpuType === request.gpuType &&
        o.gpuCount === request.gpuCount &&
        policy.allowedProviders.includes(o.provider) &&
        countryAllowed(policy.locality, o.country) &&
        o.providerCostPerHour <= policy.maxProviderCostPerHour &&
        o.stock !== "none",
    )
    .sort(
      (a, b) =>
        a.providerCostPerHour - b.providerCostPerHour ||
        STOCK_ORDER[a.stock] - STOCK_ORDER[b.stock] ||
        compare(a.provider, b.provider) ||
        compare(a.dataCenter, b.dataCenter),
    );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface LaunchAttempt {
  provider: ProviderId;
  dataCenter: string;
  outcome: ProviderErrorKind | "no_adapter" | "launched";
  detail: string;
}

export class PlacementError extends Error {
  /** "no_offers" when nothing matched; otherwise the kind of the error that ended the search. */
  readonly kind: ProviderErrorKind | "no_offers";
  readonly attempts: readonly LaunchAttempt[];

  constructor(kind: ProviderErrorKind | "no_offers", message: string, attempts: LaunchAttempt[]) {
    super(message);
    this.name = "PlacementError";
    this.kind = kind;
    this.attempts = attempts;
  }
}

export interface FallbackOptions {
  /** Ranked offers (rankOffers), tried in order. */
  offers: readonly Offer[];
  adapters: Partial<Record<ProviderId, ProviderAdapter>>;
  /** Called once per launch call: each call gets its own spec, so its own boot token. */
  spec: (offer: Offer) => LaunchSpec;
  /**
   * Revoke the boot token of a spec whose launch failed, before anything else happens. If it
   * throws, the search stops with outcome_unknown.
   */
  revokeBootToken: (spec: LaunchSpec) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Status polls after terminating a rejected machine, before giving up (default 10). */
  confirmPolls?: number;
  /** Between those polls (default 3000 ms). */
  confirmIntervalMs?: number;
  /** Launch calls in total, retries included: an integer in [1, 20], default 6. */
  maxAttempts?: number;
  /** Retries of one offer after rate limiting or a transient failure: [0, 20], default 2. */
  maxRetriesPerOffer?: number;
}

export interface Placed {
  offer: Offer;
  result: LaunchResult;
  attempts: LaunchAttempt[];
}

const MAX_BACKOFF_MS = 30_000;

/** The largest value accepted for maxAttempts and maxRetriesPerOffer. */
export const MAX_LAUNCH_ATTEMPTS = 20;

function checkBound(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > MAX_LAUNCH_ATTEMPTS) {
    throw new RangeError(`${name} must be an integer in [${min}, ${MAX_LAUNCH_ATTEMPTS}], got ${value}`);
  }
}

export function backoffMs(retry: number, retryAfterSeconds: number | null): number {
  if (!Number.isSafeInteger(retry) || retry < 0) throw new RangeError(`not a retry number: ${retry}`);
  if (retryAfterSeconds !== null && !(Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0)) {
    throw new RangeError(`not a Retry-After: ${retryAfterSeconds}`);
  }
  const ms = retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 1000 * 2 ** retry;
  return Math.min(ms, MAX_BACKOFF_MS);
}

function checkConfirmBounds(polls: number, intervalMs: number): void {
  checkBound("confirmPolls", polls, 1);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) {
    throw new RangeError(`confirmIntervalMs must be an integer in [0, 60000], got ${intervalMs}`);
  }
}

/**
 * Terminate a machine and poll until the provider reports it terminated. `polls` must be an
 * integer in [1, 20] and `intervalMs` in [0, 60000] (RangeError before any effect otherwise). Any error, or no
 * confirmation within `polls` status reads, gives false: the machine may still be running.
 */
export async function terminateAndConfirm(
  adapter: ProviderAdapter,
  providerMachineId: string,
  sleep: (ms: number) => Promise<void>,
  polls: number,
  intervalMs: number,
): Promise<boolean> {
  checkConfirmBounds(polls, intervalMs);
  try {
    await adapter.terminate(providerMachineId);
    for (let i = 0; i < polls; i++) {
      if (i > 0) await sleep(intervalMs);
      const s = await adapter.status(providerMachineId);
      // Only a status for exactly this machine at this provider confirms anything.
      if (s.provider !== adapter.info.provider || s.providerMachineId !== providerMachineId) return false;
      if (s.state === "terminated") return true;
    }
  } catch {
    // fall through: unconfirmed
  }
  return false;
}

/**
 * Launch on the first offer that works. Capacity-type refusals move on to the next offer;
 * rate limits and transient failures retry the same offer; anything else stops the search,
 * including "outcome_unknown": a machine may exist, so launching elsewhere could make two.
 * After every failed launch call, the call's boot token is revoked first; a machine the
 * provider created but we rejected is then terminated and confirmed gone, and if either step
 * fails the search stops with outcome_unknown.
 */
export async function launchWithFallback(opts: FallbackOptions): Promise<Placed> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const maxRetries = opts.maxRetriesPerOffer ?? 2;
  checkBound("maxAttempts", maxAttempts, 1);
  checkBound("maxRetriesPerOffer", maxRetries, 0);
  const confirmPolls = opts.confirmPolls ?? 10;
  const confirmIntervalMs = opts.confirmIntervalMs ?? 3000;
  checkConfirmBounds(confirmPolls, confirmIntervalMs);
  const attempts: LaunchAttempt[] = [];
  if (opts.offers.length === 0) throw new PlacementError("no_offers", "no offer matches", attempts);
  let calls = 0;
  let last: ProviderError | null = null;
  for (const offer of opts.offers) {
    const adapter = opts.adapters[offer.provider];
    if (adapter === undefined) {
      attempts.push({ provider: offer.provider, dataCenter: offer.dataCenter, outcome: "no_adapter", detail: "" });
      continue;
    }
    for (let retry = 0; ; retry++) {
      if (calls >= maxAttempts) {
        throw new PlacementError(last?.kind ?? "no_capacity", `gave up after ${calls} launch attempts`, attempts);
      }
      calls++;
      const spec = opts.spec(offer);
      try {
        const result = await adapter.launch(spec);
        attempts.push({ provider: offer.provider, dataCenter: offer.dataCenter, outcome: "launched", detail: "" });
        return { offer, result, attempts };
      } catch (e) {
        // Whatever happened, this spec's boot token must never be usable again.
        try {
          await opts.revokeBootToken(spec);
        } catch {
          if (e instanceof ProviderError) {
            attempts.push({ provider: offer.provider, dataCenter: offer.dataCenter, outcome: e.kind, detail: e.message });
          }
          throw new PlacementError("outcome_unknown", "the failed launch's boot token could not be revoked", attempts);
        }
        if (!(e instanceof ProviderError)) throw e;
        last = e;
        attempts.push({ provider: offer.provider, dataCenter: offer.dataCenter, outcome: e.kind, detail: e.message });
        if (e.providerMachineId !== null) {
          const gone = await terminateAndConfirm(adapter, e.providerMachineId, opts.sleep, confirmPolls, confirmIntervalMs);
          if (!gone) {
            throw new PlacementError(
              "outcome_unknown",
              `machine ${e.providerMachineId} was rejected but its termination is not confirmed`,
              attempts,
            );
          }
        }
        const action = launchErrorAction(e.kind);
        if (action === "stop") throw new PlacementError(e.kind, e.message, attempts);
        if (action === "retry" && retry < maxRetries) {
          await opts.sleep(backoffMs(retry, e.retryAfterSeconds));
          continue;
        }
        break;
      }
    }
  }
  throw new PlacementError(last?.kind ?? "no_offers", last?.message ?? "no adapter for any offer", attempts);
}
