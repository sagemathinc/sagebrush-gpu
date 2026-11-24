// The numbers behind the spend meter. All amounts are integer micro-USD.

export type MeterBand = "ok" | "low" | "critical" | "empty";

export interface MeterInput {
  allocation: number;
  spent: number;
  // Held back for the final save of running machines; not spendable.
  reserved: number;
  // Current accrual rate of the member's running machines, micro-USD per hour.
  ratePerHour: number;
}

export interface Meter {
  remaining: number;
  // remaining / allocation, in [0, 1]; 0 when the allocation is 0.
  fractionLeft: number;
  band: MeterBand;
  // Seconds until remaining is used up at the current rate; null when nothing is running.
  secondsLeft: number | null;
}

export const LOW_FRACTION = 0.2;
export const CRITICAL_FRACTION = 0.05;

export function computeMeter({ allocation, spent, reserved, ratePerHour }: MeterInput): Meter {
  const remaining = Math.max(0, allocation - spent - reserved);
  const fractionLeft = allocation > 0 ? Math.min(1, remaining / allocation) : 0;
  let band: MeterBand;
  if (remaining === 0) band = "empty";
  else if (fractionLeft < CRITICAL_FRACTION) band = "critical";
  else if (fractionLeft < LOW_FRACTION) band = "low";
  else band = "ok";
  const secondsLeft = ratePerHour > 0 ? Math.floor((remaining * 3600) / ratePerHour) : null;
  return { remaining, fractionLeft, band, secondsLeft };
}

// "2 d 4 h", "3 h 20 min", "45 min", "under 1 min"
export function formatDuration(seconds: number): string {
  if (!(seconds >= 60)) return "under 1 min";
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  return `${mins} min`;
}
