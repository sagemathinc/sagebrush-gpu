import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ANNOUNCE_NONCE_PATTERN, SHA256_HEX_PATTERN, isId } from "@sbgpu/api";
import { announceFixture } from "./announce-fixture.ts";

test("the shared announce fixture is exactly what the typed request generates", () => {
  const file = readFileSync(new URL("../fixtures/vm-announce.json", import.meta.url), "utf8");
  assert.equal(file, announceFixture(), "stale: run node packages/machine/scripts/gen-announce-fixture.ts");
});

test("the announce fixture is control's exact shape: these three keys, each in its pattern", () => {
  const body = JSON.parse(readFileSync(new URL("../fixtures/vm-announce.json", import.meta.url), "utf8")) as Record<string, unknown>;
  // (control's announce accepts exactly these keys, sorted: packages/control/src/vm.ts)
  assert.equal(Object.keys(body).sort().join(","), "bootScriptSha256,machineId,nonce");
  assert.deepEqual(Object.keys(body), ["machineId", "nonce", "bootScriptSha256"]);
  assert.ok(isId("machine", body.machineId));
  assert.ok(ANNOUNCE_NONCE_PATTERN.test(body.nonce as string));
  assert.ok(SHA256_HEX_PATTERN.test(body.bootScriptSha256 as string));
});
