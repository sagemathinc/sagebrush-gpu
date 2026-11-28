import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCRUING_STATES,
  QUOTE_REFUSALS,
  OFFER_MISSES,
  BILLING_MODES,
  DEFAULT_POLICY,
  MACHINE_STATES,
  MACHINE_TRANSITIONS,
  PROJECT_ROLES,
  canTransition,
  isBillingMode,
  orgRoleAtLeast,
  projectRoleAtLeast,
  type MachineState,
  VM_GATE_WORDS,
  parseGateReport,
  START_FAILURES,
  isStartFailure,
  AGENT_ERADICATION_CHECKS,
  AGENT_ABORT_REASONS,
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
  assert.deepEqual([DEFAULT_POLICY.snapshotKeepLast, DEFAULT_POLICY.snapshotNamedMax], [10, 5]);
});

test("billing modes: exactly resold and byok", () => {
  assert.deepEqual(BILLING_MODES, ["resold", "byok"]);
  for (const m of BILLING_MODES) assert.equal(isBillingMode(m), true);
  for (const x of ["", "Resold", "byok ", "other", null, undefined, 0, ["resold"]]) assert.equal(isBillingMode(x), false, String(x));
});

test("the VM gate's words: 22, sorted, distinct", () => {
  assert.equal(VM_GATE_WORDS.length, 22);
  assert.deepEqual([...VM_GATE_WORDS], [...new Set(VM_GATE_WORDS)].sort());
});

test("a gate report is accepted only in its canonical form", () => {
  assert.deepEqual(parseGateReport({ v: 1, pass: true, fail: [] }), { v: 1, pass: true, fail: [] });
  assert.deepEqual(parseGateReport({ fail: ["imds", "sudo"], pass: false, v: 1 }), { v: 1, pass: false, fail: ["imds", "sudo"] });
  const all = parseGateReport({ v: 1, pass: false, fail: [...VM_GATE_WORDS] });
  assert.deepEqual(all?.fail, [...VM_GATE_WORDS]);
  const bad: unknown[] = [
    null, undefined, "x", 1, [], [1],
    { v: 2, pass: true, fail: [] }, // another version
    { v: "1", pass: true, fail: [] },
    { pass: true, fail: [] }, // a key missing
    { v: 1, pass: true, fail: [], extra: 1 }, // an extra key
    { v: 1, pass: "true", fail: [] },
    { v: 1, pass: true, fail: {} },
    { v: 1, pass: true, fail: ["imds"] }, // pass disagrees with fail
    { v: 1, pass: false, fail: [] },
    { v: 1, pass: false, fail: ["sudo", "imds"] }, // unsorted
    { v: 1, pass: false, fail: ["imds", "imds"] }, // a duplicate
    { v: 1, pass: false, fail: ["nope"] }, // an unknown word
    { v: 1, pass: false, fail: [1] },
    { v: 1, pass: false, fail: [...VM_GATE_WORDS, "zzz"] }, // longer than the vocabulary
  ];
  for (const b of bad) assert.equal(parseGateReport(b), null, JSON.stringify(b));
  // the result is a copy: changing the input after parsing changes nothing
  const input = { v: 1, pass: false, fail: ["imds"] };
  const r = parseGateReport(input)!;
  input.fail.push("sudo");
  assert.deepEqual(r.fail, ["imds"]);
});

test("quote refusals in precedence order: credentialUnusable just before noCapacity", () => {
  assert.deepEqual(
    [...QUOTE_REFUSALS],
    ["projectNotStarted", "projectEnded", "policy", "priceCap", "credentialUnusable", "noCapacity", "concurrencyCap", "allocationTooLow"],
  );
});

test("offer misses in the order a quote checks them, and the team GPU cap defaults to one per member", () => {
  assert.deepEqual([...OFFER_MISSES], ["gpuCount", "gpuTooSmall", "gpuTooLarge", "gpuTypeNotAllowed", "providerNotAllowed", "locality", "overPrice", "noStock"]);
  assert.equal(DEFAULT_POLICY.maxGpusPerTeam, null);
});

test("start failures: the two reasons a machine never starts, and nothing else", () => {
  assert.deepEqual([...START_FAILURES], ["createDeadline", "podExited", "providerRefused", "setupFailed"]);
  for (const r of START_FAILURES) assert.equal(isStartFailure(r), true, r);
  for (const bad of ["create-deadline", "pod-exited", "provider", "", null, undefined, 1]) assert.equal(isStartFailure(bad), false, String(bad));
});

test("the container agent's eradication checks and abort reasons are exactly the contract's lists", () => {
  // (control parses a container's report against the first, and an abort's reason against the second; the agent's
  // own lists are pinned to these by the machine package's agent test)
  assert.deepEqual([...AGENT_ERADICATION_CHECKS], ["env", "processes", "files", "ssh"]);
  assert.deepEqual([...AGENT_ABORT_REASONS], ["env-not-clean", "extra-process", "key-file", "ssh-access", "other"]);
});
