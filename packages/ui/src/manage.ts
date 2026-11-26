// The manager's view of a project, as pure functions: the members table's rows, filtering
// and sorting, bulk allocation plans and the invite preview. The page only lays these out.

import { ACCRUING_STATES, type Machine, type Member, type Micros, type Project, type SpendMeter, type Team } from "@sbgpu/api";
import { parseInviteList } from "./emails.ts";
import { computeMeter, type MeterBand } from "./meter.ts";

export interface MemberRow {
  memberId: string;
  email: string;
  name: string | null;
  role: Member["role"];
  status: Member["status"];
  teamId: string | null;
  team: string | null;
  allocation: Micros;
  spent: Micros;
  remaining: Micros;
  band: MeterBand;
  running: number;
  storageBytes: number;
  /** Their storage quota, from their meter; null when they have no meter yet. */
  storageQuotaBytes: number | null;
}

/** One row per member who hasn't been removed, joined with their meter, team and machines. */
export function memberRows(members: readonly Member[], meters: readonly SpendMeter[], machines: readonly Machine[], teams: readonly Team[]): MemberRow[] {
  const meterOf = new Map(meters.map((m) => [m.allocationId, m]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const running = new Map<string, number>();
  for (const m of machines) {
    if (ACCRUING_STATES.includes(m.state)) running.set(m.memberId, (running.get(m.memberId) ?? 0) + 1);
  }
  return members
    .filter((m) => m.status !== "removed")
    .map((m) => {
      const meter = meterOf.get(m.allocationId);
      const allocation = meter?.amount ?? 0;
      const spent = meter?.spent.total ?? 0;
      const view = computeMeter({ allocation, spent, reserved: meter?.reserved ?? 0, ratePerHour: meter?.currentRatePerHour.total ?? 0 });
      return {
        memberId: m.id,
        email: m.email,
        name: m.name,
        role: m.role,
        status: m.status,
        teamId: m.teamId,
        team: m.teamId ? (teamName.get(m.teamId) ?? null) : null,
        allocation,
        spent,
        remaining: view.remaining,
        band: view.band,
        running: running.get(m.id) ?? 0,
        storageBytes: meter?.storage.usedBytes ?? 0,
        storageQuotaBytes: meter?.storage.quotaBytes ?? null,
      };
    });
}

/** Rows whose email, name or team contains every word of the query (case-insensitive). */
export function filterRows(rows: readonly MemberRow[], query: string): MemberRow[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  return rows.filter((r) => {
    const hay = [r.email, r.name ?? "", r.team ?? "", r.role, r.status].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export type SortKey = "email" | "name" | "team" | "allocation" | "spent" | "remaining" | "running";

/** A stable sort by one column; ties keep email order. Missing names and teams sort last. */
export function sortRows(rows: readonly MemberRow[], key: SortKey, descending = false): MemberRow[] {
  const dir = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    let c = 0;
    if (key === "email" || key === "name" || key === "team") {
      const x = a[key];
      const y = b[key];
      if (x == null && y != null) return 1; // missing always last, whatever the direction
      if (y == null && x != null) return -1;
      if (x != null && y != null) c = dir * x.localeCompare(y);
    } else {
      c = dir * (a[key] - b[key]);
    }
    return c !== 0 ? c : a.email.localeCompare(b.email);
  });
}

export interface AllocationChange {
  memberId: string;
  email: string;
  from: Micros;
  to: Micros;
}

export interface BulkPlan {
  changes: AllocationChange[];
  /** The change in the project's total allocation. */
  delta: Micros;
  /** Budget not yet allocated, after the plan; negative means the server will refuse. */
  headroomAfter: Micros;
}

/**
 * Set every selected member's allocation to `amount`, or add `amount` to it. Members whose
 * allocation wouldn't change are left out.
 */
export function bulkPlan(rows: readonly MemberRow[], selected: ReadonlySet<string>, mode: "set" | "add", amount: Micros, project: Pick<Project, "budget" | "allocated">): BulkPlan {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError(`amount must be non-negative micros, got ${amount}`);
  const changes: AllocationChange[] = [];
  for (const r of rows) {
    if (!selected.has(r.memberId)) continue;
    const to = mode === "set" ? amount : r.allocation + amount;
    if (to !== r.allocation) changes.push({ memberId: r.memberId, email: r.email, from: r.allocation, to });
  }
  const delta = changes.reduce((sum, c) => sum + (c.to - c.from), 0);
  return { changes, delta, headroomAfter: project.budget - project.allocated - delta };
}

export interface InvitePreview {
  /** New to the project, lowercased, once each, in the order pasted. */
  toInvite: string[];
  /** Already members (they'd just be returned as they are). */
  already: string[];
  duplicates: string[];
  invalid: string[];
}

export function invitePreview(text: string, existing: readonly Member[]): InvitePreview {
  const list = parseInviteList(text);
  const present = new Set(existing.filter((m) => m.status !== "removed").map((m) => m.email.toLowerCase()));
  return {
    toInvite: list.valid.filter((e) => !present.has(e)),
    already: list.valid.filter((e) => present.has(e)),
    duplicates: list.duplicates,
    invalid: list.invalid,
  };
}

/** "fine-tuning-lab-spend-by-member-2027-02-01.csv": a safe, descriptive download name. */
export function csvFilename(projectName: string, by: string, isoDate: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
  return `${slug}-spend-by-${by}-${isoDate.slice(0, 10)}.csv`;
}

// ---------------------------------------------------------------- teams

/** Mirrors the control plane's limit on a team name (after trimming). */
export const MAX_TEAM_NAME_LENGTH = 100;

export interface TeamRow {
  teamId: string;
  name: string;
  memberCount: number;
  allocation: Micros;
  spent: Micros;
  remaining: Micros;
  band: MeterBand;
  /** Machines running (or starting, or saving) on the team's allocation. */
  running: number;
}

/** One row per team, by name, joined with its allocation's meter and running machines. */
export function teamRows(teams: readonly Team[], meters: readonly SpendMeter[], machines: readonly Machine[]): TeamRow[] {
  const meterOf = new Map(meters.map((m) => [m.allocationId, m]));
  const running = new Map<string, number>();
  for (const m of machines) {
    if (ACCRUING_STATES.includes(m.state)) running.set(m.allocationId, (running.get(m.allocationId) ?? 0) + 1);
  }
  return [...teams]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => {
      const meter = meterOf.get(t.allocationId);
      const allocation = meter?.amount ?? 0;
      const spent = meter?.spent.total ?? 0;
      const view = computeMeter({ allocation, spent, reserved: meter?.reserved ?? 0, ratePerHour: meter?.currentRatePerHour.total ?? 0 });
      return {
        teamId: t.id,
        name: t.name,
        memberCount: t.memberCount,
        allocation,
        spent,
        remaining: view.remaining,
        band: view.band,
        running: running.get(t.allocationId) ?? 0,
      };
    });
}

/**
 * A team name as the control plane compares names for uniqueness: its index is on
 * SQLite's lower(name), which folds A-Z only (D1 has no ICU), so "Équipe" and "équipe"
 * are different names there, and here.
 */
export function teamNameKey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * A team name as typed, checked as the control plane will: trimmed, 1 to 100 characters,
 * and not another of the project's teams' name in any letter case (`self` is the team
 * being renamed, which may change its own name's case).
 */
export function checkTeamName(text: string, teams: readonly Team[], self: string | null = null): { ok: true; name: string } | { ok: false; reason: string } {
  const name = text.trim();
  if (name.length < 1 || name.length > MAX_TEAM_NAME_LENGTH) return { ok: false, reason: `A name has 1 to ${MAX_TEAM_NAME_LENGTH} characters.` };
  const clash = teams.find((t) => t.id !== self && teamNameKey(t.name) === teamNameKey(name));
  if (clash) return { ok: false, reason: `There's already one called ${clash.name}.` };
  return { ok: true, name };
}
