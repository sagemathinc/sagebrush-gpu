// The budget rules, as pure functions, so the control plane, the UI's quote display and
// the tests all use one definition.
//
// THE LEDGER RULE. Each machine is billed per UTC minute: one entry per (machine,
// minute), charging entrySplit(providerCostPerHour, s, marginBps) for the s seconds
// (0..60) it ran in that minute. Rounding happens per entry, so the budget bounds below
// are computed from the same per-entry charge, never from an aggregate hourly rate.
// entrySplit is non-decreasing in s, so no entry costs more than a full minute's entry.
//
// Every input is validated on its own before anything is combined; sums and products
// refuse results past Number.MAX_SAFE_INTEGER. The two decisions fail closed: invalid
// input stops machines (shouldHardStop) and refuses starts (canStartWithin).

import { checkedAdd, checkedMul, entrySplit, isBasisPoints, type BasisPoints, type Micros } from "./money.ts";

export const LEDGER_MINUTE_SECONDS = 60;

/** What the ledger needs to bill one machine. */
export interface MeteredMachine {
  providerCostPerHour: Micros;
  marginBps: BasisPoints;
}

function checkCount(name: string, x: unknown): asserts x is number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(x)}`);
  }
}

function checkMachine(m: unknown, i: number): asserts m is MeteredMachine {
  if (typeof m !== "object" || m === null) throw new RangeError(`machine ${i} is not an object`);
  const { providerCostPerHour, marginBps } = m as Record<string, unknown>;
  checkCount(`machine ${i} providerCostPerHour`, providerCostPerHour);
  if (!isBasisPoints(marginBps)) throw new RangeError(`machine ${i} marginBps is invalid: ${String(marginBps)}`);
}

function checkMachines(machines: unknown): asserts machines is MeteredMachine[] {
  if (!Array.isArray(machines)) throw new RangeError("machines must be an array");
  machines.forEach(checkMachine);
}

/** The total of the ledger entry for `seconds` (0..60) of one machine in one minute. */
export function minuteCharge(m: MeteredMachine, seconds: number): Micros {
  checkMachine(m, 0);
  checkCount("seconds", seconds);
  if (seconds > LEDGER_MINUTE_SECONDS) throw new RangeError(`a ledger minute has at most 60 seconds, got ${seconds}`);
  return entrySplit(m.providerCostPerHour, seconds, m.marginBps).total;
}

/**
 * The most the ledger can charge `machines` for the minutes of a window that starts on
 * a ledger-minute boundary and lasts `windowSeconds`: every minute that overlaps the
 * window, charged as a full minute, for every machine. Exact when every machine runs the
 * whole of each of those minutes.
 */
export function chargeBound(machines: readonly MeteredMachine[], windowSeconds: number): Micros {
  checkMachines(machines);
  checkCount("windowSeconds", windowSeconds);
  const minutes = Math.ceil(windowSeconds / LEDGER_MINUTE_SECONDS);
  if (minutes === 0) return 0;
  let total = 0;
  for (const m of machines) {
    total = checkedAdd(total, checkedMul(minutes, minuteCharge(m, LEDGER_MINUTE_SECONDS)));
  }
  return total;
}

/**
 * Seconds held back for the final save: the project's floor, or the agent's estimate for
 * the unsaved bytes, whichever is longer.
 */
export function reserveSeconds(policyReserveMinutes: number, estimatedSaveSeconds: number): number {
  checkCount("policyReserveMinutes", policyReserveMinutes);
  checkCount("estimatedSaveSeconds", estimatedSaveSeconds);
  return Math.max(checkedMul(policyReserveMinutes, 60), estimatedSaveSeconds);
}

/**
 * The most the ledger can charge `machines` during a final save of `seconds`, starting
 * at any point in a minute (so one more minute than the window alone): the spend meter's
 * `reserved`.
 */
export function reserveCharge(machines: readonly MeteredMachine[], seconds: number): Micros {
  checkCount("seconds", seconds);
  return chargeBound(machines, checkedAdd(seconds, LEDGER_MINUTE_SECONDS));
}

export interface HardStopInput {
  /** The allocation's amount minus every ledger entry recorded for it. May be negative. */
  unspent: Micros;
  /** The allocation's accruing machines. */
  machines: readonly MeteredMachine[];
  /** From the end of the last ledger minute recorded for these machines until now. */
  unbilledSeconds: number;
  /** Until the next check could stop them. */
  checkIntervalSeconds: number;
  /** Extra time for a late check or a slow provider stop. */
  safetySeconds: number;
  /** The final-save reserve (reserveSeconds). */
  reserveSeconds: number;
}

function sumSeconds(...parts: Array<[string, unknown]>): number {
  let total = 0;
  for (const [name, x] of parts) {
    checkCount(name, x);
    total = checkedAdd(total, x);
  }
  return total;
}

/**
 * What must remain unspent so the machines can run, unbilled time included, until the
 * next check and still pay for the final save: the ledger's own charge for every minute
 * from the last billed one to the end of that period.
 */
export function hardStopThreshold(i: HardStopInput): Micros {
  const window = sumSeconds(
    ["unbilledSeconds", i.unbilledSeconds],
    ["checkIntervalSeconds", i.checkIntervalSeconds],
    ["safetySeconds", i.safetySeconds],
    ["reserveSeconds", i.reserveSeconds],
  );
  return chargeBound(i.machines, window);
}

/**
 * Stop now (saving first) when the unspent amount is below the threshold. Fails closed:
 * any invalid input (NaN, a negative period, an overflow) means stop. An allocation with
 * no accruing machines has nothing to stop.
 */
export function shouldHardStop(i: HardStopInput): boolean {
  try {
    checkMachines(i.machines);
    if (i.machines.length === 0) return false;
    if (!Number.isSafeInteger(i.unspent)) return true;
    return i.unspent < hardStopThreshold(i);
  } catch {
    return true;
  }
}

export interface StartCheckInput {
  unspent: Micros;
  newMachine: MeteredMachine;
  /** Machines already accruing on the same allocation. */
  running: readonly MeteredMachine[];
  /** From the end of the last ledger minute recorded for this allocation until now. */
  unbilledSeconds: number;
  /** The policy's minStartMinutes. */
  minStartMinutes: number;
  checkIntervalSeconds: number;
  safetySeconds: number;
  reserveSeconds: number;
}

/**
 * The least unspent amount that allows a start: every machine on the allocation, the new
 * one included, must be able to run for the minimum slice and then stop at a check with
 * its final save paid for, as the ledger would charge it.
 */
export function requiredToStart(i: StartCheckInput): Micros {
  checkCount("minStartMinutes", i.minStartMinutes);
  const window = sumSeconds(
    ["unbilledSeconds", i.unbilledSeconds],
    // a product of safe non-negative integers is exact or past the safe range, which
    // sumSeconds refuses
    ["minStartSeconds", i.minStartMinutes * 60],
    ["checkIntervalSeconds", i.checkIntervalSeconds],
    ["safetySeconds", i.safetySeconds],
    ["reserveSeconds", i.reserveSeconds],
  );
  checkMachines(i.running);
  return chargeBound([...i.running, i.newMachine], window);
}

/** Fails closed: any invalid input refuses the start. */
export function canStartWithin(i: StartCheckInput): boolean {
  try {
    if (!Number.isSafeInteger(i.unspent)) return false;
    return i.unspent >= requiredToStart(i);
  } catch {
    return false;
  }
}

/** The spend meter's figure: remaining = amount - spent - reserved, never below zero. */
export function meterRemaining(amount: Micros, spentTotal: Micros, reserved: Micros): Micros {
  checkCount("amount", amount);
  checkCount("spentTotal", spentTotal);
  checkCount("reserved", reserved);
  return Math.max(0, amount - checkedAdd(spentTotal, reserved));
}
