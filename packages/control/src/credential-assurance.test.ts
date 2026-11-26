// Recent reauthentication with MFA proven per session (BYOK design r3, row 4): the session's
// authentication facts, the assurance route, the check quota, using an assurance, and /me's
// window. WorkOS is the fake (no network); every row is mock-only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CREDENTIAL_REFUSALS, ERROR_STATUS, credentialRefusalBody, newId, type CredentialRefusal } from "@sbgpu/api";
import { AUTH_COOKIE, VALIDATE_EVERY_MS, type AuthConfig } from "./auth.ts";
import { stmt, type Db, type SqlValue } from "./db.ts";
import { SESSION_COOKIE, sha256Hex } from "./http.ts";
import { MAX_FACTOR_PAGES, clearKeyCache } from "./workos.ts";
import { ASSURANCE_MS, CHECKS_PER_HOUR, consumeAssurance, liveAssurance, reserveCheck, type AssuranceBinding } from "./credential-assurance.ts";
import { CLIENT, CONFIG, FakeWorkos } from "./testing/fake-workos.ts";
import { MIGRATIONS_DIR } from "./testing/sqlite.ts";
import { ORIGIN, T0, addMember, call, signIn, world, type World } from "./testing/world.ts";

const AUTH: AuthConfig = { workos: CONFIG, stateKey: "s".repeat(40), refreshKeys: `v1:${randomBytes(32).toString("base64")}` };
const FACTOR = "auth_factor_01TOTP";
const HOUR = 3_600_000;

let fake: FakeWorkos;
let w: World;
beforeEach(async () => {
  clearKeyCache();
  fake = new FakeWorkos();
  w = await world({ auth: AUTH, fetch: fake.fetch, budget: 0 });
  fake.now = () => w.clock.t;
});

const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`) && !c.includes("Max-Age=0"))?.split(";")[0];

let n = 0;
/**
 * A person signed in through WorkOS (the fake), owner of a fresh byok organization, with one
 * TOTP factor: their cookie, user, session hash, WorkOS user and organization.
 */
async function owner(o: { reauth?: boolean; authTimeMs?: number; act?: boolean; impersonator?: boolean; mode?: string; role?: string; factors?: number } = {}) {
  const i = ++n;
  const email = `owner${i}@example.com`;
  const sub = `user_01OWNER${i}`;
  await addMember(w, email, "member");
  const start = await call(w, "GET", `/v1/auth/start${o.reauth === false ? "" : "?reauth=1"}`);
  const to = new URL(start.res.headers.get("location")!);
  const code = `code_${i}`;
  fake.grantChallenge(code, to.searchParams.get("code_challenge")!, {
    subject: sub, sid: `session_01S${i}`, email,
    ...(o.authTimeMs !== undefined ? { authTimeMs: o.authTimeMs } : {}),
    ...(o.act ? { act: true } : {}), ...(o.impersonator ? { impersonator: true } : {}),
  });
  const done = await call(w, "GET", `/v1/auth/callback?code=${code}&state=${to.searchParams.get("state")}`, { cookie: cookieOf(start.res, AUTH_COOKIE)! });
  const cookie = cookieOf(done.res, SESSION_COOKIE)!;
  assert.ok(cookie, "signed in");
  const hash = await sha256Hex(cookie.split("=")[1]!);
  const userId = (await w.db.all<{ user_id: string }>(`SELECT user_id FROM sessions WHERE id_sha256 = ?`, [hash]))[0]!.user_id;
  const orgId = newId("org");
  await w.db.batch([
    stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'B', ?, 0, ?)`, orgId, o.mode ?? "byok", T0),
    stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)`, orgId, userId, o.role ?? "owner"),
  ]);
  fake.factors.set(sub, Array.from({ length: o.factors ?? 1 }, (_, k) => ({ id: k === 0 ? FACTOR : `${FACTOR}${k}`, type: "totp", user_id: sub })));
  return { cookie, userId, hash, sub, orgId, sid: `session_01S${i}` };
}
type Owner = Awaited<ReturnType<typeof owner>>;

const verify = (p: Owner, body: unknown = { code: fake.totpCode }, orgId = p.orgId) => call(w, "POST", `/v1/orgs/${orgId}/credentials/assurance`, { cookie: p.cookie, body });
const assurances = (db: Db = w.db) => db.all<Record<string, SqlValue>>(`SELECT * FROM credential_assurances ORDER BY id`);
const quotaUsed = async (orgId: string) => (await w.db.all<{ u: number }>(`SELECT coalesce(sum(used), 0) AS u FROM credential_check_quota WHERE org_id = ?`, [orgId]))[0]!.u;

function refused(r: Awaited<ReturnType<typeof call>>, name: CredentialRefusal, why: string = name) {
  assert.equal(r.res.status, ERROR_STATUS[CREDENTIAL_REFUSALS[name].code], why);
  assert.deepEqual(r.json, credentialRefusalBody(name), why);
}

const binding = (p: Owner, over: Partial<AssuranceBinding> = {}): AssuranceBinding => ({
  sessionHash: p.hash, userId: p.userId, orgId: p.orgId, env: CONFIG.env, clientId: CLIENT, factorId: FACTOR, ...over,
});
/** A key change's batch in miniature: use an assurance, then a write that must apply only with it. */
async function change(b: AssuranceBinding, mark: string): Promise<boolean> {
  try {
    await w.db.batch([...consumeAssurance(b, w.clock.t), stmt(`UPDATE orgs SET name = ? WHERE id = ?`, mark, b.orgId)]);
    return true;
  } catch (e) {
    assert.match(String(e), /CHECK constraint failed: ok = 1/);
    return false;
  }
}
const nameOf = async (orgId: string) => (await w.db.all<{ name: string }>(`SELECT name FROM orgs WHERE id = ?`, [orgId]))[0]!.name;

// ---------------------------------------------------------------- the authentication

test("sign-in: reauth=1 asks WorkOS for a fresh authentication (max_age=0); a plain sign-in doesn't", async () => {
  const a = new URL((await call(w, "GET", "/v1/auth/start?reauth=1")).res.headers.get("location")!);
  assert.equal(a.searchParams.get("max_age"), "0");
  for (const q of ["", "?reauth=0", "?reauth=true", "?reauth=1x"]) {
    const b = new URL((await call(w, "GET", `/v1/auth/start${q}`)).res.headers.get("location")!);
    assert.equal(b.searchParams.has("max_age"), false, q);
  }
});

test("sign-in: the session keeps the token's auth_time, its WorkOS session id, and whether anyone impersonated", async () => {
  const p = await owner({ authTimeMs: T0 - 7000 });
  const s = (await w.db.all<Record<string, SqlValue>>(`SELECT authenticated_ms, workos_sid, impersonated FROM sessions WHERE id_sha256 = ?`, [p.hash]))[0]!;
  assert.deepEqual({ ...s }, { authenticated_ms: T0 - 7000, workos_sid: p.sid, impersonated: 0 });
  for (const o of [{ act: true }, { impersonator: true }, { act: true, impersonator: true }]) {
    const q = await owner(o);
    assert.equal((await w.db.all<{ i: number }>(`SELECT impersonated AS i FROM sessions WHERE id_sha256 = ?`, [q.hash]))[0]!.i, 1, JSON.stringify(o));
  }
});

test("refresh: never extends the authentication; records a changed WorkOS session id; impersonation only rises", async () => {
  const p = await owner();
  w.clock.t += VALIDATE_EVERY_MS;
  fake.refreshSid = "session_01CHANGED";
  fake.refreshClaims = { auth_time: Math.floor(w.clock.t / 1000), act: { sub: "admin@example.com" } };
  assert.equal((await call(w, "GET", "/v1/me", { cookie: p.cookie })).res.status, 200);
  assert.equal(fake.refreshCalls, 1);
  const s = (await w.db.all<Record<string, SqlValue>>(`SELECT authenticated_ms, workos_sid, impersonated FROM sessions WHERE id_sha256 = ?`, [p.hash]))[0]!;
  assert.deepEqual({ ...s }, { authenticated_ms: T0, workos_sid: "session_01CHANGED", impersonated: 1 });
  // and a later refresh without act doesn't lower it
  w.clock.t += VALIDATE_EVERY_MS;
  fake.refreshClaims = null;
  await call(w, "GET", "/v1/me", { cookie: p.cookie });
  assert.equal(fake.refreshCalls, 2);
  assert.equal((await w.db.all<{ i: number }>(`SELECT impersonated AS i FROM sessions WHERE id_sha256 = ?`, [p.hash]))[0]!.i, 1);
});

test("schema: a session's authentication time is fixed; its impersonation only rises", async () => {
  const p = await owner();
  const upd = (set: string, ...v: SqlValue[]) => w.db.batch([stmt(`UPDATE sessions SET ${set} WHERE id_sha256 = ?`, ...v, p.hash)]);
  await assert.rejects(upd(`authenticated_ms = authenticated_ms + 1`), /authentication time is fixed/);
  await assert.rejects(upd(`authenticated_ms = NULL`), /authentication time is fixed/);
  await assert.rejects(upd(`impersonated = NULL`), /only ever rises/);
  await upd(`impersonated = 1`);
  await assert.rejects(upd(`impersonated = 0`), /only ever rises/);
  await assert.rejects(upd(`impersonated = 2`), /only ever rises/);
  for (const [col, v] of [["impersonated", 2], ["impersonated", -1], ["authenticated_ms", -1]] as const) {
    await assert.rejects(w.db.batch([stmt(`INSERT INTO sessions (id_sha256, user_id, created_ms, expires_ms, ${col}) VALUES (?, ?, ?, ?, ?)`, "e".repeat(64), p.userId, T0, T0 + 1, v)]), /CHECK/, `${col}=${v}`);
  }
  for (const sid of ["session_", "sess_01", "sessionX01", "xxxxxxxx01", "session_01-x", `session_${"a".repeat(121)}`, "session_01" + String.fromCharCode(0)]) await assert.rejects(upd(`workos_sid = ?`, sid), sid);
  await upd(`workos_sid = 'session_01OTHER'`);
});

// ---------------------------------------------------------------- the route

test("assurance: a verified code writes one assurance bound to everything, and the page's window", async () => {
  const p = await owner({ authTimeMs: T0 - 1000 });
  w.clock.t = T0 + 2000;
  const r = await verify(p);
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json, { recentAuthForMs: ASSURANCE_MS - 3000 });
  const rows = await assurances();
  assert.equal(rows.length, 1);
  const { id: _id, ...row } = rows[0]!;
  assert.deepEqual({ ...row }, {
    session_sha256: p.hash, workos_sid: p.sid, user_id: p.userId, org_id: p.orgId, factor_id: FACTOR, auth_time_ms: T0 - 1000,
    env: CONFIG.env, client_id: CLIENT, impersonated: 0, created_ms: T0 + 2000, expires_ms: T0 - 1000 + ASSURANCE_MS, used_ms: null,
  });
  assert.equal(await quotaUsed(p.orgId), 1);
  assert.equal(fake.verifyCalls, 1);
  assert.equal((await call(w, "GET", `/v1/me?orgId=${p.orgId}`, { cookie: p.cookie })).json.recentAuthForMs, ASSURANCE_MS - 3000);
});

test("assurance: the window is 300 s from the authentication (auth_time is in whole seconds)", async () => {
  const q = await owner({ authTimeMs: T0 - ASSURANCE_MS + 1000 });
  assert.equal((await verify(q)).json.recentAuthForMs, 1000, "a second left");
  // exactly 300000 ms after: fresh, but an assurance would be born expired, so none is written
  w.clock.t = T0 + 1000;
  refused(await verify(q), "reauthenticate", "300000 ms");
  w.clock.t = T0 + 1001;
  refused(await verify(q), "reauthenticate", "300001 ms");
  assert.equal((await assurances()).length, 1);
});

test("assurance: each refusal in its place, writing nothing (the quota only from its own step on)", async () => {
  const p = await owner();
  const calls = () => fake.factorCalls + fake.verifyCalls;
  // the body: over 256 bytes, not JSON, not exactly { code } of six digits: no quota, no WorkOS
  refused(await verify(p, { code: "1".repeat(300) }), "mfaInvalid", "oversized");
  const raw = await w.app.fetch(new Request(`${ORIGIN}/v1/orgs/${p.orgId}/credentials/assurance`, { method: "POST", headers: { origin: ORIGIN, cookie: p.cookie, "content-type": "application/json" }, body: "{nope" }));
  assert.deepEqual(await raw.json(), credentialRefusalBody("mfaInvalid"));
  for (const body of [{}, { code: "12345" }, { code: "1234567" }, { code: 123456 }, { code: "12345a" }, { code: "123456", x: 1 }, { Code: "123456" }]) {
    refused(await verify(p, body), "mfaInvalid", JSON.stringify(body));
  }
  assert.equal(calls(), 0);
  assert.equal(await quotaUsed(p.orgId), 0);
  // signed out; not an owner (a viewer, a non-member); a resold org
  refused(await call(w, "POST", `/v1/orgs/${p.orgId}/credentials/assurance`, { body: { code: "123456" } }), "signedOut");
  refused(await call(w, "POST", `/v1/orgs/${p.orgId}/credentials/assurance`, { cookie: `${SESSION_COOKIE}=nope`, body: { code: "123456" } }), "signedOut");
  const viewer = await owner({ role: "viewer" });
  refused(await verify(viewer), "notOwner");
  refused(await verify(p, { code: "123456" }, viewer.orgId), "notOwner", "another org");
  refused(await verify(p, { code: "123456" }, newId("org")), "notOwner", "no such org");
  const resold = await owner({ mode: "resold" });
  refused(await verify(resold), "notByok");
  // a stale, unknown or impersonated authentication
  const stale = await owner({ authTimeMs: T0 - ASSURANCE_MS - 1 });
  refused(await verify(stale), "reauthenticate", "stale");
  for (const o of [{ act: true }, { impersonator: true }]) refused(await verify(await owner(o)), "reauthenticate", JSON.stringify(o));
  // (a session made without WorkOS: no authentication facts)
  await addMember(w, "plain@example.com", "member");
  const plain = await signIn(w, "plain@example.com");
  const u = (await w.db.all<{ user_id: string }>(`SELECT id AS user_id FROM users WHERE email = 'plain@example.com'`))[0]!.user_id;
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, p.orgId, u)]);
  refused(await call(w, "POST", `/v1/orgs/${p.orgId}/credentials/assurance`, { cookie: plain, body: { code: "123456" } }), "reauthenticate", "a session with no authentication facts");
  const nosid = await owner();
  await w.db.batch([stmt(`UPDATE sessions SET workos_sid = NULL WHERE id_sha256 = ?`, nosid.hash)]);
  refused(await verify(nosid), "reauthenticate", "no WorkOS session id");
  assert.equal(await quotaUsed(nosid.orgId), 0);
  assert.equal(calls(), 0);
  assert.equal(await quotaUsed(p.orgId), 0);
  // no TOTP factor, or two: mfaRequired (a reservation spent)
  fake.factors.set(p.sub, [{ id: "auth_factor_01SMS", type: "sms", user_id: p.sub }]);
  refused(await verify(p), "mfaRequired", "none");
  fake.factors.set(p.sub, [{ id: FACTOR, type: "totp", user_id: p.sub }, { id: "auth_factor_02", type: "totp", user_id: p.sub }]);
  refused(await verify(p), "mfaRequired", "two");
  fake.factors.set(p.sub, [{ id: FACTOR, type: "totp", user_id: "user_01SOMEONEELSE" }]);
  refused(await verify(p), "checkUnavailable", "another user's (a list we can't trust)");
  fake.factors.set(p.sub, [{ id: FACTOR, type: "totp", user_id: p.sub }]);
  // the wrong code; WorkOS down at each step; a 4xx verify
  refused(await verify(p, { code: "654321" }), "mfaInvalid", "wrong code");
  for (const k of ["factorsStatus", "challengeStatus", "verifyStatus"] as const) {
    fake[k] = 503;
    refused(await verify(p), "checkUnavailable", k);
    fake[k] = 200;
  }
  fake.verifyStatus = 422;
  refused(await verify(p), "mfaInvalid", "verify 4xx");
  fake.verifyStatus = 200;
  assert.equal((await assurances()).length, 0);
  assert.equal(await quotaUsed(p.orgId), 8);
  // and the request that passes writes one
  assert.equal((await verify(p)).res.status, 200);
  assert.equal((await assurances()).length, 1);
});

test("factors (H1): the list is read whole, page by page, and any entry or page we can't trust refuses, before any challenge", async () => {
  // (each case its own owner and organization: every verification spends a unit of its org's quota)
  const none = async (why: string, refusal: "checkUnavailable" | "mfaRequired", setUp: (p: Owner, ok: object) => void) => {
    const p = await owner();
    const ok = { object: "authentication_factor", id: FACTOR, type: "totp", user_id: p.sub };
    setUp(p, ok);
    const before = fake.verifyCalls;
    const challenges = fake.challenges.size;
    refused(await verify(p), refusal, why);
    assert.equal(fake.verifyCalls, before, `${why}: no verify`);
    assert.equal(fake.challenges.size, challenges, `${why}: no challenge`);
    assert.equal((await w.db.all(`SELECT 1 FROM credential_assurances WHERE org_id = ?`, [p.orgId])).length, 0, `${why}: no assurance`);
    fake.factorListAnswer = null;
    fake.factorPageSize = 100;
    return p;
  };
  // a valid factor with a malformed one, or another user's, is never "exactly one"
  for (const [why, bad] of [
    ["a TOTP with a malformed id", (p: Owner) => ({ id: "factor_x", type: "totp", user_id: p.sub })],
    ["a TOTP with no id", (p: Owner) => ({ type: "totp", user_id: p.sub })],
    ["another user's TOTP", () => ({ id: "auth_factor_01OTHER", type: "totp", user_id: "user_01OTHER" })],
    ["an entry with no type", (p: Owner) => ({ id: "auth_factor_01NOTYPE", user_id: p.sub })],
    ["an entry that isn't an object", () => 7],
    ["the same TOTP twice", (p: Owner) => ({ id: FACTOR, type: "totp", user_id: p.sub })],
    ["an SMS factor with a malformed id", (p: Owner) => ({ id: "x", type: "sms", user_id: p.sub })],
    ["an entry with an empty type", (p: Owner) => ({ id: "auth_factor_01EMPTY", type: "", user_id: p.sub })],
    ["an entry with an unknown type", (p: Owner) => ({ id: "auth_factor_01UNKNOWN", type: "u2f", user_id: p.sub })],
    ["an entry that isn't a factor object", (p: Owner) => ({ object: "user", id: "auth_factor_01OBJ", type: "sms", user_id: p.sub })],
    ["the same id twice, once as SMS", (p: Owner) => ({ id: FACTOR, type: "sms", user_id: p.sub })],
  ] as const) {
    await none(why, "checkUnavailable", (p, ok) => fake.factors.set(p.sub, [ok, bad(p)] as never));
  }
  // a second TOTP on the next page is seen: two factors
  await none("a second TOTP on page 2", "mfaRequired", (p, ok) => {
    fake.factorPageSize = 1;
    fake.factors.set(p.sub, [ok, { id: "auth_factor_02", type: "totp", user_id: p.sub }] as never);
  });
  assert.deepEqual(fake.factorQueries.slice(-2), ["?limit=100", `?limit=100&after=${FACTOR}`]);
  // the envelope and the pagination: malformed, a cursor loop, too many pages, a cursor that isn't one
  const answers: Array<[string, (ok: object, p: Owner) => (q: URLSearchParams) => unknown]> = [
    ["no list_metadata", (ok) => () => ({ object: "list", data: [ok] })],
    ["list_metadata not an object", (ok) => () => ({ object: "list", data: [ok], list_metadata: "x" })],
    ["after not a cursor", (ok) => () => ({ object: "list", data: [ok], list_metadata: { after: 7 } })],
    ["after missing", (ok) => () => ({ object: "list", data: [ok], list_metadata: {} })],
    ["a malformed cursor", (ok) => () => ({ object: "list", data: [ok], list_metadata: { after: "a b" } })],
    ["data not a list", () => () => ({ object: "list", data: {}, list_metadata: { after: null } })],
    ["a page past the limit", (_ok, p) => () => ({ object: "list", data: Array.from({ length: 101 }, (_, i) => ({ object: "authentication_factor", id: `auth_factor_01S${i}`, type: "sms", user_id: p.sub })), list_metadata: { after: null } })],
    ["a cursor loop", (ok) => (q) => ({ object: "list", data: q.get("after") === null ? [ok] : [], list_metadata: { after: "auth_factor_01LOOP" } })],
    ["more pages than the bound (each cursor new)", () => { let n = 0; return () => ({ object: "list", data: [], list_metadata: { after: `auth_factor_01P${n++}` } }); }],
    ["no list marker (object)", (ok) => () => ({ data: [ok], list_metadata: { after: null } })],
    ["another list marker", (ok) => () => ({ object: "page", data: [ok], list_metadata: { after: null } })],
  ];
  for (const [why, answer] of answers) {
    const reads = fake.factorQueries.length;
    await none(why, "checkUnavailable", (p, ok) => { fake.factorListAnswer = answer(ok, p); });
    if (why.startsWith("more pages")) assert.equal(fake.factorQueries.length - reads, MAX_FACTOR_PAGES, "the bound: exactly that many pages read");
  }
  // the positive control: one TOTP and an SMS factor, across two pages, is exactly one
  const p = await owner();
  fake.factorPageSize = 1;
  fake.factors.set(p.sub, [{ id: "auth_factor_01SMS", type: "sms", user_id: p.sub }, { id: FACTOR, type: "totp", user_id: p.sub }]);
  assert.equal((await verify(p)).res.status, 200);
  fake.factorPageSize = 100;
});

test("assurance: the 256-byte body cap, on a valid body: 256 bytes passes; 257 is refused before parsing, with no quota and no WorkOS call", async () => {
  const send = (p: Owner, bytes: number) => {
    const body = JSON.stringify({ code: fake.totpCode });
    return w.app.fetch(new Request(`${ORIGIN}/v1/orgs/${p.orgId}/credentials/assurance`, {
      method: "POST", headers: { origin: ORIGIN, cookie: p.cookie, "content-type": "application/json" }, body: body + " ".repeat(bytes - body.length),
    }));
  };
  const p = await owner();
  const calls = fake.factorCalls + fake.verifyCalls;
  const over = await send(p, 257);
  assert.deepEqual([over.status, await over.json()], [ERROR_STATUS[CREDENTIAL_REFUSALS.mfaInvalid.code], credentialRefusalBody("mfaInvalid")]);
  assert.deepEqual([await quotaUsed(p.orgId), fake.factorCalls + fake.verifyCalls, (await assurances()).length], [0, calls, 0]);
  const at = await send(p, 256);
  assert.equal(at.status, 200, "exactly 256 bytes");
  assert.equal((await assurances()).length, 1);
});

test("assurance: every refusal is one of the fixed credential refusals, and none carries the code", async () => {
  const p = await owner();
  const answers = [
    await verify(p, { code: "654321" }), await verify(p, { code: "x".repeat(400) }), await call(w, "POST", `/v1/orgs/${p.orgId}/credentials/assurance`, { body: { code: "123456" } }),
  ];
  for (const r of answers) {
    assert.ok(Object.keys(CREDENTIAL_REFUSALS).some((k) => JSON.stringify(r.json) === JSON.stringify(credentialRefusalBody(k as CredentialRefusal))), JSON.stringify(r.json));
    assert.equal(JSON.stringify(r.json).includes("654321"), false);
  }
});

test("assurance: impersonation arising before the write leaves none", async () => {
  const p = await owner();
  // (the session turns impersonated while WorkOS is asked)
  const real = fake.fetch;
  w.deps.fetch = async (u, init) => {
    if (String(u).includes("/verify")) await w.db.batch([stmt(`UPDATE sessions SET impersonated = 1 WHERE id_sha256 = ?`, p.hash)]);
    return real(u, init);
  };
  refused(await verify(p), "reauthenticate");
  assert.equal((await assurances()).length, 0);
});

test("assurance: the owner role lost while WorkOS is asked leaves none; an authentication time from the future is refused", async () => {
  const p = await owner();
  const real = fake.fetch;
  w.deps.fetch = async (u, init) => {
    if (String(u).includes("/verify")) await w.db.batch([stmt(`UPDATE org_members SET role = 'viewer' WHERE org_id = ? AND user_id = ?`, p.orgId, p.userId)]);
    return real(u, init);
  };
  refused(await verify(p), "reauthenticate");
  assert.equal((await assurances()).length, 0);
  w.deps.fetch = real;
  const ahead = await owner({ authTimeMs: T0 + 61_000 });
  refused(await verify(ahead), "reauthenticate", "61 s ahead");
  const near = await owner({ authTimeMs: T0 + 60_000 });
  assert.equal((await verify(near)).res.status, 200, "60 s ahead (skew)");
});

// ---------------------------------------------------------------- the quota

test("quota: the 10th reservation passes, the 11th refuses with no WorkOS call; failures count; the window resets", async () => {
  const p = await owner();
  w.clock.t = T0 - (T0 % HOUR) + HOUR - 60_000; // (a minute before an hour's end)
  const q = await owner({ authTimeMs: w.clock.t });
  for (let i = 0; i < CHECKS_PER_HOUR - 1; i++) refused(await verify(q, { code: "000000" }), "mfaInvalid", String(i));
  assert.equal((await verify(q)).res.status, 200, "the 10th");
  const before = fake.factorCalls + fake.verifyCalls;
  refused(await verify(q), "tooManyChecks", "the 11th");
  assert.equal(fake.factorCalls + fake.verifyCalls, before);
  assert.equal(await quotaUsed(q.orgId), CHECKS_PER_HOUR);
  // another org's quota is its own
  w.clock.t = T0;
  assert.equal((await verify(p)).res.status, 200);
  // the next hour
  w.clock.t = T0 - (T0 % HOUR) + HOUR + 1;
  const r = await owner({ authTimeMs: w.clock.t });
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, q.orgId, r.userId)]);
  assert.equal((await verify(r, { code: "123456" }, q.orgId)).res.status, 200);
});

test("quota: 12 reservations at once, across two database handles, pass exactly 10", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "sbgpu-quota-")), "d1.sqlite");
  const a = new DatabaseSync(file);
  a.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) a.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  const orgId = newId("org");
  a.prepare(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'B', 'byok', 0, ?)`).run(orgId, T0);
  const b = new DatabaseSync(file);
  b.exec("PRAGMA busy_timeout = 5000");
  const handle = (raw: DatabaseSync): Db => ({
    all: async <T,>(sql: string, p: SqlValue[] = []) => raw.prepare(sql).all(...p) as T[],
    run: async (sql: string, p: SqlValue[] = []) => ({ changes: Number(raw.prepare(sql).run(...p).changes) }),
    batch: async () => assert.fail("unused"),
  });
  const [ha, hb] = [handle(a), handle(b)];
  const got = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveCheck(i % 2 ? hb : ha, orgId, T0)));
  assert.equal(got.filter(Boolean).length, CHECKS_PER_HOUR);
  assert.deepEqual({ ...(a.prepare(`SELECT used FROM credential_check_quota`).get() as object) }, { used: CHECKS_PER_HOUR });
  a.close();
  b.close();
});

test("schema: a reservation is only ever added, one at a time, within its whole hour, and never released", async () => {
  const p = await owner();
  assert.equal(await reserveCheck(w.db, p.orgId, T0), true);
  const window = T0 - (T0 % HOUR);
  const upd = (set: string) => w.db.batch([stmt(`UPDATE credential_check_quota SET ${set} WHERE org_id = ?`, p.orgId)]);
  await assert.rejects(upd(`used = used - 1`), /only ever added/);
  await assert.rejects(upd(`used = used + 2`), /only ever added/);
  await assert.rejects(upd(`window_start_ms = window_start_ms + ${HOUR}`), /only ever added/);
  await assert.rejects(w.db.batch([stmt(`DELETE FROM credential_check_quota`)]), /never released/);
  const ins = (start: number, used: number) => w.db.batch([stmt(`INSERT INTO credential_check_quota (org_id, window_start_ms, used) VALUES (?, ?, ?)`, p.orgId, start, used)]);
  await assert.rejects(ins(window + 1, 1), /CHECK/);
  await assert.rejects(ins(window + HOUR, 0), /CHECK/);
  await assert.rejects(ins(window + HOUR, 11), /CHECK/);
  await assert.rejects(ins(window + HOUR, 1).then(() => ins(window + HOUR, 1)), /UNIQUE|PRIMARY/);
  await assert.rejects(w.db.batch([stmt(`INSERT INTO credential_check_quota (org_id, window_start_ms, used) VALUES (?, ?, 1)`, newId("org"), window)]), /FOREIGN KEY/);
});

// ---------------------------------------------------------------- using an assurance

test("use: a live assurance serves exactly one change; a second (crossed) change with it is refused, writing nothing", async () => {
  const p = await owner();
  assert.equal(await change(binding(p), "first"), false, "none yet");
  assert.equal(await nameOf(p.orgId), "B");
  await verify(p);
  assert.equal(await liveAssurance(w.db, binding(p), w.clock.t), true);
  assert.equal(await change(binding(p), "first"), true);
  assert.equal(await nameOf(p.orgId), "first");
  assert.equal((await assurances())[0]!.used_ms, w.clock.t);
  assert.equal(await liveAssurance(w.db, binding(p), w.clock.t), false);
  assert.equal(await change(binding(p), "second"), false);
  assert.equal(await nameOf(p.orgId), "first");
  // two assurances: two changes, the newest used first
  await verify(p);
  w.clock.t += 1;
  await verify(p);
  assert.equal(await change(binding(p), "third"), true);
  assert.deepEqual((await assurances()).map((a) => a.used_ms === null), [false, true, false]);
});

test("use: each binding refuses on its own, and the assurance stays unused", async () => {
  const cases: Array<[string, (p: Owner) => Promise<AssuranceBinding>]> = [
    ["another session", async (p) => binding(p, { sessionHash: "f".repeat(64) })],
    ["another user", async (p) => binding(p, { userId: newId("user") })],
    ["another org (an org switch)", async (p) => {
      const o = newId("org");
      await w.db.batch([stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'C', 'byok', 0, ?)`, o, T0), stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, o, p.userId)]);
      return binding(p, { orgId: o });
    }],
    ["another environment", async (p) => binding(p, { env: "prod" })],
    ["another client", async (p) => binding(p, { clientId: "client_01OTHER" })],
    ["a factor reset (another factor listed now)", async (p) => binding(p, { factorId: "auth_factor_01NEW" })],
    ["the WorkOS session changed", async (p) => { await w.db.batch([stmt(`UPDATE sessions SET workos_sid = 'session_01NEW' WHERE id_sha256 = ?`, p.hash)]); return binding(p); }],
    ["impersonation arose", async (p) => { await w.db.batch([stmt(`UPDATE sessions SET impersonated = 1 WHERE id_sha256 = ?`, p.hash)]); return binding(p); }],
    ["the session ended", async (p) => { await w.db.batch([stmt(`UPDATE sessions SET revoked_ms = ? WHERE id_sha256 = ?`, w.clock.t, p.hash)]); return binding(p); }],
    ["the session expired", async (p) => { w.clock.t = T0 + 10; await w.db.batch([stmt(`UPDATE sessions SET expires_ms = ? WHERE id_sha256 = ?`, T0 + 5, p.hash)]); return binding(p); }],
    ["the owner role lost", async (p) => { await w.db.batch([stmt(`UPDATE org_members SET role = 'viewer' WHERE org_id = ? AND user_id = ?`, p.orgId, p.userId)]); return binding(p); }],
    ["the membership lost", async (p) => { await w.db.batch([stmt(`DELETE FROM org_members WHERE org_id = ? AND user_id = ?`, p.orgId, p.userId)]); return binding(p); }],
    ["expired (one ms past)", async (p) => { w.clock.t = T0 + ASSURANCE_MS + 1; return binding(p); }],
  ];
  for (const [why, make] of cases) {
    w.clock.t = T0;
    const p = await owner();
    assert.equal((await verify(p)).res.status, 200, why);
    const b = await make(p);
    assert.equal(await liveAssurance(w.db, b, w.clock.t), false, why);
    assert.equal(await change(b, "changed"), false, why);
    assert.notEqual(await nameOf(b.orgId), "changed", why);
    assert.equal((await w.db.all(`SELECT 1 FROM credential_assurances WHERE session_sha256 = ? AND used_ms IS NOT NULL`, [p.hash])).length, 0, why);
  }
  // the boundary: exactly at expiry still serves
  w.clock.t = T0;
  const p = await owner();
  await verify(p);
  w.clock.t = T0 + ASSURANCE_MS;
  assert.equal(await change(binding(p), "at the edge"), true);
});

test("use: a stale authentication can't be dressed up with an old assurance: a new sign-in is a new session", async () => {
  const p = await owner();
  await verify(p);
  // the same person signs in again (a new session): the old session's assurance isn't the new one's
  const q = await owner();
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, p.orgId, q.userId)]);
  assert.equal(await change({ ...binding(p), sessionHash: q.hash, userId: q.userId }, "crossed"), false);
});

test("schema: an assurance changes only by its one use; none is impersonated; its life is the shorter of the two windows", async () => {
  const p = await owner();
  await verify(p);
  const id = (await assurances())[0]!.id!;
  const upd = (set: string, ...v: SqlValue[]) => w.db.batch([stmt(`UPDATE credential_assurances SET ${set} WHERE id = ?`, ...v, id)]);
  for (const set of ["org_id = org_id || 'x'", "factor_id = 'auth_factor_01X'", "expires_ms = expires_ms + 1", "env = 'prod'", "client_id = 'client_01X'", "workos_sid = 'session_01X'", "auth_time_ms = auth_time_ms - 1", "created_ms = created_ms - 1", "session_sha256 = ?", "user_id = ?", "id = id + 100"]) {
    await assert.rejects(upd(set, ...(set.includes("?") ? ["0".repeat(64)] : [])), /changes only by its use|CHECK|FOREIGN/, set);
  }
  // (changes every CHECK and key would allow: only the trigger refuses them)
  const o2 = newId("org");
  await w.db.batch([stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'O2', 'byok', 0, ?)`, o2, T0)]);
  const u2 = (await owner()).userId;
  for (const [set, v] of [["org_id = ?", o2], ["user_id = ?", u2], ["auth_time_ms = auth_time_ms - 1000, expires_ms = expires_ms - 1000", null]] as const) {
    await assert.rejects(upd(set, ...(v === null ? [] : [v])), /changes only by its use/, set);
  }
  await upd(`used_ms = ?`, T0 + 5);
  await assert.rejects(upd(`used_ms = ?`, T0 + 6), /used once/);
  await assert.rejects(upd(`used_ms = NULL`), /used once/);
  const row = (await assurances())[0]!;
  const ins = (over: Record<string, SqlValue>) => {
    const v: Record<string, SqlValue> = { ...row, id: null, used_ms: null, ...over };
    delete v.id;
    const cols = Object.keys(v);
    return w.db.batch([{ sql: `INSERT INTO credential_assurances (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: Object.values(v) }]);
  };
  await assert.rejects(ins({ impersonated: 1 }), /CHECK/);
  await assert.rejects(ins({ expires_ms: (row.expires_ms as number) + 1 }), /CHECK/);
  await assert.rejects(ins({ created_ms: T0, auth_time_ms: T0 - 10, expires_ms: T0 + ASSURANCE_MS }), /CHECK/);
  await assert.rejects(ins({ created_ms: T0 + ASSURANCE_MS, auth_time_ms: T0, expires_ms: T0 + ASSURANCE_MS }), /CHECK/, "born expired");
  await assert.rejects(ins({ created_ms: T0, auth_time_ms: T0 + 10, expires_ms: T0 + 10 + ASSURANCE_MS }), /CHECK/, "past its creation's window");
  await assert.rejects(ins({ used_ms: (row.expires_ms as number) + 1 }), /CHECK/);
  await assert.rejects(ins({ used_ms: (row.created_ms as number) - 1 }), /CHECK/);
  for (const [col, v] of [["factor_id", "factor_01"], ["factor_id", "auth_factor_"], ["factor_id", "xxxx_factor_01"], ["client_id", "clientX01"], ["client_id", "client_"], ["client_id", CLIENT + "-"], ["env", ""], ["env", "a b"], ["env", "é"], ["session_sha256", "F".repeat(64)], ["session_sha256", "f".repeat(63)]] as const) {
    await assert.rejects(ins({ [col]: v }), `${col}=${v}`);
  }
  await ins({}); // (the same values pass)
});

// ---------------------------------------------------------------- /me

test("me: the window for ?orgId= only, for an owner there, from its newest live unused assurance", async () => {
  const p = await owner();
  const me = (q: string, cookie = p.cookie) => call(w, "GET", `/v1/me${q}`, { cookie });
  assert.equal((await me("")).json.recentAuthForMs, null);
  assert.equal((await me(`?orgId=${p.orgId}`)).json.recentAuthForMs, null, "none yet");
  for (const bad of ["x", "org_", p.orgId + "x", "mch_0123456789abcdefghjk"]) assert.equal((await me(`?orgId=${encodeURIComponent(bad)}`)).res.status, 400, bad);
  w.clock.t = T0 + 1000;
  await verify(p);
  assert.equal((await me(`?orgId=${p.orgId}`)).json.recentAuthForMs, ASSURANCE_MS - 1000);
  assert.equal((await me("")).json.recentAuthForMs, null, "no org: null");
  // another org, or not an owner there: null
  const other = await owner();
  assert.equal((await me(`?orgId=${other.orgId}`)).json.recentAuthForMs, null);
  await w.db.batch([stmt(`UPDATE org_members SET role = 'viewer' WHERE org_id = ? AND user_id = ?`, p.orgId, p.userId)]);
  assert.equal((await me(`?orgId=${p.orgId}`)).json.recentAuthForMs, null, "no longer an owner");
  await w.db.batch([stmt(`UPDATE org_members SET role = 'owner' WHERE org_id = ? AND user_id = ?`, p.orgId, p.userId)]);
  w.clock.t = T0 + ASSURANCE_MS;
  assert.equal((await me(`?orgId=${p.orgId}`)).json.recentAuthForMs, 0, "at the edge");
  w.clock.t = T0 + 2000;
  assert.equal(await change(binding(p), "used"), true);
  assert.equal((await me(`?orgId=${p.orgId}`)).json.recentAuthForMs, null, "used");
});
