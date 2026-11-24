import { test } from "node:test";
import assert from "node:assert/strict";
import { ID_ALPHABET, ID_PREFIXES, idKind, isId, newId, type IdKind } from "./ids.ts";

const KINDS = Object.keys(ID_PREFIXES) as IdKind[];

test("newId makes valid ids of every kind", () => {
  for (const kind of KINDS) {
    const id = newId(kind);
    assert.ok(isId(kind, id), id);
    assert.equal(idKind(id), kind);
    assert.equal(id.length, ID_PREFIXES[kind].length + 1 + 20);
    for (const other of KINDS) if (other !== kind) assert.equal(isId(other, id), false);
  }
});

test("prefixes are distinct and none is a prefix of another plus underscore", () => {
  const prefixes = Object.values(ID_PREFIXES);
  assert.equal(new Set(prefixes).size, prefixes.length);
  for (const p of prefixes) assert.match(p, /^[a-z]+$/);
});

test("newId is random and uses the whole alphabet", () => {
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const id = newId("machine");
    ids.add(id);
    for (const c of id.slice(4)) seen.add(c);
  }
  assert.equal(ids.size, 2000);
  assert.equal(seen.size, 32);
  assert.equal(ID_ALPHABET.length, 32);
  assert.equal(new Set(ID_ALPHABET).size, 32);
});

test("isId rejects malformed ids", () => {
  const good = "mch_0123456789abcdefghjk";
  assert.equal(isId("machine", good), true);
  assert.equal(isId("machine", good + "m"), false); // too long
  assert.equal(isId("machine", good.slice(0, -1)), false); // too short
  assert.equal(isId("machine", good.toUpperCase()), false);
  assert.equal(isId("machine", "mch_0123456789abcdefghji"), false); // i not in alphabet
  assert.equal(isId("machine", "mch_0123456789abcdefghjl"), false); // l
  assert.equal(isId("machine", "mch_0123456789abcdefghjo"), false); // o
  assert.equal(isId("machine", "mch_0123456789abcdefghju"), false); // u
  assert.equal(isId("machine", "mch-0123456789abcdefghjk"), false);
  assert.equal(isId("machine", " " + good), false);
  assert.equal(isId("machine", good + "\n"), false);
  assert.equal(isId("machine", "prj_0123456789abcdefghjk"), false);
  assert.equal(isId("machine", 42), false);
  assert.equal(idKind("nope_0123456789abcdefghjk"), null);
  assert.equal(idKind(null), null);
});
