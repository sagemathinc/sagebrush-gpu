// The lifecycle contract's own check (relay-contract.ts): a lifecycle that keeps it passes; each way of breaking it fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { assertRelayLifecycleContract, type LifecycleUnderTest, type RevokeFn } from "./relay-contract.ts";

/** A toy lifecycle, compliant unless a flaw is named. */
type Flaw = "stops-without-ack" | "mints-while-in-flight" | "mints-after-a-failed-revoke" | "never-revokes" | "old-incarnation" | "mints-when-stopped" | "mints-nothing" | "never-completes"
  | "revokes-twice" | "skips-a-retry" | "mints-after-a-second-failure";

function toy(flaw?: Flaw) {
  return async (revoke: RevokeFn): Promise<LifecycleUnderTest> => {
    let stopRequested = false;
    let revoking = false;
    let stopped = false;
    let attempts = 0;
    const lc: LifecycleUnderTest = {
      mch: "mch_toy",
      inc: 4,
      async stop() {
        if (stopped) return "stopped";
        if (flaw === "never-revokes") return (stopped = true), "stopped";
        attempts++;
        if (flaw === "skips-a-retry" && attempts === 2) return "stopping";
        if (flaw !== "mints-while-in-flight") stopRequested = true;
        revoking = flaw !== "mints-while-in-flight";
        let ok = false;
        try {
          ok = await revoke(lc.mch, flaw === "old-incarnation" ? lc.inc - 1 : lc.inc);
          if (flaw === "revokes-twice" && !ok) ok = await revoke(lc.mch, lc.inc);
        } catch {
          ok = false;
        } finally {
          revoking = false;
        }
        if (flaw === "mints-while-in-flight") stopRequested = true;
        if (flaw === "mints-after-a-failed-revoke" && !ok) stopRequested = false;
        if (flaw === "mints-after-a-second-failure" && !ok && attempts === 2) stopRequested = false;
        if ((ok && flaw !== "never-completes") || flaw === "stops-without-ack") stopped = true;
        return stopped ? "stopped" : "stopping";
      },
      async mintPageToken() {
        if (flaw === "mints-nothing") return null;
        if (flaw === "mints-when-stopped" && stopped) return "tok";
        if (stopRequested || revoking || stopped) return null;
        return "tok";
      },
    };
    return lc;
  };
}

/** A non-blocking lifecycle: stop() starts a revoke and answers "stopping" while it is pending; a later ack stops the
 * machine, and a stop() after that answers "stopped" with no new revoke. */
function nonblocking(flaw?: "retries-twice" | "retries-twice-after-a-hold") {
  return async (revoke: RevokeFn): Promise<LifecycleUnderTest> => {
    let requested = false;
    let stopped = false;
    let attempts = 0;
    let held = false; // (a revoke still pending when its stop() answered)
    const lc: LifecycleUnderTest = {
      mch: "mch_async",
      inc: 4,
      async stop() {
        if (stopped) return "stopped";
        requested = true;
        attempts++;
        const twice = (flaw === "retries-twice" && attempts > 1) || (flaw === "retries-twice-after-a-hold" && held);
        let settled = false;
        const ack = (ok: boolean) => {
          settled = true;
          if (ok && !(flaw === "retries-twice-after-a-hold" && attempts === 1)) stopped = true;
        };
        void revoke(lc.mch, lc.inc).then(ack, () => (settled = true));
        if (twice) void revoke(lc.mch, lc.inc).then(ack, () => {});
        await Promise.resolve();
        await Promise.resolve();
        if (!settled) held = true;
        return stopped ? "stopped" : "stopping";
      },
      async mintPageToken() {
        return requested || stopped ? null : "tok";
      },
    };
    return lc;
  };
}

/** A blocking lifecycle whose FIRST attempt, if acknowledged, still answers "stopping" (only a revoke held in flight
 * gets there: a failed first attempt doesn't), completing on the next stop(), which revokes again: compliant unless a
 * flaw opens minting in that window or after it. */
function ackThenStopping(flaw?: "reopens-before-retry" | "mints-after-stopped") {
  return async (revoke: RevokeFn): Promise<LifecycleUnderTest> => {
    let requested = false;
    let stopped = false;
    let attempts = 0;
    let ackedStopping = false;
    const lc: LifecycleUnderTest = {
      mch: "mch_ack",
      inc: 7,
      async stop() {
        if (stopped) return "stopped";
        requested = true;
        attempts++;
        let ok = false;
        try {
          ok = await revoke(lc.mch, lc.inc);
        } catch {
          ok = false;
        }
        if (!ok) return "stopping";
        if (attempts === 1) {
          ackedStopping = true;
          if (flaw === "reopens-before-retry") requested = false;
          return "stopping";
        }
        stopped = true;
        if (flaw === "mints-after-stopped" && ackedStopping) requested = false; // (only on the held path)
        return "stopped";
      },
      async mintPageToken() {
        if (flaw === "mints-after-stopped") return requested ? null : "tok";
        return requested || stopped ? null : "tok";
      },
    };
    return lc;
  };
}

test("a lifecycle that answers stopping once after its ack keeps the contract; minting around that ack breaks it", async () => {
  await assertRelayLifecycleContract(ackThenStopping());
  await assert.rejects(assertRelayLifecycleContract(ackThenStopping("reopens-before-retry")),
    /a page token minted after the revoke in flight answered/);
  await assert.rejects(assertRelayLifecycleContract(ackThenStopping("mints-after-stopped")),
    /a page token minted for a machine stopped after a revoke in flight/);
});

test("a lifecycle that keeps the contract passes it, blocking or not", async () => {
  await assertRelayLifecycleContract(toy());
  await assertRelayLifecycleContract(nonblocking());
});

test("a non-blocking lifecycle that breaks the contract fails it, with its reason", async () => {
  await assert.rejects(assertRelayLifecycleContract(nonblocking("retries-twice")), /a stop attempt made 2 revoke calls, not one \(attempt 2\)/);
  // (the guard on the retry after a held ack: at most one new call there)
  await assert.rejects(
    assertRelayLifecycleContract(nonblocking("retries-twice-after-a-hold")),
    /a stop attempt made 2 revoke calls, more than one \(the retry after the one in flight\)/,
  );
});

test("each way of breaking the contract fails it, with its reason", async () => {
  const cases: Array<[Flaw, RegExp]> = [
    ["stops-without-ack", /completed with the revoke answering false/],
    ["mints-while-in-flight", /minted while a revoke was in flight/],
    ["mints-after-a-failed-revoke", /minted after a revoke answered false/],
    ["never-revokes", /a stop attempt made 0 revoke calls, not one \(attempt 1\)/],
    ["old-incarnation", /incarnation 3, below the current 4/],
    ["mints-when-stopped", /minted for a stopped machine/],
    ["mints-nothing", /no page token before any stop/],
    ["never-completes", /a stop not completed after its revoke was acknowledged/],
    ["revokes-twice", /a stop attempt made 2 revoke calls, not one \(attempt 1\)/],
    ["skips-a-retry", /a stop attempt made 0 revoke calls, not one \(attempt 2\)/],
    ["mints-after-a-second-failure", /minted after a revoke answered false \(attempt 2\)/],
  ];
  for (const [flaw, why] of cases) {
    await assert.rejects(assertRelayLifecycleContract(toy(flaw)), why, flaw);
  }
});

test("a stop attempt that never answers fails the contract rather than hanging it", { timeout: 30_000 }, async () => {
  const stuck = async (revoke: RevokeFn): Promise<LifecycleUnderTest> => {
    void revoke;
    return { mch: "mch_toy", inc: 1, stop: () => new Promise(() => {}), mintPageToken: async () => "tok" };
  };
  // (raced against a timer of its own, so a check that hangs is a named failure here, not a cancelled test)
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = await Promise.race([
    assertRelayLifecycleContract(stuck).then(() => "passed", (e: unknown) => e),
    new Promise((r) => (timer = setTimeout(() => r("hung"), 15_000))),
  ]);
  clearTimeout(timer);
  assert.ok(out instanceof Error && /stop\(\): no answer within/.test(out.message), String(out));
});
