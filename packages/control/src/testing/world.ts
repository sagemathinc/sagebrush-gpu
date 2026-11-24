// A test world for the control plane's HTTP API: the app over node:sqlite with a fixed
// clock, deterministic randomness, a recording mailer, one org and one project, and
// helpers to call it and to sign people in through the real flow.

import assert from "node:assert/strict";
import { newId } from "@sbgpu/api";
import { DEFAULT_CONFIG, HANDLERS, createApp, type AppDeps, type Handlers } from "../app.ts";
import { stmt } from "../db.ts";
import { sqliteDb, type TestDb } from "./sqlite.ts";

export const ORIGIN = "https://gpu.example.test";
export const T0 = Date.UTC(2027, 1, 1, 9, 0, 0);

export interface World {
  db: TestDb;
  pending: Promise<unknown>[];
  deps: AppDeps;
  mail: Array<{ email: string; url: string }>;
  clock: { t: number };
  app: ReturnType<typeof createApp>;
  orgId: string;
  projectId: string;
}

export async function world(o: { handlers?: Handlers; budget?: number } = {}): Promise<World> {
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
      for (let i = 0; i < n; i++) b[i] = (counter * 31 + i * 7 + (counter >> 8)) & 255;
      return b;
    },
    mailer: {
      async sendSignInLink(email, url) {
        mail.push({ email, url });
      },
    },
    config: { ...DEFAULT_CONFIG, appOrigin: ORIGIN, machineDomain: "m.example.test" },
    waitUntil: (p) => {
      pending.push(p);
    },
  };
  const orgId = newId("org");
  const projectId = newId("project");
  await db.batch([
    stmt(`INSERT INTO orgs (id, name, margin_bps, created_ms) VALUES (?, 'Org', 3000, ?)`, orgId, T0),
    stmt(
      `INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Proj', ?, ?, ?, ?)`,
      projectId, orgId, T0, T0 + 86_400_000, o.budget ?? 1_000_000_000, T0,
    ),
  ]);
  return { db, pending, deps, mail, clock, app: createApp(deps, o.handlers ? { ...HANDLERS, ...o.handlers } : HANDLERS), orgId, projectId };
}

export interface Req {
  body?: unknown;
  cookie?: string;
}

export async function call(w: World, method: string, path: string, r: Req = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (r.cookie) headers.cookie = r.cookie;
  let body: string | undefined;
  if (method !== "GET" && method !== "DELETE") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(r.body ?? {});
  }
  const res = await w.app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }));
  await Promise.all(w.pending.splice(0));
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { res, json: json as Record<string, unknown> & { error?: { code: string; message: string } } };
}

export const code = (r: { res: Response; json: { error?: { code: string } } }) => (r.res.status === 200 ? "ok" : r.json.error?.code);

/** A member row straight into the database (with its allocation), for setting up a scene. */
export async function addMember(
  w: World,
  email: string,
  role = "member",
  o: { status?: "invited" | "removed"; projectId?: string; allocation?: number } = {},
): Promise<string> {
  const id = newId("member");
  const projectId = o.projectId ?? w.projectId;
  await w.db.batch([
    stmt(`INSERT INTO members (id, project_id, email, role, status, created_ms) VALUES (?, ?, ?, ?, ?, ?)`, id, projectId, email, role, o.status === "removed" ? "removed" : "invited", T0),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', ?, ?, ?)`, newId("allocation"), projectId, id, o.allocation ?? 0, T0),
  ]);
  return id;
}

/** Sign in through the real flow (the email must be known); returns the cookie header. */
export async function signIn(w: World, email: string): Promise<string> {
  const n = w.mail.length;
  await call(w, "POST", "/v1/auth/email-link", { body: { email } });
  assert.equal(w.mail.length, n + 1, `a link was mailed to ${email}`);
  const token = new URL(w.mail.at(-1)!.url).searchParams.get("token")!;
  const r = await call(w, "POST", "/v1/auth/verify", { body: { token } });
  assert.equal(r.res.status, 200);
  return r.res.headers.get("set-cookie")!.split(";")[0]!;
}

/** A signed-in person with this project role (active). */
export async function person(w: World, email: string, role: string): Promise<{ cookie: string; memberId: string }> {
  const memberId = await addMember(w, email, role);
  return { cookie: await signIn(w, email), memberId };
}
