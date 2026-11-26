// A fake WorkOS for tests (no network, no credentials): its own RSA keys and key set, the
// code exchange (with PKCE) and refresh, as a fetch function. Shaped after Sagebrush's
// test-identity.mjs fake. Tokens are signed here with node:crypto; the code under test
// verifies them with jose against the fake's key set.

import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import type { Fetch, WorkosConfig } from "../workos.ts";

export const WORKOS_API = "https://api.workos.test";
/** The environment's default app (whose id the issuer and key set name) and ours, a second app in it. */
export const DEFAULT_CLIENT = "client_01DEFAULTAPP";
export const CLIENT = "client_01GPUAPP";
export const ISSUER = `${WORKOS_API}/user_management/${DEFAULT_CLIENT}`;
export const JWKS_URL = `${WORKOS_API}/sso/jwks/${DEFAULT_CLIENT}`;
export const API_KEY = "sk_test_fake_workos";

export const CONFIG: WorkosConfig = { env: "test", clientId: CLIENT, issuer: ISSUER, jwksUrl: JWKS_URL, apiKey: API_KEY, api: WORKOS_API };

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export interface Pair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}
export const newPair = (): Pair => generateKeyPairSync("rsa", { modulusLength: 2048 });

export interface CodeGrant {
  subject: string;
  sid: string;
  challenge: string;
  /** The user in the answer (default: { id: subject, email, email_verified: true }). */
  user?: unknown;
  email?: string;
  /** Another access token than the usual one. */
  token?: string;
  /** Another refresh token than a fresh one (an empty or an oversized one). */
  refresh?: string;
  noRefresh?: boolean;
  /** The authentication's time (ms; default: the exchange's now), kept by every refresh. */
  authTimeMs?: number;
  /** An impersonator in the exchange's answer, and an act claim in its tokens. */
  impersonator?: boolean;
  act?: boolean;
}

export interface FakeFactor {
  id: string;
  type: string;
  user_id: string;
}

export class FakeWorkos {
  k1 = newPair();
  keys: object[];
  jwksStatus = 200;
  jwksHuge = false;
  jwksFetches = 0;
  jwksGate: Promise<void> | null = null;
  authStatus = 0;
  authThrows = false;
  authGarbage = false;
  authCalls = 0;
  codes = new Map<string, CodeGrant>();
  /** Live refresh tokens: their user and session. A refresh rotates the token. */
  rts = new Map<string, { subject: string; sid: string; email: string; authTimeS?: number; act?: boolean }>();
  /** Each WorkOS user's authentication factors. */
  factors = new Map<string, FakeFactor[]>();
  /** The code the user's authenticator app shows now. */
  totpCode = "123456";
  challenges = new Map<string, string>();
  factorsStatus = 200;
  /** Factors listed per page (WorkOS's cursor pagination: after = the page's last id). */
  factorPageSize = 100;
  /** A whole factor-list answer of a test's own, instead of the stored factors (a malformed envelope, a cursor loop). */
  factorListAnswer: ((query: URLSearchParams) => unknown) | null = null;
  factorQueries: string[] = [];
  challengeStatus = 200;
  verifyStatus = 200;
  factorCalls = 0;
  verifyCalls = 0;
  /** The sid a refresh's token carries instead of the session's (a changed WorkOS session). */
  refreshSid: string | null = null;
  refreshStatus: { status: number; body?: string } | null = null;
  refreshThrows = false;
  refreshNoRt = false;
  /** Claims laid over a refresh's access token (another client, another subject). */
  refreshClaims: Record<string, unknown> | null = null;
  /** The user a refresh answers with, instead of the session's own. */
  refreshUser: unknown = undefined;
  refreshCalls = 0;
  bodies: Array<Record<string, unknown>> = [];
  urls: string[] = [];

  constructor() {
    this.keys = [this.jwk(this.k1, "k1")];
  }

  jwk(k: Pair, kid: string): object {
    return { ...k.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  }

  sign(claims: Record<string, unknown>, o: { kid?: string; key?: KeyObject; alg?: string } = {}): string {
    const h = b64url(JSON.stringify({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1", typ: "JWT" }));
    const p = b64url(JSON.stringify(claims));
    const s = (o.alg ?? "RS256") === "RS256" ? createSign("RSA-SHA256").update(`${h}.${p}`).sign(o.key ?? this.k1.privateKey).toString("base64url") : "";
    return `${h}.${p}.${s}`;
  }

  claims(subject: string, sid: string, nowMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const s = Math.floor(nowMs / 1000);
    return { iss: ISSUER, sub: subject, sid, client_id: CLIENT, iat: s, exp: s + 300, ...extra };
  }

  /** A code the fake will exchange, for this PKCE verifier. */
  grant(code: string, g: Omit<CodeGrant, "challenge"> & { verifier: string }): void {
    const { verifier, ...rest } = g;
    this.codes.set(code, { ...rest, challenge: createHash("sha256").update(verifier).digest("base64url") });
  }

  /** A code the fake will exchange, for the PKCE challenge an authorize URL carried. */
  grantChallenge(code: string, challenge: string, g: Omit<CodeGrant, "challenge">): void {
    this.codes.set(code, { ...g, challenge });
  }

  now = () => Date.now();

  fetch: Fetch = async (input, init) => {
    const u = new URL(input);
    this.urls.push(u.origin + u.pathname);
    if (u.origin !== WORKOS_API) return new Response("not found", { status: 404 });
    if (u.pathname.startsWith("/sso/jwks/")) {
      this.jwksFetches++;
      if (this.jwksGate) await this.jwksGate;
      if (u.toString() !== JWKS_URL) return new Response("not found", { status: 404 });
      if (this.jwksStatus !== 200) return new Response("down", { status: this.jwksStatus });
      if (this.jwksHuge) {
        const chunk = new TextEncoder().encode(" ".repeat(16 * 1024));
        let sent = 0;
        const keys = this.keys;
        return new Response(
          new ReadableStream({
            pull(c) {
              if (sent++ < 6) c.enqueue(chunk);
              else {
                c.enqueue(new TextEncoder().encode(JSON.stringify({ keys })));
                c.close();
              }
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({ keys: this.keys });
    }
    if (u.pathname === "/user_management/authenticate" && init?.method === "POST") {
      this.authCalls++;
      const b = JSON.parse(String(init.body)) as Record<string, string>;
      this.bodies.push(b);
      if (b.grant_type === "refresh_token") {
        this.refreshCalls++;
        if (this.refreshThrows) throw new Error("network");
        if (this.refreshStatus) return new Response(this.refreshStatus.body ?? "", { status: this.refreshStatus.status, headers: { "content-type": "application/json" } });
        if (b.client_id !== CLIENT || b.client_secret !== API_KEY) return Response.json({ error: "invalid_client" }, { status: 401 });
        const r = this.rts.get(b.refresh_token!);
        if (!r) return Response.json({ error: "invalid_grant" }, { status: 400 });
        this.rts.delete(b.refresh_token!);
        const next = "rt_" + randomBytes(9).toString("hex");
        this.rts.set(next, r);
        // (a refresh keeps the authentication's time and any act claim: WorkOS advances auth_time only on an active authentication)
        const access = this.sign(this.claims(r.subject, this.refreshSid ?? r.sid, this.now(), { auth_time: r.authTimeS ?? Math.floor(this.now() / 1000), ...(r.act ? { act: { sub: "admin@example.com" } } : {}), ...(this.refreshClaims ?? {}) }));
        const user = this.refreshUser !== undefined ? this.refreshUser : { id: r.subject, email: r.email, email_verified: true };
        return Response.json(this.refreshNoRt ? { access_token: access, user } : { access_token: access, refresh_token: next, user });
      }
      if (this.authThrows) throw new Error("network");
      if (this.authStatus) return new Response("answer", { status: this.authStatus });
      const c = this.codes.get(b.code!);
      this.codes.delete(b.code!);
      if (!c || b.client_id !== CLIENT || b.client_secret !== API_KEY || b.grant_type !== "authorization_code" || createHash("sha256").update(b.code_verifier ?? "").digest("base64url") !== c.challenge) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (this.authGarbage) return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
      const email = c.email ?? "someone@example.com";
      const rt = "rt_" + randomBytes(9).toString("hex");
      const authTimeS = Math.floor((c.authTimeMs ?? this.now()) / 1000);
      if (!c.noRefresh) this.rts.set(rt, { subject: c.subject, sid: c.sid, email, authTimeS, act: c.act === true });
      const user = "user" in c ? c.user : { id: c.subject, email, email_verified: true };
      const extra = { auth_time: authTimeS, ...(c.act ? { act: { sub: "admin@example.com" } } : {}) };
      return Response.json({
        access_token: c.token ?? this.sign(this.claims(c.subject, c.sid, this.now(), extra)),
        ...(c.noRefresh ? {} : { refresh_token: c.refresh ?? rt }),
        user,
        ...(c.impersonator ? { impersonator: { email: "admin@example.com", reason: "support" } } : {}),
      });
    }
    // authenticator factors: listed, challenged, verified (server-side, with the API key)
    const authorized = new Headers(init?.headers).get("authorization") === `Bearer ${API_KEY}`;
    const factorsOf = /^\/user_management\/users\/([^/]+)\/auth_factors$/.exec(u.pathname);
    if (factorsOf && (init?.method ?? "GET") === "GET") {
      this.factorCalls++;
      if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (this.factorsStatus !== 200) return new Response("down", { status: this.factorsStatus });
      this.factorQueries.push(u.search);
      if (this.factorListAnswer) return Response.json(this.factorListAnswer(u.searchParams));
      const all = (this.factors.get(factorsOf[1]!) ?? []) as Array<{ id?: unknown }>;
      const after = u.searchParams.get("after");
      const from = after === null ? 0 : all.findIndex((x) => x.id === after) + 1;
      const page = all.slice(from, from + Math.min(this.factorPageSize, Number(u.searchParams.get("limit") ?? 10)));
      const more = from + page.length < all.length;
      const data = page.map((x) => (typeof x === "object" && x !== null && !("object" in x) ? { object: "authentication_factor", ...x } : x));
      return Response.json({ object: "list", data, list_metadata: { before: null, after: more ? (page.at(-1)?.id ?? null) : null } });
    }
    const challengeOf = /^\/auth\/factors\/([^/]+)\/challenge$/.exec(u.pathname);
    if (challengeOf && init?.method === "POST") {
      if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (this.challengeStatus !== 200) return new Response("down", { status: this.challengeStatus });
      const factor = challengeOf[1]!;
      if (![...this.factors.values()].some((fs) => fs.some((f) => f.id === factor))) return Response.json({ error: "not_found" }, { status: 404 });
      const id = `auth_challenge_${randomBytes(6).toString("hex")}`;
      this.challenges.set(id, factor);
      return Response.json({ object: "authentication_challenge", id, authentication_factor_id: factor, expires_at: null });
    }
    const verifyOf = /^\/auth\/challenges\/([^/]+)\/verify$/.exec(u.pathname);
    if (verifyOf && init?.method === "POST") {
      this.verifyCalls++;
      if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (this.verifyStatus !== 200) return new Response("down", { status: this.verifyStatus });
      const factor = this.challenges.get(verifyOf[1]!);
      if (!factor) return Response.json({ error: "not_found" }, { status: 404 });
      this.challenges.delete(verifyOf[1]!);
      const b = JSON.parse(String(init.body)) as { code?: unknown };
      return Response.json({ challenge: { id: verifyOf[1], authentication_factor_id: factor }, valid: b.code === this.totpCode });
    }
    return new Response("not found", { status: 404 });
  };
}
