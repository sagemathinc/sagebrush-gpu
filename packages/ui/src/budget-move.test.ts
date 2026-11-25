import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMove, exactUsd, moveBounds } from "./budget-move.ts";

test("moveBounds: in up to the unassigned figure, back up to the budget not allocated", () => {
  assert.deepEqual(moveBounds({ unassignedCredit: 2_900_000_000 }, { budget: 2_000_000_000, allocated: 200_200_000 }), { maxAdd: 2_900_000_000, maxReturn: 1_799_800_000 });
  assert.deepEqual(moveBounds({ unassignedCredit: 0 }, { budget: 5, allocated: 5 }), { maxAdd: 0, maxReturn: 0 });
  // (a budget below its allocations can't happen on the server; nothing can be returned then)
  assert.deepEqual(moveBounds({ unassignedCredit: 1 }, { budget: 5, allocated: 7 }), { maxAdd: 1, maxReturn: 0 });
});

test("exactUsd: cents, or exactly when there's less than a cent in it", () => {
  assert.equal(exactUsd(1_799_800_000), "$1,799.80");
  assert.equal(exactUsd(0), "$0.00");
  assert.equal(exactUsd(10_000), "$0.01");
  assert.equal(exactUsd(1), "$0.000001");
  assert.equal(exactUsd(2_900_500_010), "$2,900.50001");
});

test("checkMove: the exact bounds both ways; a signed amount to send", () => {
  const b = { maxAdd: 1_000_000, maxReturn: 250_000 };
  assert.deepEqual(checkMove("1", "add", b), { ok: true, amount: 1_000_000 }); // exactly what's unassigned
  assert.deepEqual(checkMove("1.000001", "add", b), { ok: false, reason: "The organization has $1.00 not yet assigned." });
  assert.deepEqual(checkMove("$0.25", "return", b), { ok: true, amount: -250_000 }); // exactly what's not allocated
  assert.deepEqual(checkMove("0.250001", "return", b), { ok: false, reason: "Only $0.25 of this project's budget isn't allocated." });
  assert.deepEqual(checkMove(" 0.000001 ", "add", b), { ok: true, amount: 1 });
  assert.deepEqual(checkMove("0.000001", "return", b), { ok: true, amount: -1 });
  // A bound with less than a cent in it is said exactly.
  assert.deepEqual(checkMove("1", "add", { maxAdd: 500_001, maxReturn: 0 }), { ok: false, reason: "The organization has $0.500001 not yet assigned." });
  assert.deepEqual(checkMove("1", "return", { maxAdd: 0, maxReturn: 0 }), { ok: false, reason: "Only $0.00 of this project's budget isn't allocated." });
});

test("checkMove: nothing, zero and amounts finer than a micro-dollar are refused", () => {
  const b = { maxAdd: 10_000_000, maxReturn: 10_000_000 };
  for (const dir of ["add", "return"] as const) {
    assert.deepEqual(checkMove("0", dir, b), { ok: false, reason: "Enter more than $0." });
    assert.deepEqual(checkMove("0.000000", dir, b), { ok: false, reason: "Enter more than $0." });
    for (const bad of ["", " ", "0.0000001", "1.5e3", "-1", "abc", "$", "1,00"]) {
      assert.deepEqual(checkMove(bad, dir, b), { ok: false, reason: "Enter an amount in dollars, with at most six decimals." }, `${dir} ${JSON.stringify(bad)}`);
    }
  }
});

test("checkMove's words never say credit (under byok the figures are a budget)", () => {
  for (const r of [checkMove("9", "add", { maxAdd: 1, maxReturn: 1 }), checkMove("9", "return", { maxAdd: 1, maxReturn: 1 }), checkMove("x", "add", { maxAdd: 1, maxReturn: 1 })]) {
    assert.equal(r.ok, false);
    if (!r.ok) assert.doesNotMatch(r.reason, /credit/i);
  }
});
