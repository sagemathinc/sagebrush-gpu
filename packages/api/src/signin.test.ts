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
    "px",
    "/a\\b", // (same origin to URL, but a backslash all the same)
    "/a\\\\evil.example",
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

test("every accepted return path stays on the origin (checked with URL)", () => {
  const base = "https://origin.invalid";
  const chars = ["/", "a", ".", "?", "#", "@", ":", "%", "%2f", "%5c", "\u3000", "\uff0f"];
  // every path of up to 4 pieces from these, that the check accepts
  let n = 0;
  const walk = (s: string, depth: number) => {
    if (isSafeReturnPath(s)) {
      n++;
      assert.equal(new URL(s, base).origin, base, s);
    }
    if (depth < 4) for (const c of chars) walk(s + c, depth + 1);
  };
  walk("/", 0);
  assert.ok(n > 1000, String(n));
});

test("sign-in outcomes: the closed list", () => {
  assert.deepEqual([...SIGN_IN_OUTCOMES], ["refused", "error", "expired", "unavailable"]);
  for (const o of SIGN_IN_OUTCOMES) assert.equal(isSignInOutcome(o), true);
  for (const x of ["denied", "", "Refused", 1, null]) assert.equal(isSignInOutcome(x), false);
});
