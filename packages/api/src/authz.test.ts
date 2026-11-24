import { test } from "node:test";
import assert from "node:assert/strict";
import { canInvite, canRemoveMember, canUpdateMember } from "./authz.ts";
import { PROJECT_ROLES, type ProjectRole } from "./objects.ts";

const R = PROJECT_ROLES;
const res = (d: { ok: boolean; reason?: string }) => (d.ok ? "ok" : d.reason);

// The expected matrix, written out by hand rather than computed from the same rule.
// INVITE[actor] = roles that actor may give.
const MAY: Record<ProjectRole, ProjectRole[]> = {
  member: [],
  assistant: [],
  manager: ["member", "assistant"],
  owner: ["member", "assistant", "manager", "owner"],
};

test("invite: every actor x role", () => {
  for (const a of R) for (const r of R) assert.equal(res(canInvite(a, r)), MAY[a].includes(r) ? "ok" : "forbidden", `${a} invites ${r}`);
  // the negative rows SEC asked for, spelled out
  assert.equal(res(canInvite("manager", "owner")), "forbidden");
  assert.equal(res(canInvite("manager", "manager")), "forbidden");
  assert.equal(res(canInvite("assistant", "member")), "forbidden");
  assert.equal(res(canInvite("member", "member")), "forbidden");
});

test("update: every actor x target x new role, with two owners", () => {
  for (const a of R)
    for (const t of R) {
      const plain = MAY[a].includes(t) ? "ok" : "forbidden";
      assert.equal(res(canUpdateMember(a, t, undefined, 2)), plain, `${a} edits ${t}`);
      for (const n of R) {
        const expect = MAY[a].includes(t) && MAY[a].includes(n) ? "ok" : "forbidden";
        assert.equal(res(canUpdateMember(a, t, n, 2)), expect, `${a} sets ${t} -> ${n}`);
      }
    }
  assert.equal(res(canUpdateMember("manager", "member", "owner", 2)), "forbidden"); // no promotion to owner
  assert.equal(res(canUpdateMember("manager", "member", "manager", 2)), "forbidden");
  assert.equal(res(canUpdateMember("manager", "manager", "member", 2)), "forbidden"); // no demotion of a manager
  assert.equal(res(canUpdateMember("manager", "owner", "member", 2)), "forbidden");
  assert.equal(res(canUpdateMember("manager", "manager", undefined, 2)), "forbidden"); // not even a rename
});

test("update: the last owner can't be demoted", () => {
  for (const n of ["member", "assistant", "manager"] as const) {
    assert.equal(res(canUpdateMember("owner", "owner", n, 1)), "lastOwner");
    assert.equal(res(canUpdateMember("owner", "owner", n, 2)), "ok");
  }
  assert.equal(res(canUpdateMember("owner", "owner", "owner", 1)), "ok");
  assert.equal(res(canUpdateMember("owner", "owner", undefined, 1)), "ok");
  assert.equal(res(canUpdateMember("owner", "manager", "member", 1)), "ok"); // not an owner
});

test("remove: every actor x target, and the last owner", () => {
  for (const a of R) for (const t of R) assert.equal(res(canRemoveMember(a, t, 2)), MAY[a].includes(t) ? "ok" : "forbidden", `${a} removes ${t}`);
  assert.equal(res(canRemoveMember("owner", "owner", 1)), "lastOwner");
  assert.equal(res(canRemoveMember("owner", "owner", 2)), "ok");
  assert.equal(res(canRemoveMember("manager", "owner", 1)), "forbidden");
  assert.equal(res(canRemoveMember("owner", "manager", 1)), "ok");
});

test("bad input is refused", () => {
  const bad = "root" as ProjectRole;
  assert.equal(res(canInvite(bad, "member")), "badInput");
  assert.equal(res(canInvite("owner", bad)), "badInput");
  assert.equal(res(canUpdateMember("owner", bad, undefined, 2)), "badInput");
  assert.equal(res(canUpdateMember("owner", "member", bad, 2)), "badInput");
  assert.equal(res(canUpdateMember("owner", "owner", "member", 0)), "badInput"); // inconsistent count
  assert.equal(res(canUpdateMember("owner", "owner", "member", NaN)), "badInput");
  assert.equal(res(canUpdateMember("owner", "member", "member", -1)), "badInput");
  assert.equal(res(canRemoveMember("owner", "owner", 0)), "badInput");
  assert.equal(res(canRemoveMember("owner", "owner", 1.5)), "badInput");
  assert.equal(res(canRemoveMember(bad, "member", 2)), "badInput");
});
