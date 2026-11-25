// A Db over node:sqlite, for tests: the same SQL as D1 (both are SQLite), with batches
// in a transaction, and D1's limit of 100 SQL variables (bound parameters) per statement,
// set in SQLite itself (node:sqlite's default is 32,766), so a query that would fail on D1
// fails here too, at prepare, with SQLite's own "too many SQL variables".

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, SqlValue, Stmt } from "../db.ts";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** D1's limit: SQL variables (bound parameters) in one statement. */
export const D1_MAX_VARIABLES = 100;

export interface TestDb extends Db {
  raw: DatabaseSync;
}

/**
 * A fresh database with every migration applied. `upgrade` tests a migration over existing
 * data: the files before `upgrade.at` (a file name prefix such as "0006") are applied, then
 * `seed` runs on that older schema, then the rest.
 */
export function sqliteDb(o: { upgrade?: { at: string; seed(raw: DatabaseSync): void } } = {}): TestDb {
  const raw = new DatabaseSync(":memory:", { limits: { variableNumber: D1_MAX_VARIABLES } });
  raw.exec("PRAGMA foreign_keys = ON");
  let seeded = false;
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (o.upgrade && !seeded && f >= o.upgrade.at) {
      o.upgrade.seed(raw);
      seeded = true;
    }
    raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  if (o.upgrade && !seeded) throw new Error(`no migration at or after ${o.upgrade.at}`);
  return {
    raw,
    async all<T>(sql: string, params: SqlValue[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlValue[] = []) {
      return { changes: Number(raw.prepare(sql).run(...params).changes) };
    },
    async batch(stmts: Stmt[]) {
      raw.exec("BEGIN");
      try {
        for (const s of stmts) raw.prepare(s.sql).run(...s.params);
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
