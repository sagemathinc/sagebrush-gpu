import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDENTIAL_UNUSABLE_MESSAGE, ERROR_STATUS, credentialUnusableBody, errorBody, isApiErrorBody, isErrorCode } from "./errors.ts";
import { PROVIDER_IDS } from "./providers.ts";

test("every code maps to an HTTP error status", () => {
  for (const [code, status] of Object.entries(ERROR_STATUS)) {
    assert.ok(status >= 400 && status <= 599, code);
  }
  assert.equal(ERROR_STATUS.unauthenticated, 401);
  assert.equal(ERROR_STATUS.forbidden, 403);
  assert.equal(ERROR_STATUS.notFound, 404);
  assert.equal(ERROR_STATUS.internal, 500);
});

test("error bodies", () => {
  const b = errorBody("notFound", "no such machine");
  assert.deepEqual(b, { error: { code: "notFound", message: "no such machine" } });
  assert.equal(isApiErrorBody(b), true);
  assert.equal(isApiErrorBody({ error: { code: "nope", message: "" } }), false);
  assert.equal(isApiErrorBody({ error: { code: "notFound" } }), false);
  assert.equal(isApiErrorBody({ code: "notFound", message: "" }), false);
  assert.equal(isApiErrorBody(null), false);
  assert.equal(isErrorCode("toString"), false); // own keys only
  assert.equal(isErrorCode("conflict"), true);
});

test("credentialUnusable: a 409 whose body names the provider, and only that code names one", () => {
  assert.equal(ERROR_STATUS.credentialUnusable, 409);
  for (const provider of PROVIDER_IDS) {
    const b = credentialUnusableBody(provider);
    assert.deepEqual(b, { error: { code: "credentialUnusable", message: CREDENTIAL_UNUSABLE_MESSAGE, provider } });
    assert.equal(isApiErrorBody(b), true, provider);
  }
  // the message says nothing about any key
  assert.doesNotMatch(CREDENTIAL_UNUSABLE_MESSAGE, /revoked|rejected|fingerprint|error/i);
  assert.throws(() => credentialUnusableBody("aws" as never), RangeError);
  assert.throws(() => credentialUnusableBody(undefined as never), RangeError);
  // the generic builder can't make one without its provider
  assert.throws(() => errorBody("credentialUnusable", "paused"), RangeError);
  // a provider exactly when the code is credentialUnusable, and a known one
  assert.equal(isApiErrorBody({ error: { code: "credentialUnusable", message: "x" } }), false);
  assert.equal(isApiErrorBody({ error: { code: "credentialUnusable", message: "x", provider: "aws" } }), false);
  assert.equal(isApiErrorBody({ error: { code: "credentialUnusable", message: "x", provider: null } }), false);
  assert.equal(isApiErrorBody({ error: { code: "credentialUnusable", message: "x", provider: "vast" } }), true);
  assert.equal(isApiErrorBody({ error: { code: "noCapacity", message: "x", provider: "vast" } }), false);
  assert.equal(isApiErrorBody({ error: { code: "noCapacity", message: "x", provider: undefined } }), false);
  assert.equal(isApiErrorBody({ error: { code: "noCapacity", message: "x" } }), true);
});
