import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { authorizeUrl, clearKeyCache, exchangeCode, refreshSession, userOf, verifyAccessToken, type WorkosConfig } from "./workos.ts";
import { API_KEY, CLIENT, CONFIG, DEFAULT_CLIENT, FakeWorkos, ISSUER, JWKS_URL, WORKOS_API, newPair } from "./testing/fake-workos.ts";

const T = Date.UTC(2027, 1, 1, 9, 0, 0);
const SUB = "user_01ABC";
const SID = "session_01XYZ";

let fake: FakeWorkos;
beforeEach(() => {
  clearKeyCache();
  fake = new FakeWorkos();
  fake.now = () => T;
});
const verify = (token: unknown, now = T, c: WorkosConfig = CONFIG) => verifyAccessToken(c, token, { now, fetch: fake.fetch });
const good = (extra: Record<string, unknown> = {}, o: Parameters<FakeWorkos["sign"]>[1] = {}) => fake.sign(fake.claims(SUB, SID, T, extra), o);

test("verify: a current token of this environment, for this client, names its user and session", async () => {
  const r = await verify(good());
  assert.deepEqual(r.ok && [r.subject, r.sid], [SUB, SID]);
  assert.deepEqual(fake.urls, [JWKS_URL]); // (the configured key set, not one built from our client id)
});

test("verify: the line between the two apps of one environment is client_id, both ways", async () => {
  // the default app's token (the other site's) is refused here
  const theirs = good({ client_id: DEFAULT_CLIENT });
  assert.deepEqual(await verify(theirs), { ok: false, kind: "invalid", why: "client" });
  // and ours is refused by a verifier configured as the default app
  const asDefault: WorkosConfig = { ...CONFIG, clientId: DEFAULT_CLIENT };
  assert.deepEqual(await verify(good(), T, asDefault), { ok: false, kind: "invalid", why: "client" });
  assert.equal((await verify(theirs, T, asDefault)).ok, true);
  // no client id at all
  const { client_id: _c, ...noClient } = fake.claims(SUB, SID, T);
  assert.equal((await verify(fake.sign(noClient))).ok, false);
});

test("verify: issuer, algorithm, signature and key", async () => {
  for (const [what, token] of [
    ["another issuer", good({ iss: `${WORKOS_API}/user_management/${CLIENT}` })], // (a per-client issuer is not this environment's)
    ["no issuer", fake.sign((({ iss: _i, ...c }) => c)(fake.claims(SUB, SID, T)))],
    ["alg none", good({}, { alg: "none" })],
    ["HS256", good({}, { alg: "HS256" })],
    ["a stranger's key", good({}, { key: newPair().privateKey })],
    ["a tampered payload", (() => { const [h, , s] = good().split("."); return `${h}.${Buffer.from(JSON.stringify(fake.claims("user_01EVE", SID, T))).toString("base64url")}.${s}`; })()],
  ] as const) {
    const r = await verify(token);
    assert.equal(r.ok, false, what);
    assert.equal(!r.ok && r.kind, "invalid", what);
  }
});

test("verify: time, subject and session claims", async () => {
  const s = Math.floor(T / 1000);
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["expired", { exp: s - 1 }, false],
    ["iat 60 s ahead", { iat: s + 60 }, true],
    ["iat 61 s ahead", { iat: s + 61 }, false],
    ["not yet valid", { nbf: s + 120 }, false],
    ["bad sub", { sub: "usr_01" }, false],
    ["sub too long", { sub: "user_" + "a".repeat(124) }, false],
    ["sub at its longest", { sub: "user_" + "a".repeat(123) }, true],
    ["bad sid", { sid: "sess_1" }, false],
    ["sid with a dash", { sid: "session_01-x" }, false],
    ["no exp", { exp: undefined }, false],
    ["no sid", { sid: undefined }, false],
  ];
  for (const [what, extra, ok] of cases) {
    const c = fake.claims(SUB, SID, T, extra);
    for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
    assert.equal((await verify(fake.sign(c))).ok, ok, what);
  }
  for (const bad of ["", "a.b", "a.b.c.d", 5, null, "x".repeat(8193)]) assert.deepEqual(await verify(bad), { ok: false, kind: "invalid", why: "shape" }, String(bad).slice(0, 20));
});

test("verify: a rotated key is found by fetching again, at most once a minute", async () => {
  assert.equal((await verify(good())).ok, true);
  const k2 = newPair();
  fake.keys.push(fake.jwk(k2, "k2"));
  const at = (ms: number, o: Parameters<FakeWorkos["sign"]>[1] = {}) => fake.sign(fake.claims(SUB, SID, ms), o);
  // within a minute of the last fetch (an attempt counts), an unknown kid isn't looked up again
  assert.deepEqual(await verify(at(T + 30_000, { kid: "k2", key: k2.privateKey }), T + 30_000), { ok: false, kind: "invalid", why: "ERR_JWKS_NO_MATCHING_KEY" });
  assert.equal(fake.jwksFetches, 1);
  // after it, once: and the rotated key is found
  assert.equal((await verify(at(T + 61_000, { kid: "k2", key: k2.privateKey }), T + 61_000)).ok, true);
  assert.equal(fake.jwksFetches, 2);
  // a kid nobody publishes: one more look after the minute, then not again within it
  assert.equal((await verify(at(T + 125_000, { kid: "k9" }), T + 125_000)).ok, false);
  assert.equal(fake.jwksFetches, 3);
  assert.equal((await verify(at(T + 126_000, { kid: "k9" }), T + 126_000)).ok, false);
  assert.equal(fake.jwksFetches, 3);
});

test("verify: the key set unavailable is never 'invalid'; a cooldown after a failure; a huge one refused", async () => {
  fake.jwksStatus = 503;
  assert.deepEqual(await verify(good()), { ok: false, kind: "unavailable", why: "jwks" });
  fake.jwksStatus = 200;
  assert.deepEqual(await verify(good(), T + 4_000), { ok: false, kind: "unavailable", why: "jwks" }); // (cooling down)
  assert.equal(fake.jwksFetches, 1);
  assert.equal((await verify(good(), T + 6_000)).ok, true);
  clearKeyCache();
  fake.jwksHuge = true;
  assert.deepEqual(await verify(good()), { ok: false, kind: "unavailable", why: "jwks" });
});

test("verify: the cache lasts 10 minutes, and concurrent callers share one fetch", async () => {
  let open!: () => void;
  fake.jwksGate = new Promise((r) => (open = r));
  const all = Promise.all([verify(good()), verify(good()), verify(good())]);
  await new Promise((r) => setTimeout(r, 10));
  open();
  assert.deepEqual((await all).map((r) => r.ok), [true, true, true]);
  assert.equal(fake.jwksFetches, 1);
  fake.jwksGate = null;
  const at = (ms: number) => fake.sign(fake.claims(SUB, SID, ms));
  assert.equal((await verify(at(T + 600_000), T + 600_000)).ok, true);
  assert.equal(fake.jwksFetches, 1);
  assert.equal((await verify(at(T + 600_001), T + 600_001)).ok, true);
  assert.equal(fake.jwksFetches, 2);
});

test("authorizeUrl: AuthKit with PKCE S256, our client, our redirect", () => {
  const u = new URL(authorizeUrl(CONFIG, { redirectUri: "https://gpu.example.com/v1/auth/callback", state: "st", challenge: "ch" }));
  assert.equal(u.origin + u.pathname, `${WORKOS_API}/user_management/authorize`);
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    client_id: CLIENT,
    redirect_uri: "https://gpu.example.com/v1/auth/callback",
    response_type: "code",
    provider: "authkit",
    state: "st",
    code_challenge: "ch",
    code_challenge_method: "S256",
  });
});

test("exchangeCode: tokens and the verified user; every failure classed", async () => {
  fake.grant("c1", { subject: SUB, sid: SID, verifier: "v1", email: " Ada@Example.COM " });
  const r = await exchangeCode(CONFIG, "c1", "v1", fake.fetch);
  assert.ok(r.ok);
  assert.equal(typeof r.accessToken, "string");
  assert.match(r.refreshToken!, /^rt_/);
  assert.deepEqual(r.user, { id: SUB, email: "ada@example.com" });
  assert.deepEqual(fake.bodies.at(-1), { client_id: CLIENT, client_secret: API_KEY, grant_type: "authorization_code", code: "c1", code_verifier: "v1" });
  // a used code, or the wrong verifier: WorkOS says no
  assert.deepEqual(await exchangeCode(CONFIG, "c1", "v1", fake.fetch), { ok: false, kind: "invalid", status: 400 });
  fake.grant("c2", { subject: SUB, sid: SID, verifier: "v2" });
  assert.deepEqual(await exchangeCode(CONFIG, "c2", "wrong", fake.fetch), { ok: false, kind: "invalid", status: 400 });
  for (const status of [500, 503, 429, 408]) {
    fake.authStatus = status;
    assert.deepEqual(await exchangeCode(CONFIG, "x", "y", fake.fetch), { ok: false, kind: "unavailable", status }, String(status));
  }
  fake.authStatus = 401;
  assert.deepEqual(await exchangeCode(CONFIG, "x", "y", fake.fetch), { ok: false, kind: "invalid", status: 401 });
  fake.authStatus = 0;
  fake.authThrows = true;
  assert.deepEqual(await exchangeCode(CONFIG, "x", "y", fake.fetch), { ok: false, kind: "unavailable", status: 0 });
  fake.authThrows = false;
  fake.authGarbage = true;
  fake.grant("c3", { subject: SUB, sid: SID, verifier: "v3" });
  assert.deepEqual(await exchangeCode(CONFIG, "c3", "v3", fake.fetch), { ok: false, kind: "unavailable", status: 200 });
  fake.authGarbage = false;
  // no refresh token in the answer: null
  fake.grant("c4", { subject: SUB, sid: SID, verifier: "v4", noRefresh: true });
  const r4 = await exchangeCode(CONFIG, "c4", "v4", fake.fetch);
  assert.equal(r4.ok && r4.refreshToken, null);
  // an empty or oversized refresh token is none; the longest is kept
  for (const [refresh, kept] of [["", null], ["r".repeat(8193), null], ["r".repeat(8192), "r".repeat(8192)]] as const) {
    fake.grant("c5", { subject: SUB, sid: SID, verifier: "v5", refresh });
    const r5 = await exchangeCode(CONFIG, "c5", "v5", fake.fetch);
    assert.equal(r5.ok && r5.refreshToken, kept, String(refresh.length));
  }
});

test("refreshSession: rotated on success; refused only for invalid_grant", async () => {
  fake.rts.set("rt_a", { subject: SUB, sid: SID, email: "a@example.com" });
  const r = await refreshSession(CONFIG, "rt_a", fake.fetch);
  assert.ok(r.ok);
  assert.notEqual(r.refreshToken, "rt_a");
  assert.deepEqual(r.user, { id: SUB, email: "a@example.com" });
  assert.deepEqual(await refreshSession(CONFIG, "rt_a", fake.fetch), { ok: false, kind: "refused", status: 400 }); // (rotated away)
  for (const [status, body, kind] of [
    [400, JSON.stringify({ code: "invalid_grant" }), "refused"],
    [400, JSON.stringify({ error: "invalid_request" }), "unavailable"],
    [400, "not json", "unavailable"],
    [401, JSON.stringify({ error: "invalid_grant" }), "unavailable"],
    [403, "", "unavailable"],
    [404, "", "unavailable"],
    [500, "", "unavailable"],
  ] as const) {
    fake.refreshStatus = { status, body };
    assert.deepEqual(await refreshSession(CONFIG, "rt_x", fake.fetch), { ok: false, kind, status }, `${status} ${body}`);
  }
  fake.refreshStatus = null;
  fake.refreshThrows = true;
  assert.deepEqual(await refreshSession(CONFIG, "rt_x", fake.fetch), { ok: false, kind: "unavailable", status: 0 });
  fake.refreshThrows = false;
  fake.refreshNoRt = true;
  fake.rts.set("rt_b", { subject: SUB, sid: SID, email: "a@example.com" });
  assert.deepEqual(await refreshSession(CONFIG, "rt_b", fake.fetch), { ok: false, kind: "unavailable", status: 200 });
});

test("userOf: the email only when verified, trimmed and lowercased, and well formed", () => {
  assert.deepEqual(userOf({ user: { id: "user_1", email: " A@B.C ", email_verified: true } }), { id: "user_1", email: "a@b.c" });
  for (const [u, email] of [
    [{ id: "user_1", email: "a@b.c", email_verified: false }, null],
    [{ id: "user_1", email: "a@b.c" }, null],
    [{ id: "user_1", email: "a@b@c", email_verified: true }, null],
    [{ id: "user_1", email: "a b@c", email_verified: true }, null],
    [{ id: "user_1", email: "@c", email_verified: true }, null],
    [{ id: "user_1", email: "a@" + "c".repeat(319), email_verified: true }, null], // (321 characters)
    [{ id: "user_1", email: "a@" + "c".repeat(318), email_verified: true }, "a@" + "c".repeat(318)], // (320)
  ] as const) {
    assert.deepEqual(userOf({ user: u }), { id: "user_1", email }, JSON.stringify(u).slice(0, 60));
  }
  for (const j of [null, {}, { user: null }, { user: { id: "" } }, { user: { id: 5 } }, { user: { id: "u".repeat(201) } }]) assert.equal(userOf(j), null);
  assert.deepEqual(ISSUER.endsWith(DEFAULT_CLIENT), true);
});

// ---- redirects: never followed (two local origins; the second must receive nothing)

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

async function listen(handler: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body?: string }): Promise<{ origin: string; server: Server; seen: Array<{ url: string; body: string }> }> {
  const seen: Array<{ url: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body });
      const a = handler(req, body);
      res.writeHead(a.status, a.headers ?? {});
      res.end(a.body ?? "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, seen };
}

test("no WorkOS request follows a redirect: the second origin receives nothing (and, followed, it would get the API key)", async () => {
  const evil = await listen(() => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ access_token: "x", refresh_token: "y", keys: [] }) }));
  const workos = await listen((req) => ({ status: 307, headers: { location: `${evil.origin}${req.url}` } }));
  try {
    const c: WorkosConfig = { ...CONFIG, api: workos.origin, jwksUrl: `${workos.origin}/sso/jwks/${DEFAULT_CLIENT}` };
    const real = (i: string, init?: RequestInit) => fetch(i, init);
    assert.deepEqual(await exchangeCode(c, "code", "verifier", real), { ok: false, kind: "unavailable", status: 307 });
    assert.deepEqual(await refreshSession(c, "rt_secret", real), { ok: false, kind: "unavailable", status: 307 });
    clearKeyCache();
    assert.deepEqual(await verifyAccessToken(c, good(), { now: T, fetch: real }), { ok: false, kind: "unavailable", why: "jwks" });
    assert.equal(workos.seen.length, 3);
    assert.deepEqual(evil.seen, []);
    // the control: the same requests, made to follow, would hand the second origin the API key and the refresh token
    const follow = (i: string, init?: RequestInit) => fetch(i, { ...init, redirect: "follow" });
    await exchangeCode(c, "code", "verifier", follow);
    await refreshSession(c, "rt_secret", follow);
    const got: Array<{ url: string; body: string }> = evil.seen; // (re-read: the assertion above narrowed it)
    assert.equal(got.length, 2);
    assert.ok(got.every((x) => x.body.includes(API_KEY)));
    assert.ok(got[1]!.body.includes("rt_secret"));
  } finally {
    workos.server.close();
    evil.server.close();
  }
});
