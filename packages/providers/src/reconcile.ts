// Reconciliation: the provider's bill against our ledger's provider-cost column.
//
// Providers bill in time buckets (RunPod: hour or day) per machine; the ledger charges per
// machine per minute. reconcile() sums both per (machine, bucket) and classifies each pair.
// It is pure: the control plane fetches the bill (BillingSource) and the ledger rows, and
// decides what to do with the result (alarm, monthly report, invoice check).

import type { IsoTime, LedgerEntry, MachineId, Micros, ProviderId } from "@sbgpu/api";

/** One bucket of a provider's bill for one of its machines. */
export interface ProviderBillingRecord {
  provider: ProviderId;
  providerMachineId: string;
  /** The bucket, half-open: [bucketStart, bucketEnd). ISO-8601 UTC. */
  bucketStart: IsoTime;
  bucketEnd: IsoTime;
  /** Everything the provider billed for this machine in the bucket. */
  total: Micros;
  /** The parts, as the provider reports them (they need not add up to total exactly). */
  gpu: Micros;
  cpu: Micros;
  disk: Micros;
}

export type BillingBucket = "hour" | "day";

export interface BillingQuery {
  /** Inclusive; must be on a bucket boundary. */
  start: IsoTime;
  /** Exclusive; must be on a bucket boundary. */
  end: IsoTime;
  bucket: BillingBucket;
}

/** A provider that can report its bill. A bill it can't prove complete is an error. */
export interface BillingSource {
  billing(query: BillingQuery): Promise<ProviderBillingRecord[]>;
}

/** Which of our machines a provider machine was. One machine may have had several. */
export interface MachineBinding {
  machineId: MachineId;
  provider: ProviderId;
  providerMachineId: string;
}

export interface ReconcileOptions {
  bucket: BillingBucket;
  /** Buckets ending after this are still open at the provider: reported as pending. */
  closedBefore: IsoTime;
  /** A difference up to this many micros per bucket is fine (rounding, per-second billing). */
  toleranceMicros: Micros;
  /** ... or up to this fraction of the ledger amount, in basis points, if larger. */
  toleranceBps: number;
}

export type ReconcileStatus =
  /** Within tolerance. */
  | "ok"
  /** The provider billed more than the ledger charged: we under-charged, or a machine ran unmetered. */
  | "over"
  /** The provider billed less than the ledger charged. */
  | "under"
  /** The provider billed a machine we have no binding for: it ran outside our control. */
  | "unknown_machine"
  /** The bucket isn't closed yet; nothing is concluded. */
  | "pending";

export interface ReconcileRow {
  /** null for unknown_machine. */
  machineId: MachineId | null;
  provider: ProviderId;
  /** The provider machines billed in this bucket (sorted). */
  providerMachineIds: string[];
  bucketStart: IsoTime;
  billed: Micros;
  ledger: Micros;
  /** billed - ledger. */
  difference: Micros;
  status: ReconcileStatus;
}

const BUCKET_MS: Record<BillingBucket, number> = { hour: 3_600_000, day: 86_400_000 };

function parseTime(name: string, t: string): number {
  const ms = Date.parse(t);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z$/.test(t) || !Number.isFinite(ms)) {
    throw new RangeError(`${name} is not an ISO-8601 UTC time: ${t}`);
  }
  return ms;
}

/** The start of the bucket containing `ms` (UTC; hour and day buckets are UTC-aligned). */
export function bucketStartMs(ms: number, bucket: BillingBucket): number {
  return Math.floor(ms / BUCKET_MS[bucket]) * BUCKET_MS[bucket];
}

function checkMicros(name: string, x: number): void {
  if (!Number.isSafeInteger(x) || x < 0) throw new RangeError(`${name} is not a non-negative safe integer: ${x}`);
}

/** The allowed difference for a ledger amount: the larger of the absolute and relative tolerances. */
export function tolerance(ledger: Micros, opts: Pick<ReconcileOptions, "toleranceMicros" | "toleranceBps">): Micros {
  return Math.max(opts.toleranceMicros, Math.floor((ledger * opts.toleranceBps) / 10_000));
}

/**
 * Compare the bill with the ledger, per machine and bucket. Every bucket in which either side
 * has an amount gets a row; rows are sorted by bucket, then machine. Only compute entries count
 * (storage and egress are billed by other parties); their provider cost is amount.providerCost.
 * Inputs that can't be reconciled (a malformed time, a binding that maps one provider machine to
 * two of ours, a record not on a bucket of the requested size) are errors, never "ok".
 */
export function reconcile(
  billing: readonly ProviderBillingRecord[],
  ledger: readonly LedgerEntry[],
  bindings: readonly MachineBinding[],
  opts: ReconcileOptions,
): ReconcileRow[] {
  checkMicros("toleranceMicros", opts.toleranceMicros);
  if (!Number.isSafeInteger(opts.toleranceBps) || opts.toleranceBps < 0 || opts.toleranceBps > 10_000) {
    throw new RangeError(`toleranceBps must be an integer in [0, 10000], got ${opts.toleranceBps}`);
  }
  if (!Object.hasOwn(BUCKET_MS, opts.bucket)) throw new RangeError(`unknown bucket: ${String(opts.bucket)}`);
  const closedBefore = parseTime("closedBefore", opts.closedBefore);
  const size = BUCKET_MS[opts.bucket];

  const byProviderMachine = new Map<string, MachineId>();
  for (const b of bindings) {
    const key = `${b.provider}\u0000${b.providerMachineId}`;
    const prev = byProviderMachine.get(key);
    if (prev !== undefined && prev !== b.machineId) {
      throw new RangeError(`${b.provider} machine ${b.providerMachineId} is bound to two machines`);
    }
    byProviderMachine.set(key, b.machineId);
  }

  interface Cell {
    machineId: MachineId | null;
    provider: ProviderId;
    pms: Set<string>;
    bucket: number;
    billed: number;
    ledger: number;
  }
  const cells = new Map<string, Cell>();
  const cell = (machineId: MachineId | null, provider: ProviderId, bucket: number, unknownPm: string | null): Cell => {
    // Unknown provider machines get their own rows, one per provider machine.
    const key = `${bucket}\u0000${provider}\u0000${machineId ?? `?${unknownPm}`}`;
    let c = cells.get(key);
    if (c === undefined) {
      c = { machineId, provider, pms: new Set(), bucket, billed: 0, ledger: 0 };
      cells.set(key, c);
    }
    return c;
  };

  for (const r of billing) {
    const start = parseTime("bucketStart", r.bucketStart);
    const end = parseTime("bucketEnd", r.bucketEnd);
    if (start % size !== 0 || end - start !== size) {
      throw new RangeError(`billing record ${r.providerMachineId} ${r.bucketStart} is not one ${opts.bucket} bucket`);
    }
    checkMicros("billed total", r.total);
    const machineId = byProviderMachine.get(`${r.provider}\u0000${r.providerMachineId}`) ?? null;
    const c = cell(machineId, r.provider, start, machineId === null ? r.providerMachineId : null);
    c.pms.add(r.providerMachineId);
    c.billed = checkedSum(c.billed, r.total);
  }

  for (const e of ledger) {
    if (e.kind !== "compute") continue;
    if (e.machineId === null || e.provider === null) {
      throw new RangeError(`compute ledger entry ${e.id} has no machine or provider`);
    }
    checkMicros("ledger provider cost", e.amount.providerCost);
    const c = cell(e.machineId, e.provider, bucketStartMs(parseTime("periodStart", e.periodStart), opts.bucket), null);
    c.ledger = checkedSum(c.ledger, e.amount.providerCost);
  }

  const rows: ReconcileRow[] = [];
  for (const c of cells.values()) {
    const difference = c.billed - c.ledger;
    let status: ReconcileStatus;
    if (c.bucket + size > closedBefore) status = "pending";
    else if (c.machineId === null) status = "unknown_machine";
    else if (Math.abs(difference) <= tolerance(c.ledger, opts)) status = "ok";
    else status = difference > 0 ? "over" : "under";
    rows.push({
      machineId: c.machineId,
      provider: c.provider,
      providerMachineIds: [...c.pms].sort(),
      bucketStart: new Date(c.bucket).toISOString(),
      billed: c.billed,
      ledger: c.ledger,
      difference,
      status,
    });
  }
  return rows.sort(
    (a, b) =>
      cmp(a.bucketStart, b.bucketStart) ||
      cmp(a.provider, b.provider) ||
      cmp(a.machineId ?? "", b.machineId ?? "") ||
      cmp(a.providerMachineIds.join(","), b.providerMachineIds.join(",")),
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function checkedSum(a: number, b: number): number {
  const s = a + b;
  if (!Number.isSafeInteger(s)) throw new RangeError("sum exceeds the safe integer range");
  return s;
}
