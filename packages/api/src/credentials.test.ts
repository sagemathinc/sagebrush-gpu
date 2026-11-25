import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREDENTIAL_KEY_MAX_BYTES,
  CREDENTIAL_REFUSALS,
  CREDENTIAL_STATUSES,
  RECENT_AUTH_WINDOW_MS,
  credentialRefusalBody,
  isCredentialKeyShape,
  isCredentialStatus,
  isRecentAuthForMs,
} from "./credentials.ts";
import { ERROR_STATUS, isApiErrorBody } from "./errors.ts";
import { ROUTES } from "./routes.ts";

test("recentAuthForMs: an integer from 0 to the five-minute window, nothing else", () => {
  assert.equal(RECENT_AUTH_WINDOW_MS, 300_000);
  for (const ok of [0, 1, 299_999, 300_000]) assert.equal(isRecentAuthForMs(ok), true, String(ok));
  for (const bad of [-1, 300_001, 1.5, 0.1, Number.NaN, Infinity, -Infinity, -0.5, "5", null, undefined, [5], {}]) {
    assert.equal(isRecentAuthForMs(bad), false, String(bad));
  }
});

test("a key's shape: 1 to 4096 printable ASCII characters other than a space", () => {
  assert.equal(CREDENTIAL_KEY_MAX_BYTES, 4096);
  for (const ok of ["x", "!", "~", "rpa_ABC123-def.456", "!".repeat(CREDENTIAL_KEY_MAX_BYTES)]) {
    assert.equal(isCredentialKeyShape(ok), true, ok.slice(0, 20));
  }
  for (const bad of [
    "",
    " ",
    "a b",
    " key",
    "key ",
    "key\n",
    "key\t",
    "k\u0000",
    "k ",
    "k\u007f",
    "k\u0080",
    "kéy",
    "k ",
    "k😀",
    "x".repeat(CREDENTIAL_KEY_MAX_BYTES + 1),
    5,
    null,
    undefined,
    ["key"],
    { key: "x" },
  ]) {
    assert.equal(isCredentialKeyShape(bad), false, JSON.stringify(bad));
  }
  // every character from 0x21 to 0x7E, and none of the rest of the first 256 or 0x100
  for (let c = 0; c <= 0x100; c++) {
    assert.equal(isCredentialKeyShape(`k${String.fromCharCode(c)}k`), c >= 0x21 && c <= 0x7e, c.toString(16));
  }
});

test("credential statuses: the closed list", () => {
  assert.deepEqual([...CREDENTIAL_STATUSES], ["none", "unchecked", "ok", "rejected", "revoked", "error"]);
  assert.equal(Object.isFrozen(CREDENTIAL_STATUSES), true);
  for (const s of CREDENTIAL_STATUSES) assert.equal(isCredentialStatus(s), true);
  for (const x of ["", "OK", "valid", "toString", 1, null]) assert.equal(isCredentialStatus(x), false, String(x));
});

test("the refusals: fixed words with their codes, and reauthenticate is a 403", () => {
  assert.equal(ERROR_STATUS.reauthenticate, 403);
  assert.equal(Object.isFrozen(CREDENTIAL_REFUSALS), true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(CREDENTIAL_REFUSALS).map(([k, v]) => [k, v.code])),
    {
      badShape: "badRequest",
      rejected: "badRequest",
      checkUnavailable: "unavailable",
      notOwner: "forbidden",
      notByok: "forbidden",
      reauthenticate: "reauthenticate",
      unknownProvider: "notFound",
      noKey: "notFound",
      busy: "conflict",
      tooManyChecks: "rateLimited",
      signedOut: "unauthenticated",
    },
  );
  const messages = Object.values(CREDENTIAL_REFUSALS).map((r) => r.message);
  assert.equal(new Set(messages).size, messages.length, "each refusal has its own words");
  for (const [name, r] of Object.entries(CREDENTIAL_REFUSALS)) {
    const body = credentialRefusalBody(name as keyof typeof CREDENTIAL_REFUSALS);
    assert.deepEqual(body, { error: { code: r.code, message: r.message } });
    assert.equal(isApiErrorBody(body), true, name);
  }
});

test("the credential routes: an organization's owners only, by method and path", () => {
  const owner = { auth: "session", scope: "org", minRole: "owner" };
  assert.deepEqual([ROUTES.listCredentials.method, ROUTES.listCredentials.path], ["GET", "/v1/orgs/:orgId/credentials"]);
  assert.deepEqual([ROUTES.putCredential.method, ROUTES.putCredential.path], ["PUT", "/v1/orgs/:orgId/credentials/:provider"]);
  assert.deepEqual([ROUTES.deleteCredential.method, ROUTES.deleteCredential.path], ["DELETE", "/v1/orgs/:orgId/credentials/:provider"]);
  for (const name of ["listCredentials", "putCredential", "deleteCredential"] as const) assert.deepEqual(ROUTES[name].access, owner, name);
});
