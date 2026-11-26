// Recent reauthentication with MFA proven per session (BYOK design r3, row 4; SEC clear).
//
// Changing an organization's provider key takes two steps:
// - a fresh WorkOS authentication (startSignIn?reauth=1: max_age=0), whose access token's
//   auth_time the session keeps (migrations/0021);
// - then verifyCredentialAssurance: a code from the owner's one authenticator (TOTP) factor,
//   verified with WorkOS server-side.
// That verification writes an assurance: bound to the session (its id's hash, and its WorkOS
// session id), the user, the organization, the factor, the authentication time, this
// deployment's environment and client, and no impersonation. It lives at most 300 s from the
// authentication and from the verification, and is used at most once.
//
// Every key change (row 5) consumes one live assurance inside its own batch:
// consumeAssurance's UPDATE re-checks every binding against the session and the owner role
// as they are then, and the enroll_guard aborts the batch when nothing matched.
// liveAssurance is the same check, read-only, for a refusal in its place before any provider
// call.
//
// The check quota is the organization's: 10 reservations per fixed hour, shared by every code
// verification and provider check, kept in D1 (every isolate), and never released.

import { CREDENTIAL_REFUSALS, RECENT_AUTH_WINDOW_MS, isAuthenticatorCode, isId, type CredentialRefusal } from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import { stmt, type Db, type Stmt } from "./db.ts";
import { HttpError, json } from "./http.ts";
import { listTotpFactors, verifyFactorCode } from "./workos.ts";

/** An assurance lives this long, from the authentication and from the verification (whichever ends first). */
export const ASSURANCE_MS = RECENT_AUTH_WINDOW_MS;
export const CHECKS_PER_HOUR = 10;
const HOUR_MS = 3_600_000;
/** How far ahead of our clock a token's auth_time may be and still count as now. */
const AUTH_TIME_SKEW_MS = 60_000;

export const credentialRefusal = (r: CredentialRefusal) => new HttpError(CREDENTIAL_REFUSALS[r].code, CREDENTIAL_REFUSALS[r].message);

/** Whether `e` is already one of the fixed credential refusals. */
function isCredentialRefusal(e: HttpError): boolean {
  return Object.values(CREDENTIAL_REFUSALS).some((r) => r.code === e.code && r.message === e.message);
}

/** The routes that answer only CREDENTIAL_REFUSALS, and the refusal for a body that can't be read or parsed on each. */
export const CREDENTIAL_ROUTES: Readonly<Record<string, CredentialRefusal>> = Object.freeze({
  listCredentials: "notOwner",
  putCredential: "badShape",
  deleteCredential: "badExpected",
  verifyCredentialAssurance: "mfaInvalid",
});

/**
 * Any error on a credential route as one of CREDENTIAL_REFUSALS: a missing or ended session is
 * signedOut; a caller who isn't an owner (or not a member, or a request from another origin)
 * is notOwner; an unreadable body is the route's shape refusal; anything else (an outage, a
 * fault) is checkUnavailable, never a success and never another message.
 */
export function asCredentialRefusal(route: string, e: unknown): HttpError {
  if (e instanceof HttpError && isCredentialRefusal(e)) return e;
  if (e instanceof HttpError) {
    if (e.code === "unauthenticated") return credentialRefusal("signedOut");
    if (e.code === "forbidden" || e.code === "notFound") return credentialRefusal("notOwner");
    if (e.code === "badRequest") return credentialRefusal(CREDENTIAL_ROUTES[route] ?? "checkUnavailable");
  }
  return credentialRefusal("checkUnavailable");
}

// ---------------------------------------------------------------- the quota

/** One unit of `orgId`'s check quota in the current hour, if one is left. Never released. */
export async function reserveCheck(db: Db, orgId: string, nowMs: number): Promise<boolean> {
  const window = nowMs - (nowMs % HOUR_MS);
  const r = await db.run(
    `INSERT INTO credential_check_quota (org_id, window_start_ms, used) VALUES (?, ?, 1)
     ON CONFLICT (org_id, window_start_ms) DO UPDATE SET used = used + 1 WHERE used < ?`,
    [orgId, window, CHECKS_PER_HOUR],
  );
  return r.changes === 1;
}

// ---------------------------------------------------------------- the session's authentication

interface SessionAuth {
  user_id: string;
  authenticated_ms: number | null;
  workos_sid: string | null;
  impersonated: number | null;
}

async function sessionAuth(db: Db, hash: string, nowMs: number): Promise<SessionAuth | null> {
  const r = await db.all<SessionAuth>(
    `SELECT user_id, authenticated_ms, workos_sid, impersonated FROM sessions WHERE id_sha256 = ? AND revoked_ms IS NULL AND expires_ms > ?`,
    [hash, nowMs],
  );
  return r[0] ?? null;
}

/** Whether the session's authentication is fresh (within ASSURANCE_MS of now, boundary included), known and not impersonated. */
export function freshAuthentication(s: SessionAuth | null, nowMs: number): s is SessionAuth & { authenticated_ms: number; workos_sid: string } {
  return (
    s !== null &&
    s.impersonated === 0 &&
    s.workos_sid !== null &&
    s.authenticated_ms !== null &&
    nowMs - s.authenticated_ms <= ASSURANCE_MS &&
    s.authenticated_ms <= nowMs + AUTH_TIME_SKEW_MS
  );
}

// ---------------------------------------------------------------- using an assurance

/** What a key change binds its assurance to: the caller's session, user and organization, this deployment, and the factor as WorkOS lists it now. */
export interface AssuranceBinding {
  sessionHash: string;
  userId: string;
  orgId: string;
  env: string;
  clientId: string;
  factorId: string;
}

// Every binding, against the assurance (a) and the session and roles as they are now. The
// session's sid, authentication time and impersonation are its current ones: a refresh that
// changed the sid, or impersonation that arose since, leaves nothing matching.
const LIVE = `a.session_sha256 = ? AND a.user_id = ? AND a.org_id = ? AND a.env = ? AND a.client_id = ? AND a.factor_id = ?
  AND a.impersonated = 0 AND a.used_ms IS NULL AND a.expires_ms >= ?
  AND EXISTS (SELECT 1 FROM sessions s WHERE s.id_sha256 = a.session_sha256 AND s.user_id = a.user_id AND s.workos_sid = a.workos_sid
    AND s.authenticated_ms = a.auth_time_ms AND s.impersonated = 0 AND s.revoked_ms IS NULL AND s.expires_ms > ?)
  AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = a.org_id AND m.user_id = a.user_id AND m.role = 'owner')
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = a.org_id AND o.billing_mode = 'byok')`;
const liveParams = (b: AssuranceBinding, nowMs: number) => [b.sessionHash, b.userId, b.orgId, b.env, b.clientId, b.factorId, nowMs, nowMs];

/** Whether a live assurance matches every binding now (read-only: the check before any provider call). */
export async function liveAssurance(db: Db, b: AssuranceBinding, nowMs: number): Promise<boolean> {
  const r = await db.all(`SELECT 1 FROM credential_assurances a WHERE ${LIVE} LIMIT 1`, liveParams(b, nowMs));
  return r.length === 1;
}

/**
 * The first statements of a key change's batch: use exactly one live assurance matching every
 * binding (the newest), then abort the whole batch if none did. With nothing matching, nothing
 * in the batch applies.
 */
export function consumeAssurance(b: AssuranceBinding, nowMs: number): Stmt[] {
  return [
    stmt(
      `UPDATE credential_assurances SET used_ms = ? WHERE id = (SELECT a.id FROM credential_assurances a WHERE ${LIVE} ORDER BY a.id DESC LIMIT 1)`,
      nowMs,
      ...liveParams(b, nowMs),
    ),
    stmt(`INSERT INTO enroll_guard (ok) SELECT 0 WHERE changes() <> 1`),
  ];
}

/** The remaining life of the session's newest live, unused assurance for `orgId` (an owner's only), from 0 to ASSURANCE_MS; else null. */
export async function recentAuthForMs(db: Db, sessionHash: string, userId: string, orgId: string, env: string, clientId: string, nowMs: number): Promise<number | null> {
  const r = await db.all<{ e: number | null }>(
    `SELECT max(a.expires_ms) AS e FROM credential_assurances a
     WHERE a.session_sha256 = ? AND a.user_id = ? AND a.org_id = ? AND a.env = ? AND a.client_id = ?
       AND a.impersonated = 0 AND a.used_ms IS NULL AND a.expires_ms >= ?
       AND EXISTS (SELECT 1 FROM sessions s WHERE s.id_sha256 = a.session_sha256 AND s.user_id = a.user_id AND s.workos_sid = a.workos_sid
         AND s.authenticated_ms = a.auth_time_ms AND s.impersonated = 0 AND s.revoked_ms IS NULL AND s.expires_ms > ?)
       AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = a.org_id AND m.user_id = a.user_id AND m.role = 'owner')`,
    [sessionHash, userId, orgId, env, clientId, nowMs, nowMs],
  );
  const e = r[0]?.e;
  if (typeof e !== "number") return null;
  return Math.max(0, Math.min(ASSURANCE_MS, e - nowMs));
}

// ---------------------------------------------------------------- the route

export const ASSURANCE_MAX_BODY_BYTES = 256;

export const ASSURANCE_HANDLERS: Handlers = {
  /**
   * POST /v1/orgs/:orgId/credentials/assurance { code }. In order (each refusal writes nothing
   * but, from the quota on, the reservation): the body (at most 256 bytes, before parsing,
   * then exactly { code } of six digits: mfaInvalid); a fresh, known, unimpersonated
   * authentication (reauthenticate); an owner (notOwner, by the route's access) of a byok
   * organization (notByok); one unit of the check quota (tooManyChecks); the user's one TOTP
   * factor (mfaRequired); WorkOS's valid: true for the code (mfaInvalid). Then the assurance,
   * written only if the session still has that authentication, unimpersonated, and the
   * caller is still an owner.
   */
  async verifyCredentialAssurance(ctx: Ctx) {
    const { deps } = ctx;
    const now = deps.now();
    const keys = Object.keys(ctx.body);
    if (keys.length !== 1 || keys[0] !== "code" || !isAuthenticatorCode(ctx.body.code)) throw credentialRefusal("mfaInvalid");
    const code = ctx.body.code;
    const hash = ctx.sessionHash as string;
    const userId = ctx.userId as string;
    const orgId = ctx.params.orgId as string;
    const s = await sessionAuth(deps.db, hash, now);
    if (!freshAuthentication(s, now) || s.user_id !== userId) throw credentialRefusal("reauthenticate");
    const mode = await deps.db.all<{ billing_mode: string }>(`SELECT billing_mode FROM orgs WHERE id = ?`, [orgId]);
    if (mode[0]?.billing_mode !== "byok") throw credentialRefusal("notByok");
    const a = deps.config.auth;
    if (!a) throw credentialRefusal("checkUnavailable");
    if (!(await reserveCheck(deps.db, orgId, now))) throw credentialRefusal("tooManyChecks");
    const id = await deps.db.all<{ sub: string }>(`SELECT sub FROM identities WHERE user_id = ? AND iss = ?`, [userId, a.workos.issuer]);
    const sub = id[0]?.sub;
    if (!sub) throw credentialRefusal("reauthenticate");
    const factors = await listTotpFactors(a.workos, sub, deps.fetch);
    if (!factors.ok) throw credentialRefusal("checkUnavailable");
    if (factors.totp.length !== 1) throw credentialRefusal("mfaRequired");
    const factorId = factors.totp[0]!;
    const v = await verifyFactorCode(a.workos, factorId, code, deps.fetch);
    if (!v.ok && v.kind === "unavailable") throw credentialRefusal("checkUnavailable");
    if (!v.ok || !v.valid) throw credentialRefusal("mfaInvalid");
    const at = deps.now();
    const expires = Math.min(s.authenticated_ms + ASSURANCE_MS, at + ASSURANCE_MS);
    if (expires <= at) throw credentialRefusal("reauthenticate");
    const made = await deps.db.run(
      `INSERT INTO credential_assurances (session_sha256, workos_sid, user_id, org_id, factor_id, auth_time_ms, env, client_id, impersonated, created_ms, expires_ms)
       SELECT s.id_sha256, s.workos_sid, s.user_id, ?, ?, s.authenticated_ms, ?, ?, 0, ?, ? FROM sessions s
       WHERE s.id_sha256 = ? AND s.user_id = ? AND s.workos_sid = ? AND s.authenticated_ms = ? AND s.impersonated = 0 AND s.revoked_ms IS NULL AND s.expires_ms > ?
         AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ? AND m.user_id = s.user_id AND m.role = 'owner')`,
      [orgId, factorId, a.workos.env, a.workos.clientId, at, expires, hash, userId, s.workos_sid, s.authenticated_ms, at, orgId],
    );
    if (made.changes !== 1) throw credentialRefusal("reauthenticate");
    return json(200, { recentAuthForMs: Math.min(ASSURANCE_MS, expires - at) });
  },
};

/** GET /v1/me's recentAuthForMs for `?orgId=`: null without it, or for anyone but an owner there; a malformed one is badRequest. */
export async function meRecentAuth(ctx: Ctx): Promise<number | null> {
  const orgId = ctx.query.get("orgId");
  if (orgId === null) return null;
  if (!isId("org", orgId)) throw new HttpError("badRequest", "orgId must be an organization id");
  const a = ctx.deps.config.auth;
  if (!a) return null;
  return recentAuthForMs(ctx.deps.db, ctx.sessionHash as string, ctx.userId as string, orgId, a.workos.env, a.workos.clientId, ctx.deps.now());
}
