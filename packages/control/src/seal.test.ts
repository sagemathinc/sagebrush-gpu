import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { seal, sealKeys, unseal } from "./seal.ts";

const key = () => randomBytes(32).toString("base64");
const CTX = { env: "test", identity: "user_01A", session: "a".repeat(64) };

test("seal: opens in its own context only", async () => {
  const k = (await sealKeys(`v1:${key()}`))!;
  const s = await seal(k, CTX, "rt_secret");
  assert.equal(s.version, "v1");
  assert.doesNotMatch(s.ct, /rt_secret/);
  assert.equal(await unseal(k, CTX, s.version, s.ct), "rt_secret");
  for (const other of [{ ...CTX, env: "prod" }, { ...CTX, identity: "user_01B" }, { ...CTX, session: "b".repeat(64) }]) {
    assert.equal(await unseal(k, other, s.version, s.ct), null, JSON.stringify(other));
  }
  // two seals of the same text differ (fresh nonces)
  assert.notEqual((await seal(k, CTX, "rt_secret")).ct, s.ct);
  // tampered, truncated, missing
  const raw = Buffer.from(s.ct, "base64");
  raw[raw.length - 1]! ^= 1;
  assert.equal(await unseal(k, CTX, s.version, raw.toString("base64")), null);
  assert.equal(await unseal(k, CTX, s.version, Buffer.from(s.ct, "base64").subarray(0, 27).toString("base64")), null);
  assert.equal(await unseal(k, CTX, null, s.ct), null);
  assert.equal(await unseal(k, CTX, s.version, null), null);
  assert.equal(await unseal(k, CTX, "v9", s.ct), null);
  assert.equal(await unseal(k, CTX, s.version, "%%%"), null);
});

test("seal: rotation (the first key seals; older ones still open; a removed one doesn't)", async () => {
  const a = key();
  const b = key();
  const old = (await sealKeys(`v1:${a}`))!;
  const s1 = await seal(old, CTX, "one");
  const both = (await sealKeys(`v2:${b},v1:${a}`))!;
  assert.equal(both.current, "v2");
  assert.equal(await unseal(both, CTX, s1.version, s1.ct), "one");
  const s2 = await seal(both, CTX, "two");
  assert.equal(s2.version, "v2");
  const onlyNew = (await sealKeys(`v2:${b}`))!;
  assert.equal(await unseal(onlyNew, CTX, s1.version, s1.ct), null);
  assert.equal(await unseal(onlyNew, CTX, s2.version, s2.ct), "two");
  // the same version under another key doesn't open it
  assert.equal(await unseal((await sealKeys(`v1:${key()}`))!, CTX, s1.version, s1.ct), null);
});

test("sealKeys: malformed secrets are null", async () => {
  for (const bad of [undefined, "", "v1", ":" + key(), "v1:" + randomBytes(31).toString("base64"), "v1:" + randomBytes(33).toString("base64"), `v1:${key()},v1:${key()}`, `bad version:${key()}`, `${"v".repeat(17)}:${key()}`, "v1:%%%", `v1:${key()},`]) {
    assert.equal(await sealKeys(bad), null, String(bad));
  }
  assert.ok(await sealKeys(`${"v".repeat(16)}:${key()}`));
});
