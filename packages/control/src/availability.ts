// The availability record's store (migrations/0004_availability.sql): bounded writes, and
// window reads that say when they were cut short. The observation type, its validation and
// the report are in @sbgpu/providers.

import {
  availabilityReport,
  checkObservation,
  checkReportWindow,
  type AvailabilityObservation,
  type AvailabilityReport,
} from "@sbgpu/providers";
import { stmt, type Db } from "./db.ts";

/** The store never holds more rows than this: each write prunes the oldest beyond it. */
export const MAX_OBSERVATIONS = 100_000;
/** At most this many observations per write. */
export const MAX_OBSERVATIONS_PER_WRITE = 1000;
/** At most this many rows per window read; a longer window is reported as truncated. */
export const MAX_REPORT_ROWS = 50_000;

const INSERT =
  "INSERT INTO availability_observations (provider, gpu_type, gpu_count, data_center, country, observed_ms, source, outcome, quoted_cost_per_hour, ready_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

// The retention mark: the newest observed_ms among the rows PRUNE is about to delete (the same
// selection), moved forward only. It runs just before PRUNE in the same batch (one transaction).
// With nothing to prune the SELECT yields no row and nothing changes.
const MARK =
  "INSERT INTO availability_retention (id, pruned_through_ms) SELECT 1, m FROM (SELECT max(observed_ms) AS m FROM (SELECT observed_ms FROM availability_observations ORDER BY observed_ms, id LIMIT max(0, (SELECT count(*) FROM availability_observations) - ?))) WHERE m IS NOT NULL ON CONFLICT (id) DO UPDATE SET pruned_through_ms = max(pruned_through_ms, excluded.pruned_through_ms)";

// One statement, so no concurrent insert can slip between counting and deleting.
const PRUNE =
  "DELETE FROM availability_observations WHERE id IN (SELECT id FROM availability_observations ORDER BY observed_ms, id LIMIT max(0, (SELECT count(*) FROM availability_observations) - ?))";

/**
 * Record observations, all or none (one batch), then prune to MAX_OBSERVATIONS in the same
 * batch. Every observation is validated before anything is written.
 */
export async function recordObservations(db: Db, observations: readonly AvailabilityObservation[], nowMs: number): Promise<void> {
  if (observations.length === 0) return;
  if (observations.length > MAX_OBSERVATIONS_PER_WRITE) {
    throw new RangeError(`at most ${MAX_OBSERVATIONS_PER_WRITE} observations per write`);
  }
  for (const o of observations) checkObservation(o, nowMs);
  await db.batch([
    ...observations.map((o) =>
      stmt(INSERT, o.provider, o.gpuType, o.gpuCount, o.dataCenter, o.country, o.observedMs, o.source, o.outcome, o.quotedCostPerHour, o.readyMs),
    ),
    stmt(MARK, MAX_OBSERVATIONS),
    stmt(PRUNE, MAX_OBSERVATIONS),
  ]);
}

interface Row {
  provider: string;
  gpu_type: string;
  gpu_count: number;
  data_center: string;
  country: string | null;
  observed_ms: number;
  source: string;
  outcome: string;
  quoted_cost_per_hour: number | null;
  ready_ms: number | null;
}

/**
 * The observations in [fromMs, toMs), oldest first, at most `limit`; truncated says the window
 * held more (the newest are the ones left out).
 */
export async function observationsInWindow(
  db: Db,
  fromMs: number,
  toMs: number,
  limit: number = MAX_REPORT_ROWS,
): Promise<{ observations: AvailabilityObservation[]; truncated: boolean; prunedThroughMs: number | null }> {
  checkReportWindow(fromMs, toMs);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPORT_ROWS) {
    throw new RangeError(`limit must be an integer in [1, ${MAX_REPORT_ROWS}]`);
  }
  const rows = await db.all<Row>(
    "SELECT provider, gpu_type, gpu_count, data_center, country, observed_ms, source, outcome, quoted_cost_per_hour, ready_ms FROM availability_observations WHERE observed_ms >= ? AND observed_ms < ? ORDER BY observed_ms, id LIMIT ?",
    [fromMs, toMs, limit + 1],
  );
  const truncated = rows.length > limit;
  const observations = rows.slice(0, limit).map(
    (r) =>
      ({
        provider: r.provider,
        gpuType: r.gpu_type,
        gpuCount: r.gpu_count,
        dataCenter: r.data_center,
        country: r.country,
        observedMs: r.observed_ms,
        quotedCostPerHour: r.quoted_cost_per_hour,
        source: r.source,
        outcome: r.outcome,
        readyMs: r.ready_ms,
      }) as AvailabilityObservation,
  );
  // Read the retention mark AFTER the rows: a prune in between can only move it forward, which
  // marks the window incomplete (safe); read before, a prune in between could go unnoticed.
  const marks = await db.all<{ pruned_through_ms: number }>("SELECT pruned_through_ms FROM availability_retention WHERE id = 1");
  const prunedThroughMs = marks.length > 0 ? marks[0]!.pruned_through_ms : null;
  return { observations, truncated, prunedThroughMs };
}

/** The availability report for [fromMs, toMs), from the store. */
export async function storedAvailabilityReport(db: Db, fromMs: number, toMs: number): Promise<AvailabilityReport> {
  const { observations, truncated, prunedThroughMs } = await observationsInWindow(db, fromMs, toMs);
  return availabilityReport(observations, { fromMs, toMs, truncated, prunedThroughMs });
}
