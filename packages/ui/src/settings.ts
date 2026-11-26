// The project settings form: the project's name, its display words and its policy as the
// strings a form edits, and back into the smallest update request. Only the fields whose
// value differs from the form as it was first filled are sent (spacing alone is no change), so a field someone else changed
// meanwhile is left alone unless it was edited here too. @sbgpu/api's validatePolicyPatch
// and validateLabels have the last word, as they do on the server.

import {
  MAX_GPUS_PER_TEAM,
  MAX_LABEL_LENGTH,
  MAX_SETUP_SCRIPT_LENGTH,
  POLICY_BOUNDS,
  PROVIDER_IDS,
  validateLabels,
  validatePolicyPatch,
  type Checked,
  type LocalityPreset,
  type Project,
  type ProjectLabels,
  type ProjectPolicy,
  type ProviderId,
  type UpdateProjectRequest,
} from "@sbgpu/api";
import { GENERIC_LABELS, type LabelKey } from "./labels.ts";
import { MICRO_PER_USD, parseUsd } from "./money.ts";

/** Mirrors the control plane's limit on a project name (after trimming). */
export const MAX_PROJECT_NAME_LENGTH = 200;
const GIB = 1024 ** 3;

export const WHOLE_FIELDS = [
  "maxConcurrentMachines",
  "maxMachinesPerMember",
  "idleStopMinutes",
  "maxSessionMinutes",
  "minStartMinutes",
  "finalSaveReserveMinutes",
  "snapshotKeepLast",
  "snapshotNamedMax",
] as const;
export type WholeField = (typeof WHOLE_FIELDS)[number];
export const GIB_FIELDS = ["storageQuotaBytesPerMember", "storageQuotaBytesPerTeam"] as const;
export type GibField = (typeof GIB_FIELDS)[number];

/** What each policy field is called on the form (and in its error messages). */
export const FIELD_NAMES: { readonly [K in keyof ProjectPolicy]: string } = {
  allowedGpuTypes: "GPU types allowed",
  allowedProviders: "Providers allowed",
  locality: "Where machines may run",
  allowedCountries: "Only these countries",
  maxPricePerHour: "Highest price per hour",
  maxConcurrentMachines: "Machines running at once, in all",
  maxMachinesPerMember: "Machines running at once, per person",
  maxGpusPerTeam: "GPUs running at once, per team",
  idleStopMinutes: "Stop when idle for (minutes)",
  maxSessionMinutes: "Longest session (minutes)",
  minStartMinutes: "Least running time a start must afford (minutes)",
  finalSaveReserveMinutes: "Time held back for the final save (minutes)",
  setupScript: "Setup script",
  storageQuotaBytesPerMember: "Storage per person (GiB)",
  storageQuotaBytesPerTeam: "Storage per team (GiB)",
  snapshotKeepLast: "Saves kept per workspace, besides named ones",
  snapshotNamedMax: "Named saves per workspace, at most",
};

export interface SettingsForm {
  name: string;
  /** Off: the generic words (labels null). */
  customLabels: boolean;
  labels: ProjectLabels;
  /** Comma- or space-separated GPU type ids. */
  allowedGpuTypes: string;
  allowedProviders: ProviderId[];
  locality: LocalityPreset;
  /** Comma- or space-separated country codes; empty for no extra restriction. */
  allowedCountries: string;
  /** Dollars. */
  maxPricePerHour: string;
  whole: Record<WholeField, string>;
  /** Empty for the team's member count (one GPU per member). */
  maxGpusPerTeam: string;
  /** GiB. */
  gib: Record<GibField, string>;
  /** Empty for none. */
  setupScript: string;
}

/** Micro-USD as exact dollars, with at least two decimals: 2_500_000 -> "2.50". */
export function microToDollars(micro: number): string {
  const whole = Math.floor(micro / MICRO_PER_USD);
  const frac = String(micro % MICRO_PER_USD).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}

export function settingsForm(project: Project): SettingsForm {
  const p = project.policy;
  return {
    name: project.name,
    customLabels: project.labels !== null,
    labels: { ...(project.labels ?? GENERIC_LABELS) },
    allowedGpuTypes: p.allowedGpuTypes.join(", "),
    allowedProviders: [...p.allowedProviders],
    locality: p.locality,
    allowedCountries: (p.allowedCountries ?? []).join(", "),
    maxPricePerHour: microToDollars(p.maxPricePerHour),
    whole: Object.fromEntries(WHOLE_FIELDS.map((k) => [k, String(p[k])])) as Record<WholeField, string>,
    maxGpusPerTeam: p.maxGpusPerTeam === null ? "" : String(p.maxGpusPerTeam),
    gib: Object.fromEntries(GIB_FIELDS.map((k) => [k, String(p[k] / GIB)])) as Record<GibField, string>,
    setupScript: p.setupScript ?? "",
  };
}

const words = (s: string): string[] => s.split(/[\s,]+/).filter((w) => w !== "");
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

function labelsValue(form: SettingsForm): ProjectLabels | null {
  if (!form.customLabels) return null;
  const out = {} as ProjectLabels;
  for (const k of Object.keys(GENERIC_LABELS) as LabelKey[]) out[k] = form.labels[k].trim();
  return out;
}

/**
 * The update request for what changed between `base` (the form as first filled) and
 * `form`: an empty request when nothing did, or the first problem, in the form's words.
 */
export function settingsRequest(form: SettingsForm, base: SettingsForm): Checked<UpdateProjectRequest> {
  const req: UpdateProjectRequest = {};
  if (form.name.trim() !== base.name.trim()) {
    const name = form.name.trim();
    if (name.length < 1 || name.length > MAX_PROJECT_NAME_LENGTH) return { ok: false, reason: `Name: 1 to ${MAX_PROJECT_NAME_LENGTH} characters` };
    req.name = name;
  }

  const labels = labelsValue(form);
  if (JSON.stringify(labels) !== JSON.stringify(labelsValue(base))) {
    if (!validateLabels(labels).ok) return { ok: false, reason: `Words: each 1 to ${MAX_LABEL_LENGTH} characters` };
    req.labels = labels;
  }

  const policy: Partial<ProjectPolicy> = {};
  if (!sameList(words(form.allowedGpuTypes), words(base.allowedGpuTypes))) policy.allowedGpuTypes = words(form.allowedGpuTypes);
  if (!sameSet(form.allowedProviders, base.allowedProviders)) {
    policy.allowedProviders = PROVIDER_IDS.filter((id) => form.allowedProviders.includes(id));
  }
  if (form.locality !== base.locality) policy.locality = form.locality;
  const codes = words(form.allowedCountries).map((c) => c.toUpperCase());
  if (!sameList(codes, words(base.allowedCountries))) {
    policy.allowedCountries = codes.length === 0 ? null : codes;
  }
  if (form.maxPricePerHour.trim() !== base.maxPricePerHour) {
    const micro = parseUsd(form.maxPricePerHour);
    const [lo, hi] = POLICY_BOUNDS.maxPricePerHour;
    if (micro === null || micro < lo || micro > hi) {
      return { ok: false, reason: `${FIELD_NAMES.maxPricePerHour}: a dollar amount from $${lo / MICRO_PER_USD} to $${hi / MICRO_PER_USD}` };
    }
    policy.maxPricePerHour = micro;
  }
  for (const k of WHOLE_FIELDS) {
    const text = form.whole[k].trim();
    if (text === base.whole[k]) continue;
    const n = Number(text);
    const [lo, hi] = POLICY_BOUNDS[k];
    if (!/^\d+$/.test(text) || n < lo || n > hi) return { ok: false, reason: `${FIELD_NAMES[k]}: a whole number from ${lo} to ${hi}` };
    policy[k] = n;
  }
  const teamGpus = form.maxGpusPerTeam.trim();
  if (teamGpus !== base.maxGpusPerTeam) {
    if (teamGpus !== "" && (!/^\d+$/.test(teamGpus) || Number(teamGpus) > MAX_GPUS_PER_TEAM)) {
      return { ok: false, reason: `${FIELD_NAMES.maxGpusPerTeam}: empty for one per member, or a whole number from 0 to ${MAX_GPUS_PER_TEAM}` };
    }
    policy.maxGpusPerTeam = teamGpus === "" ? null : Number(teamGpus);
  }
  for (const k of GIB_FIELDS) {
    const text = form.gib[k].trim();
    if (text === base.gib[k]) continue;
    const bytes = Math.round(Number(text) * GIB);
    const [lo, hi] = POLICY_BOUNDS[k];
    if (!/^\d+(\.\d+)?$/.test(text) || bytes < lo || bytes > hi) return { ok: false, reason: `${FIELD_NAMES[k]}: a number from ${lo / GIB} to ${hi / GIB}` };
    policy[k] = bytes;
  }
  const script = form.setupScript.trim() === "" ? null : form.setupScript;
  if (script !== (base.setupScript === "" ? null : base.setupScript)) {
    if (script !== null && script.length > MAX_SETUP_SCRIPT_LENGTH) {
      return { ok: false, reason: `${FIELD_NAMES.setupScript}: at most ${MAX_SETUP_SCRIPT_LENGTH} characters` };
    }
    policy.setupScript = script;
  }

  if (Object.keys(policy).length > 0) {
    // The lists' own rules (known ids, distinct, how many): the contract's words.
    const checked = validatePolicyPatch(policy);
    if (!checked.ok) {
      const key = /^\w+/.exec(checked.reason)?.[0] ?? "";
      const name = (FIELD_NAMES as Record<string, string>)[key];
      return { ok: false, reason: name === undefined ? checked.reason : name + checked.reason.slice(key.length) };
    }
    req.policy = checked.value;
  }
  return { ok: true, value: req };
}
