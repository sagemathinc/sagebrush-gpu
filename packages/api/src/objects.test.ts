import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCRUING_STATES,
  DEFAULT_POLICY,
  MACHINE_STATES,
  MACHINE_TRANSITIONS,
  PROJECT_ROLES,
  canTransition,
  orgRoleAtLeast,
  projectRoleAtLeast,
  type MachineState,
} from "./objects.ts";

test("project role order", () => {
  assert.deepEqual([...PROJECT_ROLES], ["member", "assistant", "manager", "owner"]);
  assert.equal(projectRoleAtLeast("member", "member"), true);
  assert.equal(projectRoleAtLeast("member", "assistant"), false);
  assert.equal(projectRoleAtLeast("assistant", "member"), true);
  assert.equal(projectRoleAtLeast("manager", "owner"), false);
  assert.equal(projectRoleAtLeast("owner", "manager"), true);
  assert.equal(orgRoleAtLeast("viewer", "owner"), false);
  assert.equal(orgRoleAtLeast("owner", "viewer"), true);
  assert.equal(orgRoleAtLeast("owner", "owner"), true);
});

test("machine transitions", () => {
  for (const s of MACHINE_STATES) {
    assert.ok(Object.hasOwn(MACHINE_TRANSITIONS, s), s);
    assert.equal(canTransition(s, s), false, `${s} self-loop`);
  }
  assert.deepEqual(MACHINE_TRANSITIONS.deleted, []);
  // A stop always goes through stopping, and a save-before-stop through saving.
  assert.equal(canTransition("running", "stopped"), false);
  assert.equal(canTransition("saving", "stopped"), false);
  assert.equal(canTransition("saving", "running"), false);
  assert.equal(canTransition("running", "saving"), true);
  assert.equal(canTransition("saving", "stopping"), true);
  assert.equal(canTransition("stopping", "stopped"), true);
  // Deleting a machine the provider may still bill for is refused.
  for (const s of ACCRUING_STATES) assert.equal(canTransition(s, "deleted"), false, s);
  assert.equal(canTransition("stopped", "deleted"), true);
  assert.equal(canTransition("failed", "deleted"), true);
  assert.equal(canTransition("stopped", "starting"), true);
  assert.equal(canTransition("stopped", "running"), false);
  // Everything is reachable from starting, and deleted from everywhere.
  const reach = (from: MachineState): Set<MachineState> => {
    const seen = new Set<MachineState>([from]);
    const todo = [from];
    while (todo.length) for (const t of MACHINE_TRANSITIONS[todo.pop()!]) if (!seen.has(t)) (seen.add(t), todo.push(t));
    return seen;
  };
  assert.equal(reach("starting").size, MACHINE_STATES.length);
  for (const s of MACHINE_STATES) assert.ok(reach(s).has("deleted"), s);
});

test("accruing states", () => {
  assert.deepEqual([...ACCRUING_STATES].sort(), ["running", "saving", "starting", "stopping"]);
});

test("the default policy is frozen and allows nothing until configured", () => {
  assert.ok(Object.isFrozen(DEFAULT_POLICY));
  assert.deepEqual(DEFAULT_POLICY.allowedGpuTypes, []);
  assert.deepEqual(DEFAULT_POLICY.allowedProviders, []);
  assert.equal(DEFAULT_POLICY.finalSaveReserveMinutes, 10);
});
