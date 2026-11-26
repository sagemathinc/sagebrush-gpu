// What the screens show and allow, as pure functions of API objects, so the decisions
// are tested without a DOM. Components only lay these out.

import type { BillingMode, Machine, ProjectLabels, ProviderId, ProviderPause, QuoteRefusal, SpendMeter, StopReason } from "@sbgpu/api";
import { MACHINE_DOMAIN } from "./config.ts";
import { withArticle } from "./labels.ts";
import { computeMeter, formatDuration, type MeterBand } from "./meter.ts";
import { formatPriceSplit, formatRate, formatUsd } from "./money.ts";
import { PROVIDER_NAMES } from "./providers.ts";

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

/** Why a quote can't start; a "credentialUnusable" refusal names its provider when the quote does. */
export function refusalText(reason: QuoteRefusal, labels: ProjectLabels, provider?: ProviderId): string {
  switch (reason) {
    case "allocationTooLow":
      return "Not enough allocation left to start.";
    case "priceCap":
      return `Over the ${labels.project}'s price limit.`;
    case "credentialUnusable":
      return provider
        ? `Launches on ${PROVIDER_NAMES[provider]} are paused: the organization's key for it isn't working.`
        : "Launches are paused: the organization's provider key isn't working.";
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

/** A refused start or restart for a paused provider: its name, or the API's own words without one. */
export function pausedStartText(provider: ProviderId | undefined, apiMessage: string): string {
  return provider ? `Launches on ${PROVIDER_NAMES[provider]} are paused for this organization until its key works again.` : apiMessage;
}

const PAUSE_REASON_WORDS: Readonly<Record<NonNullable<ProviderPause["detail"]>["status"], string>> = Object.freeze({
  rejected: "was refused by the provider",
  revoked: "was revoked at the provider",
  error: "couldn't be checked",
});

/**
 * A paused provider's banner. Everyone sees that launches are paused, and since when; the
 * reason (the key's status and last check) only when `showReason` (manager and above) AND the
 * server sent it. The server already leaves it out for everyone else; the screen doesn't rely
 * on that.
 */
export function pauseView(pause: ProviderPause, showReason: boolean, nowMs: number): { headline: string; since: string; reason: string | null } {
  const name = PROVIDER_NAMES[pause.provider];
  const detail = showReason ? pause.detail : undefined;
  return {
    headline: `Launches on ${name} are paused for this organization. Machines already running keep running.`,
    since: `Paused ${ago(pause.since, nowMs)}.`,
    reason: detail
      ? `The organization's ${name} key ${PAUSE_REASON_WORDS[detail.status]}; ${detail.lastCheckedAt ? `last checked ${ago(detail.lastCheckedAt, nowMs)}` : "not checked since"}.`
      : null,
  };
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
  /** How full the storage is: "near" from 90% of the quota, "full" at or over it. */
  storageLevel: StorageLevel;
}

export type StorageLevel = "ok" | "near" | "full";

/** From this fraction of the quota, storage is "near" full. */
export const STORAGE_NEAR_FRACTION = 0.9;

/** At or over the quota is "full" (so is a quota of 0: there is no room); from 90% of it, "near". */
export function storageLevel(usedBytes: number, quotaBytes: number): StorageLevel {
  if (!(quotaBytes > 0) || usedBytes >= quotaBytes) return "full";
  return usedBytes >= STORAGE_NEAR_FRACTION * quotaBytes ? "near" : "ok";
}

/** What the member's meter says about it; null while there is room. */
export function storageWarning(level: StorageLevel, labels: ProjectLabels): string | null {
  if (level === "near") return `Storage is nearly full. Delete files you don't need, or ask ${withArticle(labels.manager)} to raise the limit.`;
  if (level === "full") return `Storage is full: your workspace can't grow until you delete files or ${withArticle(labels.manager)} raises the limit.`;
  return null;
}

export function meterView(meter: SpendMeter, mode: BillingMode = "resold"): MeterView {
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
    rate: running ? formatPriceSplit(rate.providerCost, rate.margin, mode) : null,
    timeLeft: running && m.secondsLeft != null ? `about ${formatDuration(m.secondsLeft)} left at ${formatRate(rate.total)}` : null,
    storage: `${formatBytes(meter.storage.usedBytes)} of ${formatBytes(meter.storage.quotaBytes)}`,
    storageLevel: storageLevel(meter.storage.usedBytes, meter.storage.quotaBytes),
  };
}

/** "3 min ago", "just now", "2 h ago": for the meter's asOf and last-saved times. */
export function ago(iso: string, nowMs: number): string {
  const seconds = Math.floor((nowMs - Date.parse(iso)) / 1000);
  if (!(seconds >= 60)) return "just now";
  return `${formatDuration(seconds)} ago`;
}

/**
 * The machine's Jupyter link, or null if it isn't one to open: it must parse as an
 * absolute https URL with no user info and no port, on exactly the machine's own host,
 * m-<machine id>.<machine domain> (the trusted build-time MACHINE_DOMAIN), so the one-time
 * code goes only to the machine relay's per-machine origin, never to the UI's or anyone else's.
 */
export function jupyterUrl(raw: unknown, machineId: string, machineDomain: string = MACHINE_DOMAIN): string | null {
  if (typeof raw !== "string" || machineDomain === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (url.hostname !== `m-${machineId}.${machineDomain}`.toLowerCase()) return null;
  return url.href;
}
