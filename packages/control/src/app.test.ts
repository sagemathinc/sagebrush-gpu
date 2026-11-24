import { test } from "node:test";
import assert from "node:assert/strict";
import { isApiErrorBody, newId, type Me } from "@sbgpu/api";
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
  sha256Hex,
  type AppDeps,
  type Handlers,
} from "./app.ts";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import { stmt } from "./db.ts";

const ORIGIN = "https://gpu.example.test";
const T0 = Date.UTC(2027, 1, 1, 9, 0, 0);

interface World {
  db: TestDb;
  deps: AppDeps;
  mail: Array<{ email: string; url: string }>;
  clock: { t: number };
  app: ReturnType<typeof createApp>;
  orgId: string;
  projectId: string;
}

async function world(handlers?: Handlers, o: { mailerFails?: boolean } = {}): Promise<World> {
  const db = sqliteDb();
  const mail: Array<{ email: string; url: string }> = [];
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
    mailer: {
      async sendSignInLink(email, url) {
        if (o.mailerFails) throw new Error("mail down");
        mail.push({ email, url });
      },
    },
    config: { ...DEFAULT_CONFIG, appOrigin: ORIGIN, machineDomain: "m.example.test" },
  };
  const orgId = newId("org");
  const projectId = newId("project");
  await db.batch([
    stmt(`INSERT INTO orgs (id, name, margin_bps, created_ms) VALUES (?, 'Org', 3000, ?)`, orgId, T0),
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Proj', ?, ?, 0, ?)`, projectId, orgId, T0, T0 + 86_400_000, T0),
  ]);
  return { db, deps, mail, clock, app: createApp(deps, handlers ? { ...HANDLERS, ...handlers } : undefined), orgId, projectId };
}

interface Req {
  body?: unknown;
  raw?: string;
  cookie?: string;
  origin?: string | null;
  contentType?: string | null;
}

async function call(w: World, method: string, path: string, r: Req = {}) {
  const headers: Record<string, string> = {};
  const origin = r.origin === undefined ? ORIGIN : r.origin;
  if (origin !== null) headers.origin = origin;
  if (r.cookie) headers.cookie = r.cookie;
  let body: string | undefined;
  if (method !== "GET" && method !== "DELETE") {
    const ct = r.contentType === undefined ? "application/json" : r.contentType;
    if (ct !== null) headers["content-type"] = ct;
    body = r.raw ?? JSON.stringify(r.body ?? {});
  }
  const res = await w.app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }));
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

/** Sign in through the real flow; returns the cookie header. */
async function signIn(w: World, email: string): Promise<string> {
  const n = w.mail.length;
  await call(w, "POST", "/v1/auth/email-link", { body: { email } });
  assert.equal(w.mail.length, n + 1, "a link was mailed");
  const token = new URL(w.mail.at(-1)!.url).searchParams.get("token")!;
  const r = await call(w, "POST", "/v1/auth/verify", { body: { token } });
  assert.equal(r.res.status, 200);
  const set = r.res.headers.get("set-cookie")!;
  return set.split(";")[0]!;
}

// ---------------------------------------------------------------- basics

test("every response carries the security headers, errors included", async () => {
  const w = await world();
  for (const [m, p] of [["GET", "/nope"], ["GET", "/v1/me"], ["POST", "/v1/auth/email-link"]] as const) {
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
  const r = await call(w, "GET", `/v1/projects/${w.projectId}`);
  assert.equal(code(r), "unauthenticated"); // the check comes first
  const cookie = await signIn(w, (await invite(w, "a@example.com"), "a@example.com"));
  const r2 = await call(w, "GET", `/v1/projects/${w.projectId}`, { cookie });
  assert.equal(code(r2), "notFound");
});

test("mutations need the app's own Origin (agent routes excepted)", async () => {
  const w = await world();
  assert.equal(code(await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" }, origin: null })), "forbidden");
  assert.equal(code(await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" }, origin: "https://evil.example" })), "forbidden");
  assert.equal(code(await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" }, origin: ORIGIN + ":443" })), "forbidden");
  assert.equal((await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" } })).res.status, 200);
  // every method that changes state: PATCH, PUT and DELETE too (checked before the session)
  assert.equal(code(await call(w, "PATCH", `/v1/projects/${w.projectId}`, { body: {}, origin: null })), "forbidden");
  assert.equal(code(await call(w, "PUT", `/v1/projects/${w.projectId}/members/${newId("member")}/allocation`, { body: {}, origin: null })), "forbidden");
  assert.equal(code(await call(w, "DELETE", `/v1/machines/${newId("machine")}`, { origin: null })), "forbidden");
  // GET needs none; agent routes don't use it (and agent auth is refused for now)
  assert.equal(code(await call(w, "GET", "/v1/me", { origin: null })), "unauthenticated");
  assert.equal(code(await call(w, "POST", "/v1/agent/heartbeat", { body: {}, origin: null })), "unauthenticated");
});

test("bodies: JSON objects only, at most 64 KiB", async () => {
  const w = await world();
  const p = "/v1/auth/email-link";
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

test("sign-in links: only known emails get one, always the same answer", async () => {
  const w = await world();
  await invite(w, "known@example.com");
  for (const email of ["known@example.com", "Known@Example.COM ", "stranger@example.com"]) {
    const r = await call(w, "POST", "/v1/auth/email-link", { body: { email } });
    assert.deepEqual([r.res.status, r.json], [200, { ok: true }]);
  }
  assert.deepEqual(w.mail.map((m) => m.email), ["known@example.com", "known@example.com"]);
  const url = new URL(w.mail[0]!.url);
  assert.equal(url.origin, ORIGIN);
  assert.match(url.searchParams.get("token")!, /^[A-Za-z0-9_-]{43}$/);
  // only the hash is stored
  const rows = await w.db.all<{ token_sha256: string }>(`SELECT token_sha256 FROM sign_in_links`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.token_sha256, await sha256Hex(url.searchParams.get("token")!));
  assert.equal(JSON.stringify(await w.db.all(`SELECT * FROM sign_in_links`)).includes(url.searchParams.get("token")!), false);
  // a removed member is not known
  await w.db.batch([stmt(`UPDATE members SET status = 'removed'`)]);
  await call(w, "POST", "/v1/auth/email-link", { body: { email: "known@example.com" } });
  assert.equal(w.mail.length, 2);
  for (const email of ["", "no-at", "a@b", "a@-b.com", "a b@example.com", 5, null, "x".repeat(250) + "@e.com"]) {
    assert.equal(code(await call(w, "POST", "/v1/auth/email-link", { body: { email } })), "badRequest", String(email));
  }
});

test("sign-in links: at most N per email per hour, silently", async () => {
  const w = await world();
  await invite(w, "a@example.com");
  for (let i = 0; i < DEFAULT_CONFIG.maxLinksPerEmailPerHour + 3; i++) {
    assert.equal((await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" } })).res.status, 200);
  }
  assert.equal(w.mail.length, DEFAULT_CONFIG.maxLinksPerEmailPerHour);
  w.clock.t += 2 * 60_000; // still within the hour
  await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" } });
  assert.equal(w.mail.length, DEFAULT_CONFIG.maxLinksPerEmailPerHour);
  w.clock.t += 3_600_000 + 1 - 2 * 60_000;
  await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" } });
  assert.equal(w.mail.length, DEFAULT_CONFIG.maxLinksPerEmailPerHour + 1);
});

test("a mail failure doesn't change the answer", async () => {
  const w = await world(undefined, { mailerFails: true });
  await invite(w, "a@example.com");
  assert.deepEqual((await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" } })).json, { ok: true });
});

test("verify: a link works once, before it expires; it sets a strict session cookie", async () => {
  const w = await world();
  const memberId = await invite(w, "a@example.com", "manager");
  await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" } });
  const token = new URL(w.mail[0]!.url).searchParams.get("token")!;
  for (const bad of ["", "x", token.slice(1), token + "A", 5, null]) {
    assert.equal(code(await call(w, "POST", "/v1/auth/verify", { body: { token: bad } })), "unauthenticated", String(bad));
  }
  assert.equal(code(await call(w, "POST", "/v1/auth/verify", { body: { token: base64url(new Uint8Array(32)) } })), "unauthenticated");
  const r = await call(w, "POST", "/v1/auth/verify", { body: { token } });
  assert.equal(r.res.status, 200);
  const me = r.json as unknown as Me;
  assert.equal(me.user.email, "a@example.com");
  assert.deepEqual(me.projects, [{ projectId: w.projectId, orgId: w.orgId, name: "Proj", role: "manager", memberId }]);
  const set = r.res.headers.get("set-cookie")!;
  assert.match(set, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${DEFAULT_CONFIG.sessionTtlMs / 1000}$`));
  // the session id is stored only as its hash
  const sid = set.split(";")[0]!.split("=")[1]!;
  const sessions = await w.db.all<{ id_sha256: string }>(`SELECT id_sha256 FROM sessions`);
  assert.deepEqual(sessions.map((s) => s.id_sha256), [await sha256Hex(sid)]);
  // the invitation is now active
  const m = await w.db.all<{ status: string; user_id: string }>(`SELECT status, user_id FROM members WHERE id = ?`, [memberId]);
  assert.deepEqual([m[0]!.status, m[0]!.user_id], ["active", me.user.id]);
  // used: refused
  assert.equal(code(await call(w, "POST", "/v1/auth/verify", { body: { token } })), "unauthenticated");
  // expired: refused at expiry, accepted 1 ms before
  await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" } });
  const t2 = new URL(w.mail[1]!.url).searchParams.get("token")!;
  w.clock.t += DEFAULT_CONFIG.signInLinkTtlMs;
  assert.equal(code(await call(w, "POST", "/v1/auth/verify", { body: { token: t2 } })), "unauthenticated");
  w.clock.t -= DEFAULT_CONFIG.signInLinkTtlMs;
  await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" } });
  const t3 = new URL(w.mail[2]!.url).searchParams.get("token")!;
  w.clock.t += DEFAULT_CONFIG.signInLinkTtlMs - 1;
  assert.equal((await call(w, "POST", "/v1/auth/verify", { body: { token: t3 } })).res.status, 200);
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
  // the second sign-in reuses the same user
  assert.equal((await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE email = 'a@example.com'`))[0]!.n, 1);
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
    stmt(`INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, created_ms) VALUES (?, ?, ?, 'mbr_x', 'runpod', 'L4', 1, 'X', 'starting', ?)`, mch, w.projectId, alloc, T0),
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

test("helpers: base64url and normalizeEmail", () => {
  assert.equal(base64url(new Uint8Array([0xfb, 0xff])), "-_8");
  assert.equal(base64url(new Uint8Array(32)).length, 43);
  assert.equal(base64url(new Uint8Array([1, 2, 3])), "AQID");
  assert.equal(normalizeEmail(" A@Example.com "), "a@example.com");
  assert.equal(normalizeEmail("a@example"), null);
});
