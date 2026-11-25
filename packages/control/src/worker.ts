// The control Worker: one fetch handler for the app's origin (the API, the machine relay's
// routes and the UI's static assets) and one scheduled handler (a fixed list of jobs).
// This file has no Worker-only imports, so Node's tests load it too; entry.ts adds the
// relay's Durable Object class for the deployed Worker.
//
// Every response it makes carries the security headers: the API's own, and
// withSecurityHeaders on the relay's refusals and on every static asset (the deploy config
// runs this Worker before the assets, so none is served around it). A WebSocket upgrade
// (101) is passed on as is. Nothing here logs a URL (a sign-in callback's carries a
// one-time code).

import { relayRoute, type RelayRouteEnv } from "@sbgpu/machine/relay/routes";
import { configFromEnv, createApp, withSecurityHeaders, type AppConfig } from "./app.ts";
import { d1Db, type D1Like, type Db } from "./db.ts";
import { json } from "./http.ts";
import { SCHEDULED_JOBS, type ScheduledJob } from "./jobs.ts";
import { loadAgentPublicKeys, loadAgentSigner } from "./signer.ts";
import { errorBody, type ErrorCode } from "@sbgpu/api";

export interface WorkerEnv extends RelayRouteEnv {
  DB: D1Like;
  /** The UI's static assets (the deploy config's assets binding). */
  ASSETS: { fetch(req: Request): Promise<Response> };
  APP_ORIGIN?: unknown;
  MACHINE_DOMAIN?: unknown;
  /** The agent-token signer: an Ed25519 private JWK (a secret), its kid, and the pinned public keys by kid. */
  AGENT_SIGNING_JWK?: unknown;
  AGENT_SIGNING_KID?: unknown;
  AGENT_PUBLIC_KEYS?: unknown;
}

export interface WorkerContext {
  waitUntil(work: Promise<unknown>): void;
}

/** What a failure in background work logs: its kind only, never its message (which may hold an address or a token). */
export function backgroundFailureLine(e: unknown): string {
  return `control: background work failed (${e instanceof Error ? e.name : typeof e})`;
}

/** The app's waitUntil: the Worker's, with any failure caught and logged as backgroundFailureLine. */
export function guardedWaitUntil(ctx: WorkerContext, log: (line: string) => void): (work: Promise<unknown>) => void {
  return (work) => ctx.waitUntil(work.catch((e: unknown) => log(backgroundFailureLine(e))));
}

export interface WorkerOptions {
  now?: () => number;
  log?: (line: string) => void;
  jobs?: readonly ScheduledJob[];
}

const fail = (status: number, code: ErrorCode, message: string) => json(status, errorBody(code, message));

export function createWorker(o: WorkerOptions = {}) {
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? ((line: string) => console.error(line));
  const jobs = o.jobs ?? SCHEDULED_JOBS;

  async function route(req: Request, env: WorkerEnv, ctx: WorkerContext, config: AppConfig): Promise<Response> {
    const url = new URL(req.url);
    // Only the app's origin. The machines' hosts (m-<id>.<machine domain>) will be answered
    // by the Jupyter proxy; until then they, and any other host, get nothing.
    if (url.origin !== config.appOrigin) return fail(404, "notFound", "no such host");
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      const db = d1Db(env.DB);
      const app = createApp({
        db,
        now,
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
        config,
        fetch: (input, init) => fetch(input, init),
        vm: null,
        waitUntil: guardedWaitUntil(ctx, log),
        agentSigner: () => loadAgentSigner(env.AGENT_SIGNING_JWK, env.AGENT_SIGNING_KID, env.AGENT_PUBLIC_KEYS),
        agentPublicKeys: () => loadAgentPublicKeys(env.AGENT_PUBLIC_KEYS),
        alert: (line) => log(`control: alert: ${line}`),
      });
      return app.fetch(req);
    }
    const relay = await relayRoute(req, env);
    if (relay) return relay.status === 101 ? relay : withSecurityHeaders(relay);
    if (url.pathname.startsWith("/api/")) return fail(404, "notFound", "no such endpoint");
    if (req.method !== "GET" && req.method !== "HEAD") return fail(404, "notFound", "no such endpoint");
    return withSecurityHeaders(await env.ASSETS.fetch(req));
  }

  return {
    async fetch(req: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
      let config: AppConfig;
      try {
        config = configFromEnv(env as unknown as Record<string, unknown>);
      } catch (e) {
        log(`control: the deploy config is invalid: ${e instanceof Error ? e.message : "?"}`);
        return fail(500, "internal", "the service is misconfigured");
      }
      try {
        return await route(req, env, ctx, config);
      } catch (e) {
        log(`control: request failed (${e instanceof Error ? e.name : typeof e})`);
        return fail(500, "internal", "internal error");
      }
    },

    /**
     * Each job runs whatever the others do, in order; if any failed, the run fails after
     * all of them (so the platform records it) with the failed jobs' names.
     */
    async scheduled(_controller: { scheduledTime: number; cron: string }, env: WorkerEnv, _ctx: WorkerContext): Promise<void> {
      const db: Db = d1Db(env.DB);
      const t = now();
      const began = Date.now();
      // (no VM provider is wired yet: VM mode stays unreachable until its adapter and gate land)
      const jobEnv = { db, now: t, vm: null, elapsedMs: () => Date.now() - began };
      const failed: string[] = [];
      for (const job of jobs) {
        try {
          const n = await job.run(jobEnv);
          if (n > 0) log(`control: ${job.name}: ${n}`);
        } catch (e) {
          failed.push(job.name);
          log(`control: scheduled job ${job.name} failed (${e instanceof Error ? e.name : typeof e})`);
        }
      }
      if (failed.length) throw new Error(`scheduled jobs failed: ${failed.join(", ")}`);
    },
  };
}

export default createWorker();
