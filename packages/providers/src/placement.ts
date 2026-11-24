import { priceSplit, type BasisPoints, type ProjectPolicy } from "@sbgpu/api";
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

/**
 * The largest provider cost per hour whose total with our margin (priceSplit, the contract's
 * one rounding rule) is at most `maxTotal`.
 */
export function providerCapForTotal(maxTotal: Micros, marginBps: BasisPoints): Micros {
  if (!Number.isSafeInteger(maxTotal) || maxTotal < 0) throw new RangeError(`not a price: ${maxTotal}`);
  // The estimate never overshoots: p <= maxTotal / (1 + bps/10_000) makes the exact margin at
  // most maxTotal - p, an integer, so rounding the margin can't push the total past maxTotal.
  // It can undershoot by float error (by at most one), so step up while the next cost fits.
  let p = Math.floor((maxTotal * 10_000) / (10_000 + marginBps));
  for (let step = 0; step < 2 && priceSplit(p + 1, marginBps).total <= maxTotal; step++) p++;
  return p;
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
  spec: (offer: Offer) => LaunchSpec;
  sleep: (ms: number) => Promise<void>;
  /** Launch calls in total, retries included. */
  maxAttempts?: number;
  /** Retries of one offer after rate limiting or a transient failure. */
  maxRetriesPerOffer?: number;
}

export interface Placed {
  offer: Offer;
  result: LaunchResult;
  attempts: LaunchAttempt[];
}

const MAX_BACKOFF_MS = 30_000;

export function backoffMs(retry: number, retryAfterSeconds: number | null): number {
  const ms = retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 1000 * 2 ** retry;
  return Math.min(ms, MAX_BACKOFF_MS);
}

/**
 * Launch on the first offer that works. Capacity-type refusals move on to the next offer;
 * rate limits and transient failures retry the same offer; anything else stops the search,
 * including "outcome_unknown": a machine may exist, so launching elsewhere could make two.
 */
export async function launchWithFallback(opts: FallbackOptions): Promise<Placed> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const maxRetries = opts.maxRetriesPerOffer ?? 2;
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
      try {
        const result = await adapter.launch(opts.spec(offer));
        attempts.push({ provider: offer.provider, dataCenter: offer.dataCenter, outcome: "launched", detail: "" });
        return { offer, result, attempts };
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        last = e;
        attempts.push({ provider: offer.provider, dataCenter: offer.dataCenter, outcome: e.kind, detail: e.message });
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
