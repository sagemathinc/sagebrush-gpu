// Workspace saves (snapshots) as the project page shows them: one row per save, the words for
// each kind, the check of a name before it is sent, and when the page offers a restore. The
// server has the last word on all of it (snapshots.ts's refusals).

import { SNAPSHOT_NAME_MAX, isSnapshotName, type ListSnapshotsResponse, type Machine, type ProjectLabels, type Snapshot, type SnapshotKind } from "@sbgpu/api";
import { ago, formatBytes } from "./view.ts";

/** What made each kind of save. */
export const KIND_WORDS: { readonly [K in SnapshotKind]: string } = {
  periodic: "Saved automatically",
  manual: "Saved on request",
  final: "Saved when the machine stopped",
  restore: "Restored",
};

export interface SaveRow {
  id: string;
  when: string;
  createdAt: string;
  kind: string;
  size: string;
  name: string | null;
  current: boolean;
  /** For a restore: when the save it restored was made, if that save is still listed. */
  restoredFrom: string | null;
}

/** The rows of one area's list, newest first (as listed), with the words the page shows. */
export function saveRows(items: readonly Snapshot[], nowMs: number): SaveRow[] {
  const byId = new Map(items.map((s) => [s.id, s]));
  return items.map((s) => {
    const from = s.restoredFrom == null ? null : byId.get(s.restoredFrom);
    return {
      id: s.id,
      when: ago(s.createdAt, nowMs),
      createdAt: s.createdAt,
      kind: s.kind === "restore" && from ? `Restored from the save of ${ago(from.createdAt, nowMs)}` : KIND_WORDS[s.kind],
      size: formatBytes(s.bytes),
      name: s.name,
      current: s.current,
      restoredFrom: s.restoredFrom,
    };
  });
}

/** Machines in these states write their areas (r3.1: a restore waits until none does). */
const WRITING: ReadonlySet<Machine["state"]> = new Set(["starting", "running", "saving", "stopping"]);

/**
 * Whether the page offers a restore: only when none of the caller's own machines writes their
 * areas. (A teammate's machine writing the team's area isn't listed here: the server refuses
 * that restore with its own words.)
 */
export function canRestore(machines: readonly Machine[]): boolean {
  return !machines.some((m) => WRITING.has(m.state));
}

/** The words shown instead of the restore buttons while a machine writes the area. */
export function restoreBlockedText(labels: ProjectLabels): string {
  return `To restore a save, stop your machines first: a running machine keeps writing to your workspace and your ${labels.team}'s.`;
}

/** The confirmation before a restore. */
export function restoreConfirmText(row: SaveRow): string {
  const which = row.name ? `"${row.name}" (saved ${row.when})` : `the save from ${row.when}`;
  return `Restore ${which}? It becomes your current workspace. Nothing is deleted: the current save stays in the list, so you can restore it again.`;
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/**
 * A name as the page will send it: trimmed, 1 to 64 characters, no control characters, not
 * another save's in the area, and within the project's limit of named saves (a rename doesn't
 * count again). `selfId` is the save being named, or null for a new save.
 */
export function checkSaveName(text: string, list: ListSnapshotsResponse, selfId: string | null): NameCheck {
  const name = text.trim();
  if (!isSnapshotName(name)) return { ok: false, reason: `A name has 1 to ${SNAPSHOT_NAME_MAX} characters, with no control characters.` };
  const others = list.items.filter((s) => s.id !== selfId && s.name != null);
  if (others.some((s) => s.name === name)) return { ok: false, reason: "Another save here already has that name." };
  const self = selfId == null ? null : list.items.find((s) => s.id === selfId);
  if (self?.name == null && others.length >= list.namedMax) {
    return { ok: false, reason: `This workspace already has ${list.namedMax} named ${list.namedMax === 1 ? "save" : "saves"}, the most allowed. Remove a name first.` };
  }
  return { ok: true, name };
}
