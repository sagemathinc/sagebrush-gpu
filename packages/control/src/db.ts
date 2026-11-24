// The control plane's database interface: reads, and atomic batches of writes. D1 runs
// a batch as one transaction; if any statement fails, none of it applies. The ledger
// relies on that: an entry and the machine's billed-through mark are written together.

export type SqlValue = string | number | null;

export interface Stmt {
  sql: string;
  params: SqlValue[];
}

export interface Db {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** One write; how many rows it changed (for compare-and-set updates). */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** All statements in one transaction, or none. */
  batch(stmts: Stmt[]): Promise<void>;
}

/**
 * D1 allows at most this many bound parameters in one statement (also inside a batch).
 * A query over a list of ids binds it in chunks (see chunks()).
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** `items` in consecutive chunks of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("chunk size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function stmt(sql: string, ...params: SqlValue[]): Stmt {
  return { sql, params };
}

/** The part of Cloudflare's D1Database this module uses. */
export interface D1Like {
  prepare(sql: string): { bind(...values: SqlValue[]): D1StatementLike };
  batch(statements: D1StatementLike[]): Promise<unknown>;
}
interface D1StatementLike {
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export function d1Db(d1: D1Like): Db {
  return {
    async all<T>(sql: string, params: SqlValue[] = []) {
      return (await d1.prepare(sql).bind(...params).all<T>()).results;
    },
    async run(sql: string, params: SqlValue[] = []) {
      const r = await d1.prepare(sql).bind(...params).run();
      return { changes: r.meta.changes };
    },
    async batch(stmts: Stmt[]) {
      if (stmts.length === 0) return;
      await d1.batch(stmts.map((s) => d1.prepare(s.sql).bind(...s.params)));
    },
  };
}
