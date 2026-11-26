// Tokens. Two families:
//
// - The BOOT token is opaque: 32 random bytes, base64url (43 characters), single use,
//   stored only as its SHA-256 in a control-plane row bound to the provider instance.
//   It becomes exchangeable when the provider first reports the instance running and
//   expires 120 s later; the first exchange wins, and any reuse is refused and alerted.
// - SIGNED tokens (agent, workspace, page, jupyter-link, restore) carry the claims below.
//   Every verifier runs validateClaims, a closed validator: exact key sets, version, kind,
//   ids, times and per-kind lifetime caps. The machine-scoped kinds are then compared
//   with the machine's current state (machineTokenStateOk), so a copied token dies when
//   its machine stops or restarts. A restore token is scoped to one restore operation
//   instead (single use, by its jti, at the storage gateway). Encoding and signatures
//   (Ed25519) belong to the control plane.
//
// Browser sessions and email sign-in links are not tokens here: they are random values
// the control plane stores (hashed) in D1, so they can be revoked.

import { isId, type MachineId, type MemberId, type ProjectId, type SnapshotId, type TeamId } from "./ids.ts";
import type { MachineState } from "./objects.ts";
import type { ProviderId } from "./providers.ts";
import type { IsoTime } from "./time.ts";

// ---------------------------------------------------------------- boot token

/** 32 random bytes, base64url without padding. */
export const BOOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** From the provider's first "running" report (SEC: at most 120 s). */
export const BOOT_TOKEN_TTL_SECONDS = 120;

export function isBootTokenShape(x: unknown): x is string {
  return typeof x === "string" && BOOT_TOKEN_PATTERN.test(x);
}

/** The control plane's row for one boot token. */
export interface BootTokenRecord {
  /** Lowercase hex SHA-256 of the token; the token itself is never stored. */
  tokenSha256: string;
  machineId: MachineId;
  incarnation: number;
  provider: ProviderId;
  /** The provider's instance id, bound when the launch returns it; null until then. */
  providerMachineId: string | null;
  /** Null until the provider first reports the instance running. */
  firstRunningAt: IsoTime | null;
  /** firstRunningAt + BOOT_TOKEN_TTL_SECONDS; null (not exchangeable) until then. */
  expiresAt: IsoTime | null;
  usedAt: IsoTime | null;
}

export const BOOT_EXCHANGE_REFUSALS = ["used", "notRunningYet", "expired", "unbound", "instanceMismatch"] as const;
export type BootExchangeRefusal = (typeof BOOT_EXCHANGE_REFUSALS)[number];

/**
 * Whether a boot token row may be exchanged now by an agent reporting
 * `providerMachineId`. "used" must also alert and terminate (someone copied the token).
 */
export function bootExchange(
  row: BootTokenRecord,
  providerMachineId: string | null,
  nowMs: number,
): { ok: true } | { ok: false; reason: BootExchangeRefusal } {
  if (row.usedAt !== null) return { ok: false, reason: "used" };
  if (row.providerMachineId === null) return { ok: false, reason: "unbound" };
  if (row.firstRunningAt === null || row.expiresAt === null) return { ok: false, reason: "notRunningYet" };
  const exp = Date.parse(row.expiresAt);
  const first = Date.parse(row.firstRunningAt);
  // A row whose window is malformed, empty, inverted or longer than the cap counts as
  // expired. The window is first <= now < exp, with 0 < exp - first <= the cap. (A NaN
  // now fails now < exp.)
  if (!Number.isFinite(exp) || !Number.isFinite(first)) return { ok: false, reason: "expired" };
  if (!(exp - first > 0) || exp - first > BOOT_TOKEN_TTL_SECONDS * 1000 || !(nowMs < exp)) {
    return { ok: false, reason: "expired" };
  }
  if (nowMs < first) return { ok: false, reason: "notRunningYet" };
  if (providerMachineId !== row.providerMachineId) return { ok: false, reason: "instanceMismatch" };
  return { ok: true };
}

// ---------------------------------------------------------------- signed tokens

export const TOKEN_KINDS = ["agent", "workspace", "page", "jupyter-link", "restore"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** Lifetime caps, in seconds: a token with exp - iat above its cap is invalid. */
export const TOKEN_TTL_SECONDS = {
  agent: 60 * 60,
  workspace: 15 * 60,
  page: 60,
  "jupyter-link": 60,
  /** And control mints it to end at least the clock skew before its claim's lease does (snapshots r3.1, 4.3). */
  restore: 60,
} as const satisfies Record<TokenKind, number>;

/** Allowed clock skew for iat in the future. */
export const TOKEN_CLOCK_SKEW_SECONDS = 30;

/** 16 random bytes, base64url. */
export const JTI_PATTERN = /^[A-Za-z0-9_-]{22}$/;

interface CommonClaims {
  v: 1;
  kind: TokenKind;
  /** Unique token id; single-use tokens are refused (and alerted on) when seen twice. */
  jti: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
}

/** The machine-scoped kinds' claims. */
interface BaseClaims extends CommonClaims {
  mch: MachineId;
  /** The machine's incarnation when issued; a stop or restart makes the token dead. */
  inc: number;
}

/** From enroll; refreshed through heartbeats. */
export interface AgentClaims extends BaseClaims {
  kind: "agent";
}

/** Writable grants carry their own quota, so member and team quotas stay separate. */
export type WorkspaceGrant =
  | { area: "member" | "team"; mode: "rw"; quotaBytes: number }
  | { area: "member" | "team" | "project-data"; mode: "ro" };
export type WorkspaceArea = WorkspaceGrant["area"];

/**
 * normal: periodic and on-demand saves, while the machine runs.
 * final-save: only while the machine is saving before a stop; writes go only to one
 * save (snapshot) in one area, up to maxBytes, and every grant is read-only.
 */
export type WorkspaceMode =
  | { kind: "normal" }
  | { kind: "final-save"; saveId: SnapshotId; area: "member" | "team"; maxBytes: number };

/** For the storage gateway. It derives every R2 key prefix from these claims. */
export interface WorkspaceClaims extends BaseClaims {
  kind: "workspace";
  mbr: MemberId;
  prj: ProjectId;
  team: TeamId | null;
  grants: WorkspaceGrant[];
  mode: WorkspaceMode;
}

/** For the browser's relay connection to one machine; single use. */
export interface PageClaims extends BaseClaims {
  kind: "page";
  mbr: MemberId;
}

/** A one-time code in a Jupyter link, on the machine's own origin. */
export interface JupyterLinkClaims extends BaseClaims {
  kind: "jupyter-link";
  mbr: MemberId;
}

/** The deployment a restore token is for: a gateway refuses one minted for another. */
export const DEPLOY_ENVS = ["production", "staging", "local"] as const;
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

export function isDeployEnv(x: unknown): x is DeployEnv {
  return typeof x === "string" && (DEPLOY_ENVS as readonly string[]).includes(x);
}

/** A restore operation's id: 16 random bytes, base64url (as control's area_restores.op_id). */
export const RESTORE_OP_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** The one area a restore token may write: a member's own, or a team's. */
export type RestoreArea = { kind: "member"; mbr: MemberId } | { kind: "team"; team: TeamId };

/**
 * For the storage gateway's restore mode (snapshots r3.1, 4.3 and 4.4): one restore of one
 * snapshot into one area of one project, by one member, onto the HEAD control read after its
 * claim. Single use (the gateway consumes the jti before anything else), and not machine-scoped.
 * A member area's restore is its own member's (actor = mbr); a team area's actor is a member of
 * that team, which control checks when it mints.
 */
export interface RestoreClaims extends CommonClaims {
  kind: "restore";
  env: DeployEnv;
  prj: ProjectId;
  area: RestoreArea;
  /** The operation, carried into the restore manifest so reconciliation can recognise it. */
  op: string;
  actor: MemberId;
  /** The snapshot restored. */
  snap: SnapshotId;
  /** HEAD as control read it after the claim; the gateway's compare-and-swap expects exactly this. */
  expectedHead: SnapshotId;
}

/** The gateway's key prefix for a restore token's area: prj/<prj>/m/<mbr> or prj/<prj>/t/<team>, from the claims only. */
export function restoreAreaPrefix(c: RestoreClaims): string {
  return c.area.kind === "member" ? `prj/${c.prj}/m/${c.area.mbr}` : `prj/${c.prj}/t/${c.area.team}`;
}

export type TokenClaims = AgentClaims | WorkspaceClaims | PageClaims | JupyterLinkClaims | RestoreClaims;
/** The kinds machineTokenStateOk judges. */
export type MachineTokenClaims = Exclude<TokenClaims, RestoreClaims>;
export type ClaimsOf<K extends TokenKind> = Extract<TokenClaims, { kind: K }>;

export function isTokenKind(x: unknown): x is TokenKind {
  return typeof x === "string" && (TOKEN_KINDS as readonly string[]).includes(x);
}

const COMMON_KEYS = ["v", "kind", "jti", "iat", "exp"];
const BASE_KEYS = [...COMMON_KEYS, "mch", "inc"];
const KEYS: Record<TokenKind, string[]> = {
  agent: BASE_KEYS,
  workspace: [...BASE_KEYS, "mbr", "prj", "team", "grants", "mode"],
  page: [...BASE_KEYS, "mbr"],
  "jupyter-link": [...BASE_KEYS, "mbr"],
  restore: [...COMMON_KEYS, "env", "prj", "area", "op", "actor", "snap", "expectedHead"],
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

const isCount = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const isPositive = (x: unknown): x is number => isCount(x) && x > 0;

function grantError(g: unknown, team: unknown, seen: Set<string>): string | null {
  if (!isPlainObject(g)) return "grant is not an object";
  if (g.mode === "rw") {
    if (!hasExactKeys(g, ["area", "mode", "quotaBytes"])) return "rw grant keys";
    if (g.area !== "member" && g.area !== "team") return "rw grant area";
    if (!isPositive(g.quotaBytes)) return "rw grant quotaBytes";
  } else if (g.mode === "ro") {
    if (!hasExactKeys(g, ["area", "mode"])) return "ro grant keys";
    if (g.area !== "member" && g.area !== "team" && g.area !== "project-data") return "ro grant area";
  } else {
    return "grant mode";
  }
  if (g.area === "team" && team === null) return "team grant without a team";
  if (seen.has(g.area as string)) return "duplicate grant area";
  seen.add(g.area as string);
  return null;
}

function workspaceError(o: Record<string, unknown>): string | null {
  if (!isId("member", o.mbr)) return "mbr";
  if (!isId("project", o.prj)) return "prj";
  if (o.team !== null && !isId("team", o.team)) return "team";
  if (!Array.isArray(o.grants) || o.grants.length === 0 || o.grants.length > 3) return "grants";
  const seen = new Set<string>();
  for (const g of o.grants) {
    const e = grantError(g, o.team, seen);
    if (e) return e;
  }
  const mode = o.mode;
  if (!isPlainObject(mode)) return "mode";
  if (mode.kind === "normal") {
    if (!hasExactKeys(mode, ["kind"])) return "mode keys";
  } else if (mode.kind === "final-save") {
    if (!hasExactKeys(mode, ["kind", "saveId", "area", "maxBytes"])) return "mode keys";
    if (!isId("snapshot", mode.saveId)) return "saveId";
    if (mode.area !== "member" && mode.area !== "team") return "final-save area";
    if (mode.area === "team" && o.team === null) return "final-save to a team without a team";
    if (!isPositive(mode.maxBytes)) return "maxBytes";
    if ((o.grants as Array<{ mode: string }>).some((g) => g.mode !== "ro")) return "final-save token with a writable grant";
  } else {
    return "mode kind";
  }
  return null;
}

function restoreError(o: Record<string, unknown>): string | null {
  if (!isDeployEnv(o.env)) return "env";
  if (!isId("project", o.prj)) return "prj";
  const area = o.area;
  if (!isPlainObject(area)) return "area";
  if (area.kind === "member") {
    if (!hasExactKeys(area, ["kind", "mbr"]) || !isId("member", area.mbr)) return "area";
  } else if (area.kind === "team") {
    if (!hasExactKeys(area, ["kind", "team"]) || !isId("team", area.team)) return "area";
  } else {
    return "area";
  }
  if (typeof o.op !== "string" || !RESTORE_OP_PATTERN.test(o.op)) return "op";
  if (!isId("member", o.actor)) return "actor";
  if (area.kind === "member" && o.actor !== area.mbr) return "another member's area";
  if (!isId("snapshot", o.snap)) return "snap";
  if (!isId("snapshot", o.expectedHead)) return "expectedHead";
  return null;
}

export type ClaimsCheck<K extends TokenKind> = { ok: true; claims: ClaimsOf<K> } | { ok: false; reason: string };

/**
 * The closed validator for decoded, signature-checked claims: accepts exactly the claims
 * language above for `kind`, usable at `nowSeconds`, and nothing else.
 */
export function validateClaims<K extends TokenKind>(x: unknown, kind: K, nowSeconds: number): ClaimsCheck<K> {
  const fail = (reason: string): ClaimsCheck<K> => ({ ok: false, reason });
  if (!isTokenKind(kind)) return fail("unknown expected kind");
  if (!Number.isSafeInteger(nowSeconds)) return fail("now");
  if (!isPlainObject(x)) return fail("not an object");
  if (x.kind !== kind) return fail("kind");
  if (!hasExactKeys(x, KEYS[kind])) return fail("keys");
  if (x.v !== 1) return fail("version");
  if (typeof x.jti !== "string" || !JTI_PATTERN.test(x.jti)) return fail("jti");
  if (!isCount(x.iat) || !isCount(x.exp)) return fail("times");
  if (!(x.iat < x.exp)) return fail("iat >= exp");
  if (x.exp - x.iat > TOKEN_TTL_SECONDS[kind]) return fail("lifetime over the cap");
  if (x.iat > nowSeconds + TOKEN_CLOCK_SKEW_SECONDS) return fail("issued in the future");
  if (!(nowSeconds < x.exp)) return fail("expired");
  if (kind === "restore") {
    const e = restoreError(x);
    return e ? fail(e) : { ok: true, claims: x as unknown as ClaimsOf<K> };
  }
  if (!isId("machine", x.mch)) return fail("mch");
  if (!isCount(x.inc)) return fail("inc");
  if (kind === "page" || kind === "jupyter-link") {
    if (!isId("member", x.mbr)) return fail("mbr");
  }
  if (kind === "workspace") {
    const e = workspaceError(x);
    if (e) return fail(e);
  }
  return { ok: true, claims: x as unknown as ClaimsOf<K> };
}

/**
 * Whether machine-scoped claims still match the machine: same incarnation, and a state
 * in which this kind of token may act. Ordinary workspace tokens stop working the moment
 * the final save begins; final-save tokens work only during it.
 */
export function machineTokenStateOk(claims: MachineTokenClaims, machine: { id: MachineId; state: MachineState; incarnation: number }): boolean {
  if (claims.mch !== machine.id || claims.inc !== machine.incarnation) return false;
  switch (claims.kind) {
    case "agent":
      return machine.state === "starting" || machine.state === "running" || machine.state === "saving";
    case "workspace":
      return claims.mode.kind === "final-save" ? machine.state === "saving" : machine.state === "running";
    case "page":
    case "jupyter-link":
      return machine.state === "running";
  }
}
