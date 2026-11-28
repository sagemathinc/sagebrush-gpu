// Money: integer micro-dollars (1e-6 USD), never floats. The ledger is in USD, and so are
// invoices: there is no currency conversion anywhere.

/** An integer number of micro-dollars (1 USD = 1_000_000). */
export type Micros = number;

/** Basis points: 10_000 = 100%. A 30% margin is 3000. */
export type BasisPoints = number;

export const MICROS_PER_USD = 1_000_000;
export const BPS_PER_UNIT = 10_000;
export const SECONDS_PER_HOUR = 3600;

/** The provider's part and our margin, always carried separately; total = both. */
export interface PriceSplit {
  providerCost: Micros;
  margin: Micros;
  total: Micros;
}

/** True for a safe integer number of micro-dollars (negative allowed, e.g. refunds). */
export function isMicros(x: unknown): x is Micros {
  return typeof x === "number" && Number.isSafeInteger(x);
}

/** True for a safe integer >= 0. */
export function isNonNegativeMicros(x: unknown): x is Micros {
  return isMicros(x) && x >= 0;
}

/** True for an integer margin from 0 to 1_000_000 basis points (0% to 10000%). */
export function isBasisPoints(x: unknown): x is BasisPoints {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= 100 * BPS_PER_UNIT;
}

function checkNonNegative(name: string, x: number): void {
  if (!Number.isSafeInteger(x) || x < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${x}`);
  }
}

/** a + b for safe integers, refusing a result past the safe range. */
export function checkedAdd(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new RangeError(`checkedAdd needs safe integers, got ${a} and ${b}`);
  }
  const r = a + b;
  if (!Number.isSafeInteger(r)) throw new RangeError(`${a} + ${b} exceeds the safe integer range`);
  return r;
}

/** a * b for safe integers, refusing a result past the safe range. */
export function checkedMul(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new RangeError(`checkedMul needs safe integers, got ${a} and ${b}`);
  }
  const r = a * b;
  if (!Number.isSafeInteger(r)) throw new RangeError(`${a} * ${b} exceeds the safe integer range`);
  return r;
}

/**
 * n / d rounded half-up, for integers n >= 0, d > 0. Exact: no floating-point division
 * is used for the rounding decision. The one rounding rule for every money computation.
 */
export function divRoundHalfUp(n: number, d: number): number {
  checkNonNegative("numerator", n);
  if (!Number.isSafeInteger(d) || d <= 0) {
    throw new RangeError(`denominator must be a positive safe integer, got ${d}`);
  }
  // Exact for safe integers: n / d is within half an ulp of the true quotient, and for
  // n < 2^53 half an ulp is below 1/d, the least distance from a non-integer quotient
  // to the next integer. So the floor is the true floor (tests cross-check with BigInt).
  const q = Math.floor(n / d);
  const r = n - q * d;
  return 2 * r >= d ? q + 1 : q;
}

/** Our margin on a provider cost: cost * bps / 10_000, rounded once, half-up. */
export function marginOn(providerCost: Micros, marginBps: BasisPoints): Micros {
  checkNonNegative("providerCost", providerCost);
  if (!isBasisPoints(marginBps)) {
    throw new RangeError(`marginBps must be an integer in [0, 1000000], got ${marginBps}`);
  }
  const product = providerCost * marginBps;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError("providerCost * marginBps exceeds the safe integer range");
  }
  return divRoundHalfUp(product, BPS_PER_UNIT);
}

/** A provider cost plus our margin on it. */
export function priceSplit(providerCost: Micros, marginBps: BasisPoints): PriceSplit {
  const margin = marginOn(providerCost, marginBps);
  return { providerCost, margin, total: checkedAdd(providerCost, margin) };
}

/**
 * What `seconds` of use cost at `perHour` micro-dollars per hour, rounded half-up to
 * the micro. Used for one ledger entry's provider cost: the margin is then applied to
 * that cost (marginOn), so each entry is rounded exactly twice, in a fixed order.
 */
export function costForSeconds(perHour: Micros, seconds: number): Micros {
  checkNonNegative("perHour", perHour);
  checkNonNegative("seconds", seconds);
  const product = perHour * seconds;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError("perHour * seconds exceeds the safe integer range");
  }
  return divRoundHalfUp(product, SECONDS_PER_HOUR);
}

/** One ledger entry's split: provider cost for the seconds, then the margin on it. */
export function entrySplit(providerPerHour: Micros, seconds: number, marginBps: BasisPoints): PriceSplit {
  return priceSplit(costForSeconds(providerPerHour, seconds), marginBps);
}

/** Sum of splits, part by part; refuses malformed splits and sums past the safe range. */
export function addSplits(...splits: PriceSplit[]): PriceSplit {
  let providerCost = 0;
  let margin = 0;
  for (const s of splits) {
    if (!isPriceSplit(s)) throw new RangeError(`not a price split: ${JSON.stringify(s)}`);
    providerCost = checkedAdd(providerCost, s.providerCost);
    margin = checkedAdd(margin, s.margin);
  }
  return { providerCost, margin, total: checkedAdd(providerCost, margin) };
}

/**
 * True when total == providerCost + margin and all are safe integers. (A sum past the
 * safe range can't equal a safe total, so no separate overflow check is needed.)
 */
export function isPriceSplit(x: unknown): x is PriceSplit {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    isMicros(s.providerCost) &&
    isMicros(s.margin) &&
    isMicros(s.total) &&
    s.total === (s.providerCost as number) + (s.margin as number)
  );
}

/** Micros as an exact decimal amount of dollars ("2", "0.043333", "-0.5"): integer arithmetic only, never rounded. */
export function usdDecimal(micros: Micros): string {
  if (!isMicros(micros)) throw new RangeError(`not micros: ${micros}`);
  const abs = Math.abs(micros);
  const frac = abs % MICROS_PER_USD;
  // (abs - frac is a multiple of a million, so the quotient is exact)
  const whole = (abs - frac) / MICROS_PER_USD;
  const digits = String(frac).padStart(6, "0").replace(/0+$/, "");
  return `${micros < 0 ? "-" : ""}${whole}${digits === "" ? "" : `.${digits}`}`;
}

/**
 * An SQL integer SUM read exactly: the statement casts it to text (CAST(COALESCE(SUM(x), 0) AS
 * TEXT)), and this refuses one past the safe integer range rather than let it round. A sum of
 * rows that are each in range can still pass it.
 */
export function exactSum(text: unknown): Micros {
  if (typeof text !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(text) || text.length > 20) throw new RangeError(`not an integer sum: ${String(text)}`);
  const n = BigInt(text);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`a sum past the safe integer range: ${text}`);
  return Number(n);
}

/** "$0.62" style display, for logs and CSVs; rounds half-up to the cent. */
export function formatUsd(micros: Micros): string {
  if (!isMicros(micros)) throw new RangeError(`not micros: ${micros}`);
  const neg = micros < 0;
  const cents = divRoundHalfUp(Math.abs(micros), 10_000);
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return `${neg && cents > 0 ? "-" : ""}$${dollars}.${rest}`;
}
