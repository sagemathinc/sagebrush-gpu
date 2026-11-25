// Sign-in through WorkOS AuthKit (design r3, SEC design clear): startSignIn sends the
// browser to AuthKit with a one-time state; signInCallback takes it back, exchanges the
// code, verifies the access token, admits or refuses the person, and starts our own session.
// Sessions are revalidated with WorkOS hourly (revalidate, called for every signed-in
// request).
//
// We never revoke a WorkOS session (this app shares its environment, and perhaps a session,
// with another): a refusal or a failure discards the tokens and stores nothing, and signing
// out ends only our own session. Every terminal callback answer clears the sign-in cookie,
// and is a redirect into the app: the return path, signed in, or "/?signin=<outcome>".
//
// Admission is the union of: an identity we already know; a user an operator created for
// this verified email; a live invitation (a member row that isn't removed) for it. It is
// decided inside the one batch that creates the user, the identity, the activated
// invitations and the session, so nothing is created for someone not admitted.

import { SIGN_IN_OUTCOME_PARAM, isSafeReturnPath, newId, type SignInOutcome } from "@sbgpu/api";
import type { AppDeps, Ctx, Handlers } from "./app.ts";
import { HttpError, SECURITY_HEADERS, base64url, cookieValue, sessionCookie, sha256Hex } from "./http.ts";
import { seal, sealKeys, unseal } from "./seal.ts";
import { authorizeUrl, exchangeCode, refreshSession, verifyAccessToken, type WorkosConfig } from "./workos.ts";

export interface AuthConfig {
  workos: WorkosConfig;
  /** Signs the sign-in state cookie (HMAC-SHA-256). */
  stateKey: string;
  /** REFRESH_KEYS: the sealing keys for refresh tokens at rest (seal.ts). */
  refreshKeys: string;
}

export const AUTH_COOKIE = "__Host-sbgpu_auth";
export const STATE_TTL_MS = 10 * 60_000;
/** Sign-ins under way (live states) at most; past it, new ones are refused, none evicted. */
export const MAX_LIVE_STATES = 1000;
/** A session is revalidated with WorkOS once this long has passed since the last time. */
export const VALIDATE_EVERY_MS = 60 * 60_000;
/** While WorkOS can't be asked, a session past its hour is still served for this long. */
export const OUTAGE_GRACE_MS = 15 * 60_000;
/** One request refreshes a session at a time; a claim older than this can be taken over. */
export const REFRESH_CLAIM_MS = 30_000;

const CLIENT_ID = /^client_[A-Za-z0-9]{1,100}$/;
const DEFAULT_API = "https://api.workos.com";

/**
 * The sign-in configuration from the Worker's environment, or null when any part is unset
 * (sign-in then answers "unavailable"). Anything set but malformed is refused rather than
 * guessed. The issuer and key set are the environment's (its default application's), from
 * its discovery document; never derived from our client id, never learned from a token.
 */
export function authConfigFromEnv(env: Record<string, unknown>): AuthConfig | null {
  const v = (k: string) => (typeof env[k] === "string" && env[k] !== "" ? (env[k] as string) : null);
  const clientId = v("WORKOS_CLIENT_ID");
  const issuer = v("WORKOS_ISSUER");
  const jwksUrl = v("WORKOS_JWKS_URL");
  const apiKey = v("WORKOS_API_KEY");
  const stateKey = v("STATE_KEY");
  const refreshKeys = v("REFRESH_KEYS");
  if (!clientId || !issuer || !jwksUrl || !apiKey || !stateKey || !refreshKeys) return null;
  const api = v("WORKOS_API") ?? DEFAULT_API;
  const u = new URL(api);
  if (u.protocol !== "https:" || u.origin !== api) throw new Error("WORKOS_API must be an https origin");
  if (!CLIENT_ID.test(clientId)) throw new Error("WORKOS_CLIENT_ID is malformed");
  const iss = issuer.startsWith(`${api}/user_management/`) ? issuer.slice(`${api}/user_management/`.length) : "";
  if (!CLIENT_ID.test(iss)) throw new Error("WORKOS_ISSUER must be <api>/user_management/<the environment's default client id>");
  const jw = jwksUrl.startsWith(`${api}/sso/jwks/`) ? jwksUrl.slice(`${api}/sso/jwks/`.length) : "";
  if (!CLIENT_ID.test(jw)) throw new Error("WORKOS_JWKS_URL must be <api>/sso/jwks/<client id>");
  if (stateKey.length < 32) throw new Error("STATE_KEY must be at least 32 characters");
  return { workos: { env: issuer, clientId, issuer, jwksUrl, apiKey, ...(api !== DEFAULT_API ? { api } : {}) }, stateKey, refreshKeys };
}

// ---------------------------------------------------------------- the state cookie

const utf8 = (s: string) => new TextEncoder().encode(s);

function unbase64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const hmacKey = (key: string) => crypto.subtle.importKey("raw", utf8(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const MAC_LABEL = "sbgpu-auth-state\n";

/** What the sign-in cookie carries: state, nonce, PKCE verifier, return path, expiry (ms). */
export interface SignInState {
  s: string;
  n: string;
  v: string;
  r: string;
  x: number;
}

export async function packState(key: string, st: SignInState): Promise<string> {
  const p = base64url(utf8(JSON.stringify(st)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key), utf8(MAC_LABEL + p)));
  return `${p}.${base64url(mac)}`;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // (32 random bytes, base64url)

/** The cookie's state if its MAC is ours (checked in constant time) and it is well formed; else null. */
export async function unpackState(key: string, raw: string | null): Promise<SignInState | null> {
  if (!raw || raw.length > 4096) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const mac = unbase64url(parts[1]!);
  const body = unbase64url(parts[0]!);
  if (!mac || !body) return null;
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(key), mac, utf8(MAC_LABEL + parts[0])))) return null;
  let o: unknown;
  try {
    o = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const st = o as Partial<SignInState> | null;
  if (!st || typeof st !== "object") return null;
  if (typeof st.s !== "string" || !TOKEN.test(st.s) || typeof st.n !== "string" || !TOKEN.test(st.n) || typeof st.v !== "string" || !TOKEN.test(st.v)) return null;
  if (typeof st.r !== "string" || typeof st.x !== "number" || !Number.isSafeInteger(st.x)) return null;
  return { s: st.s, n: st.n, v: st.v, r: st.r, x: st.x };
}

// ---------------------------------------------------------------- answers

const CLEAR_AUTH_COOKIE = `${AUTH_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ ...SECURITY_HEADERS, location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

/** A callback (or start) that ended without a session: into the app with its outcome, the sign-in cookie cleared. */
const outcome = (o: SignInOutcome) => redirect(`/?${SIGN_IN_OUTCOME_PARAM}=${o}`, [CLEAR_AUTH_COOKIE]);

async function sha256B64url(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))));
}

/** Whether a failed admission batch broke the one-identity-per-user rule (this email's user is someone else's). */
const otherIdentity = (e: unknown) => e instanceof Error && /identities\.user_id/.test(e.message);

// ---------------------------------------------------------------- handlers

export const SIGN_IN_HANDLERS: Handlers = {
  async startSignIn(ctx: Ctx) {
    const { deps } = ctx;
    const a = deps.config.auth;
    if (!a || !(await sealKeys(a.refreshKeys))) return outcome("unavailable");
    const ret = ctx.query.get("return");
    const st: SignInState = {
      s: base64url(deps.randomBytes(32)),
      n: base64url(deps.randomBytes(32)),
      v: base64url(deps.randomBytes(32)),
      r: isSafeReturnPath(ret) ? ret : "/",
      x: deps.now() + STATE_TTL_MS,
    };
    const cookie = `${AUTH_COOKIE}=${await packState(a.stateKey, st)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_MS / 1000}`;
    const to = authorizeUrl(a.workos, { redirectUri: `${deps.config.appOrigin}/v1/auth/callback`, state: st.s, challenge: await sha256B64url(st.v) });
    return redirect(to, [cookie]);
  },

  async signInCallback(ctx: Ctx) {
    const { deps } = ctx;
    const a = deps.config.auth;
    const keys = a ? await sealKeys(a.refreshKeys) : null;
    if (!a || !keys) return outcome("unavailable");
    const now = deps.now();
    // the browser that started this sign-in, within its 10 minutes, for this state
    const st = await unpackState(a.stateKey, cookieValue(ctx.req, AUTH_COOKIE));
    if (!st || st.x <= now || ctx.query.get("state") !== st.s) return outcome("expired");
    const ret = isSafeReturnPath(st.r) ? st.r : "/";
    const code = ctx.query.get("code");
    const providerError = ctx.query.get("error");
    // (neither a code nor an error: refused before the state is spent)
    if (!code && !providerError) return outcome("error");
    // spent once: its nonce's hash, unless MAX_LIVE_STATES sign-ins are already under way
    let spent: number;
    try {
      spent = (
        await deps.db.run(
          `INSERT INTO auth_states (nonce_sha256, expires_ms) SELECT ?, ? WHERE (SELECT COUNT(*) FROM auth_states WHERE expires_ms > ?) < ?`,
          [await sha256Hex(st.n), st.x, now, MAX_LIVE_STATES],
        )
      ).changes;
    } catch {
      return outcome("expired"); // (already spent: a replay)
    }
    if (spent !== 1) return outcome("unavailable");
    if (providerError || !code || code.length > 1024) return outcome("error");
    const ex = await exchangeCode(a.workos, code, st.v, deps.fetch);
    if (!ex.ok) return outcome(ex.kind === "unavailable" ? "unavailable" : "error");
    const ver = await verifyAccessToken(a.workos, ex.accessToken, { now, fetch: deps.fetch });
    if (!ver.ok) return outcome(ver.kind === "unavailable" ? "unavailable" : "error");
    if (!ex.refreshToken) return outcome("error");
    // (the email only from WorkOS's answer about this very user, and only verified)
    const email = ex.user && ex.user.id === ver.subject ? ex.user.email : null;
    if (!email) return outcome("refused");
    const iss = a.workos.issuer;
    const sub = ver.subject;
    const sessionValue = base64url(deps.randomBytes(32));
    const hash = await sha256Hex(sessionValue);
    const sealed = await seal(keys, { env: a.workos.env, identity: sub, session: hash }, ex.refreshToken);
    try {
      await deps.db.batch([
        // a user for a live invitation (when there's no identity and no user for this email yet)
        {
          sql: `INSERT INTO users (id, email, created_ms) SELECT ?, ?, ?
                WHERE NOT EXISTS (SELECT 1 FROM identities WHERE iss = ? AND sub = ?)
                  AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?)
                  AND EXISTS (SELECT 1 FROM members WHERE email = ? AND status <> 'removed')`,
          params: [newId("user"), email, now, iss, sub, email, email],
        },
        // the identity, for this email's user (the operator's or the one just made); a user
        // that already has another identity breaks identities.user_id's UNIQUE: refused
        {
          sql: `INSERT INTO identities (iss, sub, user_id, email, email_ticket, created_ms)
                SELECT ?, ?, id, ?, ?, ? FROM users WHERE email = ?
                  AND NOT EXISTS (SELECT 1 FROM identities WHERE iss = ? AND sub = ?)`,
          params: [iss, sub, email, now, now, email, iss, sub],
        },
        {
          sql: `UPDATE identities SET email = ?, email_ticket = ? WHERE iss = ? AND sub = ? AND email_ticket <= ?`,
          params: [email, now, iss, sub, now],
        },
        // this email's invitations, made active for the identity's user
        {
          sql: `UPDATE members SET user_id = (SELECT user_id FROM identities WHERE iss = ? AND sub = ?), status = 'active'
                WHERE email = ? AND status = 'invited' AND user_id IS NULL
                  AND EXISTS (SELECT 1 FROM identities WHERE iss = ? AND sub = ?)`,
          params: [iss, sub, email, iss, sub],
        },
        {
          sql: `INSERT INTO sessions (id_sha256, user_id, created_ms, expires_ms, refresh_version, refresh_sealed, validated_ms)
                SELECT ?, user_id, ?, ?, ?, ?, ? FROM identities WHERE iss = ? AND sub = ?`,
          params: [hash, now, now + deps.config.sessionTtlMs, sealed.version, sealed.ct, now, iss, sub],
        },
      ]);
    } catch (e) {
      return outcome(otherIdentity(e) ? "refused" : "unavailable");
    }
    const made = await deps.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE id_sha256 = ?`, [hash]);
    if (made[0]?.n !== 1) return outcome("refused");
    return redirect(ret, [sessionCookie(sessionValue, Math.floor(deps.config.sessionTtlMs / 1000)), CLEAR_AUTH_COOKIE]);
  },
};

// ---------------------------------------------------------------- revalidation

export interface SessionRow {
  user_id: string;
  refresh_version: string | null;
  refresh_sealed: string | null;
  validated_ms: number | null;
}

/**
 * A WorkOS-backed session, checked with WorkOS once its hour is up. Returns if the session
 * may be served; throws unauthenticated if WorkOS says it ended (invalid_grant, no grace) or
 * it can't be opened, and "unavailable" if WorkOS can't be asked and the 15-minute grace is
 * over (the session itself is kept). One request refreshes at a time (a claim); others are
 * served within the grace meanwhile.
 */
export async function revalidate(deps: AppDeps, hash: string, r: SessionRow): Promise<void> {
  if (r.refresh_sealed === null || r.validated_ms === null) return; // (not a WorkOS session: made by the tests)
  const now = deps.now();
  if (now - r.validated_ms < VALIDATE_EVERY_MS) return;
  const inGrace = now - r.validated_ms < VALIDATE_EVERY_MS + OUTAGE_GRACE_MS;
  const unavailable = () => {
    if (!inGrace) throw new HttpError("unavailable", "your sign-in can't be checked right now; try again in a moment");
  };
  const ended = async (why: string) => {
    await deps.db.run(`UPDATE sessions SET revoked_ms = ? WHERE id_sha256 = ? AND revoked_ms IS NULL`, [now, hash]);
    throw new HttpError("unauthenticated", why);
  };
  const a = deps.config.auth;
  const keys = a ? await sealKeys(a.refreshKeys) : null;
  if (!a || !keys) return unavailable();
  const claimed = await deps.db.run(
    `UPDATE sessions SET refresh_claim_ms = ? WHERE id_sha256 = ? AND validated_ms = ? AND (refresh_claim_ms IS NULL OR refresh_claim_ms <= ?)`,
    [now, hash, r.validated_ms, now - REFRESH_CLAIM_MS],
  );
  if (claimed.changes !== 1) {
    // another request is refreshing it, or just did
    const cur = await deps.db.all<{ validated_ms: number | null }>(`SELECT validated_ms FROM sessions WHERE id_sha256 = ? AND revoked_ms IS NULL`, [hash]);
    if (cur[0]?.validated_ms !== undefined && cur[0]?.validated_ms !== null && now - cur[0].validated_ms < VALIDATE_EVERY_MS) return;
    return unavailable();
  }
  const id = await deps.db.all<{ iss: string; sub: string }>(`SELECT iss, sub FROM identities WHERE user_id = ?`, [r.user_id]);
  const sub = id[0]?.sub;
  if (!sub || id[0]!.iss !== a.workos.issuer) return ended("sign in again");
  const rt = await unseal(keys, { env: a.workos.env, identity: sub, session: hash }, r.refresh_version, r.refresh_sealed);
  if (!rt) return ended("sign in again");
  const res = await refreshSession(a.workos, rt, deps.fetch);
  if (!res.ok) return res.kind === "refused" ? ended("your sign-in has ended; sign in again") : unavailable();
  const ver = await verifyAccessToken(a.workos, res.accessToken, { now, fetch: deps.fetch });
  if (!ver.ok) return ver.kind === "unavailable" ? unavailable() : ended("sign in again");
  if (ver.subject !== sub) return ended("sign in again");
  const sealed = await seal(keys, { env: a.workos.env, identity: sub, session: hash }, res.refreshToken);
  await deps.db.batch([
    {
      sql: `UPDATE sessions SET refresh_version = ?, refresh_sealed = ?, validated_ms = ?, refresh_claim_ms = NULL WHERE id_sha256 = ? AND refresh_claim_ms = ?`,
      params: [sealed.version, sealed.ct, now, hash, now],
    },
    ...(res.user && res.user.id === sub && res.user.email
      ? [{ sql: `UPDATE identities SET email = ?, email_ticket = ? WHERE iss = ? AND sub = ? AND email_ticket <= ?`, params: [res.user.email, now, a.workos.issuer, sub, now] }]
      : []),
  ]);
}
