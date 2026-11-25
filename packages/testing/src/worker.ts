// The shared harness for testing Workers, Durable Objects and D1 in Miniflare (local, no network): bundle an entry
// with esbuild, start Miniflare with its bindings, and apply SQL migrations to its D1 databases.
//
//   import { startWorker } from "@sbgpu/testing/worker";
//   const w = await startWorker({ entry: "packages/machine/src/relay/test-entry.ts",
//     durableObjects: { MACHINE_RELAY: "TestMachineRelay" }, bindings: { ... },
//     d1Databases: ["DB"], migrations: { DB: ["packages/control/migrations"] } });
//   const res = await w.mf.dispatchFetch("https://test.invalid/...");
//   await w.dispose();
//
// Used by node --test files (*.test.ts); scripts/check.sh runs them like any other test.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** The compatibility date every test Worker runs with (pinned with miniflare's version). */
export const COMPATIBILITY_DATE = "2026-07-01";

export interface WorkerOptions {
  /** The Worker's entry, relative to the repo root. */
  entry: string;
  /** Durable Object bindings: binding name -> exported class name (SQLite storage). */
  durableObjects?: Record<string, string>;
  /** Plain-text bindings (vars and secrets). */
  bindings?: Record<string, string>;
  /** D1 binding names. */
  d1Databases?: string[];
  /** Per D1 binding, migration directories (relative to the repo root); each one's *.sql files apply in name order. */
  migrations?: Record<string, string[]>;
  /** A directory for Durable Object and D1 storage, so state survives a dispose and a new start (a restart). */
  persist?: string;
}

export interface StartedWorker {
  mf: Miniflare;
  dispose(): Promise<void>;
}

/** Bundle the entry into one ES module (TypeScript, workspace packages included; cloudflare:* left to the runtime). */
export async function bundle(entry: string): Promise<string> {
  const out = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    write: false,
    external: ["cloudflare:*", "node:*"],
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    logLevel: "silent",
  });
  return out.outputFiles[0]!.text;
}

export async function startWorker(o: WorkerOptions): Promise<StartedWorker> {
  const script = await bundle(o.entry);
  const durableObjects = Object.fromEntries(
    Object.entries(o.durableObjects ?? {}).map(([binding, className]) => [binding, { className, useSQLite: true }]),
  );
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: COMPATIBILITY_DATE,
    durableObjects,
    bindings: o.bindings ?? {},
    d1Databases: o.d1Databases ?? [],
    ...(o.persist ? { durableObjectsPersist: join(o.persist, "do"), d1Persist: join(o.persist, "d1") } : {}),
  });
  try {
    await mf.ready;
    for (const [binding, dirs] of Object.entries(o.migrations ?? {})) {
      const db = await mf.getD1Database(binding);
      for (const dir of dirs) {
        for (const file of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".sql")).sort()) {
          const statements = splitSql(readFileSync(join(ROOT, dir, file), "utf8"));
          if (statements.length) await db.batch(statements.map((s) => db.prepare(s))); // (one file, one transaction)
        }
      }
    }
  } catch (e) {
    // (the caller gets no handle to dispose: this one is disposed here, or the process would never exit)
    await mf.dispose().catch(() => {});
    throw e;
  }
  return { mf, dispose: () => mf.dispose() };
}

/**
 * SQL text split into statements (D1 runs one statement per prepare): on `;` outside strings, quoted identifiers and
 * comments, and outside a trigger's BEGIN ... END body (where CASE ... END nests).  Comments are dropped; empty
 * statements too.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let trigger = false; // (this statement is a CREATE [TEMP] TRIGGER)
  let body = false; // (inside its BEGIN ... END)
  let cases = 0; // (CASE ... END open inside the body)
  const word = (at: number) => /^[A-Za-z_]+/.exec(sql.slice(at))?.[0]?.toUpperCase() ?? "";
  const boundary = (at: number) => at === 0 || !/[A-Za-z0-9_]/.test(sql[at - 1]!);
  const flush = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = "";
    trigger = body = false;
    cases = 0;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
      cur += "\n";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new Error("an unterminated comment");
      i = end + 2;
      cur += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) throw new Error("an unterminated string or identifier");
        if (close !== "]" && sql[k + 1] === close) {
          j = k + 2; // (a doubled quote)
          continue;
        }
        j = k + 1;
        break;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c) && boundary(i)) {
      const w = word(i);
      if (!cur.trim()) {
        trigger = false;
      }
      if (w === "TRIGGER" && /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?$/i.test(cur.trim() + " ")) trigger = true;
      if (trigger && !body && w === "BEGIN") body = true;
      else if (body && w === "CASE") cases++;
      else if (body && w === "END") {
        if (cases > 0) cases--;
        else body = false;
      }
      cur += sql.slice(i, i + w.length);
      i += w.length;
      continue;
    }
    if (c === ";" && !body) {
      flush();
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  flush();
  return out;
}
