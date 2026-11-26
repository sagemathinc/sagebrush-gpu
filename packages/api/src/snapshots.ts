// Workspace snapshots (contract r3.1, SEC DESIGN CLEAR): the saves of a member's or a team's
// workspace area, kept as the newest snapshotKeepLast unnamed ones (the current one among them when
// it is unnamed) plus every named one, and restored by writing a new snapshot.
//
// - Storage is the machine design's (5.1): content-addressed chunks, immutable manifests and a
//   HEAD only the storage gateway writes, by compare-and-swap. Control never stores which
//   snapshot is current: `current` is derived from the gateway's HEAD when listing.
// - A caller acts only on their own member area and their own current team's area. Control
//   derives the concrete area from current membership; the request's `area` only chooses
//   between the two. A snapshot outside that area is notFound, as one that doesn't exist.
// - A restore deletes nothing: it writes a new `restore` snapshot (now current) whose files are
//   the target's, so another restore undoes it. It needs no recent reauthentication.
// - A restore claims its area (one live claim per area, in control's area_restores) only while
//   no machine writes there, and a machine can't start into an area with a live claim. The
//   writers of an area are the machines whose area keys, pinned at `starting`, name it.

import { isId, type MachineId, type MemberId, type ProjectId, type SnapshotId, type TeamId } from "./ids.ts";
import type { ApiErrorBody, ErrorCode } from "./errors.ts";
import type { IsoTime } from "./time.ts";

export const SNAPSHOT_KINDS = ["periodic", "manual", "final", "restore"] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

/** Which of the caller's two areas: their own, or their current team's. */
export const SNAPSHOT_AREAS = ["member", "team"] as const;
export type SnapshotArea = (typeof SNAPSHOT_AREAS)[number];

export interface Snapshot {
  id: SnapshotId;
  area: SnapshotArea;
  createdAt: IsoTime;
  kind: SnapshotKind;
  bytes: number;
  /** Set when named: a named snapshot is kept until unnamed (within snapshotNamedMax). */
  name: string | null;
  /** The machine that wrote it; null for a restore. */
  machineId: MachineId | null;
  /** Derived from the area's HEAD at listing time (the gateway's), never stored in control. */
  current: boolean;
  /** For a restore: the snapshot it restored. */
  restoredFrom: SnapshotId | null;
}

export interface ListSnapshotsResponse {
  items: Snapshot[];
  keepLast: number;
  namedMax: number;
}

/** PUT .../snapshots/:snapshotId/name: a name, or null to unname. */
export interface NameSnapshotRequest {
  area: SnapshotArea;
  name: string | null;
}

/** POST .../snapshots/:snapshotId/restore. */
export interface RestoreSnapshotRequest {
  area: SnapshotArea;
}

/** POST /v1/machines/:machineId/save: a name for the snapshot this save produces. */
export interface SaveMachineRequest {
  name?: string;
}

export function isSnapshotKind(x: unknown): x is SnapshotKind {
  return typeof x === "string" && (SNAPSHOT_KINDS as readonly string[]).includes(x);
}

export function isSnapshotArea(x: unknown): x is SnapshotArea {
  return x === "member" || x === "team";
}

/** A name's most characters (code points). */
export const SNAPSHOT_NAME_MAX = 64;

// control characters, lone surrogates, and the line and paragraph separators
const NOT_PRINTABLE = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;

/** 1 to 64 printable characters, no control characters, trimmed; unique within an area (the handler's check). */
export function isSnapshotName(x: unknown): x is string {
  if (typeof x !== "string" || x.trim() !== x) return false;
  const n = [...x].length;
  return n >= 1 && n <= SNAPSHOT_NAME_MAX && !NOT_PRINTABLE.test(x);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

/** No key but these. (A missing one is refused by its own value's check.) */
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/** The name route's body, exactly: { area, name } with a valid name or null; null otherwise. */
export function parseNameSnapshotRequest(x: unknown): NameSnapshotRequest | null {
  if (!isPlainObject(x) || !onlyKeys(x, ["area", "name"])) return null;
  if (!isSnapshotArea(x.area) || (x.name !== null && !isSnapshotName(x.name))) return null;
  return { area: x.area, name: x.name };
}

/** The restore route's body, exactly: { area }; null otherwise. */
export function parseRestoreSnapshotRequest(x: unknown): RestoreSnapshotRequest | null {
  if (!isPlainObject(x) || !onlyKeys(x, ["area"]) || !isSnapshotArea(x.area)) return null;
  return { area: x.area };
}

/** The save route's body: {} or { name } with a valid name; null otherwise. */
export function parseSaveMachineRequest(x: unknown): SaveMachineRequest | null {
  if (!isPlainObject(x) || !onlyKeys(x, ["name"])) return null;
  if (!Object.hasOwn(x, "name")) return {};
  return isSnapshotName(x.name) ? { name: x.name } : null;
}

// ---------------------------------------------------------------- area keys

/**
 * An area's key in control: `m:<prj>:<mbr>` for a member's, `t:<prj>:<team>` for a team's.
 * Machines pin theirs at `starting` (member_area_key, team_area_key), and a restore claims one.
 */
export type AreaKey = string;

export function memberAreaKey(projectId: ProjectId, memberId: MemberId): AreaKey {
  if (!isId("project", projectId) || !isId("member", memberId)) throw new RangeError("a member area needs a project id and a member id");
  return `m:${projectId}:${memberId}`;
}

export function teamAreaKey(projectId: ProjectId, teamId: TeamId): AreaKey {
  if (!isId("project", projectId) || !isId("team", teamId)) throw new RangeError("a team area needs a project id and a team id");
  return `t:${projectId}:${teamId}`;
}

export function isAreaKey(x: unknown): x is AreaKey {
  if (typeof x !== "string") return false;
  const [kind, prj, holder, ...rest] = x.split(":");
  if (rest.length > 0 || !isId("project", prj)) return false;
  return (kind === "m" && isId("member", holder)) || (kind === "t" && isId("team", holder));
}

// ---------------------------------------------------------------- restore

/** A claim's states: claimed, then exactly one of the others, one way. */
export const RESTORE_STATES = ["claimed", "done", "failed", "expired"] as const;
export type RestoreState = (typeof RESTORE_STATES)[number];

/** A restore claim's lease, from the claim. */
export const RESTORE_LEASE_MS = 120_000;
/** A restore token's longest life. */
export const RESTORE_TOKEN_MAX_TTL_MS = 60_000;
/** The clock skew allowed (N2): a token's exp plus this is never past its claim's lease. */
export const RESTORE_CLOCK_SKEW_MS = 30_000;

/** A restore token's exp, ms: min(now + 60 s, the lease's end - 30 s). Null when that isn't after now. */
export function restoreTokenExpMs(nowMs: number, claimedMs: number): number | null {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(claimedMs)) return null;
  const exp = Math.min(nowMs + RESTORE_TOKEN_MAX_TTL_MS, claimedMs + RESTORE_LEASE_MS - RESTORE_CLOCK_SKEW_MS);
  return exp > nowMs ? exp : null;
}

// ---------------------------------------------------------------- refusals

/** The snapshot routes' refusals, each with fixed words. */
export const SNAPSHOT_REFUSALS = Object.freeze({
  badRequest: {
    code: "badRequest",
    message: "That request isn't one this page sends. Reload the page and try again.",
  },
  badName: {
    code: "badRequest",
    message: "A save's name is 1 to 64 characters, with no control characters and no spaces at either end.",
  },
  notFound: {
    code: "notFound",
    message: "There's no such save in this workspace.",
  },
  nameTaken: {
    code: "conflict",
    message: "Another save in this workspace already has that name.",
  },
  tooManyNamed: {
    code: "quotaExceeded",
    message: "This workspace already has as many named saves as the project allows. Unname one first.",
  },
  restoreInProgress: {
    code: "conflict",
    message: "A restore of this workspace is already in progress.",
  },
  writerRunning: {
    code: "invalidState",
    message: "Stop the machine that's using this workspace first.",
  },
  startDuringRestore: {
    code: "invalidState",
    message: "A restore of this workspace is in progress. Try again in a moment.",
  },
  headMoved: {
    code: "conflict",
    message: "The workspace changed during the restore, so nothing was restored.",
  },
} as const satisfies Record<string, { code: ErrorCode; message: string }>);
export type SnapshotRefusal = keyof typeof SNAPSHOT_REFUSALS;

export function snapshotRefusalBody(refusal: SnapshotRefusal): ApiErrorBody {
  const { code, message } = SNAPSHOT_REFUSALS[refusal];
  return { error: { code, message } };
}
