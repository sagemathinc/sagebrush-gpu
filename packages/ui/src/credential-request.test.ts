// The provider keys' own request path: fetch only, fixed outcomes, nothing from the request in them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDENTIAL_REFUSALS, type CredentialRefusal } from "@sbgpu/api";
import {
  credentialRequest,
  credentialsPath,
  readCredential,
  readCredentialList,
  readRemoved,
  refusalOf,
} from "./credential-request.ts";

const ROW = { provider: "shadeform", status: "ok", fingerprint: "0a1b2c3d", setBy: "o@example.org", setAt: "2027-02-01T09:00:00.000Z", lastCheckedAt: "2027-02-01T09:00:00.000Z", runningMachines: 2 };
const KEY = "sk_live_Q7f!x~K3";

function recorder(respond: () => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  };
  return { calls, fetchFn };
}

test("PUT sends the one body as JSON, same-origin, no redirects, with the signal; GET and DELETE send none", async () => {
  const r = recorder(() => Response.json(ROW));
  const signal = new AbortController().signal;
  const body = JSON.stringify({ key: KEY });
  const o = await credentialRequest(r.fetchFn, "PUT", credentialsPath("org_1", "shadeform"), body, signal, readCredential);
  assert.deepEqual(o, { ok: true, value: ROW });
  assert.equal(r.calls.length, 1);
  const { url, init } = r.calls[0]!;
  assert.equal(url, "/v1/orgs/org_1/credentials/shadeform");
  assert.deepEqual(
    { method: init.method, credentials: init.credentials, redirect: init.redirect, headers: init.headers, body: init.body },
    { method: "PUT", credentials: "same-origin", redirect: "error", headers: { accept: "application/json", "content-type": "application/json" }, body },
  );
  assert.equal(init.signal, signal);
  for (const method of ["GET", "DELETE"] as const) {
    const g = recorder(() => Response.json({ items: [] }));
    await credentialRequest(g.fetchFn, method, credentialsPath("org_1"), null, signal, readCredentialList);
    assert.equal(g.calls[0]!.init.body, undefined, method);
    assert.deepEqual(g.calls[0]!.init.headers, { accept: "application/json" }, method);
    assert.equal(g.calls[0]!.init.method, method);
  }
});

test("only a credentials path is sent at all", async () => {
  const r = recorder(() => Response.json(ROW));
  const signal = new AbortController().signal;
  for (const path of ["/v1/orgs/org_1/projects", "https://evil.example/v1/orgs/org_1/credentials", "/v1/orgs/org_1/credentials/shadeform/x", "/v1/orgs/a b/credentials"]) {
    assert.deepEqual(await credentialRequest(r.fetchFn, "GET", path, null, signal, readCredential), { ok: false, refusal: "badResponse" }, path);
  }
  assert.equal(r.calls.length, 0);
  assert.equal(credentialsPath("org_1"), "/v1/orgs/org_1/credentials");
  assert.equal(credentialsPath("a/b", "vast"), "/v1/orgs/a%2Fb/credentials/vast");
});

test("every refusal is named only by its exact code and words; anything else is badResponse", async () => {
  for (const [name, r] of Object.entries(CREDENTIAL_REFUSALS)) {
    const f = recorder(() => Response.json({ error: { code: r.code, message: r.message } }, { status: 400 }));
    const o = await credentialRequest(f.fetchFn, "PUT", credentialsPath("org_1", "vast"), "{}", new AbortController().signal, readCredential);
    assert.deepEqual(o, { ok: false, refusal: name as CredentialRefusal });
  }
  // A known code with other words (an echo of the key, say) is not a refusal the page knows.
  assert.equal(refusalOf({ error: { code: "badRequest", message: `bad key ${KEY}` } }), "badResponse");
  assert.equal(refusalOf({ error: { code: "conflict", message: CREDENTIAL_REFUSALS.rejected.message } }), "badResponse");
  for (const x of [null, {}, { error: null }, { error: "x" }, "x"]) assert.equal(refusalOf(x), "badResponse", JSON.stringify(x));
});

test("no answer, a thrown fetch, or one that isn't JSON: fixed outcomes with nothing of the error in them", async () => {
  const signal = new AbortController().signal;
  const path = credentialsPath("org_1", "vast");
  const failing = (url: string, init: RequestInit) => Promise.reject(new Error(`failed: ${String(init.body)}`));
  assert.deepEqual(await credentialRequest(failing, "PUT", path, KEY, signal, readCredential), { ok: false, refusal: "network" });
  const throwing = () => {
    throw new Error(KEY);
  };
  assert.deepEqual(await credentialRequest(throwing, "PUT", path, KEY, signal, readCredential), { ok: false, refusal: "network" });
  for (const status of [200, 500]) {
    const r = recorder(() => new Response("<html>", { status }));
    assert.deepEqual(await credentialRequest(r.fetchFn, "PUT", path, KEY, signal, readCredential), { ok: false, refusal: "badResponse" }, String(status));
  }
  const odd = recorder(() => Response.json({ ...ROW, status: "fine" }));
  assert.deepEqual(await credentialRequest(odd.fetchFn, "PUT", path, KEY, signal, readCredential), { ok: false, refusal: "badResponse" });
});

test("answers are read as the contract has them, field by field", () => {
  assert.deepEqual(readCredential(ROW), ROW);
  const none = { provider: "vast", status: "none", fingerprint: null, setBy: null, setAt: null, lastCheckedAt: null, runningMachines: 0 };
  assert.deepEqual(readCredential(none), none);
  assert.deepEqual(readCredential({ ...ROW, extra: KEY }), ROW, "only the contract's fields are kept");
  for (const bad of [
    null,
    "x",
    { ...ROW, provider: "aws" },
    { ...ROW, status: "fine" },
    { ...ROW, fingerprint: 5 },
    { ...ROW, setBy: 5 },
    { ...ROW, setAt: 5 },
    { ...ROW, lastCheckedAt: 5 },
    { ...ROW, runningMachines: -1 },
    { ...ROW, runningMachines: 1.5 },
    { ...ROW, runningMachines: "2" },
  ]) {
    assert.equal(readCredential(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(readCredentialList({ items: [ROW, none] }), [ROW, none]);
  assert.equal(readCredentialList({ items: [ROW, ROW] }), null, "a provider twice");
  assert.equal(readCredentialList({ items: [ROW, { ...ROW, provider: 1 }] }), null);
  assert.equal(readCredentialList({ items: "x" }), null);
  assert.equal(readCredentialList(null), null);
  assert.equal(readRemoved({ removed: true }), true);
  assert.equal(readRemoved({ removed: "true" }), null);
  assert.equal(readRemoved(null), null);
});
