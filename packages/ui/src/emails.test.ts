import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmail, MAX_EMAIL_LENGTH, parseInviteList } from "./emails.ts";

test("parseInviteList splits on commas, semicolons and newlines", () => {
  assert.deepEqual(parseInviteList("A@X.com, b@y.org;\nc@z.io\r\nd@w.co.uk"), {
    valid: ["a@x.com", "b@y.org", "c@z.io", "d@w.co.uk"],
    duplicates: [],
    invalid: [],
  });
});

test("parseInviteList takes the address from Name <email>", () => {
  assert.deepEqual(parseInviteList("Ann Lee <Ann@X.com>").valid, ["ann@x.com"]);
});

test("parseInviteList reports duplicates case-insensitively", () => {
  assert.deepEqual(parseInviteList("a@x.com\nA@X.COM\nB <a@x.com>"), {
    valid: ["a@x.com"],
    duplicates: ["a@x.com", "a@x.com"],
    invalid: [],
  });
});

test("parseInviteList reports invalid entries as typed, skips blanks", () => {
  assert.deepEqual(parseInviteList(",,\n ; \n  nope  \na@b\n"), {
    valid: [],
    duplicates: [],
    invalid: ["nope", "a@b"],
  });
});

test("isEmail", () => {
  assert.equal(isEmail("a@b.co"), true);
  assert.equal(isEmail("first.last+tag@sub.example.org"), true);
  assert.equal(isEmail("Ann.Lee+cs101@Mail.Example.AC.uk"), true);
  assert.equal(isEmail("a@b-c.d2.com"), true);
  assert.equal(isEmail("a@xn--80ak6aa92e.com"), true);
  assert.equal(isEmail("a@1.co"), true);
  assert.equal(isEmail(`a@${"b".repeat(63)}.com`), true);
  for (const bad of [
    "a@b/c.com", "a@b:25.com", "a@-b.com", "a@b-.com", "a@b.-com", "a@b.com-", "a@b_.com",
    "a@b_c.com", "a@b!.com", "a@[127.0.0.1]", "a@b.c/d", `a@${"b".repeat(64)}.com`,
  ]) {
    assert.equal(isEmail(bad), false, bad);
  }
  assert.deepEqual(parseInviteList("a@b/c.com\nok@x.com").invalid, ["a@b/c.com"]);
  for (const bad of ["", "a@b", "@b.com", "a@.com", "a@b.", "a@b..com", "a@@b.com", "a b@c.com", "a@b c.com", '"a"@b.com', "a<b@c.com"]) {
    assert.equal(isEmail(bad), false, bad);
  }
  assert.equal(MAX_EMAIL_LENGTH, 254); // RFC 5321's path limit, minus the angle brackets
  const at = "@x.com";
  assert.equal(isEmail("a".repeat(MAX_EMAIL_LENGTH - at.length) + at), true);
  assert.equal(isEmail("a".repeat(MAX_EMAIL_LENGTH - at.length + 1) + at), false);
});
