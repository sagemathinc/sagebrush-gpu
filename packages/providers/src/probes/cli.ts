// The eradication probe's command line. A dry run unless given --execute with an approval
// reference; see eradication.ts for what the probe does.
//
//   node packages/providers/src/probes/cli.ts --agent-url URL --agent-sha256 HEX --control-url URL [options]
//
//   --agent-url URL        https URL of the probe agent tarball (required; with --execute, exactly
//                          PINNED_PROBE_AGENT's)
//   --agent-sha256 HEX     its sha256, 64 lowercase hex (required; with --execute, exactly the pin)
//   --control-url URL      https URL of the control plane (required; checked by the launcher)
//                          The launcher argv is built from these and a fresh random salt: the
//                          probe-only prologue (@sbgpu/machine renderProbePrologue) followed by the
//                          unchanged production launcher script; no other launcher can be given.
//   --gpu TYPE             our GPU type id (default RTX-A4000, the cheapest Secure Cloud GPU we map)
//   --dc ID                RunPod data center (default EU-SE-1)
//   --image IMAGE          provider stock image (default: the production image)
//   --max-usd N            spend cap in USD, at most 10 (default 3)
//   --max-minutes N        pod lifetime cap (default 60)
//   --execute              actually launch (costs money)
//   --approval TEXT        who approved the spend and where; required with --execute
//   --key-file PATH        the RunPod API key file; required with --execute, and only the
//                          authorized path (AUTHORIZED_KEY_FILE) is accepted
//
// The key is read from the file inside this process and goes only into the Authorization header
// of RunPod requests: never into the environment, argv, the pod, output or errors. The salt is
// never printed or reported. The report goes to stdout as JSON; after the pod is confirmed gone,
// it adds the account's currentSpendPerHr, which must read 0 for the run to count as settled.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isGpuType } from "../gpus.ts";
import type { Fetch } from "../http.ts";
import { RunPodAdapter, RUNPOD_API } from "../runpod/adapter.ts";
import type { LaunchSpec } from "../types.ts";
import {
  CALL_TIMEOUT_MS,
  checkPlan,
  launcherSha256,
  maskSalt,
  parseLogSse,
  probeLauncher,
  runEradicationProbe,
  type ProbePlan,
  type ProbeProviderApi,
  type ProbeReport,
} from "./eradication.ts";

/** The one key file this probe may read (William's approval, Nov 24 2026). */
export const AUTHORIZED_KEY_FILE = "/run/secrets/cocalc/runpod";
/** A key file larger than this is refused. */
export const MAX_KEY_FILE_BYTES = 512;

export const DEFAULT_IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";

/**
 * The only probe agent a paid run may launch: the release built from the commit whose agent
 * prints exactly PROBE_CHECKS (listen22-start ... listen22-end, done). Pinned here so the judge and
 * the agent change together: an older tarball (six checks) can never meet this judge in a paid run.
 */
export const PINNED_PROBE_AGENT = {
  url: "https://github.com/sagemathinc/sagebrush-gpu/releases/download/probe-agent-8de3c4382a7d/sbgpu-probe-agent.tar.gz",
  sha256: "8de3c4382a7d04c88cd5eb4217c6d89a9da03faa395e7c03df46dd7d7e434324",
} as const;

export interface CliOptions {
  agentUrl: string;
  agentSha256: string;
  controlUrl: string;
  gpu: string;
  dc: string;
  image: string;
  maxUsd: number;
  maxMinutes: number;
  execute: boolean;
  approval: string;
  keyFile: string;
}

/** Parse the arguments; unknown or malformed ones throw. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = {
    agentUrl: "",
    agentSha256: "",
    controlUrl: "",
    gpu: "RTX-A4000",
    dc: "EU-SE-1",
    image: DEFAULT_IMAGE,
    maxUsd: 3,
    maxMinutes: 60,
    execute: false,
    approval: "",
    keyFile: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new RangeError(`${a} needs a value`);
      return v;
    };
    const num = (v: string) => {
      if (!/^\d+(\.\d+)?$/.test(v)) throw new RangeError(`${a} needs a number`);
      return Number(v);
    };
    switch (a) {
      case "--agent-url": o.agentUrl = value(); break;
      case "--agent-sha256": o.agentSha256 = value(); break;
      case "--control-url": o.controlUrl = value(); break;
      case "--gpu": o.gpu = value(); break;
      case "--dc": o.dc = value(); break;
      case "--image": o.image = value(); break;
      case "--max-usd": o.maxUsd = num(value()); break;
      case "--max-minutes": o.maxMinutes = num(value()); break;
      case "--approval": o.approval = value(); break;
      case "--execute": o.execute = true; break;
      case "--key-file": o.keyFile = value(); break;
      default: throw new RangeError(`unknown argument: ${a}`);
    }
  }
  if (o.agentUrl === "" || o.agentSha256 === "" || o.controlUrl === "") {
    throw new RangeError("--agent-url, --agent-sha256 and --control-url are required");
  }
  if (!isGpuType(o.gpu)) throw new RangeError(`unknown GPU type: ${o.gpu}`);
  if (o.execute && o.approval.trim().length < 8) throw new RangeError("--execute needs --approval");
  if (o.execute && (o.agentUrl !== PINNED_PROBE_AGENT.url || o.agentSha256 !== PINNED_PROBE_AGENT.sha256)) {
    throw new RangeError("--execute needs the pinned probe agent (PINNED_PROBE_AGENT)");
  }
  if (o.execute && o.keyFile !== AUTHORIZED_KEY_FILE) throw new RangeError(`--execute needs --key-file ${AUTHORIZED_KEY_FILE}`);
  if (!o.execute && o.keyFile !== "") throw new RangeError("--key-file is only for --execute");
  return o;
}

/**
 * The plan for the options. The launcher is built from the probe agent's values and the salt
 * (renderBootScript refuses a non-https or non-plain URL and a malformed hash; the prologue
 * refuses a malformed salt). The boot token is random: nothing exchanges it.
 */
export function planFor(o: CliOptions, bootToken: string, saltHex: string): ProbePlan {
  const agent = { agentUrl: o.agentUrl, agentSha256: o.agentSha256, controlUrl: o.controlUrl };
  const launcher = probeLauncher(agent, saltHex);
  const maxSpendMicros = Math.round(o.maxUsd * 1_000_000);
  const spec: LaunchSpec = {
    machineId: "mch_pr0bepr0bepr0bepr0be",
    gpuType: o.gpu,
    gpuCount: 1,
    dataCenter: o.dc,
    image: o.image,
    diskGb: 40,
    bootToken,
    launcher,
    // The rate the pod may bill: the spend cap spread over the lifetime, so a launch at a
    // higher rate is refused (price_above_cap) before it can run the cap down.
    maxProviderCostPerHour: Math.floor((maxSpendMicros * 60) / o.maxMinutes),
  };
  const plan: ProbePlan = {
    approval: o.approval === "" ? "dry-run (no approval)" : o.approval,
    agent,
    saltHex,
    spec,
    maxSpendMicros,
    maxMinutes: o.maxMinutes,
    stageMinutes: 15,
    pollSeconds: 30,
  };
  checkPlan(plan);
  return plan;
}

/**
 * The API key from a key file: one line, no whitespace, at most MAX_KEY_FILE_BYTES. Errors never
 * include the file's content.
 */
export function readKeyFile(path: string, read: (path: string) => Uint8Array = readFileSync): string {
  if (path !== AUTHORIZED_KEY_FILE) throw new RangeError("only the authorized key file may be read");
  const bytes = read(path);
  if (bytes.length > MAX_KEY_FILE_BYTES) throw new RangeError("the key file is too large");
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text === "" || /\s/.test(text)) throw new RangeError("the key file is empty or malformed");
  return text;
}

export const RUNPOD_GRAPHQL = "https://api.runpod.io/graphql";

/**
 * The account's current spend rate (USD per hour) from RunPod's GraphQL `myself`. Throws on any
 * failure, never with the response body.
 */
export async function accountSpendPerHr(apiKey: string, doFetch: typeof fetch = fetch): Promise<number> {
  const res = await doFetch(RUNPOD_GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "query { myself { currentSpendPerHr } }" }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    redirect: "manual",
  });
  // Status first: an error reply's body is never read.
  if (res.status !== 200) throw new Error(`spend read: HTTP ${res.status}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("spend read: not JSON");
  }
  // GraphQL reports failures beside partial data: any error makes the read fail (its text is never kept).
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) throw new Error("spend read: GraphQL errors");
  const v = (body as { data?: { myself?: { currentSpendPerHr?: unknown } } } | null)?.data?.myself?.currentSpendPerHr;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("spend read: no valid currentSpendPerHr");
  return v;
}

/**
 * Read the account's spend rate until it is 0 (billing lags a terminated pod by about a minute),
 * at most `polls` times. Settled only on a successful read of exactly 0; failures count as not
 * settled. Never launches or changes anything.
 */
export async function settleSpend(
  read: () => Promise<number>,
  sleep: (ms: number) => Promise<void>,
  polls = 6,
  intervalMs = 30_000,
): Promise<{ settled: boolean; lastSpendPerHr: number | null }> {
  let last: number | null = null;
  for (let i = 0; i < polls; i++) {
    if (i > 0) await sleep(intervalMs);
    try {
      last = await read();
    } catch {
      last = null;
      continue;
    }
    if (last === 0) return { settled: true, lastSpendPerHr: 0 };
  }
  return { settled: false, lastSpendPerHr: last };
}

/**
 * The length of the complete events at the start of an SSE body: up to and including its last
 * blank line, whether lines end in LF or CRLF. Anything after it is an unfinished event.
 */
export function completeEventsLength(body: string): number {
  let end = 0;
  for (const m of body.matchAll(/(?:\r\n|\n)(?:\r\n|\n)/g)) end = m.index + m[0].length;
  return end;
}

export interface ReadLogsOptions {
  fetch?: typeof fetch;
  /** Stop after this long without new data (the stream never ends by itself). */
  quietMs?: number;
  /** Stop after this long in all. */
  maxMs?: number;
  maxBytes?: number;
}

/** Read RunPod's SSE log stream until it is quiet, then keep only its complete events. */
export async function readLogs(apiKey: string, id: string, since: string, opts: ReadLogsOptions = {}): Promise<string[]> {
  const doFetch = opts.fetch ?? fetch;
  const url = `${RUNPOD_API}/v2/pods/${encodeURIComponent(id)}/logs?${new URLSearchParams({ since })}`;
  const ctl = new AbortController();
  const hard = setTimeout(() => ctl.abort(), opts.maxMs ?? CALL_TIMEOUT_MS);
  let body = "";
  try {
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" }, signal: ctl.signal, redirect: "manual" });
    if (res.status !== 200 || res.body === null) throw new Error(`logs HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quiet = new Promise<"quiet">((r) => {
        timer = setTimeout(() => r("quiet"), opts.quietMs ?? 3000);
      });
      const next = await Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
      if (next === "quiet" || next.done) break;
      body += dec.decode(next.value, { stream: true });
      if (body.length > (opts.maxBytes ?? 4_000_000)) throw new Error("logs too large");
    }
    await reader.cancel().catch(() => {});
  } finally {
    clearTimeout(hard);
    ctl.abort();
  }
  return parseLogSse(body.slice(0, completeEventsLength(body)));
}

/** A pod action (stop, terminate) by RunPod's REST API. Throws on any non-2xx, before any body read. */
export async function podAction(apiKey: string, id: string, action: string, doFetch: typeof fetch = fetch): Promise<void> {
  const res = await doFetch(`${RUNPOD_API}/v2/pods/${encodeURIComponent(id)}/action`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(30_000),
    redirect: "manual",
  });
  if (!(res.status >= 200 && res.status < 300)) throw new Error(`action ${action} HTTP ${res.status}`);
  await res.text();
}

async function main(argv: readonly string[]): Promise<number> {
  const o = parseArgs(argv);
  const saltHex = randomBytes(32).toString("hex");
  const plan = planFor(o, randomBytes(32).toString("base64url"), saltHex);
  const preview = new RunPodAdapter({ apiKey: "unused", fetch: (() => Promise.reject(new Error("dry run"))) as Fetch });
  const body = preview.createBody(plan.spec);
  (body["env"] as Record<string, string>)[preview.info.bootTokenEnv] = "<random, 43 chars>";
  if (!o.execute) {
    const launcherHash = await launcherSha256(plan.spec.launcher);
    const { saltHex: _salt, ...shown } = plan;
    const out = JSON.stringify({ dryRun: true, launcherSha256: launcherHash, plan: { ...shown, spec: { ...plan.spec, bootToken: "<random>" } }, createBody: body }, null, 2);
    process.stdout.write(maskSalt(out, saltHex) + "\n");
    return 0;
  }
  const apiKey = readKeyFile(o.keyFile);
  const adapter = new RunPodAdapter({ apiKey, fetch: globalThis.fetch as unknown as Fetch });
  const api: ProbeProviderApi = {
    action: (id, action) => podAction(apiKey, id, action),
    logs: (id, since) => readLogs(apiKey, id, since),
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return finishRun({
    run: () => runEradicationProbe(plan, adapter, api, { now: () => Date.now(), sleep }),
    readSpend: () => accountSpendPerHr(apiKey),
    sleep,
    write: (text) => process.stdout.write(text),
    apiKey,
    saltHex,
  });
}

export interface FinishRunDeps {
  run: () => Promise<ProbeReport>;
  readSpend: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  write: (text: string) => void;
  /** Only to refuse printing it; never written. */
  apiKey: string;
  saltHex: string;
}

/**
 * The paid run after the plan: run the probe, then (only after the pod is confirmed gone) wait for
 * the account's spend rate to come back to 0, print the report, and give the exit code: 3 if
 * termination is unconfirmed, 0 only for a pass with the spend settled, else 1.
 */
export async function finishRun(d: FinishRunDeps): Promise<number> {
  const report = await d.run();
  const spend = report.terminatedConfirmed ? await settleSpend(d.readSpend, d.sleep) : { settled: false, lastSpendPerHr: null };
  const out = maskSalt(JSON.stringify({ ...report, accountSpendPerHrAfter: spend.lastSpendPerHr, spendSettled: spend.settled }, null, 2), d.saltHex);
  if (out.includes(d.apiKey)) throw new Error("refusing to print a report that contains the key");
  d.write(out + "\n");
  if (!report.terminatedConfirmed) return 3;
  return report.outcome === "pass" && spend.settled ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`error: ${e instanceof Error ? e.message : "unknown"}\n`);
      process.exit(2);
    },
  );
}
