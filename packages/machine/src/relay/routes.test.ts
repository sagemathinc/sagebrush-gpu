// revokeMachine (routes.ts) against a fake binding: only an answer that acknowledges at least the asked incarnation,
// after the object's durable write, counts as done; anything else (an error status, a malformed body, a lower
// revokedThrough, a thrown fetch, bad arguments) is false, so control keeps the stop pending.
import { test } from "node:test";
import assert from "node:assert/strict";

import { newId } from "@sbgpu/api";
import { revokeMachine, type RelayRouteEnv } from "./routes.ts";

function env(answer: () => Response | Promise<Response>, seen: Array<{ url: string; init: RequestInit | undefined }> = []): RelayRouteEnv {
  const stub = { fetch: async (url: string, init?: RequestInit) => (seen.push({ url, init }), answer()) };
  return { MACHINE_RELAY: { idFromName: (n: string) => n, get: () => stub } as unknown as RelayRouteEnv["MACHINE_RELAY"] };
}

test("revokeMachine: true only for ok with revokedThrough >= inc", async () => {
  const mch = newId("machine");
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  assert.equal(await revokeMachine(env(() => Response.json({ ok: true, revokedThrough: 5 }), seen), mch, 5), true);
  assert.equal(seen[0]!.url, "https://relay.internal/revoke");
  assert.equal(seen[0]!.init!.method, "POST");
  assert.equal(seen[0]!.init!.body, JSON.stringify({ inc: 5 }));
  assert.equal(await revokeMachine(env(() => Response.json({ ok: true, revokedThrough: 7 })), mch, 5), true);
  for (const [why, answer] of [
    ["a lower revokedThrough", () => Response.json({ ok: true, revokedThrough: 4 })],
    ["no revokedThrough", () => Response.json({ ok: true })],
    ["revokedThrough not a number", () => Response.json({ ok: true, revokedThrough: "5" })],
    ["ok not true", () => Response.json({ ok: "yes", revokedThrough: 5 })],
    ["an error status", () => Response.json({ ok: true, revokedThrough: 5 }, { status: 500 })],
    ["not JSON", () => new Response("nope")],
    ["a thrown fetch", () => { throw new Error("network"); }],
  ] as const) {
    assert.equal(await revokeMachine(env(answer), mch, 5), false, why);
  }
  for (const [m, inc] of [["nope", 1], [mch, -1], [mch, 1.5], [mch, Number.NaN]] as const) {
    assert.equal(await revokeMachine(env(() => Response.json({ ok: true, revokedThrough: 9 })), m, inc), false, `${m} ${inc}`);
  }
});
