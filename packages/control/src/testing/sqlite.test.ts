// The test database keeps D1's limit of 100 bound parameters per statement (node:sqlite's
// own default is 32,766), so a query that would break on D1 breaks in tests too.
import { test } from "node:test";
import assert from "node:assert/strict";

import { D1_MAX_VARIABLES, sqliteDb } from "./sqlite.ts";

const vars = (n: number) => Array.from({ length: n }, () => "?").join(",");
const values = (n: number) => Array.from({ length: n }, (_, i) => i);

test("100 bound parameters work; 101 are refused, in all, run and batch", async () => {
  assert.equal(D1_MAX_VARIABLES, 100);
  const db = sqliteDb();
  db.raw.exec("CREATE TABLE t (x INTEGER NOT NULL) STRICT");
  // (100: fine everywhere)
  const sum = Array.from({ length: 100 }, () => "?").join(" + ");
  assert.equal((await db.all<{ s: number }>(`SELECT ${sum} AS s`, values(100)))[0]!.s, 4950);
  assert.equal((await db.run(`INSERT INTO t (x) SELECT 1 WHERE 1 IN (${vars(100)})`, values(100))).changes, 1);
  await db.batch([{ sql: `INSERT INTO t (x) SELECT 2 WHERE 2 IN (${vars(100)})`, params: values(100) }]);
  // (101: refused, and a refused batch leaves nothing behind)
  await assert.rejects(db.all(`SELECT ${vars(101)}`, values(101)), /too many SQL variables/);
  await assert.rejects(db.run(`INSERT INTO t (x) SELECT 3 WHERE 3 IN (${vars(101)})`, values(101)), /too many SQL variables/);
  await assert.rejects(
    db.batch([{ sql: "INSERT INTO t (x) VALUES (4)", params: [] }, { sql: `SELECT ${vars(101)}`, params: values(101) }]),
    /too many SQL variables/,
  );
  assert.deepEqual((await db.all<{ x: number }>("SELECT x FROM t ORDER BY x")).map((r) => r.x), [1, 2]);
});

test("SQLite itself refuses a statement with 101 variables at prepare, and takes 100", () => {
  const db = sqliteDb();
  db.raw.prepare(`SELECT ${vars(100)}`);
  assert.throws(() => db.raw.prepare(`SELECT ${vars(101)}`), /too many SQL variables/);
  // (numbered variables count by their highest number, as in D1)
  db.raw.prepare("SELECT ?100");
  assert.throws(() => db.raw.prepare("SELECT ?101"), /variable number must be between \?1 and \?100/);
});
