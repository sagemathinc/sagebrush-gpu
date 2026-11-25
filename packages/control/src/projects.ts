// Organizations and projects: an organization's credit, its projects, and each project's
// policy, labels and budget. Credit moves between an organization and its projects only
// in single batches that also record a credit event, so no balance is ever half-moved;
// CHECK constraints keep every balance non-negative, and the budget triggers keep a
// project's budget at or above its allocations.

import {
  DEFAULT_POLICY,
  isIsoTime,
  isNonNegativeMicros,
  mergePolicy,
  newId,
  toIso,
  validateLabels,
  validatePolicyPatch,
  type Organization,
  type Project,
  type ProjectLabels,
  type ProjectPolicy,
} from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import { D1_MAX_BOUND_PARAMETERS, chunks, type Db, type Stmt } from "./db.ts";
import { HttpError, json } from "./http.ts";

export const PROJECTS_PAGE_SIZE = 50;
export const MAX_PROJECT_NAME_LENGTH = 200;
export const MAX_CREDIT_REFERENCE_LENGTH = 200;
const ID_CHUNK = D1_MAX_BOUND_PARAMETERS - 2;
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

interface OrgRow {
  id: string;
  name: string;
  margin_bps: number;
  unassigned_credit: number;
  total_credit: number;
  created_ms: number;
}

interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  starts_ms: number;
  ends_ms: number;
  margin_bps_override: number | null;
  budget: number;
  final_save_reserve_minutes: number;
  policy_json: string;
  labels_json: string | null;
  created_ms: number;
}

const PROJECT_COLUMNS = `id, org_id, name, starts_ms, ends_ms, margin_bps_override, budget, final_save_reserve_minutes, policy_json, labels_json, created_ms`;

function toOrg(r: OrgRow): Organization {
  return {
    id: r.id,
    name: r.name,
    marginBps: r.margin_bps,
    unassignedCredit: r.unassigned_credit,
    totalCredit: r.total_credit,
    createdAt: toIso(r.created_ms),
  };
}

/** The stored policy (fields that differ from the defaults) over the defaults, with the reserve from its column. */
function policyOf(r: ProjectRow): ProjectPolicy {
  return { ...mergePolicy(DEFAULT_POLICY, JSON.parse(r.policy_json) as Partial<ProjectPolicy>), finalSaveReserveMinutes: r.final_save_reserve_minutes };
}

/** Projects as the API returns them, with what is allocated and spent, from grouped queries per chunk. */
async function toProjects(db: Db, rows: ProjectRow[]): Promise<Project[]> {
  const allocated = new Map<string, number>();
  const spent = new Map<string, { p: number; m: number; t: number }>();
  for (const ids of chunks(rows.map((r) => r.id), ID_CHUNK)) {
    for (const a of await db.all<{ project_id: string; n: number }>(
      `SELECT project_id, COALESCE(SUM(amount), 0) AS n FROM allocations WHERE project_id IN (${placeholders(ids.length)}) GROUP BY project_id`,
      ids,
    )) allocated.set(a.project_id, a.n);
    for (const s of await db.all<{ project_id: string; p: number; m: number; t: number }>(
      `SELECT project_id, SUM(provider_cost) AS p, SUM(margin) AS m, SUM(total) AS t FROM ledger_entries WHERE project_id IN (${placeholders(ids.length)}) GROUP BY project_id`,
      ids,
    )) spent.set(s.project_id, { p: s.p, m: s.m, t: s.t });
  }
  return rows.map((r) => {
    const s = spent.get(r.id) ?? { p: 0, m: 0, t: 0 };
    return {
      id: r.id,
      orgId: r.org_id,
      name: r.name,
      labels: r.labels_json === null ? null : (JSON.parse(r.labels_json) as ProjectLabels),
      startsAt: toIso(r.starts_ms),
      endsAt: toIso(r.ends_ms),
      marginBpsOverride: r.margin_bps_override,
      budget: r.budget,
      allocated: allocated.get(r.id) ?? 0,
      spent: { providerCost: s.p, margin: s.m, total: s.t },
      policy: policyOf(r),
      createdAt: toIso(r.created_ms),
    };
  });
}

async function loadProject(db: Db, projectId: string): Promise<ProjectRow> {
  const r = await db.all<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`, [projectId]);
  if (!r[0]) throw new HttpError("notFound", "no such project");
  return r[0];
}

async function projectResponse(db: Db, projectId: string): Promise<Response> {
  const [p] = await toProjects(db, [await loadProject(db, projectId)]);
  return json(200, p);
}

/** The database refused a credit or budget write: say why. (Nothing here can push total credit or a budget past the safe range: moves leave the total alone, and a budget is at most the total.) */
function creditWriteError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("unassigned_credit")) throw new HttpError("conflict", "the organization doesn't have that much unassigned credit");
  if (msg.includes("over-allocation")) throw new HttpError("conflict", "the budget would be below its allocations");
  if (msg.includes("budget BETWEEN")) throw new HttpError("conflict", "the project's budget isn't that large");
  throw e;
}

async function batch(db: Db, stmts: Stmt[]): Promise<void> {
  try {
    await db.batch(stmts);
  } catch (e) {
    creditWriteError(e);
  }
}

function projectName(x: unknown): string {
  if (typeof x !== "string") throw new HttpError("badRequest", "a project name is a string");
  const name = x.trim();
  if (name.length < 1 || name.length > MAX_PROJECT_NAME_LENGTH) throw new HttpError("badRequest", `a project name has 1 to ${MAX_PROJECT_NAME_LENGTH} characters`);
  return name;
}

function time(x: unknown, what: string): number {
  if (!isIsoTime(x)) throw new HttpError("badRequest", `${what} is an ISO-8601 UTC time`);
  return Date.parse(x);
}

function policyPatch(x: unknown): Partial<ProjectPolicy> {
  const r = validatePolicyPatch(x);
  if (!r.ok) throw new HttpError("badRequest", r.reason);
  return r.value;
}

function labels(x: unknown): ProjectLabels | null {
  const r = validateLabels(x);
  if (!r.ok) throw new HttpError("badRequest", r.reason);
  return r.value;
}

/** What to store for a policy: the fields that differ from the defaults, without the reserve (its own column). */
function storedPolicy(p: ProjectPolicy): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "finalSaveReserveMinutes") continue;
    if (JSON.stringify(v) !== JSON.stringify((DEFAULT_POLICY as Record<string, unknown>)[k])) out[k] = v;
  }
  return JSON.stringify(out);
}

/**
 * Operators add credit to an organization (an invoice or purchase order): never over
 * HTTP. One batch: both balances and the credit event.
 */
export async function addOrgCredit(db: Db, orgId: string, amount: number, reference: string, nowMs: number): Promise<Organization> {
  if (!Number.isSafeInteger(amount) || amount < 1) throw new RangeError("amount must be a positive safe integer");
  if (typeof reference !== "string" || reference.length < 1 || reference.length > MAX_CREDIT_REFERENCE_LENGTH) throw new RangeError("reference: 1 to 200 characters");
  const exists = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM orgs WHERE id = ?`, [orgId]);
  if (exists[0]?.n !== 1) throw new RangeError("no such organization");
  await db.batch([
    { sql: `UPDATE orgs SET unassigned_credit = unassigned_credit + ?, total_credit = total_credit + ? WHERE id = ?`, params: [amount, amount, orgId] },
    {
      sql: `INSERT INTO credit_events (id, org_id, kind, amount, reference, created_ms) VALUES (?, ?, 'credit', ?, ?, ?)`,
      params: [newId("creditEvent"), orgId, amount, reference, nowMs],
    },
  ]);
  const r = await db.all<OrgRow>(`SELECT id, name, margin_bps, unassigned_credit, total_credit, created_ms FROM orgs WHERE id = ?`, [orgId]);
  return toOrg(r[0]!);
}

const creditEventId = () => newId("creditEvent");

export const PROJECT_HANDLERS: Handlers = {
  async getOrg(ctx: Ctx) {
    const r = await ctx.deps.db.all<OrgRow>(`SELECT id, name, margin_bps, unassigned_credit, total_credit, created_ms FROM orgs WHERE id = ?`, [ctx.params.orgId as string]);
    if (!r[0]) throw new HttpError("notFound", "no such organization");
    return json(200, toOrg(r[0]));
  },

  async listProjects(ctx: Ctx) {
    const { db } = ctx.deps;
    const rows = await db.all<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE org_id = ? AND id > ? ORDER BY id LIMIT ?`,
      [ctx.params.orgId as string, ctx.query.get("cursor") ?? "", PROJECTS_PAGE_SIZE + 1],
    );
    const page = rows.slice(0, PROJECTS_PAGE_SIZE);
    return json(200, { items: await toProjects(db, page), next: rows.length > PROJECTS_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null });
  },

  async createProject(ctx: Ctx) {
    const { db, now } = ctx.deps;
    const orgId = ctx.params.orgId as string;
    const b = ctx.body;
    const name = projectName(b.name);
    const starts = time(b.startsAt, "startsAt");
    const ends = time(b.endsAt, "endsAt");
    if (!(ends > starts)) throw new HttpError("badRequest", "endsAt must be after startsAt");
    const budget = b.budget;
    if (!isNonNegativeMicros(budget)) throw new HttpError("badRequest", "budget is a non-negative whole number of micro-dollars");
    const policy = mergePolicy(DEFAULT_POLICY, b.policy === undefined ? {} : policyPatch(b.policy));
    const lab = b.labels === undefined ? null : labels(b.labels);
    const id = newId("project");
    const t = now();
    const stmts: Stmt[] = [
      // the budget comes out of the organization's unassigned credit (the CHECK refuses an overdraft)
      { sql: `UPDATE orgs SET unassigned_credit = unassigned_credit - ? WHERE id = ?`, params: [budget, orgId] },
      {
        sql: `INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, final_save_reserve_minutes, policy_json, labels_json, created_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, orgId, name, starts, ends, budget, policy.finalSaveReserveMinutes, storedPolicy(policy), lab === null ? null : JSON.stringify(lab), t],
      },
    ];
    if (budget > 0) {
      stmts.push({ sql: `INSERT INTO credit_events (id, org_id, kind, amount, project_id, created_ms) VALUES (?, ?, 'to_project', ?, ?, ?)`, params: [creditEventId(), orgId, budget, id, t] });
    }
    await batch(db, stmts);
    return projectResponse(db, id);
  },

  async getProject(ctx: Ctx) {
    return projectResponse(ctx.deps.db, ctx.params.projectId as string);
  },

  async updateProject(ctx: Ctx) {
    const { db } = ctx.deps;
    const p = await loadProject(db, ctx.params.projectId as string);
    const b = ctx.body;
    const name = b.name === undefined ? p.name : projectName(b.name);
    const starts = b.startsAt === undefined ? p.starts_ms : time(b.startsAt, "startsAt");
    const ends = b.endsAt === undefined ? p.ends_ms : time(b.endsAt, "endsAt");
    if (!(ends > starts)) throw new HttpError("badRequest", "endsAt must be after startsAt");
    const policy = b.policy === undefined ? policyOf(p) : mergePolicy(policyOf(p), policyPatch(b.policy));
    const lab = b.labels === undefined ? p.labels_json : (() => {
      const l = labels(b.labels);
      return l === null ? null : JSON.stringify(l);
    })();
    await batch(db, [
      {
        sql: `UPDATE projects SET name = ?, starts_ms = ?, ends_ms = ?, final_save_reserve_minutes = ?, policy_json = ?, labels_json = ? WHERE id = ?`,
        params: [name, starts, ends, policy.finalSaveReserveMinutes, storedPolicy(policy), lab, p.id],
      },
    ]);
    return projectResponse(db, p.id);
  },

  async moveProjectBudget(ctx: Ctx) {
    const { db, now } = ctx.deps;
    const p = await loadProject(db, ctx.params.projectId as string);
    // money moves only for someone who owns the organization, not just the project
    const org = await db.all<{ role: string }>(`SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`, [p.org_id, ctx.userId]);
    if (org[0]?.role !== "owner") throw new HttpError("forbidden", "only an owner of the organization moves credit");
    const amount = ctx.body.amount;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount === 0) {
      throw new HttpError("badRequest", "amount is a non-zero whole number of micro-dollars (negative returns credit to the organization)");
    }
    await batch(db, [
      { sql: `UPDATE orgs SET unassigned_credit = unassigned_credit - ? WHERE id = ?`, params: [amount, p.org_id] },
      { sql: `UPDATE projects SET budget = budget + ? WHERE id = ?`, params: [amount, p.id] },
      {
        sql: `INSERT INTO credit_events (id, org_id, kind, amount, project_id, created_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [creditEventId(), p.org_id, amount > 0 ? "to_project" : "from_project", Math.abs(amount), p.id, now()],
      },
    ]);
    return projectResponse(db, p.id);
  },
};
