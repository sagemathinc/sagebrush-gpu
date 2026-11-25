import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { newId, type Me } from "@sbgpu/api";
import { AUTH_COOKIE, MAX_LIVE_STATES, OUTAGE_GRACE_MS, STATE_TTL_MS, VALIDATE_EVERY_MS, authConfigFromEnv, packState, unpackState, type AuthConfig } from "./auth.ts";
import { DEFAULT_CONFIG } from "./app.ts";
import { stmt } from "./db.ts";
import { SESSION_COOKIE } from "./http.ts";
import { clearKeyCache } from "./workos.ts";
import { API_KEY, CLIENT, CONFIG, DEFAULT_CLIENT, FakeWorkos, ISSUER, JWKS_URL, WORKOS_API } from "./testing/fake-workos.ts";
import { ORIGIN, T0, addMember, call, world, type World } from "./testing/world.ts";

const STATE_KEY = "s".repeat(40);
const REFRESH_KEYS = `v1:${randomBytes(32).toString("base64")}`;
const AUTH: AuthConfig = { workos: CONFIG, stateKey: STATE_KEY, refreshKeys: REFRESH_KEYS };

let fake: FakeWorkos;
let w: World;
beforeEach(async () => {
  clearKeyCache();
  fake = new FakeWorkos();
  w = await world({ auth: AUTH, fetch: fake.fetch, budget: 0 });
  fake.now = () => w.clock.t;
});

const cookies = (res: Response) => res.headers.getSetCookie();
const authCookieOf = (res: Response) => cookies(res).find((c) => c.startsWith(`${AUTH_COOKIE}=`) && !c.includes("Max-Age=0"))?.split(";")[0];
const cleared = (res: Response) => cookies(res).includes(`${AUTH_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);

/** Start a sign-in: the authorize URL's state and challenge, and the browser's cookie. */
async function begin(ret?: string) {
  const r = await call(w, "GET", `/v1/auth/start${ret === undefined ? "" : `?return=${encodeURIComponent(ret)}`}`);
  assert.equal(r.res.status, 302);
  const to = new URL(r.res.headers.get("location")!);
  return { to, state: to.searchParams.get("state")!, challenge: to.searchParams.get("code_challenge")!, cookie: authCookieOf(r.res)!, res: r.res };
}

let codes = 0;
/** WorkOS's redirect back, for a sign-in begun with `b`, as this WorkOS user. */
async function finish(b: Awaited<ReturnType<typeof begin>>, o: { sub?: string; sid?: string; email?: string; user?: unknown; query?: string; noRefresh?: boolean; token?: string } = {}) {
  const code = `code_${++codes}`;
  const sub = o.sub ?? "user_01ADA";
  fake.grantChallenge(code, b.challenge, {
    subject: sub,
    sid: o.sid ?? `session_01S${codes}`,
    email: o.email ?? "ada@example.com",
    ...(o.user !== undefined ? { user: o.user } : {}),
    ...(o.noRefresh ? { noRefresh: true } : {}),
    ...(o.token ? { token: o.token } : {}),
  });
  const q = o.query ?? `code=${code}&state=${b.state}`;
  const r = await call(w, "GET", `/v1/auth/callback?${q}`, { cookie: b.cookie });
  return r.res;
}
const where = (res: Response) => res.headers.get("location");
const sessionOf = (res: Response) => cookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];

async function counts() {
  const n = async (t: string) => (await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))[0]!.n;
  return { users: await n("users"), identities: await n("identities"), sessions: await n("sessions") };
}

test("config: off unless every part is set; malformed parts refused; the environment's issuer and key set", () => {
  const env = {
    WORKOS_CLIENT_ID: "client_01M88ADBQ9AZ30G3RYR13G5E3Z",
    WORKOS_ISSUER: "https://api.workos.com/user_management/client_01M7CB1DZV2VJEV3A8PBP62ZVN",
    WORKOS_JWKS_URL: "https://api.workos.com/sso/jwks/client_01M7CB1DZV2VJEV3A8PBP62ZVN",
    WORKOS_API_KEY: "sk_test_x",
    STATE_KEY,
    REFRESH_KEYS,
  };
  const c = authConfigFromEnv(env)!;
  assert.deepEqual(c.workos, { env: env.WORKOS_ISSUER, clientId: env.WORKOS_CLIENT_ID, issuer: env.WORKOS_ISSUER, jwksUrl: env.WORKOS_JWKS_URL, apiKey: "sk_test_x" });
  for (const k of Object.keys(env)) {
    assert.equal(authConfigFromEnv({ ...env, [k]: undefined }), null, k);
    assert.equal(authConfigFromEnv({ ...env, [k]: "" }), null, k);
  }
  for (const [k, v] of [
    ["WORKOS_CLIENT_ID", "client-01"],
    ["WORKOS_ISSUER", "https://auth.example.com"],
    ["WORKOS_ISSUER", "https://api.workos.com/user_management/"],
    ["WORKOS_ISSUER", "https://evil.example/user_management/client_01A"],
    ["WORKOS_JWKS_URL", "https://api.workos.com/sso/jwks/"],
    ["WORKOS_JWKS_URL", "https://evil.example/sso/jwks/client_01A"],
    ["STATE_KEY", "short"],
    ["WORKOS_API", "http://api.workos.test"],
  ] as const) {
    assert.throws(() => authConfigFromEnv({ ...env, [k]: v }), Error, `${k}=${v}`);
  }
  // a test API origin: the issuer and key set must be under it
  const t = authConfigFromEnv({ ...env, WORKOS_API: WORKOS_API, WORKOS_ISSUER: ISSUER, WORKOS_JWKS_URL: JWKS_URL })!;
  assert.equal(t.workos.api, WORKOS_API);
  assert.throws(() => authConfigFromEnv({ ...env, WORKOS_API: WORKOS_API }));
});

test("the state cookie: our MAC only, well formed only", async () => {
  const st = { s: "a".repeat(43), n: "b".repeat(43), v: "c".repeat(43), r: "/p", x: T0 };
  const packed = await packState(STATE_KEY, st);
  assert.deepEqual(await unpackState(STATE_KEY, packed), st);
  assert.equal(await unpackState("t".repeat(40), packed), null); // (another key)
  const [p, m] = packed.split(".");
  const other = Buffer.from(JSON.stringify({ ...st, r: "//evil.example" })).toString("base64url");
  for (const bad of [null, "", p!, `${other}.${m}`, `${p}.${m}x`, `${p}.${m}.x`, `${p}!.${m}`, "x".repeat(4097)]) assert.equal(await unpackState(STATE_KEY, bad), null, String(bad).slice(0, 30));
  for (const shape of [{ ...st, s: "short" }, { ...st, x: 1.5 }, { ...st, r: 5 }, { s: st.s }]) {
    assert.equal(await unpackState(STATE_KEY, await packState(STATE_KEY, shape as never)), null, JSON.stringify(shape).slice(0, 40));
  }
});

test("start: AuthKit with PKCE, our client and callback; a signed 10-minute cookie; the return path kept only if safe", async () => {
  const b = await begin("/p/prj_1/members?x=1#top");
  assert.equal(b.to.origin + b.to.pathname, `${WORKOS_API}/user_management/authorize`);
  assert.equal(b.to.searchParams.get("client_id"), CLIENT);
  assert.equal(b.to.searchParams.get("redirect_uri"), `${ORIGIN}/v1/auth/callback`);
  assert.equal(b.to.searchParams.get("code_challenge_method"), "S256");
  assert.match(b.state, /^[A-Za-z0-9_-]{43}$/);
  const set = cookies(b.res).find((c) => c.startsWith(`${AUTH_COOKIE}=`))!;
  assert.match(set, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  assert.equal(b.res.headers.get("referrer-policy"), "no-referrer");
  const st = (await unpackState(STATE_KEY, b.cookie.split("=")[1]!))!;
  assert.deepEqual([st.s, st.r, st.x], [b.state, "/p/prj_1/members?x=1#top", T0 + STATE_TTL_MS]);
  for (const bad of ["//evil.example", "https://evil.example/", "/\\evil.example", ""]) {
    const c = await begin(bad);
    assert.equal((await unpackState(STATE_KEY, c.cookie.split("=")[1]!))!.r, "/", bad);
  }
  assert.equal((await unpackState(STATE_KEY, (await begin()).cookie.split("=")[1]!))!.r, "/");
  // two starts: different states, verifiers and nonces
  const [x, y] = [await begin(), await begin()];
  assert.notEqual(x.state, y.state);
  assert.notEqual(x.challenge, y.challenge);
});

test("an invited person: admitted, signed in, invitation active; the refresh token sealed, never stored plain", async () => {
  const memberId = await addMember(w, "ada@example.com", "manager");
  const b = await begin("/p/x");
  const res = await finish(b, { email: "Ada@Example.com" });
  assert.equal(res.status, 302);
  assert.equal(where(res), "/p/x");
  assert.ok(cleared(res));
  const set = cookies(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
  assert.match(set, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${DEFAULT_CONFIG.sessionTtlMs / 1000}$`));
  const me = (await call(w, "GET", "/v1/me", { cookie: sessionOf(res)! })).json as unknown as Me;
  assert.equal(me.user.email, "ada@example.com");
  assert.deepEqual(me.projects.map((p) => [p.memberId, p.role]), [[memberId, "manager"]]);
  const id = await w.db.all<{ iss: string; sub: string; email: string }>(`SELECT iss, sub, email FROM identities`);
  assert.deepEqual(id.map((x) => ({ ...x })), [{ iss: ISSUER, sub: "user_01ADA", email: "ada@example.com" }]);
  const s = await w.db.all<{ refresh_version: string; refresh_sealed: string; validated_ms: number }>(`SELECT refresh_version, refresh_sealed, validated_ms FROM sessions`);
  assert.equal(s[0]!.refresh_version, "v1");
  assert.equal(s[0]!.validated_ms, T0);
  for (const rt of fake.rts.keys()) assert.ok(!s[0]!.refresh_sealed.includes(rt) && !JSON.stringify(await w.db.all(`SELECT * FROM sessions`)).includes(rt));
  assert.deepEqual(fake.urls.filter((u) => u.includes("revoke")), []);
});

test("refused: no invitation, a removed one, no verified email, another user's answer; nothing is created, nothing revoked", async () => {
  await addMember(w, "gone@example.com", "member", { status: "removed" });
  const before = await counts();
  for (const [what, o] of [
    ["not invited", { email: "stranger@example.com" }],
    ["removed", { email: "gone@example.com" }],
    ["unverified", { user: { id: "user_01ADA", email: "ada@example.com", email_verified: false } }],
    ["no user", { user: null }],
    ["someone else's user", { user: { id: "user_01EVE", email: "ada@example.com", email_verified: true } }],
  ] as const) {
    if (what === "unverified" || what === "no user" || what === "someone else's user") await addMember(w, "ada@example.com", "member").catch(() => {});
    const res = await finish(await begin(), o);
    assert.equal(where(res), "/?signin=refused", what);
    assert.ok(cleared(res), what);
    assert.equal(sessionOf(res), undefined, what);
  }
  const after = await counts();
  assert.deepEqual([after.users, after.identities, after.sessions], [before.users, before.identities, before.sessions]);
  assert.deepEqual(fake.urls.filter((u) => u.includes("revoke")), []);
});

test("admitted: a user an operator made (bound to the identity once); a known identity, whatever its invitations", async () => {
  const userId = newId("user");
  await w.db.batch([stmt(`INSERT INTO users (id, email, created_ms) VALUES (?, 'op@example.com', ?)`, userId, T0)]);
  const res = await finish(await begin(), { sub: "user_01OP", email: "op@example.com" });
  assert.equal(where(res), "/");
  assert.equal((await w.db.all<{ user_id: string }>(`SELECT user_id FROM identities WHERE sub = 'user_01OP'`))[0]!.user_id, userId);
  // another identity with the same email: refused (that user is someone else's now)
  const before = await counts();
  assert.equal(where(await finish(await begin(), { sub: "user_01OTHER", email: "op@example.com" })), "/?signin=refused");
  assert.deepEqual(await counts(), before);
  // the known identity signs in again, even with no invitation at all, and with another verified email
  const again = await finish(await begin(), { sub: "user_01OP", email: "op.new@example.com" });
  assert.equal(where(again), "/");
  assert.equal((await counts()).users, before.users);
  assert.equal((await w.db.all<{ email: string }>(`SELECT email FROM identities WHERE sub = 'user_01OP'`))[0]!.email, "op.new@example.com");
});

test("the state: missing, forged, expired, another sign-in's, replayed; no code and no error isn't spent", async () => {
  await addMember(w, "ada@example.com");
  const b = await begin();
  const check = async (res: Response, outcomeWord: string, what: string) => {
    assert.equal(where(res), `/?signin=${outcomeWord}`, what);
    assert.ok(cleared(res), what);
  };
  await check((await call(w, "GET", `/v1/auth/callback?code=x&state=${b.state}`)).res, "expired", "no cookie");
  await check((await call(w, "GET", `/v1/auth/callback?code=x&state=${b.state}`, { cookie: `${AUTH_COOKIE}=${await packState("t".repeat(40), (await unpackState(STATE_KEY, b.cookie.split("=")[1]!))!)}` })).res, "expired", "another key");
  await check(await finish(b, { query: `code=x&state=${(await begin()).state}` }), "expired", "another sign-in's state");
  // neither code nor error: refused, the state not spent, so the real answer still works
  await check(await finish(b, { query: `state=${b.state}` }), "error", "no code");
  assert.equal((await counts()).identities, 0);
  const ok = await finish(b);
  assert.equal(where(ok), "/");
  // the same answer again: spent
  await check((await call(w, "GET", `/v1/auth/callback?code=code_${codes}&state=${b.state}`, { cookie: b.cookie })).res, "expired", "replay");
  // a provider error
  await check(await finish(await begin(), { query: "" }).then(async () => (await call(w, "GET", `/v1/auth/callback?error=access_denied&state=${(await begin()).state}`)).res), "expired", "no cookie, error");
  const e = await begin();
  await check(await finish(e, { query: `error=access_denied&state=${e.state}` }), "error", "provider error");
  // expired: 10 minutes after the start
  const late = await begin();
  w.clock.t += STATE_TTL_MS;
  await check(await finish(late), "expired", "10 minutes");
  w.clock.t -= STATE_TTL_MS;
  const inTime = await begin();
  w.clock.t += STATE_TTL_MS - 1;
  assert.equal(where(await finish(inTime)), "/");
});

test("the state table is bounded: full, a sign-in is refused before WorkOS is asked", async () => {
  await addMember(w, "ada@example.com");
  const stmts = [];
  for (let i = 0; i < MAX_LIVE_STATES; i++) stmts.push(stmt(`INSERT INTO auth_states (nonce_sha256, expires_ms) VALUES (?, ?)`, i.toString(16).padStart(64, "0"), T0 + 60_000));
  await w.db.batch(stmts);
  const calls = fake.authCalls;
  assert.equal(where(await finish(await begin())), "/?signin=unavailable");
  assert.equal(fake.authCalls, calls);
  // expired states don't count
  w.clock.t += 60_000;
  assert.equal(where(await finish(await begin())), "/");
});

test("exchange and token failures: unavailable or error, never a session", async () => {
  await addMember(w, "ada@example.com");
  for (const [what, setup, word] of [
    ["WorkOS down", () => (fake.authStatus = 500), "unavailable"],
    ["WorkOS refuses", () => (fake.authStatus = 400), "error"],
    ["network", () => (fake.authThrows = true), "unavailable"],
    ["key set down", () => (fake.jwksStatus = 503), "unavailable"],
  ] as const) {
    clearKeyCache();
    fake.authStatus = 0;
    fake.authThrows = false;
    fake.jwksStatus = 200;
    setup();
    const res = await finish(await begin());
    assert.equal(where(res), `/?signin=${word}`, what);
    assert.ok(cleared(res), what);
  }
  fake.jwksStatus = 200;
  clearKeyCache();
  // the other app's token (its client id), and a token with no refresh token
  const theirs = fake.sign(fake.claims("user_01ADA", "session_01X", T0, { client_id: DEFAULT_CLIENT }));
  assert.equal(where(await finish(await begin(), { token: theirs })), "/?signin=error");
  assert.equal(where(await finish(await begin(), { noRefresh: true })), "/?signin=error");
  assert.equal((await counts()).sessions, 0);
  assert.deepEqual(fake.urls.filter((u) => u.includes("revoke")), []);
});

test("two first sign-ins of one person at once: one user, one identity, two sessions", async () => {
  await addMember(w, "ada@example.com");
  const [a, b] = [await begin(), await begin()];
  const [ra, rb] = await Promise.all([finish(a), finish(b)]);
  assert.deepEqual([where(ra), where(rb)], ["/", "/"]);
  assert.deepEqual(await counts(), { users: 1, identities: 1, sessions: 2 });
});

test("revalidation: hourly; a refused refresh ends the session at once; WorkOS down: 15 minutes of grace, then 503, the session kept", async () => {
  await addMember(w, "ada@example.com");
  const cookie = sessionOf(await finish(await begin()))!;
  const me = () => call(w, "GET", "/v1/me", { cookie });
  w.clock.t += VALIDATE_EVERY_MS - 1;
  assert.equal((await me()).res.status, 200);
  assert.equal(fake.refreshCalls, 0);
  // past the hour: refreshed, the new token sealed, validated now
  w.clock.t += 1;
  const sealedBefore = (await w.db.all<{ s: string }>(`SELECT refresh_sealed AS s FROM sessions`))[0]!.s;
  assert.equal((await me()).res.status, 200);
  assert.equal(fake.refreshCalls, 1);
  const row = (await w.db.all<{ s: string; v: number; c: number | null }>(`SELECT refresh_sealed AS s, validated_ms AS v, refresh_claim_ms AS c FROM sessions`))[0]!;
  assert.notEqual(row.s, sealedBefore);
  assert.deepEqual([row.v, row.c], [w.clock.t, null]);
  // WorkOS down past the next hour: served within the grace, then 503, and the session stays
  const v = w.clock.t; // (validated)
  fake.refreshStatus = { status: 500 };
  w.clock.t = v + VALIDATE_EVERY_MS;
  assert.equal((await me()).res.status, 200);
  const tried = fake.refreshCalls;
  w.clock.t = v + VALIDATE_EVERY_MS + 31_000; // (the first attempt's claim lapsed: tried again)
  assert.equal((await me()).res.status, 200);
  assert.equal(fake.refreshCalls, tried + 1);
  w.clock.t = v + VALIDATE_EVERY_MS + OUTAGE_GRACE_MS - 1;
  assert.equal((await me()).res.status, 200);
  w.clock.t = v + VALIDATE_EVERY_MS + OUTAGE_GRACE_MS;
  const down = await me();
  assert.equal(down.res.status, 503);
  assert.equal(down.json.error?.code, "unavailable");
  assert.equal((await w.db.all<{ r: number | null }>(`SELECT revoked_ms AS r FROM sessions`))[0]!.r, null);
  // WorkOS back, and it says the session ended (invalid_grant): no grace
  fake.refreshStatus = null;
  fake.rts.clear();
  w.clock.t += 30_000;
  const ended = await me();
  assert.equal(ended.res.status, 401);
  assert.notEqual((await w.db.all<{ r: number | null }>(`SELECT revoked_ms AS r FROM sessions`))[0]!.r, null);
});

test("revalidation: one request refreshes at a time; a changed verified email is recorded", async () => {
  await addMember(w, "ada@example.com");
  const cookie = sessionOf(await finish(await begin()))!;
  w.clock.t += VALIDATE_EVERY_MS;
  for (const r of fake.rts.values()) r.email = "ada.lovelace@example.com";
  const all = await Promise.all([1, 2, 3, 4].map(() => call(w, "GET", "/v1/me", { cookie })));
  assert.deepEqual(all.map((r) => r.res.status), [200, 200, 200, 200]);
  assert.equal(fake.refreshCalls, 1);
  assert.equal((await w.db.all<{ email: string }>(`SELECT email FROM identities`))[0]!.email, "ada.lovelace@example.com");
});

test("sign-out ends only our session; WorkOS isn't asked", async () => {
  await addMember(w, "ada@example.com");
  const cookie = sessionOf(await finish(await begin()))!;
  const urls = fake.urls.length;
  assert.equal((await call(w, "POST", "/v1/auth/sign-out", { cookie })).res.status, 200);
  assert.equal((await call(w, "GET", "/v1/me", { cookie })).res.status, 401);
  assert.equal(fake.urls.length, urls);
  assert.equal(API_KEY.length > 0, true);
});
