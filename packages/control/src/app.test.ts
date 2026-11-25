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
  readCapped,
  sha256Hex,
  withSecurityHeaders,
  type AppDeps,
  type Handlers,
} from "./app.ts";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import { stmt } from "./db.ts";

const ORIGIN = "https://gpu.example.test";
const T0 = Date.UTC(2027, 1, 1, 9, 0, 0);

interface World {
  db: TestDb;
  /** Work handed to waitUntil, not yet awaited. */
  pending: Promise<unknown>[];
  deps: AppDeps;
  mail: Array<{ email: string; url: string }>;
  clock: { t: number };
  app: ReturnType<typeof createApp>;
  orgId: string;
  projectId: string;
}

async function world(handlers?: Handlers, o: { mailerFails?: boolean; mailer?: AppDeps["mailer"] } = {}): Promise<World> {
  const db = sqliteDb();
  const mail: Array<{ email: string; url: string }> = [];
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
    mailer: o.mailer ?? {
      async sendSignInLink(email, url) {
        if (o.mailerFails) throw new Error("mail down");
        mail.push({ email, url });
      },
    },
    waitUntil: (p) => {
      pending.push(p);
    },
    config: { ...DEFAULT_CONFIG, appOrigin: ORIGIN, machineDomain: "m.example.test" },
  };
  const orgId = newId("org");
  const projectId = newId("project");
  await db.batch([
    stmt(`INSERT INTO orgs (id, name, margin_bps, created_ms) VALUES (?, 'Org', 3000, ?)`, orgId, T0),
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Proj', ?, ?, 0, ?)`, projectId, orgId, T0, T0 + 86_400_000, T0),
  ]);
  return { db, pending, deps, mail, clock, app: createApp(deps, handlers ? { ...HANDLERS, ...handlers } : undefined), orgId, projectId };
}

interface Req {
  body?: unknown;
  raw?: string;
  cookie?: string;
  origin?: string | null;
  contentType?: string | null;
  /** Don't run the deferred work (mail) after the response. */
  noFlush?: boolean;
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
  const r = await call(w, "GET", `/v1/projects/${w.projectId}/spend`);
  assert.equal(code(r), "unauthenticated"); // the check comes first
  const cookie = await signIn(w, (await invite(w, "a@example.com"), "a@example.com"));
  const r2 = await call(w, "GET", `/v1/projects/${w.projectId}/spend`, { cookie });
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

/** A streamed body: the chunks, pulled one at a time (highWaterMark 0), counting pulls. */
function streamed(chunks: Uint8Array[], contentLength?: string) {
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
  const req = new Request(`${ORIGIN}/v1/auth/email-link`, { method: "POST", body, headers, duplex: "half" } as RequestInit);
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
  const w = await world();
  const status = async (x: ReturnType<typeof streamed>) => {
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
  const s = (parts: number[]) => streamed(parts.map((n) => new Uint8Array(n).fill(1))).req.body;
  assert.equal((await readCapped(s([4, 6]), 10))!.length, 10);
  assert.equal(await readCapped(s([4, 7]), 10), null);
  assert.equal(await readCapped(s([11]), 10), null);
  assert.equal((await readCapped(s([]), 0))!.length, 0);
  assert.equal(await readCapped(s([1]), 0), null);
  assert.deepEqual(await readCapped(streamed([new Uint8Array([1, 2]), new Uint8Array([3])]).req.body, 3), new Uint8Array([1, 2, 3]));
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

test("sign-in links: the hourly limit holds under simultaneous requests", async () => {
  const w = await world();
  await invite(w, "a@example.com");
  const emails = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? "A@Example.com" : i % 3 === 1 ? "a@example.com" : " a@EXAMPLE.com "));
  const results = await Promise.all(emails.map((email) => call(w, "POST", "/v1/auth/email-link", { body: { email } })));
  for (const r of results) assert.deepEqual([r.res.status, r.json], [200, { ok: true }]);
  assert.equal(w.mail.length, DEFAULT_CONFIG.maxLinksPerEmailPerHour);
  assert.equal((await w.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM sign_in_links`))[0]!.n, DEFAULT_CONFIG.maxLinksPerEmailPerHour);
  // at the boundary: 4 used, then 3 at once -> exactly one more
  const v = await world();
  await invite(v, "b@example.com");
  for (let i = 0; i < DEFAULT_CONFIG.maxLinksPerEmailPerHour - 1; i++) await call(v, "POST", "/v1/auth/email-link", { body: { email: "b@example.com" } });
  assert.equal(v.mail.length, DEFAULT_CONFIG.maxLinksPerEmailPerHour - 1);
  await Promise.all([0, 1, 2].map(() => call(v, "POST", "/v1/auth/email-link", { body: { email: "B@example.com" } })));
  assert.equal(v.mail.length, DEFAULT_CONFIG.maxLinksPerEmailPerHour);
  // the mailed links are exactly the stored ones
  const stored = new Set((await v.db.all<{ h: string }>(`SELECT token_sha256 AS h FROM sign_in_links`)).map((r) => r.h));
  for (const m of v.mail) assert.ok(stored.has(await sha256Hex(new URL(m.url).searchParams.get("token")!)));
});

test("a mail failure doesn't change the answer, and its rejection is handled", async () => {
  const w = await world(undefined, { mailerFails: true });
  await invite(w, "a@example.com");
  const r = await call(w, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" }, noFlush: true });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(w.pending.length, 1);
  const settled = await Promise.allSettled(w.pending.splice(0));
  assert.deepEqual(settled.map((x) => x.status), ["fulfilled"]); // caught inside: no unhandled rejection
  // a mailer that throws synchronously is caught too
  const v = await world(undefined, { mailer: { sendSignInLink: (() => { throw new Error("sync"); }) as never } });
  await invite(v, "a@example.com");
  const r2 = await call(v, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" }, noFlush: true });
  assert.deepEqual(r2.json, { ok: true });
  assert.deepEqual((await Promise.allSettled(v.pending.splice(0))).map((x) => x.status), ["fulfilled"]);
});

test("mail is sent after the response: a held mail can't tell known from unknown", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sent: string[] = [];
  const w = await world(undefined, {
    mailer: {
      async sendSignInLink(email) {
        await held;
        sent.push(email);
      },
    },
  });
  await invite(w, "known@example.com");
  for (const email of ["known@example.com", "unknown@example.com"]) {
    // the response must come while the mail is held (a response that waited would never come)
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      call(w, "POST", "/v1/auth/email-link", { body: { email }, noFlush: true }),
      new Promise<"waited">((resolve) => (timer = setTimeout(() => resolve("waited"), 1000))),
    ]);
    clearTimeout(timer);
    assert.notEqual(r, "waited", `${email}: the response waited for the mail`);
    if (r !== "waited") assert.deepEqual([r.res.status, r.json], [200, { ok: true }], email);
  }
  assert.deepEqual(sent, []); // both answered while the known address's mail is still held
  assert.equal(w.pending.length, 1); // only the known address scheduled mail
  release();
  await Promise.all(w.pending.splice(0));
  assert.deepEqual(sent, ["known@example.com"]);
  // past the hourly limit, nothing is scheduled at all
  const v = await world();
  await invite(v, "a@example.com");
  for (let i = 0; i < DEFAULT_CONFIG.maxLinksPerEmailPerHour; i++) await call(v, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" } });
  await call(v, "POST", "/v1/auth/email-link", { body: { email: "a@example.com" }, noFlush: true });
  assert.equal(v.pending.length, 0);
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

test("role checks are scoped to the project: another real project, its machines, another org's owner", async () => {
  const ok = async () => new Response('{"ok":true}', { status: 200 });
  const w = await world({ getProject: ok, getMachine: ok, updateProject: ok, getOrg: ok });
  // a second, real organization with its own project and machine
  const orgB = newId("org");
  const prjB = newId("project");
  const allocB = newId("allocation");
  const mchB = newId("machine");
  await w.db.batch([
    stmt(`INSERT INTO orgs (id, name, margin_bps, created_ms) VALUES (?, 'Org B', 0, ?)`, orgB, T0),
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Proj B', ?, ?, 0, ?)`, prjB, orgB, T0, T0 + 1, T0),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', 'mbr_x', 0, ?)`, allocB, prjB, T0),
    stmt(`INSERT INTO machines (id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, created_ms) VALUES (?, ?, ?, 'mbr_x', 'runpod', 'L4', 1, 'X', 'starting', ?)`, mchB, prjB, allocB, T0),
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
