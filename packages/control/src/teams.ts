// Teams of a project: list, create, change (name, members), delete, and set the team's
// allocation. A member belongs to at most one team. The database (migrations/0005) keeps
// a member's team a live team of its project, caps a project at 200 live teams, and keeps
// deleted teams on record without members.

import { isNonNegativeMicros, newId, projectRoleAtLeast, toIso, type Allocation, type ProjectRole, type Team } from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import { D1_MAX_BOUND_PARAMETERS, chunks, type Db, type Stmt } from "./db.ts";
import { HttpError, json } from "./http.ts";

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** Statements that put the given members in `teamId`, each within D1's parameter cap. */
function joinTeam(teamId: string, projectId: string, ids: string[]): Stmt[] {
  return chunks(ids, ID_CHUNK).map((part) => ({
    sql: `UPDATE members SET team_id = ? WHERE project_id = ? AND id IN (${placeholders(part.length)})`,
    params: [teamId, projectId, ...part],
  }));
}

export const MAX_TEAMS_PER_PROJECT = 200;
export const MAX_TEAM_NAME_LENGTH = 100;
export const MAX_TEAM_MEMBERS_PER_REQUEST = 500;

interface TeamRow {
  id: string;
  project_id: string;
  name: string;
  created_ms: number;
  allocation_id: string;
}

const TEAM_SELECT = `SELECT t.id, t.project_id, t.name, t.created_ms, a.id AS allocation_id
  FROM teams t JOIN allocations a ON a.project_id = t.project_id AND a.holder_kind = 'team' AND a.holder_id = t.id`;

/** Ids per IN-list, leaving room for a statement's other parameters (D1 allows 100 in all). */
const ID_CHUNK = D1_MAX_BOUND_PARAMETERS - 2;

async function toTeams(db: Db, rows: TeamRow[]): Promise<Team[]> {
  const members: Array<{ id: string; team_id: string }> = [];
  for (const ids of chunks(rows.map((r) => r.id), ID_CHUNK)) {
    members.push(
      ...(await db.all<{ id: string; team_id: string }>(
        `SELECT id, team_id FROM members WHERE team_id IN (${placeholders(ids.length)}) AND status <> 'removed'`,
        ids,
      )),
    );
  }
  members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    memberIds: members.filter((m) => m.team_id === r.id).map((m) => m.id),
    allocationId: r.allocation_id,
    createdAt: toIso(r.created_ms),
  }));
}

async function loadTeam(db: Db, projectId: string, teamId: string): Promise<TeamRow> {
  const r = await db.all<TeamRow>(`${TEAM_SELECT} WHERE t.project_id = ? AND t.id = ? AND t.deleted_ms IS NULL`, [projectId, teamId]);
  if (!r[0]) throw new HttpError("notFound", "no such team");
  return r[0];
}

/** The database refused a write because of an invariant: say which. */
export function teamWriteError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("over-allocation")) throw new HttpError("conflict", "allocations would exceed the project budget");
  if (msg.includes("team-cap")) throw new HttpError("conflict", `a project has at most ${MAX_TEAMS_PER_PROJECT} teams`);
  if (msg.includes("teams_live_name")) throw new HttpError("conflict", "a team with that name exists");
  // the team was deleted between the check and the write
  if (msg.includes("team:")) throw new HttpError("conflict", "the team was deleted");
  throw e;
}

async function batch(db: Db, stmts: Stmt[]): Promise<void> {
  try {
    await db.batch(stmts);
  } catch (e) {
    teamWriteError(e);
  }
}

function teamName(x: unknown): string {
  if (typeof x !== "string") throw new HttpError("badRequest", "a team name is a string");
  const name = x.trim();
  if (name.length < 1 || name.length > MAX_TEAM_NAME_LENGTH) {
    throw new HttpError("badRequest", `a team name has 1 to ${MAX_TEAM_NAME_LENGTH} characters`);
  }
  return name;
}

/** Distinct member ids, each a member (not removed) of the project. */
async function memberIds(db: Db, projectId: string, x: unknown): Promise<string[]> {
  if (!Array.isArray(x) || x.length > MAX_TEAM_MEMBERS_PER_REQUEST || x.some((v) => typeof v !== "string")) {
    throw new HttpError("badRequest", `memberIds is a list of at most ${MAX_TEAM_MEMBERS_PER_REQUEST} member ids`);
  }
  const ids = [...new Set(x as string[])];
  let found = 0;
  for (const part of chunks(ids, ID_CHUNK)) {
    const r = await db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM members WHERE project_id = ? AND status <> 'removed' AND id IN (${placeholders(part.length)})`,
      [projectId, ...part],
    );
    found += r[0]?.n ?? 0;
  }
  if (found !== ids.length) throw new HttpError("badRequest", "memberIds names a member that isn't in this project");
  return ids;
}


export const TEAM_HANDLERS: Handlers = {
  async listTeams(ctx: Ctx) {
    const { db } = ctx.deps;
    const projectId = ctx.params.projectId as string;
    let rows: TeamRow[];
    if (projectRoleAtLeast(ctx.projectRole as ProjectRole, "assistant")) {
      rows = await db.all<TeamRow>(`${TEAM_SELECT} WHERE t.project_id = ? AND t.deleted_ms IS NULL ORDER BY t.name, t.id`, [projectId]);
    } else {
      // members see their own team only
      rows = await db.all<TeamRow>(
        `${TEAM_SELECT} WHERE t.project_id = ? AND t.deleted_ms IS NULL
           AND t.id = (SELECT team_id FROM members WHERE project_id = ? AND user_id = ? AND status = 'active')`,
        [projectId, projectId, ctx.userId],
      );
    }
    return json(200, { teams: await toTeams(db, rows) });
  },

  async createTeam(ctx: Ctx) {
    const { db, now } = ctx.deps;
    const projectId = ctx.params.projectId as string;
    const name = teamName(ctx.body.name);
    const ids = ctx.body.memberIds === undefined ? [] : await memberIds(db, projectId, ctx.body.memberIds);
    const allocation = ctx.body.allocation === undefined ? 0 : ctx.body.allocation;
    if (!isNonNegativeMicros(allocation)) throw new HttpError("badRequest", "an allocation is a non-negative whole number of micro-dollars");
    const t = now();
    const id = newId("team");
    const stmts: Stmt[] = [
      { sql: `INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, ?, ?)`, params: [id, projectId, name, t] },
      {
        sql: `INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, ?, ?)`,
        params: [newId("allocation"), projectId, id, allocation, t],
      },
    ];
    stmts.push(...joinTeam(id, projectId, ids));
    await batch(db, stmts);
    const [team] = await toTeams(db, [await loadTeam(db, projectId, id)]);
    return json(200, team);
  },

  async updateTeam(ctx: Ctx) {
    const { db } = ctx.deps;
    const projectId = ctx.params.projectId as string;
    const team = await loadTeam(db, projectId, ctx.params.teamId as string);
    const stmts: Stmt[] = [];
    if (ctx.body.name !== undefined) {
      stmts.push({ sql: `UPDATE teams SET name = ? WHERE id = ?`, params: [teamName(ctx.body.name), team.id] });
    }
    if (ctx.body.memberIds !== undefined) {
      // the list replaces the team's membership
      // (in one batch: everyone leaves, then the listed members join)
      const ids = await memberIds(db, projectId, ctx.body.memberIds);
      stmts.push({ sql: `UPDATE members SET team_id = NULL WHERE team_id = ?`, params: [team.id] });
      stmts.push(...joinTeam(team.id, projectId, ids));
    }
    if (stmts.length > 0) await batch(db, stmts);
    const [out] = await toTeams(db, [await loadTeam(db, projectId, team.id)]);
    return json(200, out);
  },

  async deleteTeam(ctx: Ctx) {
    const { db, now } = ctx.deps;
    const team = await loadTeam(db, ctx.params.projectId as string, ctx.params.teamId as string);
    // members leave the team, its allocation returns to the project, and it stays on record
    await batch(db, [
      { sql: `UPDATE members SET team_id = NULL WHERE team_id = ?`, params: [team.id] },
      { sql: `UPDATE allocations SET amount = 0, updated_ms = ? WHERE id = ?`, params: [now(), team.allocation_id] },
      { sql: `UPDATE teams SET deleted_ms = ? WHERE id = ? AND deleted_ms IS NULL`, params: [now(), team.id] },
    ]);
    return json(200, { ok: true });
  },

  async setTeamAllocation(ctx: Ctx) {
    const { db, now } = ctx.deps;
    const team = await loadTeam(db, ctx.params.projectId as string, ctx.params.teamId as string);
    const amount = ctx.body.amount;
    if (!isNonNegativeMicros(amount)) throw new HttpError("badRequest", "amount is a non-negative whole number of micro-dollars");
    await batch(db, [{ sql: `UPDATE allocations SET amount = ?, updated_ms = ? WHERE id = ?`, params: [amount, now(), team.allocation_id] }]);
    const a = await db.all<{ amount: number; updated_ms: number }>(`SELECT amount, updated_ms FROM allocations WHERE id = ?`, [team.allocation_id]);
    const out: Allocation = {
      id: team.allocation_id,
      projectId: team.project_id,
      holder: { kind: "team", teamId: team.id },
      amount: a[0]!.amount,
      updatedAt: toIso(a[0]!.updated_ms),
    };
    return json(200, out);
  },
};
