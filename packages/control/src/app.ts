// The control plane's HTTP API: dispatch through the contract's route table, body and
// origin checks, sessions, role checks, and the handlers. createApp takes its
// dependencies (database, clock, randomness, config) so tests run it as is.
//
// Every response carries the security headers, including Referrer-Policy: no-referrer
// (the sign-in landing page has a one-time token in its URL). Errors are always the
// contract's { error: { code, message } }.

import { renderBootCommand } from "@sbgpu/machine";
import { isInstallation } from "@sbgpu/providers";
import {
  ERROR_STATUS,
  errorBody,
  matchRoute,
  newId,
  orgRoleAtLeast,
  projectRoleAtLeast,
  ROUTES,
  toIso,
  type AgentClaims,
  type EndpointName,
  type ErrorCode,
  type Me,
  type OrgRole,
  type ProjectRole,
  type RouteAccess,
} from "@sbgpu/api";
import type { Db } from "./db.ts";
import { SIGN_IN_HANDLERS, authConfigFromEnv, revalidate, type AuthConfig, type SessionRow } from "./auth.ts";
import { HttpError, SECURITY_HEADERS, SESSION_COOKIE, base64url, cookieValue, json, sessionCookie, sha256Hex } from "./http.ts";
import type { Fetch } from "./workos.ts";
import { ANNOUNCE_MAX_BODY_BYTES, VM_HANDLERS, type VmProvider } from "./vm.ts";
import type { ContainerDeps } from "./container.ts";
import { ENROLL_HANDLERS, ENROLL_MAX_BODY_BYTES } from "./enroll.ts";
import type { AgentKeysSource, AgentSignerSource } from "./signer.ts";
import { agentAuth } from "./agent-auth.ts";
import { HEARTBEAT_HANDLERS, HEARTBEAT_MAX_BODY_BYTES } from "./heartbeat.ts";
import { MEMBER_HANDLERS } from "./members.ts";
import { TEAM_HANDLERS } from "./teams.ts";
import { PROJECT_HANDLERS } from "./projects.ts";
import { SPEND_HANDLERS } from "./spend.ts";
import { normalizeEmail } from "./validate.ts";
import { CREDENTIAL_HANDLERS, PUT_MAX_BODY_BYTES, type CredentialCheck } from "./credential-routes.ts";
import { ASSURANCE_HANDLERS, ASSURANCE_MAX_BODY_BYTES, CREDENTIAL_ROUTES, asCredentialRefusal, meRecentAuth } from "./credential-assurance.ts";

export { HttpError, SECURITY_HEADERS, SESSION_COOKIE, base64url, json, normalizeEmail, sha256Hex };

// ---------------------------------------------------------------- config

export interface AppConfig {
  /** The UI's origin, e.g. "https://gpu.example.com"; mutations must come from it. */
  appOrigin: string;
  /** Machines are served at https://m-<machineId>.<machineDomain>/ (the deploy config's MACHINE_DOMAIN). */
  machineDomain: string;
  sessionTtlMs: number;
  /** Sign-in through WorkOS; null when it isn't configured (sign-in then answers "unavailable"). */
  auth: AuthConfig | null;
  /**
   * This deployment's installation slug (SBGPU_INSTALLATION, `[a-z0-9]{4,8}`): it is in every
   * provider-side machine name. Null when unset: every launch is then "not-started", nothing
   * written. Changing it later orphans every live launch by design (none parses as ours).
   */
  installation: string | null;
  /**
   * Container launches (RunPod), on only with SBGPU_CONTAINER_LAUNCH=on: the release every pod
   * runs. Null when off (the default).
   */
  containerLaunch: ContainerLaunchConfig | null;
  /** The credential store's Worker secrets, as set (credential-seal.ts parses them strictly; missing or malformed: the store is unavailable). */
  credentialKeks?: string;
  credentialFingerprintKey?: string;
}

/** What every container launch pins: the release's image, and its agent tarball with that tarball's sha256. */
export interface ContainerLaunchConfig {
  /** SBGPU_CONTAINER_IMAGE: a provider stock image name. */
  image: string;
  /** SBGPU_AGENT_URL: a plain https URL. */
  agentUrl: string;
  /** SBGPU_AGENT_SHA256: 64 lowercase hex. */
  agentSha256: string;
}

/** A container image name (registry, path, tag or digest), nothing a provider's API would read otherwise. */
const IMAGE_NAME = /^[a-z0-9][a-z0-9._\/:@-]{0,255}$/;

/**
 * The container-launch config: null when SBGPU_CONTAINER_LAUNCH is unset or "off"; with "on", the
 * release's image, agent URL and agent sha256, each checked (the launcher is rendered once here,
 * so a value it would refuse is refused at startup). Anything else throws.
 */
function containerLaunchFromEnv(env: Record<string, unknown>, appOrigin: string): ContainerLaunchConfig | null {
  const flag = env.SBGPU_CONTAINER_LAUNCH;
  if (flag === undefined || flag === "off") return null;
  if (flag !== "on") throw new Error("SBGPU_CONTAINER_LAUNCH must be on or off");
  const { SBGPU_CONTAINER_IMAGE: image, SBGPU_AGENT_URL: agentUrl, SBGPU_AGENT_SHA256: agentSha256 } = env;
  if (typeof image !== "string" || !IMAGE_NAME.test(image)) throw new Error("SBGPU_CONTAINER_IMAGE must be an image name");
  if (typeof agentUrl !== "string" || typeof agentSha256 !== "string") throw new Error("SBGPU_AGENT_URL and SBGPU_AGENT_SHA256 must be set");
  try {
    renderBootCommand({ agentUrl, agentSha256, controlUrl: appOrigin, mode: "container" });
  } catch {
    throw new Error("SBGPU_AGENT_URL must be a plain https URL and SBGPU_AGENT_SHA256 64 lowercase hex");
  }
  return { image, agentUrl, agentSha256 };
}

export const DEFAULT_CONFIG: Omit<AppConfig, "appOrigin" | "machineDomain" | "auth" | "installation" | "containerLaunch"> = {
  sessionTtlMs: 30 * 24 * 60 * 60_000,
};

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The config from the Worker's environment: the same deploy config that defines
 * MACHINE_DOMAIN for the UI build. Refuses anything malformed rather than guessing.
 */
export function configFromEnv(env: Record<string, unknown>): AppConfig {
  const appOrigin = env.APP_ORIGIN;
  const machineDomain = env.MACHINE_DOMAIN;
  if (typeof appOrigin !== "string") throw new Error("APP_ORIGIN is not set");
  const u = new URL(appOrigin);
  if (u.protocol !== "https:" || u.origin !== appOrigin || u.username || u.password) throw new Error("APP_ORIGIN must be an https origin");
  if (typeof machineDomain !== "string" || !HOSTNAME.test(machineDomain)) throw new Error("MACHINE_DOMAIN must be a lowercase hostname");
  const installation = env.SBGPU_INSTALLATION;
  if (installation !== undefined && !isInstallation(installation)) throw new Error("SBGPU_INSTALLATION must be 4 to 8 of [a-z0-9]");
  // (passed on as set: the store parses them strictly, and anything malformed leaves it unavailable)
  const keks = typeof env.CREDENTIAL_KEKS === "string" ? env.CREDENTIAL_KEKS : undefined;
  const fp = typeof env.CREDENTIAL_FINGERPRINT_KEY === "string" ? env.CREDENTIAL_FINGERPRINT_KEY : undefined;
  return {
    ...DEFAULT_CONFIG,
    appOrigin,
    machineDomain,
    auth: authConfigFromEnv(env),
    installation: installation ?? null,
    containerLaunch: containerLaunchFromEnv(env, appOrigin),
    ...(keks !== undefined ? { credentialKeks: keks } : {}),
    ...(fp !== undefined ? { credentialFingerprintKey: fp } : {}),
  };
}

// ---------------------------------------------------------------- deps

export interface AppDeps {
  db: Db;
  now(): number;
  randomBytes(n: number): Uint8Array;
  config: AppConfig;
  /** Outbound requests (WorkOS). */
  fetch: Fetch;
  /** VM mode's provider adapter; null where none is wired (VM announces are then refused). */
  vm: VmProvider | null;
  /** Container mode's adapter and what its pods must show; null where none is wired (container enroll is then refused). */
  container: ContainerDeps | null;
  /** Runs work after the response (the Worker's ctx.waitUntil). */
  waitUntil(work: Promise<unknown>): void;
  /** The agent-token signer, proved ready per use; null when it isn't (VM enroll then refuses). */
  agentSigner: AgentSignerSource;
  /** The pinned public keys by kid, for verifying agent tokens; null when the pins are malformed. */
  agentPublicKeys: AgentKeysSource;
  /** An operator alert: a fixed line (never a token, key, address or other value). */
  alert(line: string): void;
  /** Row 3's provider check of an organization's key (and the providers keys are accepted for); null where none is wired (no provider is then accepted). */
  credentialCheck: CredentialCheck | null;
}

// ---------------------------------------------------------------- http helpers

/**
 * The security headers on a response the Worker serves that isn't the API's JSON (the
 * app's HTML, including the sign-in landing page whose URL carries a one-time token).
 * Cache-Control is left to the asset.
 */
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== "cache-control") headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const MAX_BODY_BYTES = 64 * 1024;
/** Routes whose bodies are smaller still (read, counted and refused the same way, before any handler). */
const ROUTE_BODY_CAPS: Partial<Record<EndpointName, number>> = { agentAnnounce: ANNOUNCE_MAX_BODY_BYTES, agentEnroll: ENROLL_MAX_BODY_BYTES, agentHeartbeat: HEARTBEAT_MAX_BODY_BYTES, verifyCredentialAssurance: ASSURANCE_MAX_BODY_BYTES, putCredential: PUT_MAX_BODY_BYTES };

function fail(e: HttpError): Response {
  return json(ERROR_STATUS[e.code], errorBody(e.code, e.message));
}



/**
 * The stream's bytes if they total at most `cap`, else null. Each chunk's size is checked
 * before it is kept, and the stream is cancelled at the first chunk that would pass the
 * cap, so nothing past it is read, kept, decoded or parsed.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.byteLength > cap - total) {
      await reader.cancel().catch(() => {});
      return null;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function readJsonObject(req: Request, cap: number): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new HttpError("badRequest", "the body must be application/json");
  const tooLarge = () => new HttpError("badRequest", "the body is too large");
  // A declared length over the cap is refused before anything is read. A smaller (or no)
  // declared length proves nothing: the bytes are counted as they arrive.
  const declared = req.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > cap) {
    await req.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const buf = await readCapped(req.body, cap);
  if (buf === null) throw tooLarge();
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    throw new HttpError("badRequest", "the body is not valid JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError("badRequest", "the body must be a JSON object");
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------- auth and roles

export interface Ctx {
  deps: AppDeps;
  req: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** Set for session routes. */
  userId: string | null;
  sessionHash: string | null;
  /** The caller's effective role in the route's scope, when it has one. */
  projectRole: ProjectRole | null;
  orgRole: OrgRole | null;
  /** Set for agent routes: the verified agent token's claims. */
  agent: AgentClaims | null;
}

async function sessionUser(deps: AppDeps, req: Request): Promise<{ userId: string; hash: string }> {
  const value = cookieValue(req, SESSION_COOKIE);
  // a malformed value hashes to nothing stored, so it fails the lookup below
  if (!value) throw new HttpError("unauthenticated", "sign in first");
  const hash = await sha256Hex(value);
  const rows = await deps.db.all<SessionRow>(
    `SELECT user_id, refresh_version, refresh_sealed, validated_ms FROM sessions WHERE id_sha256 = ? AND revoked_ms IS NULL AND expires_ms > ?`,
    [hash, deps.now()],
  );
  if (rows.length !== 1) throw new HttpError("unauthenticated", "sign in first");
  await revalidate(deps, hash, rows[0]!);
  return { userId: rows[0]!.user_id, hash };
}

/** The project a route's path names (directly, or through its machine). */
async function projectOf(db: Db, access: RouteAccess, params: Record<string, string>): Promise<string | null> {
  if (access.auth !== "session") return null;
  if (access.scope === "project") return params.projectId ?? null;
  if (access.scope === "machine") {
    const r = await db.all<{ project_id: string }>(`SELECT project_id FROM machines WHERE id = ?`, [params.machineId ?? ""]);
    return r[0]?.project_id ?? null;
  }
  return null;
}

/**
 * The caller's effective project role: their active membership's role, or "owner" if
 * they own the project's organization. Null when they have none (then: notFound).
 */
export async function effectiveProjectRole(db: Db, userId: string, projectId: string): Promise<ProjectRole | null> {
  const rows = await db.all<{ role: string | null; org_role: string | null }>(
    `SELECT (SELECT m.role FROM members m WHERE m.project_id = p.id AND m.user_id = ? AND m.status = 'active') AS role,
            (SELECT o.role FROM org_members o WHERE o.org_id = p.org_id AND o.user_id = ?) AS org_role
     FROM projects p WHERE p.id = ?`,
    [userId, userId, projectId],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.org_role === "owner") return "owner";
  return (r.role as ProjectRole | null) ?? null;
}

async function authorize(ctx: Ctx, access: RouteAccess): Promise<void> {
  const { deps } = ctx;
  if (access.auth === "public") return;
  if (access.auth === "system") throw new HttpError("forbidden", "operators only");
  if (access.auth === "agent") {
    ctx.agent = await agentAuth(ctx);
    return;
  }
  const s = await sessionUser(deps, ctx.req);
  ctx.userId = s.userId;
  ctx.sessionHash = s.hash;
  if (access.scope === "none") return;
  if (access.scope === "org") {
    const r = await deps.db.all<{ role: OrgRole }>(`SELECT role FROM org_members WHERE org_id = ? AND user_id = ?`, [ctx.params.orgId ?? "", s.userId]);
    const role = r[0]?.role ?? null;
    if (!role) throw new HttpError("notFound", "no such organization");
    if (!orgRoleAtLeast(role, access.minRole)) throw new HttpError("forbidden", "your role doesn't allow this");
    ctx.orgRole = role;
    return;
  }
  const projectId = await projectOf(deps.db, access, ctx.params);
  const role = projectId ? await effectiveProjectRole(deps.db, s.userId, projectId) : null;
  if (!role) throw new HttpError("notFound", access.scope === "machine" ? "no such machine" : "no such project");
  if (!projectRoleAtLeast(role, access.minRole)) throw new HttpError("forbidden", "your role doesn't allow this");
  ctx.projectRole = role;
}

// ---------------------------------------------------------------- handlers

export type Handler = (ctx: Ctx) => Promise<Response>;
export type Handlers = Partial<Record<EndpointName, Handler>>;

async function buildMe(db: Db, userId: string): Promise<Me> {
  const u = await db.all<{ id: string; email: string; name: string | null; created_ms: number }>(`SELECT id, email, name, created_ms FROM users WHERE id = ?`, [userId]);
  const user = u[0];
  if (!user) throw new HttpError("unauthenticated", "sign in first");
  const orgs = await db.all<{ org_id: string; name: string; role: OrgRole }>(
    `SELECT o.org_id, g.name, o.role FROM org_members o JOIN orgs g ON g.id = o.org_id WHERE o.user_id = ? ORDER BY g.name, o.org_id`,
    [userId],
  );
  const projects = await db.all<{ project_id: string; org_id: string; name: string; role: ProjectRole; member_id: string }>(
    `SELECT m.project_id, p.org_id, p.name, m.role, m.id AS member_id FROM members m JOIN projects p ON p.id = m.project_id
     WHERE m.user_id = ? AND m.status = 'active' ORDER BY p.name, m.project_id`,
    [userId],
  );
  return {
    user: { id: user.id, email: user.email, name: user.name, createdAt: toIso(user.created_ms) },
    orgs: orgs.map((o) => ({ orgId: o.org_id, name: o.name, role: o.role })),
    projects: projects.map((p) => ({ projectId: p.project_id, orgId: p.org_id, name: p.name, role: p.role, memberId: p.member_id })),
  };
}

const AUTH_HANDLERS: Handlers = {
  async signOut(ctx) {
    await ctx.deps.db.run(`UPDATE sessions SET revoked_ms = ? WHERE id_sha256 = ? AND revoked_ms IS NULL`, [ctx.deps.now(), ctx.sessionHash]);
    return json(200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
  },

  async getMe(ctx) {
    const recentAuthForMs = await meRecentAuth(ctx);
    return json(200, { ...(await buildMe(ctx.deps.db, ctx.userId as string)), recentAuthForMs });
  },
};

export const HANDLERS: Handlers = { ...AUTH_HANDLERS, ...SIGN_IN_HANDLERS, ...MEMBER_HANDLERS, ...TEAM_HANDLERS, ...PROJECT_HANDLERS, ...SPEND_HANDLERS, ...VM_HANDLERS, ...ENROLL_HANDLERS, ...HEARTBEAT_HANDLERS, ...ASSURANCE_HANDLERS, ...CREDENTIAL_HANDLERS };

// ---------------------------------------------------------------- dispatch

const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

export function createApp(deps: AppDeps, handlers: Handlers = HANDLERS): { fetch(req: Request): Promise<Response> } {
  return {
    async fetch(req: Request): Promise<Response> {
      let route: string | null = null;
      try {
        const url = new URL(req.url);
        const match = matchRoute(req.method, url.pathname);
        route = match?.name ?? null;
        if (!match) throw new HttpError("notFound", "no such endpoint");
        const spec = ROUTES[match.name];
        // State changes from browsers must come from the app's own origin (machines,
        // under /v1/agent/, send no Origin and authenticate with their tokens).
        const fromBrowser = !url.pathname.startsWith("/v1/agent/");
        if (fromBrowser && req.method !== "GET" && req.headers.get("origin") !== deps.config.appOrigin) {
          throw new HttpError("forbidden", "cross-origin request refused");
        }
        const ctx: Ctx = {
          deps,
          req,
          params: match.params,
          query: url.searchParams,
          body: BODY_METHODS.has(req.method) ? await readJsonObject(req, ROUTE_BODY_CAPS[match.name] ?? MAX_BODY_BYTES) : {},
          userId: null,
          sessionHash: null,
          projectRole: null,
          orgRole: null,
          agent: null,
        };
        await authorize(ctx, spec.access);
        const handler = handlers[match.name];
        if (!handler) throw new HttpError("notFound", "not implemented yet");
        return await handler(ctx);
      } catch (e) {
        // (the credential routes answer only CREDENTIAL_REFUSALS, whatever failed)
        if (route !== null && Object.hasOwn(CREDENTIAL_ROUTES, route)) return fail(asCredentialRefusal(route, e));
        if (e instanceof HttpError) return fail(e);
        return fail(new HttpError("internal", "internal error"));
      }
    },
  };
}
