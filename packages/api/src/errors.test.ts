import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_STATUS, errorBody, isApiErrorBody, isErrorCode } from "./errors.ts";

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
