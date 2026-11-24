// Ids are a kind prefix, an underscore and 20 lowercase base-32 characters,
// e.g. "mch_7f3k9q2m4x8z1c5v6b0n". Providers tag machines with them, so they stay
// short and use only [0-9a-z_].

export const ID_PREFIXES = {
  org: "org",
  project: "prj",
  member: "mbr",
  team: "team",
  user: "usr",
  allocation: "alc",
  machine: "mch",
  ledgerEntry: "led",
  snapshot: "snp",
  command: "cmd",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export type OrgId = string;
export type ProjectId = string;
export type MemberId = string;
export type TeamId = string;
export type UserId = string;
export type AllocationId = string;
export type MachineId = string;
export type LedgerEntryId = string;
export type SnapshotId = string;
export type CommandId = string;

export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base 32, lowercase
export const ID_RANDOM_LENGTH = 20; // 100 bits

const BODY = `[${ID_ALPHABET}]{${ID_RANDOM_LENGTH}}`;
const PATTERNS = Object.fromEntries(
  Object.entries(ID_PREFIXES).map(([kind, prefix]) => [kind, new RegExp(`^${prefix}_${BODY}$`)]),
) as Record<IdKind, RegExp>;

export function isId(kind: IdKind, x: unknown): x is string {
  return typeof x === "string" && PATTERNS[kind].test(x);
}

/** The kind of an id, or null if it is not a well-formed id of any kind. */
export function idKind(x: unknown): IdKind | null {
  if (typeof x !== "string") return null;
  for (const kind of Object.keys(PATTERNS) as IdKind[]) {
    if (PATTERNS[kind].test(x)) return kind;
  }
  return null;
}

/** A fresh random id. 256 is a multiple of 32, so `byte % 32` is uniform. */
export function newId(kind: IdKind): string {
  const bytes = new Uint8Array(ID_RANDOM_LENGTH);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const b of bytes) body += ID_ALPHABET[b % 32];
  return `${ID_PREFIXES[kind]}_${body}`;
}
