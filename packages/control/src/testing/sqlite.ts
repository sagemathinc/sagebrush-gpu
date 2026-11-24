// A Db over node:sqlite, for tests: the same SQL as D1 (both are SQLite), with batches
// in a transaction.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, SqlValue, Stmt } from "../db.ts";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export interface TestDb extends Db {
  raw: DatabaseSync;
}

export function sqliteDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  return {
    raw,
    async all<T>(sql: string, params: SqlValue[] = []) {
      return raw.prepare(sql).all(...params) as T[];
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
