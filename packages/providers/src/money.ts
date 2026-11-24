import type { Micros } from "./types.ts";

/**
 * A provider's USD amount (a JSON float such as 0.69) as integer micro-USD, rounded to the
 * nearest micro. Refuses negative, non-finite and unsafe values instead of guessing.
 */
export function usdToMicros(usd: number): Micros {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`not a USD amount: ${String(usd)}`);
  }
  const micros = Math.round(usd * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new RangeError(`USD amount too large: ${usd}`);
  return micros;
}
