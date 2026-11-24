// The eradication probe's command line. A dry run unless given --execute with an approval
// reference; see eradication.ts for what the probe does.
//
//   node packages/providers/src/probes/cli.ts --launcher launcher.json [options]
//
//   --launcher FILE        JSON {"argv": [...]} from @sbgpu/machine's renderBootCommand, with the
//                          probe agent's URL and sha256 (required)
//   --gpu TYPE             our GPU type id (default RTX-A4000, the cheapest Secure Cloud GPU we map)
//   --dc ID                RunPod data center (default EU-SE-1)
//   --image IMAGE          provider stock image (default: the production image)
//   --max-usd N            spend cap in USD, at most 10 (default 3)
//   --max-minutes N        pod lifetime cap (default 60)
//   --execute              actually launch (costs money)
//   --approval TEXT        who approved the spend and where; required with --execute
//
// With --execute, the API key comes from the RUNPOD_API_KEY environment variable of the shell
// running this (never a file path, never printed). The report goes to stdout as JSON.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isGpuType } from "../gpus.ts";
import type { Fetch } from "../http.ts";
import { RunPodAdapter, RUNPOD_API } from "../runpod/adapter.ts";
import type { LaunchSpec } from "../types.ts";
import { checkPlan, parseLogSse, runEradicationProbe, type ProbePlan, type ProbeProviderApi } from "./eradication.ts";

export const DEFAULT_IMAGE = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";

export interface CliOptions {
  launcherFile: string;
  gpu: string;
  dc: string;
  image: string;
  maxUsd: number;
  maxMinutes: number;
  execute: boolean;
  approval: string;
}

/** Parse the arguments; unknown or malformed ones throw. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = {
    launcherFile: "",
    gpu: "RTX-A4000",
    dc: "EU-SE-1",
    image: DEFAULT_IMAGE,
    maxUsd: 3,
    maxMinutes: 60,
    execute: false,
    approval: "",
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
      case "--launcher": o.launcherFile = value(); break;
      case "--gpu": o.gpu = value(); break;
      case "--dc": o.dc = value(); break;
      case "--image": o.image = value(); break;
      case "--max-usd": o.maxUsd = num(value()); break;
      case "--max-minutes": o.maxMinutes = num(value()); break;
      case "--approval": o.approval = value(); break;
      case "--execute": o.execute = true; break;
      default: throw new RangeError(`unknown argument: ${a}`);
    }
  }
  if (o.launcherFile === "") throw new RangeError("--launcher is required");
  if (!isGpuType(o.gpu)) throw new RangeError(`unknown GPU type: ${o.gpu}`);
  if (o.execute && o.approval.trim().length < 8) throw new RangeError("--execute needs --approval");
  return o;
}

/** The plan for the options and launcher argv. The boot token is random: nothing exchanges it. */
export function planFor(o: CliOptions, launcher: readonly string[], bootToken: string): ProbePlan {
  if (!Array.isArray(launcher) || launcher.length === 0 || !launcher.every((s) => typeof s === "string")) {
    throw new RangeError("the launcher file must hold {\"argv\": [strings]}");
  }
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
    spec,
    maxSpendMicros,
    maxMinutes: o.maxMinutes,
    stageMinutes: 15,
    pollSeconds: 30,
  };
  checkPlan(plan);
  return plan;
}

/** Read an SSE log stream for a few quiet seconds, then stop (the stream never ends by itself). */
async function readLogs(apiKey: string, id: string, since: string): Promise<string[]> {
  const url = `${RUNPOD_API}/v2/pods/${encodeURIComponent(id)}/logs?${new URLSearchParams({ since })}`;
  const ctl = new AbortController();
  const hard = setTimeout(() => ctl.abort(), 30_000);
  let body = "";
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" }, signal: ctl.signal });
    if (res.status !== 200 || res.body === null) throw new Error(`logs HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const quiet = new Promise<"quiet">((r) => setTimeout(() => r("quiet"), 3000));
      const next = await Promise.race([reader.read(), quiet]);
      if (next === "quiet" || next.done) break;
      body += dec.decode(next.value, { stream: true });
      if (body.length > 4_000_000) throw new Error("logs too large");
    }
    await reader.cancel().catch(() => {});
  } finally {
    clearTimeout(hard);
    ctl.abort();
  }
  // Only whole events count.
  return parseLogSse(body.slice(0, body.lastIndexOf("\n\n") + 2));
}

async function main(argv: readonly string[]): Promise<number> {
  const o = parseArgs(argv);
  const parsed: unknown = JSON.parse(readFileSync(o.launcherFile, "utf8"));
  const launcher = (parsed as { argv?: unknown }).argv as string[];
  const plan = planFor(o, launcher, randomBytes(32).toString("base64url"));
  const preview = new RunPodAdapter({ apiKey: "unused", fetch: (() => Promise.reject(new Error("dry run"))) as Fetch });
  const body = preview.createBody(plan.spec);
  (body["env"] as Record<string, string>)[preview.info.bootTokenEnv] = "<random, 43 chars>";
  if (!o.execute) {
    process.stdout.write(JSON.stringify({ dryRun: true, plan: { ...plan, spec: { ...plan.spec, bootToken: "<random>" } }, createBody: body }, null, 2) + "\n");
    return 0;
  }
  const apiKey = process.env["RUNPOD_API_KEY"];
  if (apiKey === undefined || apiKey === "") throw new RangeError("RUNPOD_API_KEY is not set");
  const adapter = new RunPodAdapter({ apiKey, fetch: globalThis.fetch as unknown as Fetch });
  const api: ProbeProviderApi = {
    async action(id, action) {
      const res = await fetch(`${RUNPOD_API}/v2/pods/${encodeURIComponent(id)}/action`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(30_000),
      });
      await res.text();
      if (res.status >= 300) throw new Error(`action ${action} HTTP ${res.status}`);
    },
    logs: (id, since) => readLogs(apiKey, id, since),
  };
  const report = await runEradicationProbe(plan, adapter, api, {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.outcome === "pass" ? 0 : report.terminatedConfirmed ? 1 : 3;
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
