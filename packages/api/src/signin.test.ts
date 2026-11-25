import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETURN_PATH_LENGTH, SIGN_IN_OUTCOMES, isSafeReturnPath, isSignInOutcome } from "./signin.ts";

test("return paths: relative, on the app's own origin, bounded", () => {
  for (const ok of ["/", "/p/prj_1/members", "/o/org_1?tab=credit#top", "/a/b/../c", "/" + "x".repeat(MAX_RETURN_PATH_LENGTH - 1)]) {
    assert.equal(isSafeReturnPath(ok), true, ok);
  }
  for (const bad of [
    "",
    "p/x",
    "//evil.example/x",
    "/\\evil.example",
    "/\\/evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "/x\ny",
    "/x\ty",
    "/x\u0000",
    "/x\u007f",
    " /x",
    "/" + "x".repeat(MAX_RETURN_PATH_LENGTH),
    5,
    null,
    ["/"],
  ]) {
    assert.equal(isSafeReturnPath(bad), false, JSON.stringify(bad));
  }
});

test("sign-in outcomes: the closed list", () => {
  assert.deepEqual([...SIGN_IN_OUTCOMES], ["refused", "error", "expired", "unavailable"]);
  for (const o of SIGN_IN_OUTCOMES) assert.equal(isSignInOutcome(o), true);
  for (const x of ["denied", "", "Refused", 1, null]) assert.equal(isSignInOutcome(x), false);
});
