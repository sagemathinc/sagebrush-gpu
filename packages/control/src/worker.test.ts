import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newId } from "@sbgpu/api";
import { startWorker, type StartedWorker } from "@sbgpu/testing/worker";
import { SECURITY_HEADERS } from "./http.ts";
import { inspect } from "node:util";
import { renderBootCommand } from "@sbgpu/machine";
import { RunPodAdapter } from "@sbgpu/providers";
import { configFromEnv } from "./app.ts";
import { CONTAINER_WATCHDOG_SELECT } from "./container.ts";
import { backgroundFailureLine, containerDeps, createWorker, guardedWaitUntil } from "./worker.ts";
import { PRUNE_BATCH } from "./jobs.ts";
import { d1Db, type D1Like } from "./db.ts";

// The deploy config, as deployed: the tests take its bindings, vars and asset handling
// from it (only the assets directory is a fixture, as the UI's build isn't in the repo).
const WRANGLER = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8")) as {
  main: string;
  assets: { binding: string; not_found_handling: "single-page-application"; run_worker_first: boolean };
  d1_databases: Array<{ binding: string; migrations_dir: string }>;
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  triggers: { crons: string[] };
  vars: Record<string, string>;
};
const APP = WRANGLER.vars.APP_ORIGIN!;

function start(vars: Record<string, string> = WRANGLER.vars): Promise<StartedWorker> {
  const d1 = WRANGLER.d1_databases[0]!;
  return startWorker({
    entry: `packages/control/${WRANGLER.main}`,
    durableObjects: Object.fromEntries(WRANGLER.durable_objects.bindings.map((b) => [b.name, b.class_name])),
    bindings: vars,
    d1Databases: [d1.binding],
    migrations: { [d1.binding]: [`packages/control/${d1.migrations_dir}`] },
    assets: {
      directory: "packages/control/fixtures/assets",
      binding: WRANGLER.assets.binding,
      notFoundHandling: WRANGLER.assets.not_found_handling,
      runWorkerFirst: WRANGLER.assets.run_worker_first,
    },
  });
}

let w: StartedWorker;
before(async () => {
  w = await start();
});
after(async () => {
  await w?.dispose();
});

const get = (url: string, init?: RequestInit) => w.mf.dispatchFetch(url, init as never) as unknown as Promise<Response>;

function secured(res: Response, what: string) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (k === "cache-control") continue; // (left to the asset)
    assert.equal(res.headers.get(k), v, `${what}: ${k}`);
  }
}

test("the deploy config: the Worker runs before every asset, the SPA fallback, a cron every minute, placeholders only", () => {
  assert.equal(WRANGLER.assets.run_worker_first, true);
  // no workers.dev route around the zone's edge (the VM announce trusts the edge's client-IP header)
  assert.equal((WRANGLER as unknown as { workers_dev: unknown }).workers_dev, false);
  assert.equal(WRANGLER.assets.not_found_handling, "single-page-application");
  assert.deepEqual(WRANGLER.triggers.crons, ["* * * * *"]);
  const text = readFileSync(new URL("../wrangler.json", import.meta.url), "utf8");
  assert.doesNotMatch(text, /account_id/);
  for (const id of text.match(/"database_id":\s*"([^"]*)"/g) ?? []) assert.match(id, /"0{8}-0{4}-0{4}-0{4}-0{12}"/);
  // hosts are example.com; WorkOS ids are the all-zero placeholder (the issuer and JWKS are the environment's, set at deploy)
  for (const [k, v] of Object.entries(WRANGLER.vars)) {
    if (k.startsWith("WORKOS_")) assert.match(v, /client_0{26}$/, k);
    else assert.match(v, /example\.com$/, k);
  }
  assert.deepEqual(Object.keys(WRANGLER.vars).sort(), ["APP_ORIGIN", "MACHINE_DOMAIN", "WORKOS_CLIENT_ID", "WORKOS_ISSUER", "WORKOS_JWKS_URL"]);
});

test("static assets: the app's files and its paths, each with the security headers", async () => {
  for (const [path, body] of [
    ["/", "fixture index"],
    ["/?token=a-one-time-token", "fixture index"], // (the sign-in landing page)
    ["/p/prj_00000000000000000000/members", "fixture index"], // (an app path: the SPA fallback)
    ["/app.js", "fixture app"],
    ["/v1beta", "fixture index"], // (only /v1 and /v1/... are the API)
  ] as const) {
    const res = await get(APP + path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), new RegExp(body), path);
    secured(res, path);
  }
  const head = await get(APP + "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  secured(head, "HEAD /");
});

test("the API: answered by the app, with its headers; other paths and methods get nothing", async () => {
  const me = await get(APP + "/v1/me");
  assert.equal(me.status, 401);
  assert.equal(((await me.json()) as { error: { code: string } }).error.code, "unauthenticated");
  assert.equal(me.headers.get("cache-control"), "no-store");
  secured(me, "/v1/me");
  for (const [method, path] of [["GET", "/v1"], ["GET", "/v1/nope"], ["GET", "/api/nope"], ["POST", "/"], ["DELETE", "/app.js"], ["PUT", "/p/x"]] as const) {
    const res = await get(APP + path, { method, headers: { origin: APP } });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "notFound", `${method} ${path}`);
    secured(res, `${method} ${path}`);
  }
});

test("no email sign-in: the link routes answer not implemented, and nothing is stored", async () => {
  const db = await w.mf.getD1Database("DB");
  await db.prepare(`INSERT INTO users (id, email, created_ms) VALUES (?, 'known@example.com', 0)`).bind(newId("user")).run();
  const res = await get(APP + "/v1/auth/email-link", { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body: JSON.stringify({ email: "known@example.com" }) });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "notFound");
  secured(res, "email-link");
  assert.equal(await db.prepare(`SELECT name FROM sqlite_master WHERE name = 'sign_in_links'`).first(), null);
});

test("only the app's origin: machine hosts, other hosts and plain http get nothing", async () => {
  for (const url of [
    `https://m-${newId("machine")}.${WRANGLER.vars.MACHINE_DOMAIN}/`,
    "https://other.example.net/",
    APP.replace("https:", "http:") + "/",
    APP + ":8443/",
  ]) {
    const res = await get(url);
    assert.equal(res.status, 404, url);
    secured(res, url);
    assert.doesNotMatch(await res.text(), /fixture/, url);
  }
});

test("the relay: its refusals carry the headers; an upgrade reaches the machine's Durable Object", async () => {
  const mch = newId("machine");
  for (const [path, status] of [
    [`/api/relay/v1/peer?machine=${mch}`, 426], // (not an upgrade)
    ["/api/relay/v1/nope", 404],
  ] as const) {
    const res = await get(APP + path);
    assert.equal(res.status, status, path);
    secured(res, path);
  }
  const bad = await get(APP + "/api/relay/v1/peer?machine=nope", { headers: { upgrade: "websocket" } });
  assert.equal(bad.status, 400);
  secured(bad, "bad machine id");
  // (Miniflare's response carries the client end of the socket, workerd-style: accept, then close)
  const up = (await get(APP + `/api/relay/v1/peer?machine=${mch}`, { headers: { upgrade: "websocket" } })) as Response & { webSocket: { accept(): void; close(code: number): void } | null };
  assert.equal(up.status, 101);
  assert.ok(up.webSocket);
  up.webSocket.accept();
  up.webSocket.close(1000);
});

test("the scheduled run prunes expired sessions, at most a batch per run, soonest expired first", async () => {
  const db = await w.mf.getD1Database("DB");
  const now = Date.now();
  const user = newId("user");
  await db.prepare(`INSERT INTO users (id, email, created_ms) VALUES (?, 'p@example.com', 0)`).bind(user).run();
  const hex = (i: number, tag: string) => (tag + i.toString(16)).padStart(64, "0");
  const stmts = [];
  // (session i expired i seconds before session 0)
  for (let i = 0; i < PRUNE_BATCH + 100; i++) {
    stmts.push(db.prepare(`INSERT INTO sessions (id_sha256, user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)`).bind(hex(i, "b"), user, 0, now - 1000 - i * 1000));
  }
  // kept: a live session
  stmts.push(db.prepare(`INSERT INTO sessions (id_sha256, user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)`).bind(hex(1, "d"), user, now, now + 3_600_000));
  await db.batch(stmts);
  const count = async () => (await db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`).bind(user).first<{ n: number }>())!.n;
  const has = async (id: string) => !!(await db.prepare(`SELECT 1 FROM sessions WHERE id_sha256 = ?`).bind(id).first());
  const worker = await w.mf.getWorker();
  await worker.scheduled({ cron: WRANGLER.triggers.crons[0]!, scheduledTime: new Date(now) });
  assert.equal(await count(), 101);
  assert.deepEqual([await has(hex(0, "b")), await has(hex(PRUNE_BATCH + 99, "b"))], [true, false]);
  await worker.scheduled({ cron: WRANGLER.triggers.crons[0]!, scheduledTime: new Date(now) });
  assert.equal(await count(), 1);
  assert.ok(await has(hex(1, "d")));
});

test("a bad deploy config: every request refused with the headers, nothing served", async () => {
  const bad = await start({ ...WRANGLER.vars, APP_ORIGIN: "http://gpu.example.com" });
  try {
    for (const path of ["/", "/v1/me", "/app.js"]) {
      const res = (await bad.mf.dispatchFetch("https://gpu.example.com" + path)) as unknown as Response;
      assert.equal(res.status, 500, path);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "internal");
      secured(res, path);
    }
  } finally {
    await bad.dispose();
  }
});

// ---- in Node: the parts the runtime doesn't show

test("background failures log their kind only, never their message", () => {
  const line = backgroundFailureLine(new TypeError("mail to someone@example.com with https://x/?token=secret failed"));
  assert.equal(line, "control: background work failed (TypeError)");
  assert.equal(backgroundFailureLine("x"), "control: background work failed (string)");
});

test("background work: a failure is caught (the Worker sees settled work) and logged by kind", async () => {
  const handed: Promise<unknown>[] = [];
  const logs: string[] = [];
  const wait = guardedWaitUntil({ waitUntil: (p) => handed.push(p) }, (l) => logs.push(l));
  wait(Promise.reject(new RangeError("to someone@example.com")));
  wait(Promise.resolve(1));
  await Promise.all(handed); // (would reject if a failure got through)
  assert.deepEqual(logs, ["control: background work failed (RangeError)"]);
});

test("scheduled: every job runs even if one fails; then the run fails, naming it; failures log no message", async () => {
  const ran: string[] = [];
  const logs: string[] = [];
  const worker = createWorker({
    now: () => 123,
    log: (l) => logs.push(l),
    jobs: [
      { name: "one", run: async (e) => (ran.push(`one@${e.now}`), 2) },
      { name: "two", run: async () => { ran.push("two"); throw new Error("secret detail"); } },
      { name: "three", run: async () => (ran.push("three"), 0) },
    ],
  });
  const env = { DB: { prepare() { throw new Error("unused"); }, batch() { throw new Error("unused"); } } } as never;
  await assert.rejects(worker.scheduled({ scheduledTime: 0, cron: "* * * * *" }, env, { waitUntil() {} }), /scheduled jobs failed: two$/);
  assert.deepEqual(ran, ["one@123", "two", "three"]);
  assert.deepEqual(logs, ["control: one: 2", "control: scheduled job two failed (Error)"]);
  // all well: no error
  await createWorker({ log: () => {}, jobs: [{ name: "ok", run: async () => 0 }] }).scheduled({ scheduledTime: 0, cron: "" }, env, { waitUntil() {} });
});

// ---- container launch (off by default): the Worker's wiring

const BASE_VARS = { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com" };
const RELEASE = {
  SBGPU_CONTAINER_IMAGE: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  SBGPU_AGENT_URL: "https://cdn.example.com/agent/sbgpu-agent.tar.gz",
  SBGPU_AGENT_SHA256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

test("containerDeps: off by default; on but unusable without the installation or the key; usable: our RunPod adapter, the release's image and launcher", () => {
  assert.deepEqual(containerDeps(configFromEnv(BASE_VARS), "k", fetch), { off: true });
  const on = configFromEnv({ ...BASE_VARS, ...RELEASE, SBGPU_CONTAINER_LAUNCH: "on" });
  assert.deepEqual(containerDeps(on, "k", fetch), { unusable: "SBGPU_INSTALLATION is unset" });
  const full = configFromEnv({ ...BASE_VARS, ...RELEASE, SBGPU_CONTAINER_LAUNCH: "on", SBGPU_INSTALLATION: "prod" });
  for (const key of [undefined, "", 5]) assert.deepEqual(containerDeps(full, key, fetch), { unusable: "RUNPOD_API_KEY is unset" }, String(key));
  const d = containerDeps(full, "rpa_SECRETKEYVALUE0000", fetch);
  assert.ok("deps" in d);
  assert.ok(d.deps.provider instanceof RunPodAdapter);
  const boot = renderBootCommand({ agentUrl: RELEASE.SBGPU_AGENT_URL, agentSha256: RELEASE.SBGPU_AGENT_SHA256, controlUrl: "https://gpu.example.com", mode: "container" });
  assert.ok("argv" in boot);
  assert.deepEqual(d.deps.expect, { image: RELEASE.SBGPU_CONTAINER_IMAGE, launcher: boot.argv, bootEnv: "SBGPU_BOOT_TOKEN" });
  assert.ok(!inspect(d, { depth: null, showHidden: true }).includes("SECRETKEYVALUE"), "the key isn't visible in the deps");
});

/** A D1 that answers every read with no rows and records each statement's SQL. */
function recordingD1(failReads = false) {
  const sqls: string[] = [];
  const stmt = (sql: string) => ({
    bind: () => ({
      all: async () => {
        sqls.push(sql);
        if (failReads) throw new Error("d1 down");
        return { results: [] };
      },
      run: async () => (sqls.push(sql), { meta: { changes: 0 } }),
    }),
  });
  return { sqls, d1: { prepare: (sql: string) => stmt(sql), batch: async () => [] } };
}

test("scheduled: the container watchdog runs only when container launch is on and usable; on but unusable is one alert line a run", async () => {
  const cases: Array<[Record<string, string>, boolean, string[]]> = [
    [{}, false, []],
    [{ ...RELEASE, SBGPU_CONTAINER_LAUNCH: "off" }, false, []],
    [{ ...RELEASE, SBGPU_CONTAINER_LAUNCH: "on" }, false, ["control: alert: container launch is on but SBGPU_INSTALLATION is unset: launches not started"]],
    [{ ...RELEASE, SBGPU_CONTAINER_LAUNCH: "on", SBGPU_INSTALLATION: "prod" }, false, ["control: alert: container launch is on but RUNPOD_API_KEY is unset: launches not started"]],
    [{ ...RELEASE, SBGPU_CONTAINER_LAUNCH: "on", SBGPU_INSTALLATION: "prod", RUNPOD_API_KEY: "k" }, true, []],
  ];
  for (const [vars, ran, lines] of cases) {
    const logs: string[] = [];
    const r = recordingD1();
    const other: string[] = [];
    await createWorker({ now: () => 123, log: (l) => logs.push(l), jobs: [{ name: "other", run: async () => (other.push("ran"), 0) }] }).scheduled(
      { scheduledTime: 0, cron: "" },
      { DB: r.d1, ...BASE_VARS, ...vars } as never,
      { waitUntil() {} },
    );
    assert.equal(r.sqls.includes(CONTAINER_WATCHDOG_SELECT), ran, JSON.stringify(vars));
    assert.deepEqual([logs, other], [lines, ["ran"]], JSON.stringify(vars));
  }
  // a failing container watchdog fails the run by name, after the other jobs; a bad deploy config only skips it
  const logs: string[] = [];
  const failing = recordingD1(true);
  await assert.rejects(
    createWorker({ now: () => 123, log: (l) => logs.push(l), jobs: [] }).scheduled(
      { scheduledTime: 0, cron: "" },
      { DB: failing.d1, ...BASE_VARS, ...RELEASE, SBGPU_CONTAINER_LAUNCH: "on", SBGPU_INSTALLATION: "prod", RUNPOD_API_KEY: "k" } as never,
      { waitUntil() {} },
    ),
    /scheduled jobs failed: container watchdog$/,
  );
  assert.deepEqual(logs, ["control: scheduled job container watchdog failed (Error)"]);
  const bad: string[] = [];
  await createWorker({ now: () => 123, log: (l) => bad.push(l), jobs: [] }).scheduled({ scheduledTime: 0, cron: "" }, { DB: recordingD1().d1, MACHINE_DOMAIN: "m.example.com", SBGPU_CONTAINER_LAUNCH: "on" } as never, { waitUntil() {} });
  assert.deepEqual(bad, ["control: the deploy config is invalid; no container watchdog"]);
});

// ---- the enroll batch's guard on D1 itself (SEC): the all-or-nothing proof rests on D1
// running a batch's statements in order, on one connection, in one transaction, so that
// changes() in a guard sees the write just before it. The native SQLite suite can't show that.

const WRITE_TOOK = "INSERT INTO enroll_guard (ok) SELECT 0 WHERE changes() <> 1";

test("D1: a write followed by the enroll guard commits when it changed one row, and rolls the whole batch back when it changed none", async () => {
  // (the guard the handler uses is exactly this statement)
  assert.ok(readFileSync(new URL("./enroll.ts", import.meta.url), "utf8").includes("`" + WRITE_TOOK + "`"));
  const db = d1Db((await w.mf.getD1Database("DB")) as unknown as D1Like);
  const [a, b, c] = [newId("user"), newId("user"), newId("user")];
  await db.batch([{ sql: `INSERT INTO users (id, email, created_ms) VALUES (?, ?, 0)`, params: [a, `${a}@example.com`] }]);
  const email = async (id: string) => (await db.all<{ email: string }>(`SELECT email FROM users WHERE id = ?`, [id]))[0]?.email ?? null;
  // one row changed, then the guard: committed
  await db.batch([
    { sql: `UPDATE users SET email = ? WHERE id = ?`, params: [`a2-${a}@example.com`, a] },
    { sql: WRITE_TOOK, params: [] },
    { sql: `INSERT INTO users (id, email, created_ms) VALUES (?, ?, 0)`, params: [b, `${b}@example.com`] },
    { sql: WRITE_TOOK, params: [] },
  ]);
  assert.deepEqual([await email(a), await email(b)], [`a2-${a}@example.com`, `${b}@example.com`]);
  // an earlier write, then a write that changed nothing, then the guard: all of it rolled back
  await assert.rejects(
    db.batch([
      { sql: `UPDATE users SET email = ? WHERE id = ?`, params: [`a3-${a}@example.com`, a] },
      { sql: WRITE_TOOK, params: [] },
      { sql: `INSERT INTO users (id, email, created_ms) VALUES (?, ?, 0)`, params: [c, `${c}@example.com`] },
      { sql: `UPDATE users SET email = 'x' WHERE id = ?`, params: [newId("user")] },
      { sql: WRITE_TOOK, params: [] },
    ]),
  );
  assert.deepEqual([await email(a), await email(c)], [`a2-${a}@example.com`, null]);
  assert.deepEqual(await db.all(`SELECT * FROM enroll_guard`), []);
});

// ---- the heartbeat's ordering on D1 itself: an upsert whose DO UPDATE is skipped changes no
// row, and the next statement's changes() sees that (so the save estimate follows the report)

test("D1: an upsert skipped by its WHERE changes nothing, and a write gated on changes() = 1 after it doesn't happen", async () => {
  const hb = readFileSync(new URL("./heartbeat.ts", import.meta.url), "utf8");
  assert.ok(hb.includes("WHERE excluded.last_ms > machine_heartbeats.last_ms`") && hb.includes("AND changes() = 1`"));
  const db = d1Db((await w.mf.getD1Database("DB")) as unknown as D1Like);
  const [a, b] = [newId("user"), newId("user")];
  await db.batch([{ sql: `INSERT INTO users (id, email, created_ms) VALUES (?, ?, 10)`, params: [a, `${a}@example.com`] }]);
  await db.batch([{ sql: `INSERT INTO users (id, email, created_ms) VALUES (?, ?, 0)`, params: [b, `${b}@example.com`] }]);
  const upsert = (ms: number, email: string) => ({
    sql: `INSERT INTO users (id, email, created_ms) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email, created_ms = excluded.created_ms
          WHERE excluded.created_ms > users.created_ms`,
    params: [a, email, ms],
  });
  const follow = (email: string) => ({ sql: `UPDATE users SET email = ? WHERE id = ? AND changes() = 1`, params: [email, b] });
  const rows = async () => (await db.all<{ email: string; created_ms: number }>(`SELECT email, created_ms FROM users WHERE id IN (?, ?) ORDER BY created_ms DESC`, [a, b])).map((r) => [r.email, r.created_ms]);
  // older (and equal): neither written
  await db.batch([upsert(9, `old-${a}@example.com`), follow(`old-${b}@example.com`)]);
  await db.batch([upsert(10, `eq-${a}@example.com`), follow(`eq-${b}@example.com`)]);
  assert.deepEqual(await rows(), [[`${a}@example.com`, 10], [`${b}@example.com`, 0]]);
  // newer: both
  await db.batch([upsert(11, `new-${a}@example.com`), follow(`new-${b}@example.com`)]);
  assert.deepEqual(await rows(), [[`new-${a}@example.com`, 11], [`new-${b}@example.com`, 0]]);
});
