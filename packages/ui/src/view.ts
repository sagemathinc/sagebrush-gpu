// What the screens show and allow, as pure functions of API objects, so the decisions
// are tested without a DOM. Components only lay these out.

import type { Machine, ProjectLabels, QuoteRefusal, SpendMeter, StopReason } from "@sbgpu/api";
import { withArticle } from "./labels.ts";
import { computeMeter, formatDuration, type MeterBand } from "./meter.ts";
import { formatPriceSplit, formatRate, formatUsd } from "./money.ts";

export function machineStateLabel(m: Machine): string {
  switch (m.state) {
    case "starting":
      return "Starting";
    case "running":
      return m.save.state === "saving" ? "Running, saving" : "Running";
    case "saving":
      return "Saving before stop";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "deleted":
      return "Deleted";
  }
}

export function stopReasonText(reason: StopReason, labels: ProjectLabels): string {
  switch (reason) {
    case "user":
      return "You stopped it.";
    case "idle":
      return "Stopped after being idle.";
    case "maxSession":
      return "Stopped at the maximum session length.";
    case "budget":
      return "Stopped because the allocation was nearly used up.";
    case "watchdog":
      return "Stopped by the service's safety check.";
    case "provider":
      return "The provider stopped or lost the machine.";
    case "manager":
      return `Stopped by ${withArticle(labels.manager)}.`;
    case "projectEnded":
      return `Stopped because the ${labels.project} ended.`;
  }
}

export function refusalText(reason: QuoteRefusal, labels: ProjectLabels): string {
  switch (reason) {
    case "allocationTooLow":
      return "Not enough allocation left to start.";
    case "priceCap":
      return `Over the ${labels.project}'s price limit.`;
    case "noCapacity":
      return "No capacity right now. Try another type or try again soon.";
    case "policy":
      return `Not allowed in this ${labels.project}.`;
    case "projectEnded":
      return `The ${labels.project} has ended.`;
    case "projectNotStarted":
      return `The ${labels.project} hasn't started yet.`;
    case "concurrencyCap":
      return "Too many machines running. Stop one first.";
  }
}

export interface MachineActions {
  openTerminal: boolean;
  openJupyter: boolean;
  save: boolean;
  stop: boolean;
  restart: boolean;
  delete: boolean;
}

/** Which buttons a machine shows. The server still decides; these avoid offering what it would refuse. */
export function machineActions(m: Machine): MachineActions {
  const running = m.state === "running";
  return {
    openTerminal: running && m.terminalAvailable,
    openJupyter: running && m.jupyterAvailable,
    save: running && m.save.state !== "saving",
    stop: m.state === "starting" || running || m.state === "failed",
    restart: m.state === "stopped",
    delete: m.state === "stopped" || m.state === "failed",
  };
}

/** Whole percent of a save, 0..100; null when no save is in progress. */
export function savePercent(m: Machine): number | null {
  const p = m.save.progress;
  if (p == null) return null;
  if (p.bytesTotal <= 0) return 100;
  return Math.max(0, Math.min(100, Math.floor((p.bytesDone * 100) / p.bytesTotal)));
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1024-based, one decimal from KB up: "512 B", "1.5 GB". */
export function formatBytes(bytes: number): string {
  if (!(bytes >= 0)) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

export interface MeterView {
  band: MeterBand;
  /** Width of the used part of the bar, whole percent 0..100. */
  usedPercent: number;
  used: string;
  remaining: string;
  allocation: string;
  /** Held back for the final save of running machines, or null when nothing is held. */
  reserved: string | null;
  /** "provider $0.48/h + service $0.14/h = $0.62/h", or null when nothing is running. */
  rate: string | null;
  /** "about 3 h 20 min left at $0.62/h", or null when nothing is running. */
  timeLeft: string | null;
  storage: string;
}

export function meterView(meter: SpendMeter): MeterView {
  const m = computeMeter({
    allocation: meter.amount,
    spent: meter.spent.total,
    reserved: meter.reserved,
    ratePerHour: meter.currentRatePerHour.total,
  });
  const rate = meter.currentRatePerHour;
  const running = rate.total > 0;
  return {
    band: m.band,
    usedPercent: Math.round((1 - m.fractionLeft) * 100),
    used: formatUsd(meter.spent.total),
    remaining: formatUsd(m.remaining),
    allocation: formatUsd(meter.amount),
    reserved: meter.reserved > 0 ? formatUsd(meter.reserved) : null,
    rate: running ? formatPriceSplit(rate.providerCost, rate.margin) : null,
    timeLeft: running && m.secondsLeft != null ? `about ${formatDuration(m.secondsLeft)} left at ${formatRate(rate.total)}` : null,
    storage: `${formatBytes(meter.storage.usedBytes)} of ${formatBytes(meter.storage.quotaBytes)}`,
  };
}

/** "3 min ago", "just now", "2 h ago": for the meter's asOf and last-saved times. */
export function ago(iso: string, nowMs: number): string {
  const seconds = Math.floor((nowMs - Date.parse(iso)) / 1000);
  if (!(seconds >= 60)) return "just now";
  return `${formatDuration(seconds)} ago`;
}
