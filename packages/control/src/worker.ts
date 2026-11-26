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

import { BOOT_TOKEN_ENV, renderBootCommand } from "@sbgpu/machine";
import { relayRoute, type RelayRouteEnv } from "@sbgpu/machine/relay/routes";
import { RunPodAdapter } from "@sbgpu/providers";
import { configFromEnv, createApp, withSecurityHeaders, type AppConfig } from "./app.ts";
import { runContainerWatchdog, type ContainerDeps } from "./container.ts";
import { runContainerSweep } from "./sweep.ts";
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
  /** Container launches: "on" or "off" (the default), and the release they pin (see configFromEnv). */
  SBGPU_CONTAINER_LAUNCH?: unknown;
  SBGPU_INSTALLATION?: unknown;
  /** Our RunPod API key (a secret): only ever given to the RunPod adapter, never logged, returned or put in a pod. */
  RUNPOD_API_KEY?: unknown;
}

/**
 * Container mode's dependencies, or why there are none: off (the flag), or on but unusable
 * (no installation slug, or no RunPod key; launches then aren't started). The adapter holds our
 * key and is built per request or run; the pods must show the release's image and the launcher
 * rendered for this origin.
 */
/**
 * The container watchdog's dependencies for cleanup, whatever the flag says: launches made while
 * container launch was on must still end, and their accruals close, after it is switched off.
 * It needs this deployment's installation slug (name recovery) and our key; the pods' expected
 * release is the configured one when there is one (the watchdog itself never checks it).
 */
export function cleanupDeps(config: AppConfig, apiKey: unknown, f: typeof fetch): { deps: ContainerDeps } | { unusable: string } {
  if (config.installation === null) return { unusable: "SBGPU_INSTALLATION is unset" };
  if (typeof apiKey !== "string" || apiKey === "") return { unusable: "RUNPOD_API_KEY is unset" };
  const on = containerDeps(config, apiKey, f);
  if ("deps" in on) return on;
  return { deps: { provider: new RunPodAdapter({ apiKey, fetch: (input, init) => f(input, init) }), expect: { image: "", launcher: [], bootEnv: BOOT_TOKEN_ENV } } };
}

/** A container launch the container watchdog still has to act on: due, so not final (the due index). */
export const CONTAINER_PENDING_SELECT = `SELECT 1 AS one FROM launches WHERE next_ms IS NOT NULL AND mode = 'container' LIMIT 1`;

export function containerDeps(config: AppConfig, apiKey: unknown, f: typeof fetch): { deps: ContainerDeps } | { off: true } | { unusable: string } {
  const c = config.containerLaunch;
  if (c === null) return { off: true };
  if (config.installation === null) return { unusable: "SBGPU_INSTALLATION is unset" };
  if (typeof apiKey !== "string" || apiKey === "") return { unusable: "RUNPOD_API_KEY is unset" };
  const boot = renderBootCommand({ agentUrl: c.agentUrl, agentSha256: c.agentSha256, controlUrl: config.appOrigin, mode: "container" });
  if (!("argv" in boot)) return { unusable: "the launcher has no argv" };
  return {
    deps: {
      provider: new RunPodAdapter({ apiKey, fetch: (input, init) => f(input, init) }),
      expect: { image: c.image, launcher: boot.argv, bootEnv: BOOT_TOKEN_ENV },
    },
  };
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
        container: (() => {
          const d = containerDeps(config, env.RUNPOD_API_KEY, fetch);
          return "deps" in d ? d.deps : null;
        })(),
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
      // Container mode's watchdog: whenever container launches are on and usable, and also while
      // any container launch is still due after they're switched off (off stops new launches, not
      // cleanup). On but unusable: one alert line a run (why nothing launches); due launches that
      // the watchdog can't reach (no installation or key): one alert line a run (why they can't end).
      let config: AppConfig | null = null;
      try {
        config = configFromEnv(env as unknown as Record<string, unknown>);
      } catch {
        // (the fetch path logs a bad config per request; here only when container launch was asked for)
        if (env.SBGPU_CONTAINER_LAUNCH === "on") log("control: the deploy config is invalid; no container watchdog");
      }
      if (config !== null) {
        const d = containerDeps(config, env.RUNPOD_API_KEY, fetch);
        if ("unusable" in d) log(`control: alert: container launch is on but ${d.unusable}: launches not started`);
        let deps: ContainerDeps | null = "deps" in d ? d.deps : null;
        if (deps === null) {
          let pending = true;
          try {
            pending = (await db.all(CONTAINER_PENDING_SELECT)).length > 0;
          } catch {
            // (unread: as if there were some, so the watchdog runs or the alert says why it can't)
          }
          if (pending) {
            const c = cleanupDeps(config, env.RUNPOD_API_KEY, fetch);
            if ("deps" in c) deps = c.deps;
            else log(`control: alert: container launches are due but ${c.unusable}: they can't be ended`);
          }
        }
        if (deps !== null) {
          const live = deps;
          try {
            const n = await runContainerWatchdog({
              db,
              installation: config.installation,
              clock: now,
              provider: live.provider,
              expect: live.expect,
              randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
              elapsedMs: () => Date.now() - began,
            });
            if (n > 0) log(`control: container watchdog: ${n}`);
          } catch (e) {
            failed.push("container watchdog");
            log(`control: scheduled job container watchdog failed (${e instanceof Error ? e.name : typeof e})`);
          }
        }
        // The orphan sweep: with the watchdog's adapter, or, when there is none (off, nothing due),
        // the cleanup adapter if this deployment has an installation and a key (pods it once
        // launched may outlive the flag). With neither, there is nothing it could end.
        const sweepDeps = deps ?? (() => {
          const c = cleanupDeps(config, env.RUNPOD_API_KEY, fetch);
          return "deps" in c ? c.deps : null;
        })();
        if (sweepDeps !== null) {
          try {
            const n = await runContainerSweep({
              db,
              installation: config.installation,
              clock: now,
              provider: sweepDeps.provider,
              expect: sweepDeps.expect,
              randomBytes: (k) => crypto.getRandomValues(new Uint8Array(k)),
              elapsedMs: () => Date.now() - began,
              alert: (line) => log(`control: alert: ${line}`),
            });
            if (n > 0) log(`control: container sweep: ${n}`);
          } catch (e) {
            failed.push("container sweep");
            log(`control: scheduled job container sweep failed (${e instanceof Error ? e.name : typeof e})`);
          }
        }
      }
      if (failed.length) throw new Error(`scheduled jobs failed: ${failed.join(", ")}`);
    },
  };
}

export default createWorker();
