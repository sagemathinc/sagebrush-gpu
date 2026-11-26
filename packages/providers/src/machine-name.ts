// The provider-side name of a machine (the orphan/credential-pause contract, section 1a, SEC
// design clear): `sbg-<installation>-<machine>-<incarnation>`, in `[a-z0-9-]` only and at most 46
// characters, which fits every provider's limit. It carries this deployment's installation slug,
// the machine id's 20-character body (without `mch_`) and the launch's incarnation, so the
// watchdog and the orphan sweep map a provider machine to exactly one launch of exactly one
// deployment. Anything that doesn't parse isn't ours.
//
// The builder refuses rather than truncates; the parse is its exact inverse, and strict.

import { isId, type MachineId, type ParsedMachineName } from "@sbgpu/api";

const PREFIX = "sbg-";
/** A deployment's installation slug: fixed per deployment, from config, never from request input. */
const INSTALLATION = /^[a-z0-9]{4,8}$/;
/** 1 to 12 decimal digits; no leading zero unless the whole field is "0". */
const INCARNATION = /^(?:0|[1-9][0-9]{0,11})$/;

/** The largest incarnation a name can carry. */
export const MAX_NAME_INCARNATION = 999_999_999_999;
/** The longest name: "sbg-" + 8 + "-" + 20 + "-" + 12. */
export const MAX_MACHINE_NAME_LENGTH = 46;

export type { ParsedMachineName };

/** Whether a string is a well-formed installation slug. */
export function isInstallation(x: unknown): x is string {
  return typeof x === "string" && INSTALLATION.test(x);
}

/**
 * The name of a machine's launch. Throws (never truncates) for an installation slug outside
 * `[a-z0-9]{4,8}`, a non-`mch_` id, or an incarnation that isn't an integer in 0..10^12 - 1. The
 * messages are fixed: they never echo the input.
 */
export function machineName(installation: string, machineId: MachineId, incarnation: number): string {
  if (!isInstallation(installation)) throw new RangeError("not an installation slug");
  if (!isId("machine", machineId)) throw new RangeError("not a machine id");
  if (!Number.isSafeInteger(incarnation) || incarnation < 0 || incarnation > MAX_NAME_INCARNATION) throw new RangeError("not a nameable incarnation");
  return `${PREFIX}${installation}-${machineId.slice("mch_".length)}-${incarnation}`;
}

/**
 * The exact inverse of machineName, or null: exactly `sbg-` and three fields separated by single
 * `-`; the installation `[a-z0-9]{4,8}`; the body exactly what, with `mch_` re-added, is a
 * machine id (20 characters of the id alphabet); the incarnation canonical decimal (1 to 12 digits, no
 * leading zero but "0" itself).
 */
export function parseMachineName(name: unknown): ParsedMachineName | null {
  if (typeof name !== "string" || name.length > MAX_MACHINE_NAME_LENGTH || !name.startsWith(PREFIX)) return null;
  const fields = name.slice(PREFIX.length).split("-");
  if (fields.length !== 3) return null;
  const [installation, body, incarnation] = fields as [string, string, string];
  if (!INSTALLATION.test(installation) || !INCARNATION.test(incarnation)) return null;
  const machineId = `mch_${body}`;
  if (!isId("machine", machineId)) return null;
  return { installation, machineId, incarnation: Number(incarnation) };
}

/** Whether a launch spec's name is the name of exactly its own machine and incarnation. */
export function specNameMatches(spec: { name: string; machineId: MachineId; incarnation: number }): boolean {
  const p = parseMachineName(spec.name);
  return p !== null && p.machineId === spec.machineId && p.incarnation === spec.incarnation;
}

/** Whether a parsed name is exactly the given name's triple. */
export function sameMachineName(parsed: ParsedMachineName | null, name: string): boolean {
  const p = parseMachineName(name);
  return parsed !== null && p !== null && parsed.installation === p.installation && parsed.machineId === p.machineId && parsed.incarnation === p.incarnation;
}

/** A provider-side name's two status fields: the parsed triple, and its machine (both null unless it parses). */
export function nameFields(name: unknown): { machineId: MachineId | null; parsedName: ParsedMachineName | null } {
  const parsedName = parseMachineName(name);
  return { machineId: parsedName?.machineId ?? null, parsedName };
}
