// WorkOS AuthKit as the sign-in provider: the authorize URL, the server-side code exchange,
// the access token's verification, and a session's refresh. The account is never WorkOS's:
// a verified token only names who signed in, by (issuer, subject), and the caller maps that
// to a user of its own. We never revoke a WorkOS session: this app shares its WorkOS
// environment (and perhaps a session) with another, so a revoke here could sign the person
// out there too. Refused or failed sign-ins just discard what they got.
//
// Ported from Sagebrush's web/share/identity/workos.ts (our own code, reviewed there), with
// three changes: the key set's URL is configuration (the environment's, from its discovery
// document), not derived from our client id; the revoke and the unverified sid reader are
// gone; and no request follows a redirect (each pins redirect: "manual", and a 3xx is
// "unavailable", its body unread), as in the provider adapters.
//
// The token check is jose's (a maintained verifier), with everything pinned by the caller's
// configuration, never learned from the token: the exact issuer, RS256 only, this client's
// id (the line between the apps sharing the environment), finite exp and iat (nbf honoured),
// and a well-formed WorkOS user id and session id. Keys come from the configured JWKS,
// cached per (environment, client, issuer, key set URL), fetched with a deadline and a size
// cap, one fetch at a time per key (concurrent callers share it). A key id the cache doesn't
// know refreshes it at most once a minute, counting failed attempts; after a failed fetch, a
// cache past its age isn't fetched again for a few seconds. "Unavailable" (WorkOS couldn't
// be asked) is never reported as "invalid", nor the reverse.

import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";

export interface WorkosConfig {
  /** The environment's name ("staging", "prod"): part of the key cache's key, so no two environments share keys. */
  env: string;
  clientId: string;
  /** The exact issuer this environment's tokens carry (its default application's), from configuration. */
  issuer: string;
  /** The environment's key set (the issuer's discovery document's jwks_uri), from configuration. */
  jwksUrl: string;
  apiKey: string;
  /** Checked when set. */
  audience?: string;
  /** Tests only: another API origin. */
  api?: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Verified =
  | { ok: true; subject: string; sid: string; claims: JWTPayload }
  | { ok: false; kind: "invalid" | "unavailable"; why: string };

const API = "https://api.workos.com";
const DEADLINE_MS = 3000;
const JWKS_MAX_BYTES = 64 * 1024;
const BODY_MAX_BYTES = 64 * 1024;
const JWKS_TTL_MS = 10 * 60_000;
const KID_REFRESH_MS = 60_000;
/** After a failed fetch, no new one for this long (a cache past its age then answers "unavailable"). */
const FAIL_COOLDOWN_MS = 5000;
export const TOKEN_MAX = 8192;
/** A token's iat may be at most this far ahead of our clock (seconds). */
const SKEW_S = 60;
export const SUBJECT = /^user_[A-Za-z0-9]{1,123}$/;
const SID = /^session_[A-Za-z0-9]{1,120}$/;

const api = (c: WorkosConfig) => c.api ?? API;
/** A redirect is never followed: these requests carry the API key or a refresh token (or must come from WorkOS itself). */
const isRedirect = (r: Response) => r.status >= 300 && r.status < 400;
const defaultFetch: Fetch = (i, init) => fetch(i, init);

/** A response body as JSON, refused past `max` bytes (read as a stream, so an oversized body is never held whole). */
async function boundedJson(r: Response, max: number): Promise<unknown> {
  if (Number(r.headers.get("content-length") ?? "0") > max) throw new Error("too large");
  if (!r.body) throw new Error("no body");
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

/** A key set: its keys and when they were fetched (none yet: null), and the last fetch attempt, and whether it failed. */
interface CacheEntry {
  keys: JSONWebKeySet | null;
  at: number;
  tried: number;
  failed: boolean;
}
const caches = new Map<string, CacheEntry>();
/** The fetch under way per key: every caller that needs one while it runs waits for the same one. */
const inflight = new Map<string, Promise<JSONWebKeySet>>();
const cacheKey = (c: WorkosConfig) => `${c.env}\n${c.clientId}\n${c.issuer}\n${c.jwksUrl}`;
/** Tests only: forget every cached key set and attempt. */
export function clearKeyCache(): void {
  caches.clear();
  inflight.clear();
}

async function fetchKeys(c: WorkosConfig, f: Fetch): Promise<JSONWebKeySet> {
  const r = await f(c.jwksUrl, { redirect: "manual", signal: AbortSignal.timeout(DEADLINE_MS) });
  if (!r.ok) throw new Error(`jwks ${r.status}`); // (a redirect included: not followed, not read)
  const j = (await boundedJson(r, JWKS_MAX_BYTES)) as { keys?: unknown } | null;
  if (!j || !Array.isArray(j.keys)) throw new Error("jwks shape");
  return { keys: j.keys as JSONWebKeySet["keys"] };
}

/** The fetch for key `k`: the one under way if there is one, else a new one, recorded as an attempt either way it ends. */
function fetchOnce(k: string, c: WorkosConfig, f: Fetch, now: number): Promise<JSONWebKeySet> {
  const running = inflight.get(k);
  if (running) return running;
  const prev = caches.get(k);
  caches.set(k, { keys: prev?.keys ?? null, at: prev?.at ?? 0, tried: now, failed: false });
  const p = fetchKeys(c, f)
    .then(
      (keys) => {
        caches.set(k, { keys, at: now, tried: now, failed: false });
        return keys;
      },
      (e: unknown) => {
        const cur = caches.get(k);
        caches.set(k, { keys: cur?.keys ?? null, at: cur?.at ?? 0, tried: now, failed: true });
        throw e;
      },
    )
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/**
 * The environment's key set. The cached one while it's younger than its TTL; otherwise
 * fetched, unless a fetch failed within FAIL_COOLDOWN_MS (then "unavailable"). With
 * `refresh` (a key id the cache lacks), fetched again only if no attempt, successful or not,
 * was made within KID_REFRESH_MS; `retry: false` then says not to look again. Throws
 * "unavailable" when no usable key set can be had.
 */
async function keySet(c: WorkosConfig, f: Fetch, now: number, refresh: boolean): Promise<{ keys: JSONWebKeySet; retry: boolean }> {
  const k = cacheKey(c);
  const e = caches.get(k);
  const current = e?.keys && now - e.at <= JWKS_TTL_MS ? e.keys : null;
  if (current && !refresh) return { keys: current, retry: true };
  if (inflight.has(k)) return { keys: await inflight.get(k)!, retry: false };
  if (refresh && e && now - e.tried <= KID_REFRESH_MS) {
    // (an attempt was made within the minute: no new one; if it failed, we can't say the key doesn't exist)
    if (e.failed || !current) throw new Error("unavailable");
    return { keys: current, retry: false };
  }
  if (!refresh && e?.failed && now - e.tried <= FAIL_COOLDOWN_MS) throw new Error("unavailable");
  return { keys: await fetchOnce(k, c, f, now), retry: false };
}

function ownChecks(c: WorkosConfig, p: JWTPayload, nowS: number): string | null {
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) return "exp";
  if (typeof p.iat !== "number" || !Number.isFinite(p.iat)) return "iat";
  if (p.iat > nowS + SKEW_S) return "future";
  if (p.nbf !== undefined && (typeof p.nbf !== "number" || !Number.isFinite(p.nbf))) return "nbf";
  // (this client's token only: the other app's in the environment, or a Connect or agent token, is never a sign-in here)
  if (p.client_id !== c.clientId) return "client";
  if (typeof p.sub !== "string" || !SUBJECT.test(p.sub)) return "subject";
  if (typeof p.sid !== "string" || !SID.test(p.sid)) return "session";
  return null;
}

/** The access token's subject and session if it is this environment's, for this client, signed, and current. */
export async function verifyAccessToken(c: WorkosConfig, token: unknown, opts: { now?: number; fetch?: Fetch } = {}): Promise<Verified> {
  const now = opts.now ?? Date.now();
  const f = opts.fetch ?? defaultFetch;
  if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX || token.split(".").length !== 3) return { ok: false, kind: "invalid", why: "shape" };
  const opt = {
    issuer: c.issuer,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "sid", "client_id"],
    currentDate: new Date(now),
    ...(c.audience ? { audience: c.audience } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let ks: { keys: JSONWebKeySet; retry: boolean };
    try {
      ks = await keySet(c, f, now, attempt > 0);
    } catch {
      return { ok: false, kind: "unavailable", why: "jwks" };
    }
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(ks.keys), opt);
      const why = ownChecks(c, payload, Math.floor(now / 1000));
      return why ? { ok: false, kind: "invalid", why } : { ok: true, subject: payload.sub as string, sid: payload.sid as string, claims: payload };
    } catch (e) {
      // (a key id we don't know: the keys may have rotated; look again once (at most one attempt a minute), then it's invalid)
      if (e instanceof errors.JWKSNoMatchingKey && attempt === 0 && ks.retry) continue;
      return { ok: false, kind: "invalid", why: e instanceof errors.JOSEError ? e.code : "malformed" };
    }
  }
  return { ok: false, kind: "invalid", why: "kid" };
}

/** Where to send the browser: AuthKit's hosted sign-in, with PKCE (S256). */
export function authorizeUrl(c: WorkosConfig, a: { redirectUri: string; state: string; challenge: string; reauth?: boolean }): string {
  const u = new URL(`${api(c)}/user_management/authorize`);
  const q: Record<string, string> = {
    client_id: c.clientId,
    redirect_uri: a.redirectUri,
    response_type: "code",
    provider: "authkit",
    state: a.state,
    code_challenge: a.challenge,
    code_challenge_method: "S256",
    // (a fresh authentication, never a remembered one: the token's auth_time is then now)
    ...(a.reauth ? { max_age: "0" } : {}),
  };
  u.search = new URLSearchParams(q).toString();
  return u.toString();
}

/**
 * The user WorkOS's own answer names (the code exchange's or a refresh's, both server-side
 * with the API key): its id, and its email only when WorkOS says that address is verified,
 * trimmed and lowercased; otherwise null. An address that is too long, has whitespace or a
 * control character, or isn't one "@" between two non-empty parts is null too. The caller
 * uses it only when `id` is the verified access token's subject.
 */
export type WorkosUser = { id: string; email: string | null };
const EMAIL_MAX = 320;
export function userOf(j: unknown): WorkosUser | null {
  const u = (j as { user?: unknown } | null)?.user as { id?: unknown; email?: unknown; email_verified?: unknown } | null | undefined;
  if (!u || typeof u !== "object" || typeof u.id !== "string" || !u.id || u.id.length > 200) return null;
  const e = typeof u.email === "string" ? u.email.trim().toLowerCase() : "";
  const ok = u.email_verified === true && e.length <= EMAIL_MAX && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(e);
  return { id: u.id, email: ok ? e : null };
}

export type Exchanged =
  | { ok: true; accessToken: string; refreshToken: string | null; user: WorkosUser | null; impersonated: boolean }
  | { ok: false; kind: "invalid" | "unavailable"; status: number };

/** The code exchanged for tokens, server-side, with the API key. */
export async function exchangeCode(c: WorkosConfig, code: string, verifier: string, f: Fetch = defaultFetch): Promise<Exchanged> {
  let r: Response;
  try {
    r = await f(`${api(c)}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.apiKey, grant_type: "authorization_code", code, code_verifier: verifier }),
      redirect: "manual",
      signal: AbortSignal.timeout(DEADLINE_MS * 2),
    });
  } catch {
    return { ok: false, kind: "unavailable", status: 0 };
  }
  if (isRedirect(r)) return { ok: false, kind: "unavailable", status: r.status };
  if (r.status >= 500 || r.status === 429 || r.status === 408) return { ok: false, kind: "unavailable", status: r.status };
  if (!r.ok) return { ok: false, kind: "invalid", status: r.status };
  try {
    const j = (await boundedJson(r, BODY_MAX_BYTES)) as { access_token?: unknown; refresh_token?: unknown; impersonator?: unknown };
    if (typeof j.access_token !== "string") return { ok: false, kind: "invalid", status: r.status };
    const rt = typeof j.refresh_token === "string" && j.refresh_token.length > 0 && j.refresh_token.length <= TOKEN_MAX ? j.refresh_token : null;
    // (any impersonator field at all, whatever its shape, counts)
    return { ok: true, accessToken: j.access_token, refreshToken: rt, user: userOf(j), impersonated: j.impersonator !== undefined && j.impersonator !== null };
  } catch {
    return { ok: false, kind: "unavailable", status: r.status };
  }
}

export type Refreshed =
  | { ok: true; accessToken: string; refreshToken: string; user: WorkosUser | null }
  | { ok: false; kind: "refused" | "unavailable"; status: number };

/**
 * A session refreshed with its refresh token, server-side, with the API key. WorkOS may
 * rotate the refresh token: the caller stores the one returned. "refused" only for WorkOS's
 * own answer that this refresh token is no good, a 400 whose error is invalid_grant (the
 * session revoked or signed out, the user disabled or deleted, a token already rotated
 * away), so the session ends. Everything else is "unavailable": nothing about the session is
 * known and nothing changes (a timeout, 408, 429, 5xx, an unreadable answer, and also a
 * 401/403 or another 4xx, which say our request or configuration is wrong, not that the
 * user's session ended).
 */
export async function refreshSession(c: WorkosConfig, refreshToken: string, f: Fetch = defaultFetch): Promise<Refreshed> {
  let r: Response;
  try {
    r = await f(`${api(c)}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.apiKey, grant_type: "refresh_token", refresh_token: refreshToken }),
      redirect: "manual",
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch {
    return { ok: false, kind: "unavailable", status: 0 };
  }
  // (a redirect is not followed, and like every status but 400 it is "unavailable", unread:
  // only WorkOS's own 400 body can say "refused")
  if (!r.ok) {
    if (r.status !== 400) return { ok: false, kind: "unavailable", status: r.status };
    const e = (await boundedJson(r, BODY_MAX_BYTES).catch(() => null)) as { error?: unknown; code?: unknown } | null;
    return { ok: false, kind: e && (e.error === "invalid_grant" || e.code === "invalid_grant") ? "refused" : "unavailable", status: r.status };
  }
  try {
    const j = (await boundedJson(r, BODY_MAX_BYTES)) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string" || j.refresh_token.length === 0 || j.refresh_token.length > TOKEN_MAX) {
      return { ok: false, kind: "unavailable", status: r.status };
    }
    return { ok: true, accessToken: j.access_token, refreshToken: j.refresh_token, user: userOf(j) };
  } catch {
    return { ok: false, kind: "unavailable", status: r.status };
  }
}

// ---------------------------------------------------------------- authenticator factors (BYOK row 4)

/** What a verified token says about the authentication itself: when it was (auth_time), and whether someone was impersonating. */
export function authenticationOf(claims: JWTPayload): { authenticatedMs: number | null; impersonated: boolean } {
  const t = claims.auth_time;
  const authenticatedMs = typeof t === "number" && Number.isSafeInteger(t) && t >= 0 && t * 1000 <= Number.MAX_SAFE_INTEGER ? t * 1000 : null;
  return { authenticatedMs, impersonated: claims.act !== undefined && claims.act !== null };
}

export const FACTOR_ID = /^auth_factor_[A-Za-z0-9]{1,116}$/;
const CHALLENGE_ID = /^auth_challenge_[A-Za-z0-9]{1,113}$/;

export type Factors = { ok: true; totp: string[] } | { ok: false; kind: "invalid" | "unavailable" };

async function apiCall(c: WorkosConfig, f: Fetch, path: string, body: unknown): Promise<{ ok: true; j: unknown } | { ok: false; kind: "invalid" | "unavailable" }> {
  let r: Response;
  try {
    r = await f(`${api(c)}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${c.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch {
    return { ok: false, kind: "unavailable" };
  }
  if (isRedirect(r) || r.status >= 500 || r.status === 429 || r.status === 408) return { ok: false, kind: "unavailable" };
  if (!r.ok) return { ok: false, kind: "invalid" };
  try {
    return { ok: true, j: await boundedJson(r, BODY_MAX_BYTES) };
  } catch {
    return { ok: false, kind: "unavailable" };
  }
}

/** The user's TOTP factors' ids, as WorkOS lists them now (server-side, with the API key). */
export async function listTotpFactors(c: WorkosConfig, userId: string, f: Fetch = defaultFetch): Promise<Factors> {
  if (!SUBJECT.test(userId)) return { ok: false, kind: "invalid" };
  const r = await apiCall(c, f, `/user_management/users/${userId}/auth_factors?limit=100`, undefined);
  if (!r.ok) return r;
  const data = (r.j as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { ok: false, kind: "unavailable" };
  const totp: string[] = [];
  for (const x of data as Array<{ id?: unknown; type?: unknown; user_id?: unknown } | null>) {
    if (x && x.type === "totp" && typeof x.id === "string" && FACTOR_ID.test(x.id) && x.user_id === userId) totp.push(x.id);
  }
  return { ok: true, totp };
}

/** `code` checked against `factorId`: a challenge created for it, then verified. valid is true only for WorkOS's own `valid: true`. */
export async function verifyFactorCode(c: WorkosConfig, factorId: string, code: string, f: Fetch = defaultFetch): Promise<{ ok: true; valid: boolean } | { ok: false; kind: "invalid" | "unavailable" }> {
  if (!FACTOR_ID.test(factorId)) return { ok: false, kind: "invalid" };
  const ch = await apiCall(c, f, `/auth/factors/${factorId}/challenge`, {});
  if (!ch.ok) return ch;
  const challengeId = (ch.j as { id?: unknown } | null)?.id;
  if (typeof challengeId !== "string" || !CHALLENGE_ID.test(challengeId) || (ch.j as { authentication_factor_id?: unknown }).authentication_factor_id !== factorId) {
    return { ok: false, kind: "unavailable" };
  }
  const v = await apiCall(c, f, `/auth/challenges/${challengeId}/verify`, { code });
  if (!v.ok) return v;
  return { ok: true, valid: (v.j as { valid?: unknown } | null)?.valid === true };
}
