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

// |micro| rounded half up to `decimals` places, in micro-USD. Integer arithmetic: exact.
function roundAbs(micro: number, decimals: number): number {
  const abs = Math.abs(micro);
  const step = 10 ** (6 - decimals);
  const remainder = abs % step;
  return abs - remainder + (remainder * 2 >= step ? step : 0);
}

// Format micro-USD as "$1,234.56" with `decimals` places (0..6), rounding half away from zero.
export function formatUsd(micro: number, decimals = 2): string {
  assertMicro(micro);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw new RangeError(`decimals must be 0..6: ${decimals}`);
  }
  const rounded = roundAbs(micro, decimals);
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

// The fewest decimals (2, or 4 for a sub-cent part, up to 6) at which the rounded
// provider price and margin add up to the rounded total and no nonzero part shows as
// zero, so a shown sum is never wrong.
export function splitDecimals(provider: number, margin: number): number {
  assertMicro(provider);
  assertMicro(margin);
  const subCent = [provider, margin].some((x) => x !== 0 && Math.abs(x) < 10_000);
  for (let d = subCent ? 4 : 2; d < 6; d++) {
    const round = (x: number) => Math.sign(x) * roundAbs(x, d);
    const shown = (x: number) => x === 0 || round(x) !== 0;
    if (shown(provider) && shown(margin) && round(provider) + round(margin) === round(provider + margin)) return d;
  }
  return 6;
}

export interface PriceText {
  /** "$0.62/h" */
  total: string;
  /** "provider $0.48 + service $0.14" */
  parts: string;
}

// A price per hour as its total and its two parts, rounded alike so the parts add up.
export function priceText(providerPerHour: number, marginPerHour: number): PriceText {
  const d = splitDecimals(providerPerHour, marginPerHour);
  return {
    total: formatUsd(providerPerHour + marginPerHour, d) + "/h",
    parts: `provider ${formatUsd(providerPerHour, d)} + service ${formatUsd(marginPerHour, d)}`,
  };
}

// "provider $0.48/h + service $0.14/h = $0.62/h", with parts that add up.
export function formatPriceSplit(providerPerHour: number, marginPerHour: number): string {
  const d = splitDecimals(providerPerHour, marginPerHour);
  const rate = (x: number) => formatUsd(x, d) + "/h";
  return `provider ${rate(providerPerHour)} + service ${rate(marginPerHour)} = ${rate(providerPerHour + marginPerHour)}`;
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
