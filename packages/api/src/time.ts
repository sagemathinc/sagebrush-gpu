// Times on the wire: ISO-8601 UTC with milliseconds, exactly as Date.toISOString() writes
// them ("2027-02-01T09:00:00.000Z"). One spelling, so strings compare in time order.

export type IsoTime = string;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoTime(x: unknown): x is IsoTime {
  if (typeof x !== "string" || !ISO.test(x)) return false;
  const t = Date.parse(x);
  // Round-trip rejects impossible dates such as 2027-02-30.
  return Number.isFinite(t) && new Date(t).toISOString() === x;
}

export function toIso(ms: number): IsoTime {
  return new Date(ms).toISOString();
}

/** The start of the UTC minute containing `ms`; ledger entries are keyed by it. */
export function minuteStart(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}
