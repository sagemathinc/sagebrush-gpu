import type { Micros } from "./types.ts";

// Provider money is exact (William's exact-money rule; Codex audit G02-3). A provider's reply is JSON, and
// JSON.parse turns every number into a binary double, so a price token like "0.1234564999999999999999" would
// come back as a double that rounds a micro the other way. So:
// - parseProviderJson keeps a number only if the double holds its token's exact decimal value (any token of
//   up to 15 significant digits does); a token a double can't hold exactly becomes NaN, which every money
//   reader already refuses (a price of NaN is no price).
// - usdToMicros then rounds the number's exact decimal value (its shortest round-trip spelling, which for such a
//   number is the token's own value) to integer micro-USD, once, half up, in integer arithmetic.

/** A decimal's exact value as digits × 10^exponent, from its plain or exponent spelling; null if it isn't one. */
function decimalParts(text: string): { digits: bigint; exponent: number } | null {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (m === null) return null;
  const frac = m[3] ?? "";
  const exponent = Number(m[4] ?? "0") - frac.length;
  if (!Number.isSafeInteger(exponent)) return null;
  let digits = BigInt(m[2]! + frac);
  if (m[1] === "-") digits = -digits;
  return { digits, exponent };
}

/** digits × 10^exponent with trailing zeros moved into the exponent, so equal values compare equal. */
function normalized(p: { digits: bigint; exponent: number }): string {
  let { digits, exponent } = p;
  if (digits === 0n) return "0";
  while (digits % 10n === 0n) {
    digits /= 10n;
    exponent++;
  }
  return `${digits}e${exponent}`;
}

/**
 * JSON from a provider, with every number checked against its own token: a number whose double isn't exactly
 * the token's decimal value is NaN. A runtime that can't show the token fails closed (throws).
 */
export function parseProviderJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    const src = context?.source;
    if (typeof src !== "string") throw new SyntaxError("this runtime can't read numbers exactly");
    const token = decimalParts(src);
    const held = decimalParts(String(value));
    return token !== null && held !== null && normalized(token) === normalized(held) ? value : Number.NaN;
  });
}

/**
 * A provider's USD amount as integer micro-USD: its exact decimal value rounded once, half up. Refuses negative,
 * non-finite (NaN included: a token parseProviderJson couldn't hold exactly) and unsafe values instead of
 * guessing.
 */
export function usdToMicros(usd: number): Micros {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`not a USD amount: ${String(usd)}`);
  }
  const p = decimalParts(String(usd));
  if (p === null) throw new RangeError(`not a USD amount: ${String(usd)}`);
  // micros = digits × 10^(exponent + 6), rounded half up
  const shift = p.exponent + 6;
  let micros: bigint;
  if (shift >= 0) micros = p.digits * 10n ** BigInt(shift);
  else {
    const d = 10n ** BigInt(-shift);
    micros = p.digits / d;
    if ((p.digits % d) * 2n >= d) micros += 1n;
  }
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`USD amount too large: ${usd}`);
  return Number(micros);
}
