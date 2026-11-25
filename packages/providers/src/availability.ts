// The availability record: what providers actually did when we asked, for honest, measured
// availability reports (William, Nov 16 2026: "regular probes ... pass on honest reports").
//
// Two kinds of observation, never mixed up:
// - "listing": a provider's own stock label for an offer (high/medium/low/none/unknown). It is
//   what the provider said, not availability: launches can fail on "high" offers.
// - "launch": a real launch attempt and what happened: launched (with the time to ready if it
//   was measured), no_capacity, refused (the provider turned this offer down for another
//   reason), or error.
// The report counts these, per provider, GPU type and count, and data center, over a window.
// Every figure is a count or a value that was observed. Nothing is interpolated or
// extrapolated, and a group with no launch attempts has no success rate at all.

import type { ProviderErrorKind } from "./errors.ts";
import { isGpuType } from "./gpus.ts";
import type { CountryCode, GpuTypeId, Micros, Offer, ProviderId, StockLevel } from "./types.ts";

export const PROVIDERS: readonly ProviderId[] = ["runpod", "shadeform", "hyperstack", "nebius", "vast"];
export const STOCK_LEVELS: readonly StockLevel[] = ["high", "medium", "low", "none", "unknown"];
export const LAUNCH_OUTCOMES = ["launched", "no_capacity", "refused", "error"] as const;
export type LaunchOutcome = (typeof LAUNCH_OUTCOMES)[number];

export type AvailabilityObservation = {
  provider: ProviderId;
  gpuType: GpuTypeId;
  gpuCount: number;
  dataCenter: string;
  /** ISO 3166-1 alpha-2, or null when unknown. */
  country: CountryCode | null;
  observedMs: number;
  /** The provider's quoted price for the whole machine, per hour, if it quoted one. */
  quotedCostPerHour: Micros | null;
} & (
  | { source: "listing"; outcome: StockLevel; readyMs: null }
  | {
      source: "launch";
      outcome: LaunchOutcome;
      /** Launched only: from the launch request to the provider reporting it running, if measured. */
      readyMs: number | null;
    }
);

/** Limits on one observation. */
export const MAX_GPU_COUNT = 16;
export const MAX_QUOTED_COST_PER_HOUR = 1_000_000_000; // $1000/h
export const MAX_READY_MS = 86_400_000; // a day
/** Observations may be stamped at most this far ahead of the recorder's clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function check(ok: boolean, what: string): void {
  if (!ok) throw new RangeError(`availability observation: ${what}`);
}

function safeIn(x: unknown, lo: number, hi: number): boolean {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= lo && x <= hi;
}

/** Throws RangeError unless `o` is a well-formed observation made no later than nowMs + skew. */
export function checkObservation(o: AvailabilityObservation, nowMs: number): void {
  check(PROVIDERS.includes(o.provider), "unknown provider");
  check(typeof o.gpuType === "string" && isGpuType(o.gpuType), "unknown GPU type");
  check(safeIn(o.gpuCount, 1, MAX_GPU_COUNT), "bad GPU count");
  check(typeof o.dataCenter === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(o.dataCenter), "bad data center");
  check(o.country === null || (typeof o.country === "string" && /^[A-Z]{2}$/.test(o.country)), "bad country");
  check(safeIn(nowMs, 0, Number.MAX_SAFE_INTEGER), "bad clock");
  check(safeIn(o.observedMs, 0, nowMs + MAX_CLOCK_SKEW_MS), "bad or future time");
  check(o.quotedCostPerHour === null || safeIn(o.quotedCostPerHour, 0, MAX_QUOTED_COST_PER_HOUR), "bad quoted price");
  if (o.source === "listing") {
    check(STOCK_LEVELS.includes(o.outcome), "a listing's outcome must be a stock level");
    check(o.readyMs === null, "a listing has no time to ready");
  } else {
    check(o.source === "launch", "unknown source");
    check((LAUNCH_OUTCOMES as readonly string[]).includes(o.outcome), "a launch's outcome must be launched, no_capacity, refused or error");
    check(o.readyMs === null || (o.outcome === "launched" && safeIn(o.readyMs, 0, MAX_READY_MS)), "bad time to ready");
  }
}

/** Listing observations for a set of offers, as listed at `observedMs`. */
export function listingObservations(offers: readonly Offer[], observedMs: number): AvailabilityObservation[] {
  return offers.map((o) => ({
    provider: o.provider,
    gpuType: o.gpuType,
    gpuCount: o.gpuCount,
    dataCenter: o.dataCenter,
    country: o.country,
    observedMs,
    quotedCostPerHour: o.providerCostPerHour,
    source: "listing" as const,
    outcome: o.stock,
    readyMs: null,
  }));
}

/**
 * The availability outcome of a failed launch attempt, from its ProviderError kind. Only a
 * capacity refusal says the offer wasn't available; other refusals and errors are recorded as
 * such and never counted for or against availability.
 */
export function launchOutcomeOf(kind: ProviderErrorKind): Exclude<LaunchOutcome, "launched"> {
  switch (kind) {
    case "no_capacity":
      return "no_capacity";
    case "unplaceable":
    case "forbidden":
    case "price_above_cap":
    case "spec_mismatch":
    case "invalid_request":
    case "insufficient_funds":
    case "auth":
      return "refused";
    case "rate_limited":
    case "transient":
    case "not_found":
    case "outcome_unknown":
    case "unknown":
      return "error";
  }
}

// ---------------------------------------------------------------- the report

export interface AvailabilityGroup {
  provider: ProviderId;
  gpuType: GpuTypeId;
  gpuCount: number;
  dataCenter: string;
  /** The country of the group's latest observation (null if unknown). */
  country: CountryCode | null;
  listings: { observations: number; byStock: Record<StockLevel, number> };
  launches: {
    attempts: number;
    launched: number;
    noCapacity: number;
    refused: number;
    errors: number;
    /**
     * launched out of (launched + noCapacity): the attempts that tested capacity. null when
     * there were none: no attempts means no measurement, not 0%.
     */
    capacity: { launched: number; of: number } | null;
    /** Over launched attempts whose time to ready was measured; median is the lower median. */
    readyMs: { measured: number; min: number; median: number; max: number } | null;
  };
  quotedCostPerHour: { min: Micros; max: Micros; latest: Micros } | null;
  firstMs: number;
  lastMs: number;
}

export interface AvailabilityReport {
  /** The window, half-open: [fromMs, toMs). */
  fromMs: number;
  toMs: number;
  observations: number;
  /** The store returned only part of the window: narrow it before drawing conclusions. */
  truncated: boolean;
  /** The newest time the store has pruned observations at, or null if it never pruned any. */
  prunedThroughMs: number | null;
  /**
   * Every observation ever recorded in the window is in this report: not truncated, and the
   * window starts after anything pruned. When false, missing groups or counts may be data that
   * was discarded, not "never measured".
   */
  complete: boolean;
  groups: AvailabilityGroup[];
}

/** The longest window a report covers. */
export const MAX_REPORT_WINDOW_MS = 366 * 86_400_000;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Throws RangeError unless [fromMs, toMs) is a valid report window. Check before reading. */
export function checkReportWindow(fromMs: number, toMs: number): void {
  check(safeIn(fromMs, 0, Number.MAX_SAFE_INTEGER) && safeIn(toMs, 0, Number.MAX_SAFE_INTEGER), "bad window");
  check(toMs > fromMs && toMs - fromMs <= MAX_REPORT_WINDOW_MS, "a window must be non-empty and at most 366 days");
}

/**
 * The report for the observations inside [fromMs, toMs). Observations outside the window are
 * ignored. Groups are sorted by provider, GPU type, GPU count and data center.
 */
export function availabilityReport(
  observations: readonly AvailabilityObservation[],
  window: { fromMs: number; toMs: number; truncated: boolean; prunedThroughMs: number | null },
): AvailabilityReport {
  const { fromMs, toMs, prunedThroughMs } = window;
  checkReportWindow(fromMs, toMs);
  check(prunedThroughMs === null || safeIn(prunedThroughMs, 0, Number.MAX_SAFE_INTEGER), "bad retention mark");
  const groups = new Map<string, AvailabilityGroup & { latestPriceMs: number; latestCountryMs: number; ready: number[] }>();
  let counted = 0;
  for (const o of observations) {
    if (o.observedMs < fromMs || o.observedMs >= toMs) continue;
    counted++;
    const key = JSON.stringify([o.provider, o.gpuType, o.gpuCount, o.dataCenter]);
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        provider: o.provider,
        gpuType: o.gpuType,
        gpuCount: o.gpuCount,
        dataCenter: o.dataCenter,
        country: o.country,
        listings: { observations: 0, byStock: { high: 0, medium: 0, low: 0, none: 0, unknown: 0 } },
        launches: { attempts: 0, launched: 0, noCapacity: 0, refused: 0, errors: 0, capacity: null, readyMs: null },
        quotedCostPerHour: null,
        firstMs: o.observedMs,
        lastMs: o.observedMs,
        latestPriceMs: -1,
        latestCountryMs: o.observedMs,
        ready: [],
      };
      groups.set(key, g);
    }
    g.firstMs = Math.min(g.firstMs, o.observedMs);
    g.lastMs = Math.max(g.lastMs, o.observedMs);
    if (o.observedMs >= g.latestCountryMs) {
      g.latestCountryMs = o.observedMs;
      g.country = o.country;
    }
    if (o.quotedCostPerHour !== null) {
      const q = o.quotedCostPerHour;
      if (g.quotedCostPerHour === null) g.quotedCostPerHour = { min: q, max: q, latest: q };
      g.quotedCostPerHour.min = Math.min(g.quotedCostPerHour.min, q);
      g.quotedCostPerHour.max = Math.max(g.quotedCostPerHour.max, q);
      if (o.observedMs >= g.latestPriceMs) {
        g.latestPriceMs = o.observedMs;
        g.quotedCostPerHour.latest = q;
      }
    }
    if (o.source === "listing") {
      g.listings.observations++;
      g.listings.byStock[o.outcome]++;
    } else {
      g.launches.attempts++;
      if (o.outcome === "launched") {
        g.launches.launched++;
        if (o.readyMs !== null) g.ready.push(o.readyMs);
      } else if (o.outcome === "no_capacity") g.launches.noCapacity++;
      else if (o.outcome === "refused") g.launches.refused++;
      else g.launches.errors++;
    }
  }
  const out: AvailabilityGroup[] = [];
  for (const g of groups.values()) {
    const of = g.launches.launched + g.launches.noCapacity;
    g.launches.capacity = of > 0 ? { launched: g.launches.launched, of } : null;
    if (g.ready.length > 0) {
      const r = [...g.ready].sort((a, b) => a - b);
      g.launches.readyMs = { measured: r.length, min: r[0]!, median: r[Math.floor((r.length - 1) / 2)]!, max: r[r.length - 1]! };
    }
    const { latestPriceMs: _p, latestCountryMs: _c, ready: _r, ...group } = g;
    out.push(group);
  }
  out.sort(
    (a, b) =>
      cmp(a.provider, b.provider) || cmp(a.gpuType, b.gpuType) || a.gpuCount - b.gpuCount || cmp(a.dataCenter, b.dataCenter),
  );
  const complete = !window.truncated && (prunedThroughMs === null || fromMs > prunedThroughMs);
  return { fromMs, toMs, observations: counted, truncated: window.truncated, prunedThroughMs, complete, groups: out };
}
