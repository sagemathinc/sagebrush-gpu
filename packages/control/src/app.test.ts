import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTES, isApiErrorBody, newId, type Me } from "@sbgpu/api";
import {
  DEFAULT_CONFIG,
  HANDLERS,
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
  SESSION_COOKIE,
  base64url,
  configFromEnv,
  createApp,
  effectiveProjectRole,
  normalizeEmail,
  readCapped,
  sha256Hex,
  withSecurityHeaders,
  type AppDeps,
  type Handlers,
} from "./app.ts";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import { startSession } from "./testing/sessions.ts";
import { stmt } from "./db.ts";

const ORIGIN = "https://gpu.example.test";
const T0 = Date.UTC(2027, 1, 1, 9, 0, 0);

interface World {
  db: TestDb;
  /** Work handed to waitUntil, not yet awaited. */
  pending: Promise<unknown>[];
  deps: AppDeps;
  clock: { t: number };
  app: ReturnType<typeof createApp>;
  /** Sent when a call names no cookie. */
  defaultCookie?: string;
  orgId: string;
  projectId: string;
}

/**
 * The dispatch tests' POST route: sign-out, with a stub handler that changes nothing, called
 * signed in (see vehicleWorld). Bodies, origins and headers are checked before any handler.
 */
const VEHICLE = "/v1/auth/sign-out";
const STUB: Handlers = { signOut: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...SECURITY_HEADERS, "content-type": "application/json" } }) };

async function world(handlers?: Handlers): Promise<World> {
  const db = sqliteDb();
  const pending: Promise<unknown>[] = [];
  const clock = { t: T0 };
  let counter = 0;
  const deps: AppDeps = {
    db,
    now: () => clock.t,
    randomBytes: (n) => {
      const b = new Uint8Array(n);
      counter++;
      for (let i = 0; i < n; i++) b[i] = (counter * 31 + i * 7) & 255;
      return b;
    },
    waitUntil: (p) => {
      pending.push(p);
    },
    config: { ...DEFAULT_CONFIG, appOrigin: ORIGIN, machineDomain: "m.example.test", auth: null, installation: "test", containerLaunch: null },
    fetch: async () => {
      throw new Error("no network in tests");
    },
    vm: null,
    container: null,
    agentSigner: async () => null,
    agentPublicKeys: async () => null,
    alert: () => {},
    credentialCheck: null,
  };
  const orgId = newId("org");
  const projectId = newId("project");
  await db.batch([
    stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'Org', 'resold', 3000, ?)`, orgId, T0),
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Proj', ?, ?, 0, ?)`, projectId, orgId, T0, T0 + 86_400_000, T0),
  ]);
  return { db, pending, deps, clock, app: createApp(deps, handlers ? { ...HANDLERS, ...handlers } : HANDLERS), orgId, projectId };
}

interface Req {
  body?: unknown;
  raw?: string;
  cookie?: string;
  origin?: string | null;
  contentType?: string | null;
  /** Don't run the deferred work after the response. */
  noFlush?: boolean;
}

async function call(w: World, method: string, path: string, r: Req = {}) {
  const headers: Record<string, string> = {};
  const origin = r.origin === undefined ? ORIGIN : r.origin;
  if (origin !== null) headers.origin = origin;
  const cookie = r.cookie ?? w.defaultCookie;
  if (cookie) headers.cookie = cookie;
  let body: string | undefined;
  if (method !== "GET" && method !== "DELETE") {
    const ct = r.contentType === undefined ? "application/json" : r.contentType;
    if (ct !== null) headers["content-type"] = ct;
    body = r.raw ?? JSON.stringify(r.body ?? {});
  }
  const res = await w.app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }));
  if (!r.noFlush) await Promise.all(w.pending.splice(0));
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { res, json: json as Record<string, unknown> & { error?: { code: string } } };
}

const code = (r: { json: { error?: { code: string } } }) => r.json.error?.code;

async function invite(w: World, email: string, role = "member", projectId = w.projectId): Promise<string> {
  const id = newId("member");
  await w.db.batch([
    stmt(`INSERT INTO members (id, project_id, email, role, status, created_ms) VALUES (?, ?, ?, ?, 'invited', ?)`, id, projectId, email, role, T0),
  ]);
  return id;
}

/** Signed in, as the sign-in callback leaves a person; returns the cookie header. */
async function signIn(w: World, email: string): Promise<string> {
  return (await startSession(w.deps, email)).setCookie.split(";")[0]!;
}

/** A world whose calls go signed in, with sign-out stubbed: the dispatch tests' POST route. */
async function vehicleWorld(): Promise<World> {
  const w = await world(STUB);
  await invite(w, "v@example.com");
  w.defaultCookie = await signIn(w, "v@example.com");
  return w;
}

// ---------------------------------------------------------------- basics

test("every response carries the security headers, errors included", async () => {
  const w = await vehicleWorld();
  for (const [m, p] of [["GET", "/nope"], ["GET", "/v1/me"], ["POST", VEHICLE], ["POST", "/v1/auth/start"]] as const) {
    const { res } = await call(w, m, p, { body: { email: "x@example.com" } });
    for (const [k, v] of Object.entries({
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
    })) assert.equal(res.headers.get(k), v, `${m} ${p} ${k}`);
    assert.deepEqual(Object.keys(SECURITY_HEADERS).sort(), ["cache-control", "referrer-policy", "x-content-type-options", "x-frame-options"]);
    assert.match(res.headers.get("content-type")!, /^application\/json/);
  }
  assert.equal(SECURITY_HEADERS["referrer-policy"], "no-referrer");
});

test("unknown paths and methods are notFound, in the contract's error shape", async () => {
  const w = await world();
  for (const [m, p] of [["GET", "/"], ["GET", "/v2/me"], ["DELETE", "/v1/me"], ["GET", "/v1/me/"], ["GET", "/v1/me/x"]] as const) {
    const r = await call(w, m, p);
    assert.equal(r.res.status, 404, `${m} ${p}`);
    assert.ok(isApiErrorBody(r.json));
    assert.equal(code(r), "notFound");
  }
});

test("a known route without a handler yet is notFound, after its access check", async () => {
  const w = await world();
  const r = await call(w, "GET", `/v1/projects/${w.projectId}/gpu-types`);
  assert.equal(code(r), "unauthenticated"); // the check comes first
  const cookie = await signIn(w, (await invite(w, "a@example.com"), "a@example.com"));
  const r2 = await call(w, "GET", `/v1/projects/${w.projectId}/gpu-types`, { cookie });
  assert.equal(code(r2), "notFound");
});

test("mutations need the app's own Origin (agent routes excepted)", async () => {
  const w = await vehicleWorld();
  assert.equal(code(await call(w, "POST", VEHICLE, { body: { email: "a@example.com" }, origin: null })), "forbidden");
  assert.equal(code(await call(w, "POST", VEHICLE, { body: { email: "a@example.com" }, origin: "https://evil.example" })), "forbidden");
  assert.equal(code(await call(w, "POST", VEHICLE, { body: { email: "a@example.com" }, origin: ORIGIN + ":443" })), "forbidden");
  assert.equal((await call(w, "POST", VEHICLE, { body: { email: "a@example.com" } })).res.status, 200);
  // every method that changes state: PATCH, PUT and DELETE too (checked before the session)
  assert.equal(code(await call(w, "PATCH", `/v1/projects/${w.projectId}`, { body: {}, origin: null })), "forbidden");
  assert.equal(code(await call(w, "PUT", `/v1/projects/${w.projectId}/members/${newId("member")}/allocation`, { body: {}, origin: null })), "forbidden");
  assert.equal(code(await call(w, "DELETE", `/v1/machines/${newId("machine")}`, { origin: null })), "forbidden");
  // GET needs none; agent routes don't use it (and agent auth is refused for now)
  assert.equal(code(await call(w, "GET", "/v1/me", { origin: null, cookie: "x=1" })), "unauthenticated");
  assert.equal(code(await call(w, "POST", "/v1/agent/heartbeat", { body: {}, origin: null, cookie: "x=1" })), "unauthenticated");
});

test("bodies: JSON objects only, at most 64 KiB", async () => {
  const w = await vehicleWorld();
  const p = VEHICLE;
  assert.equal(code(await call(w, "POST", p, { body: { email: "a@example.com" }, contentType: "text/plain" })), "badRequest");
  assert.equal(code(await call(w, "POST", p, { body: { email: "a@example.com" }, contentType: null })), "badRequest");
  assert.equal(code(await call(w, "POST", p, { raw: "{nope" })), "badRequest");
  assert.equal(code(await call(w, "POST", p, { raw: "[1]" })), "badRequest");
  assert.equal(code(await call(w, "POST", p, { raw: "null" })), "badRequest");
  assert.equal(code(await call(w, "POST", p, { raw: '"x"' })), "badRequest");
  const pad = "x".repeat(MAX_BODY_BYTES);
  assert.equal(code(await call(w, "POST", p, { body: { email: "a@example.com", pad } })), "badRequest");
  const fits = "x".repeat(MAX_BODY_BYTES - JSON.stringify({ email: "a@example.com", pad: "" }).length);
  assert.equal((await call(w, "POST", p, { body: { email: "a@example.com", pad: fits } })).res.status, 200);
  assert.equal(code(await call(w, "POST", p, { body: { email: "a@example.com", pad: fits + "x" } })), "badRequest");
  assert.equal((await call(w, "POST", p, { body: { email: "a@example.com" }, contentType: "application/json; charset=utf-8" })).res.status, 200);
  assert.equal(code(await call(w, "POST", p, { body: { email: "a@example.com" }, contentType: "application/jsonp" })), "badRequest");
});

/** A streamed body: the chunks, pulled one at a time (highWaterMark 0), counting pulls. */
function streamedBody(chunks: Uint8Array[], contentLength?: string, cookie?: string) {
  const stats = { pulls: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        stats.pulls++;
        if (i < chunks.length) c.enqueue(chunks[i++]!);
        else c.close();
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  if (cookie !== undefined) headers.cookie = cookie;
  const req = new Request(`${ORIGIN}${VEHICLE}`, { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { req, stats };
}

/** A JSON body {"email":"a@example.com","pad":"<fill>"} of exactly `bytes` UTF-8 bytes. */
function jsonOfBytes(bytes: number, fillChar = "x"): Uint8Array {
  const head = '{"email":"a@example.com","pad":"';
  const tail = '"}';
  const unit = new TextEncoder().encode(fillChar).length;
  const room = bytes - head.length - tail.length;
  const n = Math.floor(room / unit);
  const s = head + fillChar.repeat(n) + "x".repeat(room - n * unit) + tail;
  const b = new TextEncoder().encode(s);
  assert.equal(b.length, bytes);
  return b;
}

const split = (b: Uint8Array, size: number) => {
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += size) out.push(b.slice(i, i + size));
  return out;
};

test("the body cap bounds what is read: streamed bytes are counted, the stream cancelled early", async () => {
  const w = await vehicleWorld();
  const streamed = (chunks: Uint8Array[], contentLength?: string) => streamedBody(chunks, contentLength, w.defaultCookie);
  const status = async (x: ReturnType<typeof streamedBody>) => {
    const res = await w.app.fetch(x.req);
    const j = (await res.json()) as { error?: { code: string } };
    return res.status === 200 ? "ok" : j.error?.code;
  };
  // no length: 100 chunks of 16 KiB; refused after the 5th, which would pass the cap
  const big = streamed(Array.from({ length: 100 }, () => new Uint8Array(16384)));
  assert.equal(await status(big), "badRequest");
  assert.equal(big.stats.pulls, 5);
  assert.equal(big.stats.cancelled, true);
  // a dishonest small length changes nothing
  const liar = streamed(Array.from({ length: 100 }, () => new Uint8Array(16384)), "10");
  assert.equal(await status(liar), "badRequest");
  assert.equal(liar.stats.pulls, 5);
  assert.equal(liar.stats.cancelled, true);
  // a declared length over the cap: refused before a single chunk is read
  const declared = streamed([new TextEncoder().encode('{"email":"a@example.com"}')], String(MAX_BODY_BYTES + 1));
  assert.equal(await status(declared), "badRequest");
  assert.equal(declared.stats.pulls, 0);
  // one huge chunk: refused at its first (only) pull, never kept
  const huge = streamed([new Uint8Array(1 << 20), new Uint8Array(1)]);
  assert.equal(await status(huge), "badRequest");
  assert.equal(huge.stats.pulls, 1);
  assert.equal(huge.stats.cancelled, true);
  // exactly 64 KiB, streamed in pieces, is accepted (and read to its end); one byte more is not
  const exact = streamed(split(jsonOfBytes(MAX_BODY_BYTES), 10_000));
  assert.equal(await status(exact), "ok");
  assert.equal(exact.stats.cancelled, false);
  const over = streamed(split(jsonOfBytes(MAX_BODY_BYTES + 1), 10_000));
  assert.equal(await status(over), "badRequest");
  assert.equal(over.stats.cancelled, true);
  // multibyte: the cap counts bytes, not characters
  const mbExact = streamed(split(jsonOfBytes(MAX_BODY_BYTES, "é"), 7_777));
  assert.equal(await status(mbExact), "ok");
  const mbOver = streamed(split(jsonOfBytes(MAX_BODY_BYTES + 1, "é"), 7_777));
  assert.equal(await status(mbOver), "badRequest");
  // an honest exact length is fine
  assert.equal(await status(streamed([jsonOfBytes(MAX_BODY_BYTES)], String(MAX_BODY_BYTES))), "ok");
});

test("readCapped", async () => {
  assert.deepEqual(await readCapped(null, 10), new Uint8Array(0));
  const s = (parts: number[]) => streamedBody(parts.map((n) => new Uint8Array(n).fill(1))).req.body;
  assert.equal((await readCapped(s([4, 6]), 10))!.length, 10);
  assert.equal(await readCapped(s([4, 7]), 10), null);
  assert.equal(await readCapped(s([11]), 10), null);
  assert.equal((await readCapped(s([]), 0))!.length, 0);
  assert.equal(await readCapped(s([1]), 0), null);
  assert.deepEqual(await readCapped(streamedBody([new Uint8Array([1, 2]), new Uint8Array([3])]).req.body, 3), new Uint8Array([1, 2, 3]));
});

test("a body that isn't an object is refused even where the handler reads nothing", async () => {
  const w = await world();
  await invite(w, "a@example.com");
  const cookie = await signIn(w, "a@example.com");
  assert.equal(code(await call(w, "POST", "/v1/auth/sign-out", { cookie, raw: "[1]" })), "badRequest");
  assert.equal((await call(w, "GET", "/v1/me", { cookie })).res.status, 200); // still signed in
});

test("an unexpected error is a generic internal error", async () => {
  const w = await world({ getMe: async () => { throw new Error("secret detail"); } });
  await invite(w, "a@example.com");
  const cookie = await signIn(w, "a@example.com");
  const r = await call(w, "GET", "/v1/me", { cookie });
  assert.equal(r.res.status, 500);
  assert.deepEqual(r.json, { error: { code: "internal", message: "internal error" } });
});

// ---------------------------------------------------------------- sign-in

test("email sign-in links are gone; without WorkOS configured, sign-in answers unavailable", async () => {
  for (const name of ["requestSignInLink", "verifySignInLink"]) {
    assert.equal(name in HANDLERS, false, name);
    assert.equal(name in ROUTES, false, name);
  }
  const w = await world();
  for (const p of ["/v1/auth/email-link", "/v1/auth/verify"]) assert.equal(code(await call(w, "POST", p, { body: { email: "a@example.com" } })), "notFound", p);
  // with sign-in not configured, both answer "unavailable", into the app
  for (const p of ["/v1/auth/start?return=/", "/v1/auth/callback?code=x&state=y"]) {
    const r = await call(w, "GET", p);
    assert.equal(r.res.status, 302, p);
    assert.equal(r.res.headers.get("location"), "/?signin=unavailable", p);
    assert.equal(r.res.headers.get("referrer-policy"), "no-referrer", p);
  }
  assert.deepEqual(await w.db.all(`SELECT name FROM sqlite_master WHERE name = 'sign_in_links'`), []);
});

test("withSecurityHeaders puts the headers on the app's HTML, the landing page included", async () => {
  const page = new Response("<!doctype html><p>hi", {
    status: 200,
    headers: { "content-type": "text/html", "referrer-policy": "unsafe-url", "cache-control": "max-age=60" },
  });
  const res = withSecurityHeaders(page);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<!doctype html><p>hi");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("content-type"), "text/html");
  assert.equal(res.headers.get("cache-control"), "max-age=60"); // left to the asset
});

test("startSession: the user once, invitations made active, a strict session cookie", async () => {
  const w = await world();
  const memberId = await invite(w, "a@example.com", "manager");
  const { setCookie, userId } = await startSession(w.deps, "a@example.com");
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${DEFAULT_CONFIG.sessionTtlMs / 1000}$`));
  const cookie = setCookie.split(";")[0]!;
  const me = (await call(w, "GET", "/v1/me", { cookie })).json as unknown as Me;
  assert.equal(me.user.id, userId);
  assert.equal(me.user.email, "a@example.com");
  assert.deepEqual(me.projects, [{ projectId: w.projectId, orgId: w.orgId, name: "Proj", role: "manager", memberId }]);
  // the session id is stored only as its hash, with its expiry
  const sessions = await w.db.all<{ id_sha256: string; created_ms: number; expires_ms: number }>(`SELECT id_sha256, created_ms, expires_ms FROM sessions`);
  assert.deepEqual(sessions.map((x) => ({ ...x })), [{ id_sha256: await sha256Hex(cookie.split("=")[1]!), created_ms: T0, expires_ms: T0 + DEFAULT_CONFIG.sessionTtlMs }]);
  // the invitation is now active
  const m = await w.db.all<{ status: string; user_id: string }>(`SELECT status, user_id FROM members WHERE id = ?`, [memberId]);
  assert.deepEqual([m[0]!.status, m[0]!.user_id], ["active", userId]);
  // a second session: the same user, a different cookie
  const again = await startSession(w.deps, "a@example.com");
  assert.equal(again.userId, userId);
  assert.notEqual(again.setCookie, setCookie);
  assert.equal((await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE email = 'a@example.com'`))[0]!.n, 1);
  // a removed invitation stays removed when the person signs in through another one
  const other = newId("project");
  await w.db.batch([
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Other', ?, ?, 0, ?)`, other, w.orgId, T0, T0 + 1, T0),
    stmt(`INSERT INTO members (id, project_id, email, role, status, created_ms) VALUES (?, ?, 'b@example.com', 'member', 'removed', ?)`, newId("member"), other, T0),
  ]);
  await invite(w, "b@example.com");
  await signIn(w, "b@example.com");
  const st = await w.db.all<{ status: string; user_id: string | null }>(`SELECT status, user_id FROM members WHERE email = 'b@example.com' ORDER BY status`);
  assert.deepEqual(st.map((x) => [x.status, x.user_id === null]), [["active", false], ["removed", true]]);
});

test("sessions: /v1/me needs one; it expires, and sign-out revokes it", async () => {
  const w = await world();
  await invite(w, "a@example.com");
  assert.equal(code(await call(w, "GET", "/v1/me")), "unauthenticated");
  const cookie = await signIn(w, "a@example.com");
  const me = await call(w, "GET", "/v1/me", { cookie });
  assert.equal(me.res.status, 200);
  assert.equal((me.json as unknown as Me).user.email, "a@example.com");
  for (const bad of [`${SESSION_COOKIE}=`, `${SESSION_COOKIE}=nope`, `other=${cookie.split("=")[1]}`, `${SESSION_COOKIE}=${base64url(new Uint8Array(32))}`]) {
    assert.equal(code(await call(w, "GET", "/v1/me", { cookie: bad })), "unauthenticated", bad);
  }
  // a look-alike cookie name is not the session cookie
  assert.equal(code(await call(w, "GET", "/v1/me", { cookie: `x${cookie}` })), "unauthenticated");
  // other cookies around it are fine
  assert.equal((await call(w, "GET", "/v1/me", { cookie: `a=1; ${cookie}; b=2` })).res.status, 200);
  // sign-out: revoked, and the cookie is cleared
  const out = await call(w, "POST", "/v1/auth/sign-out", { cookie });
  assert.equal(out.res.status, 200);
  assert.match(out.res.headers.get("set-cookie")!, new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0$`));
  assert.equal(code(await call(w, "GET", "/v1/me", { cookie })), "unauthenticated");
  // expiry
  const c2 = await signIn(w, "a@example.com");
  w.clock.t += DEFAULT_CONFIG.sessionTtlMs - 1;
  assert.equal((await call(w, "GET", "/v1/me", { cookie: c2 })).res.status, 200);
  w.clock.t += 1;
  assert.equal(code(await call(w, "GET", "/v1/me", { cookie: c2 })), "unauthenticated");
});

test("/v1/me lists org roles and active project memberships only", async () => {
  const w = await world();
  await invite(w, "a@example.com", "assistant");
  const other = newId("project");
  await w.db.batch([
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Other', ?, ?, 0, ?)`, other, w.orgId, T0, T0 + 1, T0),
  ]);
  await invite(w, "a@example.com", "member", other);
  const cookie = await signIn(w, "a@example.com");
  const me = (await call(w, "GET", "/v1/me", { cookie })).json as unknown as Me;
  await w.db.batch([
    stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'viewer')`, w.orgId, me.user.id),
    stmt(`UPDATE members SET status = 'removed' WHERE project_id = ?`, other),
  ]);
  const me2 = (await call(w, "GET", "/v1/me", { cookie })).json as unknown as Me;
  assert.deepEqual(me2.orgs, [{ orgId: w.orgId, name: "Org", role: "viewer" }]);
  assert.deepEqual(me2.projects.map((p) => [p.projectId, p.role]), [[w.projectId, "assistant"]]);
});

// ---------------------------------------------------------------- roles

test("role checks: no role is notFound, too low is forbidden, org owners own the project", async () => {
  const ok = async () => new Response('{"ok":true}', { status: 200 });
  const w = await world({ getProject: ok, updateProject: ok, moveProjectBudget: ok, getOrg: ok, createProject: ok, getMachine: ok });
  const people: Record<string, string> = {};
  for (const [email, role] of [["m@example.com", "member"], ["s@example.com", "assistant"], ["g@example.com", "manager"], ["o@example.com", "owner"]] as const) {
    await invite(w, email, role);
    people[role] = await signIn(w, email);
  }
  // someone with no membership at all
  const stranger = newId("member");
  await w.db.batch([stmt(`INSERT INTO members (id, project_id, email, role, status, created_ms) VALUES (?, ?, 'x@example.com', 'owner', 'invited', ?)`, stranger, w.projectId, T0)]);
  const outsider = await signIn(w, "x@example.com");
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE email = 'x@example.com'`)]);
  const P = `/v1/projects/${w.projectId}`;
  const s = async (cookie: string, m: string, p: string) => {
    const r = await call(w, m, p, { cookie, body: {} });
    return r.res.status === 200 ? "ok" : code(r);
  };
  assert.deepEqual(
    [await s(people.member!, "GET", P), await s(people.assistant!, "GET", P), await s(outsider, "GET", P)],
    ["ok", "ok", "notFound"],
  );
  assert.deepEqual(
    [await s(people.member!, "PATCH", P), await s(people.assistant!, "PATCH", P), await s(people.manager!, "PATCH", P), await s(people.owner!, "PATCH", P)],
    ["forbidden", "forbidden", "ok", "ok"],
  );
  assert.deepEqual([await s(people.manager!, "POST", `${P}/budget`), await s(people.owner!, "POST", `${P}/budget`)], ["forbidden", "ok"]);
  // another project's id: notFound, not forbidden
  assert.equal(await s(people.owner!, "GET", `/v1/projects/${newId("project")}`), "notFound");
  // org roles
  const O = `/v1/orgs/${w.orgId}`;
  assert.equal(await s(people.owner!, "GET", O), "notFound"); // a project owner isn't an org member
  const me = (await call(w, "GET", "/v1/me", { cookie: people.member! })).json as unknown as Me;
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'viewer')`, w.orgId, me.user.id)]);
  assert.deepEqual([await s(people.member!, "GET", O), await s(people.member!, "POST", `${O}/projects`)], ["ok", "forbidden"]);
  await w.db.batch([stmt(`UPDATE org_members SET role = 'owner' WHERE user_id = ?`, me.user.id)]);
  // an org owner owns every project of the org, whatever their membership says
  assert.deepEqual([await s(people.member!, "POST", `${O}/projects`), await s(people.member!, "POST", `${P}/budget`)], ["ok", "ok"]);
  // machine routes check the machine's project
  const alloc = newId("allocation");
  const mch = newId("machine");
  await w.db.batch([
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', 'mbr_x', 0, ?)`, alloc, w.projectId, T0),
    stmt(`INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, created_ms) VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, 'mbr_x', 'runpod', 'L4', 1, 'X', 'starting', ?)`, mch, w.projectId, alloc, T0),
  ]);
  assert.deepEqual([await s(people.assistant!, "GET", `/v1/machines/${mch}`), await s(outsider, "GET", `/v1/machines/${mch}`)], ["ok", "notFound"]);
  assert.equal(await s(people.assistant!, "GET", `/v1/machines/${newId("machine")}`), "notFound");
  // system routes: refused to everyone over HTTP for now
  assert.equal(await s(people.member!, "POST", `${O}/credit`), "forbidden");
});

test("schema: an active member has a user", async () => {
  const w = await world();
  await assert.rejects(w.db.batch([stmt(`INSERT INTO members (id, project_id, email, role, status, created_ms) VALUES (?, ?, 'c@example.com', 'member', 'active', ?)`, newId("member"), w.projectId, T0)]));
  await assert.rejects(w.db.batch([stmt(`INSERT INTO members (id, project_id, email, role, status, created_ms) VALUES (?, ?, 'C@example.com', 'member', 'invited', ?)`, newId("member"), w.projectId, T0)]));
});

test("role checks are scoped to the project: another real project, its machines, another org's owner", async () => {
  const ok = async () => new Response('{"ok":true}', { status: 200 });
  const w = await world({ getProject: ok, getMachine: ok, updateProject: ok, getOrg: ok });
  // a second, real organization with its own project and machine
  const orgB = newId("org");
  const prjB = newId("project");
  const allocB = newId("allocation");
  const mchB = newId("machine");
  await w.db.batch([
    stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'Org B', 'resold', 0, ?)`, orgB, T0),
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Proj B', ?, ?, 0, ?)`, prjB, orgB, T0, T0 + 1, T0),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', 'mbr_x', 0, ?)`, allocB, prjB, T0),
    stmt(`INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, created_ms) VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, 'mbr_x', 'runpod', 'L4', 1, 'X', 'starting', ?)`, mchB, prjB, allocB, T0),
  ]);
  // an owner of the first project only
  await invite(w, "o@example.com", "owner");
  const owner = await signIn(w, "o@example.com");
  const s = async (cookie: string, m: string, p: string) => {
    const r = await call(w, m, p, { cookie, body: {} });
    return r.res.status === 200 ? "ok" : code(r);
  };
  assert.equal(await s(owner, "GET", `/v1/projects/${w.projectId}`), "ok");
  assert.equal(await s(owner, "GET", `/v1/projects/${prjB}`), "notFound");
  assert.equal(await s(owner, "PATCH", `/v1/projects/${prjB}`), "notFound");
  assert.equal(await s(owner, "GET", `/v1/machines/${mchB}`), "notFound");
  // an owner of ANOTHER organization doesn't own this one's projects
  const me = (await call(w, "GET", "/v1/me", { cookie: owner })).json as unknown as Me;
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, orgB, me.user.id)]);
  assert.equal(await s(owner, "GET", `/v1/projects/${prjB}`), "ok"); // now it does: it owns org B
  await invite(w, "p@example.com", "member");
  const plain = await signIn(w, "p@example.com");
  const me2 = (await call(w, "GET", "/v1/me", { cookie: plain })).json as unknown as Me;
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, orgB, me2.user.id)]);
  assert.equal(await s(plain, "PATCH", `/v1/projects/${w.projectId}`), "forbidden"); // still only a member here
  assert.equal(await s(plain, "PATCH", `/v1/projects/${prjB}`), "ok");
  // org routes are scoped to the named org
  assert.equal(await s(plain, "GET", `/v1/orgs/${w.orgId}`), "notFound");
  assert.equal(await s(plain, "GET", `/v1/orgs/${orgB}`), "ok");
  // an owner of its OWN organization gets nothing of another organization's project
  await invite(w, "q@example.com", "member");
  const ownOrg = await signIn(w, "q@example.com");
  const me3 = (await call(w, "GET", "/v1/me", { cookie: ownOrg })).json as unknown as Me;
  await w.db.batch([
    stmt(`UPDATE members SET status = 'removed' WHERE email = 'q@example.com'`),
    stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, 'owner')`, w.orgId, me3.user.id),
  ]);
  assert.equal(await s(ownOrg, "GET", `/v1/projects/${w.projectId}`), "ok"); // its own org's project
  assert.equal(await s(ownOrg, "GET", `/v1/projects/${prjB}`), "notFound");
  assert.equal(await s(ownOrg, "GET", `/v1/machines/${mchB}`), "notFound");
  assert.equal(await s(ownOrg, "GET", `/v1/orgs/${orgB}`), "notFound");
});

test("effectiveProjectRole", async () => {
  const w = await world();
  assert.equal(await effectiveProjectRole(w.db, "usr_x", w.projectId), null);
  assert.equal(await effectiveProjectRole(w.db, "usr_x", "prj_none"), null);
});

// ---------------------------------------------------------------- config

test("configFromEnv takes the deploy config's MACHINE_DOMAIN and APP_ORIGIN, strictly", () => {
  const c = configFromEnv({ APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com" });
  assert.equal(c.machineDomain, "m.example.com");
  assert.equal(c.appOrigin, "https://gpu.example.com");
  // the installation slug: unset is null (no launch then); set, exactly [a-z0-9]{4,8}
  assert.equal(c.installation, null);
  const base = { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com" };
  for (const slug of ["prod", "a1b2c3d4", "0000"]) assert.equal(configFromEnv({ ...base, SBGPU_INSTALLATION: slug }).installation, slug);
  for (const slug of ["abc", "abcdefghi", "Prod", "pr-d", "pr_d", "", " prod", 1234]) assert.throws(() => configFromEnv({ ...base, SBGPU_INSTALLATION: slug }), /SBGPU_INSTALLATION/, String(slug));
  for (const env of [
    {},
    { APP_ORIGIN: "https://gpu.example.com" },
    { APP_ORIGIN: "http://gpu.example.com", MACHINE_DOMAIN: "m.example.com" },
    { APP_ORIGIN: "https://gpu.example.com/", MACHINE_DOMAIN: "m.example.com" },
    { APP_ORIGIN: "https://u:p@gpu.example.com", MACHINE_DOMAIN: "m.example.com" },
    { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "M.example.com" },
    { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "example" },
    { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com." },
    { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com:443" },
    { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "-m.example.com" },
  ]) {
    assert.throws(() => configFromEnv(env), Error, JSON.stringify(env));
  }
});

test("configFromEnv: container launch is off unless SBGPU_CONTAINER_LAUNCH=on, and then needs the release it pins, strictly", () => {
  const base = { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com" };
  const release = {
    SBGPU_CONTAINER_IMAGE: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
    SBGPU_AGENT_URL: "https://cdn.example.com/agent/sbgpu-agent.tar.gz",
    SBGPU_AGENT_SHA256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
  // off: unset, or "off", whatever else is set
  assert.equal(configFromEnv(base).containerLaunch, null);
  assert.equal(configFromEnv({ ...base, ...release, SBGPU_CONTAINER_LAUNCH: "off" }).containerLaunch, null);
  // on, with the release
  assert.deepEqual(configFromEnv({ ...base, ...release, SBGPU_CONTAINER_LAUNCH: "on" }).containerLaunch, {
    image: release.SBGPU_CONTAINER_IMAGE,
    agentUrl: release.SBGPU_AGENT_URL,
    agentSha256: release.SBGPU_AGENT_SHA256,
  });
  // anything else refused at startup
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ SBGPU_CONTAINER_LAUNCH: "yes" }, /SBGPU_CONTAINER_LAUNCH/],
    [{ SBGPU_CONTAINER_LAUNCH: "ON" }, /SBGPU_CONTAINER_LAUNCH/],
    [{ SBGPU_CONTAINER_LAUNCH: true }, /SBGPU_CONTAINER_LAUNCH/],
    [{ SBGPU_CONTAINER_LAUNCH: "on", SBGPU_CONTAINER_IMAGE: undefined }, /SBGPU_CONTAINER_IMAGE/],
    [{ SBGPU_CONTAINER_LAUNCH: "on", SBGPU_CONTAINER_IMAGE: "Upper/Case" }, /SBGPU_CONTAINER_IMAGE/],
    [{ SBGPU_CONTAINER_LAUNCH: "on", SBGPU_CONTAINER_IMAGE: "img with space" }, /SBGPU_CONTAINER_IMAGE/],
    [{ SBGPU_CONTAINER_LAUNCH: "on", SBGPU_AGENT_URL: undefined }, /SBGPU_AGENT_URL/],
    [{ SBGPU_CONTAINER_LAUNCH: "on", SBGPU_AGENT_SHA256: undefined }, /SBGPU_AGENT_SHA256/],
    [{ SBGPU_CONTAINER_LAUNCH: "on", SBGPU_AGENT_URL: "http://cdn.example.com/a.tgz" }, /SBGPU_AGENT_URL/],
    [{ SBGPU_CONTAINER_LAUNCH: "on", SBGPU_AGENT_URL: "https://cdn.example.com/a b.tgz" }, /SBGPU_AGENT_URL/],
    [{ SBGPU_CONTAINER_LAUNCH: "on", SBGPU_AGENT_SHA256: "0123" }, /SBGPU_AGENT_SHA256/],
    [{ SBGPU_CONTAINER_LAUNCH: "on", SBGPU_AGENT_SHA256: release.SBGPU_AGENT_SHA256.toUpperCase() }, /SBGPU_AGENT_SHA256/],
  ];
  for (const [over, why] of bad) {
    const env: Record<string, unknown> = { ...base, ...release, ...over };
    for (const k of Object.keys(over)) if (over[k] === undefined) delete env[k];
    assert.throws(() => configFromEnv(env), why, JSON.stringify(over));
  }
});

test("helpers: base64url and normalizeEmail", () => {
  assert.equal(base64url(new Uint8Array([0xfb, 0xff])), "-_8");
  assert.equal(base64url(new Uint8Array(32)).length, 43);
  assert.equal(base64url(new Uint8Array([1, 2, 3])), "AQID");
  assert.equal(normalizeEmail(" A@Example.com "), "a@example.com");
  assert.equal(normalizeEmail("a@example"), null);
  // at most 254 characters (an address's limit), whatever the pattern allows
  const at = (n: number) => "a".repeat(n - "@example.com".length) + "@example.com";
  assert.equal(normalizeEmail(at(254)), at(254));
  assert.equal(normalizeEmail(at(255)), null);
  assert.equal(normalizeEmail(` ${at(254)} `), at(254)); // (counted after trimming)
});
