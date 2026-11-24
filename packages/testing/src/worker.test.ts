import { test } from "node:test";
import assert from "node:assert/strict";

import { splitSql, startWorker } from "./worker.ts";

test("splitSql: statements on ; outside strings, identifiers, comments and trigger bodies", () => {
  assert.deepEqual(splitSql("CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y TEXT);\n"), ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y TEXT)"]);
  assert.deepEqual(splitSql("INSERT INTO a VALUES ('x;y', 'it''s; fine');"), ["INSERT INTO a VALUES ('x;y', 'it''s; fine')"]);
  assert.deepEqual(splitSql('CREATE TABLE "we;ird" ([a;b] INTEGER, `c;d` TEXT);'), ['CREATE TABLE "we;ird" ([a;b] INTEGER, `c;d` TEXT)']);
  assert.deepEqual(splitSql("-- a comment; with ;\nSELECT 1; /* block ; comment */ SELECT 2;"), ["SELECT 1", "SELECT 2"]);
  const trigger = `CREATE TRIGGER t AFTER INSERT ON a BEGIN
  INSERT INTO b (n) VALUES (NEW.x);
  INSERT INTO b (n) VALUES (CASE WHEN NEW.x > 1 THEN CASE WHEN NEW.x > 9 THEN 3 ELSE 2 END ELSE 1 END);
END;
CREATE TEMP TRIGGER u BEFORE DELETE ON a BEGIN SELECT RAISE(ABORT, 'no; deletes'); END;
CREATE INDEX i ON a (x) WHERE y IS NOT NULL;`;
  const parts = splitSql(trigger);
  assert.equal(parts.length, 3, JSON.stringify(parts));
  assert.ok(parts[0]!.startsWith("CREATE TRIGGER t") && parts[0]!.endsWith("END"));
  assert.ok(parts[1]!.startsWith("CREATE TEMP TRIGGER u") && parts[1]!.endsWith("END"));
  assert.equal(parts[2], "CREATE INDEX i ON a (x) WHERE y IS NOT NULL");
  // (a column or table merely named like a keyword isn't a trigger body)
  assert.deepEqual(splitSql("CREATE TABLE begin_end (casey INTEGER, end_at INTEGER); SELECT 1;"), ["CREATE TABLE begin_end (casey INTEGER, end_at INTEGER)", "SELECT 1"]);
  assert.deepEqual(splitSql(" ;; \n"), []);
  assert.throws(() => splitSql("SELECT 'unterminated"), /unterminated/);
  assert.throws(() => splitSql("SELECT 1 /* open"), /unterminated/);
});

test("startWorker: a bundled entry, a Durable Object, and D1 migrations applied in name order (triggers included)", async () => {
  const w = await startWorker({
    entry: "packages/testing/fixtures/entry.ts",
    durableObjects: { COUNTER: "Counter" },
    bindings: { GREETING: "hi" },
    d1Databases: ["DB"],
    migrations: { DB: ["packages/testing/fixtures/migrations"] },
  });
  try {
    assert.equal(await (await w.mf.dispatchFetch("https://test.invalid/greet")).text(), "hi");
    assert.equal(await (await w.mf.dispatchFetch("https://test.invalid/count")).text(), "1");
    assert.equal(await (await w.mf.dispatchFetch("https://test.invalid/count")).text(), "2");
    const db = await w.mf.getD1Database("DB");
    await db.prepare("INSERT INTO a (x, y) VALUES (5, 'q')").run();
    const rows = (await db.prepare("SELECT n FROM b ORDER BY n").all()).results.map((r) => (r as { n: number }).n);
    assert.deepEqual(rows, [2, 5]); // (0001's trigger, then 0002's CASE row)
    await assert.rejects(db.prepare("INSERT INTO a (x, y) VALUES ('not an integer', 'q')").run()); // (STRICT)
  } finally {
    await w.dispose();
  }
});
