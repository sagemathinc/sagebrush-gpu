// The project-membership authorization policy, executable: handlers call these and the
// tests enumerate them. `actor` is the caller's effective project role (an organization
// owner acts as a project owner). The rules:
// - managers may invite, change and remove members and assistants, and give only those
//   roles;
// - only owners may invite, promote, demote, change or remove managers and owners;
// - the last owner can be neither removed nor demoted;
// - assistants and members manage nobody.

import { PROJECT_ROLES, type ProjectRole } from "./objects.ts";

export type MembershipDecision = { ok: true } | { ok: false; reason: "forbidden" | "lastOwner" | "badInput" };

const OK: MembershipDecision = { ok: true };
const FORBIDDEN: MembershipDecision = { ok: false, reason: "forbidden" };
const LAST_OWNER: MembershipDecision = { ok: false, reason: "lastOwner" };
const BAD: MembershipDecision = { ok: false, reason: "badInput" };

function isRole(x: unknown): x is ProjectRole {
  return typeof x === "string" && (PROJECT_ROLES as readonly string[]).includes(x);
}

/** Roles that only an owner may give, take away, or act on. */
function ownerOnly(role: ProjectRole): boolean {
  return role === "manager" || role === "owner";
}

/** May `actor` manage a person holding (or to be given) `role`? */
function mayManage(actor: ProjectRole, role: ProjectRole): boolean {
  if (actor === "owner") return true;
  if (actor === "manager") return !ownerOnly(role);
  return false;
}

/** Invite someone with `role`. */
export function canInvite(actor: ProjectRole, role: ProjectRole): MembershipDecision {
  if (!isRole(actor) || !isRole(role)) return BAD;
  return mayManage(actor, role) ? OK : FORBIDDEN;
}

/**
 * Change a member (`newRole` undefined when the role doesn't change). `ownerCount` is
 * the number of active owners in the project, the target included if an owner.
 */
export function canUpdateMember(
  actor: ProjectRole,
  target: ProjectRole,
  newRole: ProjectRole | undefined,
  ownerCount: number,
): MembershipDecision {
  if (!isRole(actor) || !isRole(target) || (newRole !== undefined && !isRole(newRole))) return BAD;
  if (!Number.isSafeInteger(ownerCount) || ownerCount < 0 || (target === "owner" && ownerCount < 1)) return BAD;
  if (!mayManage(actor, target)) return FORBIDDEN;
  if (newRole !== undefined && !mayManage(actor, newRole)) return FORBIDDEN;
  if (target === "owner" && newRole !== undefined && newRole !== "owner" && ownerCount <= 1) return LAST_OWNER;
  return OK;
}

/** Remove a member (an owner may remove themselves, unless they are the last owner). */
export function canRemoveMember(actor: ProjectRole, target: ProjectRole, ownerCount: number): MembershipDecision {
  if (!isRole(actor) || !isRole(target)) return BAD;
  if (!Number.isSafeInteger(ownerCount) || ownerCount < 0 || (target === "owner" && ownerCount < 1)) return BAD;
  if (!mayManage(actor, target)) return FORBIDDEN;
  if (target === "owner" && ownerCount <= 1) return LAST_OWNER;
  return OK;
}
