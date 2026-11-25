import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newId } from "@sbgpu/api";
import { startWorker, type StartedWorker } from "@sbgpu/testing/worker";
import { SECURITY_HEADERS } from "./http.ts";
import { backgroundFailureLine, createWorker, guardedWaitUntil } from "./worker.ts";
import { PRUNE_BATCH } from "./jobs.ts";

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
