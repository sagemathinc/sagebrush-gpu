// Money in the UI is integer micro-USD, exactly as the API sends it.
// Nothing here uses floating-point arithmetic on amounts.

export const MICRO_PER_USD = 1_000_000;

function assertMicro(micro: number): void {
  if (!Number.isSafeInteger(micro)) {
    throw new RangeError(`not an integer micro-USD amount: ${micro}`);
  }
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Format micro-USD as "$1,234.56" with `decimals` places (0..6), rounding half away from zero.
export function formatUsd(micro: number, decimals = 2): string {
  assertMicro(micro);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new RangeError(`decimals must be 0..6: ${decimals}`);
  }
  const abs = Math.abs(micro);
  const step = 10 ** (6 - decimals);
  // Integer arithmetic: abs is a safe integer, so (abs - remainder) is exact.
  const remainder = abs % step;
  const rounded = abs - remainder + (remainder * 2 >= step ? step : 0);
  const whole = Math.floor(rounded / MICRO_PER_USD);
  const frac = rounded % MICRO_PER_USD;
  let text = "$" + groupThousands(String(whole));
  if (decimals > 0) {
    text += "." + String(frac).padStart(6, "0").slice(0, decimals);
  }
  return micro < 0 && rounded !== 0 ? "-" + text : text;
}

// A price per hour: two decimals unless that would hide a nonzero sub-cent amount.
export function formatRate(microPerHour: number): string {
  assertMicro(microPerHour);
  const abs = Math.abs(microPerHour);
  const decimals = abs !== 0 && abs < 10_000 ? 4 : 2;
  return formatUsd(microPerHour, decimals) + "/h";
}

// "provider $0.48/h + service $0.14/h = $0.62/h"
export function formatPriceSplit(providerPerHour: number, marginPerHour: number): string {
  return (
    `provider ${formatRate(providerPerHour)} + service ${formatRate(marginPerHour)}` +
    ` = ${formatRate(providerPerHour + marginPerHour)}`
  );
}

// Parse a dollar amount typed by a manager ("12", "$1,234.5", "0.000001") into micro-USD.
// Returns null for anything that isn't a plain non-negative amount with at most 6 decimals.
export function parseUsd(text: string): number | null {
  const m = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (m == null || m[1] == null) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  const frac = Number((m[2] ?? "").padEnd(6, "0"));
  const micro = whole * MICRO_PER_USD + frac;
  return Number.isSafeInteger(micro) ? micro : null;
}
