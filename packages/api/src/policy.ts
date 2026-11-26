// Validation of a project's policy and display labels: one closed definition the control
// plane enforces and the UI's forms can check against before sending. Every field has an
// explicit bound; unknown fields are refused.

import { LOCALITY_PRESETS, type LocalityPreset, type ProjectLabels, type ProjectPolicy } from "./objects.ts";
import { PROVIDER_IDS, isGpuTypeId, isProviderId } from "./providers.ts";

/** The bounds of each numeric policy field, inclusive. */
export const POLICY_BOUNDS = {
  maxPricePerHour: [0, 1_000_000_000], // up to $1000 per hour
  maxConcurrentMachines: [0, 1000],
  maxMachinesPerMember: [0, 16],
  idleStopMinutes: [5, 24 * 60],
  maxSessionMinutes: [15, 7 * 24 * 60],
  minStartMinutes: [1, 24 * 60],
  finalSaveReserveMinutes: [0, 24 * 60],
  storageQuotaBytesPerMember: [0, 1024 ** 4], // up to 1 TiB
  storageQuotaBytesPerTeam: [0, 1024 ** 4],
  snapshotKeepLast: [1, 50],
  snapshotNamedMax: [0, 20],
} as const satisfies Partial<Record<keyof ProjectPolicy, readonly [number, number]>>;

export const MAX_POLICY_LIST = 64;
export const MAX_SETUP_SCRIPT_LENGTH = 16 * 1024;
export const MAX_LABEL_LENGTH = 40;
const COUNTRY = /^[A-Z]{2}$/;
const POLICY_KEYS = new Set<keyof ProjectPolicy>([
  "allowedGpuTypes",
  "allowedProviders",
  "locality",
  "allowedCountries",
  "maxPricePerHour",
  "maxConcurrentMachines",
  "maxMachinesPerMember",
  "idleStopMinutes",
  "maxSessionMinutes",
  "minStartMinutes",
  "finalSaveReserveMinutes",
  "setupScript",
  "storageQuotaBytesPerMember",
  "storageQuotaBytesPerTeam",
  "snapshotKeepLast",
  "snapshotNamedMax",
]);

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

function distinctList<T>(x: unknown, max: number, each: (v: unknown) => v is T): T[] | null {
  if (!Array.isArray(x) || x.length > max || !x.every(each)) return null;
  return new Set(x).size === x.length ? (x as T[]) : null;
}

/**
 * A partial policy, as a create or update request sends it: every present field valid,
 * no unknown field. Absent fields keep their current (or default) values.
 */
export function validatePolicyPatch(x: unknown): Checked<Partial<ProjectPolicy>> {
  if (!isPlainObject(x)) return { ok: false, reason: "policy must be an object" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (!POLICY_KEYS.has(k as keyof ProjectPolicy)) return { ok: false, reason: `unknown policy field: ${k}` };
    const key = k as keyof ProjectPolicy;
    if (key in POLICY_BOUNDS) {
      const [lo, hi] = POLICY_BOUNDS[key as keyof typeof POLICY_BOUNDS];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) return { ok: false, reason: `${k} must be a whole number from ${lo} to ${hi}` };
    } else if (key === "allowedGpuTypes") {
      if (!distinctList(v, MAX_POLICY_LIST, isGpuTypeId)) return { ok: false, reason: `allowedGpuTypes: at most ${MAX_POLICY_LIST} distinct GPU types` };
    } else if (key === "allowedProviders") {
      if (!distinctList(v, PROVIDER_IDS.length, isProviderId)) return { ok: false, reason: "allowedProviders: distinct known providers" };
    } else if (key === "locality") {
      if (typeof v !== "string" || !(LOCALITY_PRESETS as readonly string[]).includes(v)) return { ok: false, reason: "locality: a known preset" };
    } else if (key === "allowedCountries") {
      const isCountry = (c: unknown): c is string => typeof c === "string" && COUNTRY.test(c);
      if (v !== null && !distinctList(v, MAX_POLICY_LIST, isCountry)) return { ok: false, reason: "allowedCountries: null, or distinct ISO 3166 alpha-2 codes" };
    } else if (key === "setupScript") {
      if (v !== null && (typeof v !== "string" || v.length > MAX_SETUP_SCRIPT_LENGTH)) return { ok: false, reason: `setupScript: null, or a string of at most ${MAX_SETUP_SCRIPT_LENGTH} characters` };
    }
    out[k] = v;
  }
  return { ok: true, value: out as Partial<ProjectPolicy> };
}

/** A whole policy: the base with a validated patch over it. */
export function mergePolicy(base: Readonly<ProjectPolicy>, patch: Partial<ProjectPolicy>): ProjectPolicy {
  return { ...base, ...patch };
}

const LABEL_KEYS = ["project", "member", "manager", "assistant", "team"] as const;

/** Display labels: null, or exactly the five words, each 1 to 40 characters with no surrounding spaces. */
export function validateLabels(x: unknown): Checked<ProjectLabels | null> {
  if (x === null) return { ok: true, value: null };
  if (!isPlainObject(x)) return { ok: false, reason: "labels must be an object or null" };
  // exactly five keys, each of which the loop below requires
  if (Object.keys(x).length !== LABEL_KEYS.length) {
    return { ok: false, reason: `labels has exactly: ${LABEL_KEYS.join(", ")}` };
  }
  for (const k of LABEL_KEYS) {
    const v = x[k];
    if (typeof v !== "string" || v.length < 1 || v.length > MAX_LABEL_LENGTH || v.trim() !== v) {
      return { ok: false, reason: `labels.${k}: 1 to ${MAX_LABEL_LENGTH} characters, no surrounding spaces` };
    }
  }
  return { ok: true, value: x as unknown as ProjectLabels };
}

export type { LocalityPreset };
