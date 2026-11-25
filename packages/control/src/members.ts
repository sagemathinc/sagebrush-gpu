// Members of a project and their allocations: list, invite, change, remove, and set an
// allocation. The contract's authz rules decide who may do what; the database's triggers
// (migrations/0003) keep the two invariants whatever the order of concurrent requests:
// allocations stay within the project budget, and the last active owner stays.

import {
  canInvite,
  canRemoveMember,
  canUpdateMember,
  isNonNegativeMicros,
  newId,
  PROJECT_ROLES,
  toIso,
  type Allocation,
  type Member,
  type MembershipDecision,
  type ProjectRole,
} from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import { D1_MAX_BOUND_PARAMETERS, chunks, type Db, type Stmt } from "./db.ts";
import { HttpError, json } from "./http.ts";
import { normalizeEmail } from "./validate.ts";

/** At most this many rows in one invitation request. */
export const MAX_INVITES_PER_REQUEST = 500;
/** Members per page of listMembers. */
export const MEMBERS_PAGE_SIZE = 200;
export const MAX_NAME_LENGTH = 200;

interface MemberRow {
  id: string;
  project_id: string;
  user_id: string | null;
  email: string;
  name: string | null;
  role: ProjectRole;
  status: Member["status"];
  team_id: string | null;
  allocation_id: string;
  created_ms: number;
}

const MEMBER_SELECT = `SELECT m.id, m.project_id, m.user_id, m.email, m.name, m.role, m.status, m.team_id, a.id AS allocation_id, m.created_ms
  FROM members m JOIN allocations a ON a.project_id = m.project_id AND a.holder_kind = 'member' AND a.holder_id = m.id`;

function toMember(r: MemberRow): Member {
  return {
    id: r.id,
    projectId: r.project_id,
    userId: r.user_id,
    email: r.email,
    name: r.name,
    role: r.role,
    status: r.status,
    teamId: r.team_id,
    allocationId: r.allocation_id,
    createdAt: toIso(r.created_ms),
  };
}

/** The database refused a write because of an invariant: say which, as a conflict. */
function asConflict(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("over-allocation")) throw new HttpError("conflict", "allocations would exceed the project budget");
  if (msg.includes("last-owner")) throw new HttpError("conflict", "a project keeps at least one active owner");
  if (msg.includes("UNIQUE") && msg.includes("members.")) throw new HttpError("conflict", "already a member of this project");
  if (msg.includes("team:")) throw new HttpError("badRequest", "no such team in this project");
  throw e;
}

async function batchOrConflict(db: Db, stmts: Stmt[]): Promise<void> {
  try {
    await db.batch(stmts);
  } catch (e) {
    asConflict(e);
  }
}

function decide(d: MembershipDecision): void {
  if (d.ok) return;
  if (d.reason === "lastOwner") throw new HttpError("conflict", "a project keeps at least one active owner");
  if (d.reason === "forbidden") throw new HttpError("forbidden", "your role doesn't allow this");
  throw new HttpError("badRequest", "invalid role");
}

async function loadMember(db: Db, projectId: string, memberId: string): Promise<MemberRow> {
  const r = await db.all<MemberRow>(`${MEMBER_SELECT} WHERE m.project_id = ? AND m.id = ?`, [projectId, memberId]);
  if (!r[0]) throw new HttpError("notFound", "no such member");
  return r[0];
}

/**
 * The owner count authz needs: the project's other active owners, plus the target. (authz
 * reads it only when the target is an owner. It is a fast path: the members_keep_an_owner
 * trigger is the authority and refuses the same changes, so both end in the same conflict.)
 */
async function ownerCountFor(db: Db, target: MemberRow): Promise<number> {
  const r = await db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM members WHERE project_id = ? AND role = 'owner' AND status = 'active' AND id <> ?`,
    [target.project_id, target.id],
  );
  return (r[0]?.n ?? 0) + 1;
}

const isRole = (x: unknown): x is ProjectRole => typeof x === "string" && (PROJECT_ROLES as readonly string[]).includes(x);

function optionalName(x: unknown): string | null {
  if (x === undefined || x === null) return null;
  if (typeof x !== "string" || x.length > MAX_NAME_LENGTH) throw new HttpError("badRequest", `a name is a string of at most ${MAX_NAME_LENGTH} characters`);
  return x.trim() || null;
}

/** A team id, null for none, or undefined when absent. (The database checks it is a live team of the project.) */
function teamId(x: unknown): string | null | undefined {
  // (an unknown id is refused by the database; a non-string couldn't even be bound)
  if (x === undefined || x === null) return x;
  if (typeof x !== "string") throw new HttpError("badRequest", "teamId is a team id or null");
  return x;
}

export const MEMBER_HANDLERS: Handlers = {
  async listMembers(ctx: Ctx) {
    const projectId = ctx.params.projectId as string;
    const cursor = ctx.query.get("cursor");
    // ?teamId= lists one team's members (removed ones excluded), with the same paging
    const team = ctx.query.get("teamId");
    const rows = await ctx.deps.db.all<MemberRow>(
      team === null
        ? `${MEMBER_SELECT} WHERE m.project_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`
        : `${MEMBER_SELECT} WHERE m.project_id = ? AND m.team_id = ? AND m.status <> 'removed' AND m.id > ? ORDER BY m.id LIMIT ?`,
      team === null ? [projectId, cursor ?? "", MEMBERS_PAGE_SIZE + 1] : [projectId, team, cursor ?? "", MEMBERS_PAGE_SIZE + 1],
    );
    const items = rows.slice(0, MEMBERS_PAGE_SIZE).map(toMember);
    const next = rows.length > MEMBERS_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null;
    return json(200, { items, next });
  },

  async inviteMembers(ctx: Ctx) {
    const { db, now } = ctx.deps;
    const projectId = ctx.params.projectId as string;
    const list = ctx.body.members;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_INVITES_PER_REQUEST) {
      throw new HttpError("badRequest", `members must be a list of 1 to ${MAX_INVITES_PER_REQUEST} invitations`);
    }
    const t = now();
    const seen = new Set<string>();
    const rows: Array<{ id: string; email: string; name: string | null; role: ProjectRole; allocation: number; team: string | null }> = [];
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null) throw new HttpError("badRequest", "each invitation is an object");
      const o = raw as Record<string, unknown>;
      const email = normalizeEmail(o.email);
      if (!email) throw new HttpError("badRequest", "each invitation needs a valid email address");
      if (seen.has(email)) throw new HttpError("badRequest", `${email} is listed twice`);
      seen.add(email);
      const role = o.role === undefined ? "member" : o.role;
      if (!isRole(role)) throw new HttpError("badRequest", "invalid role");
      decide(canInvite(ctx.projectRole as ProjectRole, role));
      const team = teamId(o.teamId) ?? null;
      const allocation = o.allocation === undefined ? 0 : o.allocation;
      if (!isNonNegativeMicros(allocation)) throw new HttpError("badRequest", "an allocation is a non-negative whole number of micro-dollars");
      rows.push({ id: newId("member"), email, name: optionalName(o.name), role, allocation, team });
    }
    const stmts: Stmt[] = [];
    for (const r of rows) {
      // A person who already has an account joins as active; others when they sign in.
      stmts.push({
        sql: `INSERT INTO members (id, project_id, user_id, email, name, role, status, team_id, created_ms)
              SELECT ?, ?, u.id, ?, ?, ?, CASE WHEN u.id IS NULL THEN 'invited' ELSE 'active' END, ?, ?
              FROM (SELECT (SELECT id FROM users WHERE email = ?) AS id) u`,
        params: [r.id, projectId, r.email, r.name, r.role, r.team, t, r.email],
      });
      stmts.push({
        sql: `INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', ?, ?, ?)`,
        params: [newId("allocation"), projectId, r.id, r.allocation, t],
      });
    }
    await batchOrConflict(db, stmts);
    // Read the new members back in chunks: one parameter for the project, the rest ids,
    // so no statement passes D1's bound-parameter cap (500 invites would be 501).
    const members: MemberRow[] = [];
    for (const ids of chunks(rows.map((r) => r.id), D1_MAX_BOUND_PARAMETERS - 1)) {
      members.push(
        ...(await db.all<MemberRow>(`${MEMBER_SELECT} WHERE m.project_id = ? AND m.id IN (${ids.map(() => "?").join(",")})`, [projectId, ...ids])),
      );
    }
    members.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    return json(200, { members: members.map(toMember) });
  },

  async updateMember(ctx: Ctx) {
    const { db } = ctx.deps;
    const target = await loadMember(db, ctx.params.projectId as string, ctx.params.memberId as string);
    if (target.status === "removed") throw new HttpError("invalidState", "this member was removed");
    const b = ctx.body;
    // (an invalid role is refused by authz as badInput)
    const role = b.role === undefined ? undefined : (b.role as ProjectRole);
    const team = teamId(b.teamId);
    const name = b.name === undefined ? undefined : optionalName(b.name);
    decide(canUpdateMember(ctx.projectRole as ProjectRole, target.role, role, await ownerCountFor(db, target)));
    await batchOrConflict(db, [
      {
        sql: `UPDATE members SET role = COALESCE(?, role), name = CASE WHEN ? THEN ? ELSE name END,
                team_id = CASE WHEN ? THEN ? ELSE team_id END WHERE id = ?`,
        params: [role ?? null, name === undefined ? 0 : 1, name ?? null, team === undefined ? 0 : 1, team ?? null, target.id],
      },
    ]);
    return json(200, toMember(await loadMember(db, target.project_id, target.id)));
  },

  async removeMember(ctx: Ctx) {
    const { db } = ctx.deps;
    const target = await loadMember(db, ctx.params.projectId as string, ctx.params.memberId as string);
    if (target.status === "removed") throw new HttpError("invalidState", "this member was already removed");
    decide(canRemoveMember(ctx.projectRole as ProjectRole, target.role, await ownerCountFor(db, target)));
    await batchOrConflict(db, [
      { sql: `UPDATE members SET status = 'removed' WHERE id = ?`, params: [target.id] },
    ]);
    return json(200, { ok: true });
  },

  async setMemberAllocation(ctx: Ctx) {
    const { db, now } = ctx.deps;
    const target = await loadMember(db, ctx.params.projectId as string, ctx.params.memberId as string);
    const amount = ctx.body.amount;
    if (!isNonNegativeMicros(amount)) throw new HttpError("badRequest", "amount is a non-negative whole number of micro-dollars");
    await batchOrConflict(db, [
      { sql: `UPDATE allocations SET amount = ?, updated_ms = ? WHERE id = ?`, params: [amount, now(), target.allocation_id] },
    ]);
    const a = await db.all<{ id: string; project_id: string; amount: number; updated_ms: number }>(
      `SELECT id, project_id, amount, updated_ms FROM allocations WHERE id = ?`,
      [target.allocation_id],
    );
    const row = a[0]!;
    const out: Allocation = {
      id: row.id,
      projectId: row.project_id,
      holder: { kind: "member", memberId: target.id },
      amount: row.amount,
      updatedAt: toIso(row.updated_ms),
    };
    return json(200, out);
  },
};
