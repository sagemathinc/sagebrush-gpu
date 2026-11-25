// The relay's lifecycle contract (DESIGN.md section 4; SEC ruling, Nov 24): what control's machine lifecycle must do
// around revokeMachine, and a conformance check its tests run.  Test-only (node:assert): it lives in the test-only
// package, which no runtime source may import (boundary.ts).
//
//   (a) A stop is complete only once revokeMachine(env, mch, inc) has returned true: the machine's object wrote
//       revokedThrough >= inc durably before answering.  false, a throw or no answer leave the stop pending, retried.
//       The inc is the machine's current incarnation (or higher): an ack for a lower one revokes nothing current.
//   (b) No page token is minted for a machine while a revoke for it is in flight, failed, or not yet acknowledged; nor
//       once it is stopped.
//
// The lifecycle under test gets a scripted stand-in for revokeMachine, injected wherever it would call revokeMachine,
// and gives back two functions: stop() (one attempt each call, as the cron retries) and mintPageToken().
import assert from "node:assert/strict";

/** revokeMachine's shape, as the lifecycle calls it (env bound). */
export type RevokeFn = (mch: string, inc: number) => Promise<boolean>;

export interface LifecycleUnderTest {
  /** The machine, and its current incarnation. */
  mch: string;
  inc: number;
  /** One stop attempt: "stopped" only once a revoke was acknowledged; else "stopping" (it may also reject). */
  stop(): Promise<"stopped" | "stopping">;
  /** A page token for the machine, or null when minting is refused. */
  mintPageToken(): Promise<string | null>;
}

/** The scripted revoke: each call answers as `answer` says when it is made ("hold" waits for release()). */
class ScriptedRevoke {
  answer: "true" | "false" | "throw" | "hold" = "true";
  calls: Array<{ mch: string; inc: number; acked: boolean }> = [];
  private held: Array<() => void> = [];
  readonly fn: RevokeFn = async (mch, inc) => {
    const call = { mch, inc, acked: false };
    this.calls.push(call);
    const a = this.answer;
    if (a === "throw") throw new Error("the relay is unreachable (scripted)");
    if (a === "hold") await new Promise<void>((r) => this.held.push(r));
    call.acked = a === "true" || a === "hold";
    return call.acked;
  };
  release(): void {
    for (const r of this.held.splice(0)) r();
  }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

async function within<T>(p: Promise<T>, what: string, ms = 5000): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`${what}: no answer within ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

/** One stop attempt; a rejection counts as still stopping (the stop stays pending). */
async function attempt(lc: LifecycleUnderTest): Promise<"stopped" | "stopping"> {
  try {
    return await within(lc.stop(), "stop()");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("stop(): no answer")) throw e;
    return "stopping";
  }
}

/** One stop attempt on a machine not yet stopped: it must call revoke exactly once (one attempt each call). */
async function attemptOnce(lc: LifecycleUnderTest, rev: ScriptedRevoke, what: string): Promise<"stopped" | "stopping"> {
  const before = rev.calls.length;
  const s = await attempt(lc);
  const made = rev.calls.length - before;
  assert.equal(made, 1, `a stop attempt made ${made} revoke calls, not one (${what})`);
  return s;
}

function callsAreForThisIncarnation(rev: ScriptedRevoke, lc: LifecycleUnderTest): void {
  for (const c of rev.calls) {
    assert.equal(c.mch, lc.mch, "a revoke for another machine");
    assert.ok(Number.isSafeInteger(c.inc) && c.inc >= lc.inc, `a revoke for incarnation ${c.inc}, below the current ${lc.inc}`);
  }
}

/**
 * Runs the contract's scenarios, each on a fresh lifecycle from `make`; rejects (an AssertionError) at the first
 * breach.  `make` gets the scripted revoke to inject in place of revokeMachine.
 */
export async function assertRelayLifecycleContract(make: (revoke: RevokeFn) => Promise<LifecycleUnderTest>): Promise<void> {
  // 1. The control: before any stop, minting works (else the refusals below would prove nothing).
  {
    const rev = new ScriptedRevoke();
    const lc = await make(rev.fn);
    const tok = await within(lc.mintPageToken(), "mintPageToken()");
    assert.ok(typeof tok === "string" && tok.length > 0, "no page token before any stop: the contract can't be checked");
  }
  // 2. A revoke answering false, then throwing: each attempt calls revoke once, the stop stays pending and minting is
  //    refused after every failed attempt; a retry acked: stopped.
  for (const failing of ["false", "throw"] as const) {
    const rev = new ScriptedRevoke();
    const lc = await make(rev.fn);
    rev.answer = failing;
    for (const n of [1, 2]) {
      assert.equal(await attemptOnce(lc, rev, `attempt ${n}`), "stopping", `a stop completed with the revoke answering ${failing} (attempt ${n})`);
      assert.equal(await within(lc.mintPageToken(), "mintPageToken()"), null, `a page token minted after a revoke answered ${failing} (attempt ${n})`);
    }
    rev.answer = "true";
    assert.equal(await attemptOnce(lc, rev, "the acked retry"), "stopped", "a stop not completed after its revoke was acknowledged");
    assert.ok(rev.calls.some((c) => c.acked), "stopped without an acknowledged revoke");
    assert.equal(await within(lc.mintPageToken(), "mintPageToken()"), null, "a page token minted for a stopped machine");
    callsAreForThisIncarnation(rev, lc);
  }
  // 3. A revoke in flight: minting is refused meanwhile, and the stop isn't complete until the ack.
  {
    const rev = new ScriptedRevoke();
    const lc = await make(rev.fn);
    rev.answer = "hold";
    let done: "stopped" | "stopping" | "rejected" | null = null;
    const p = lc.stop().then(
      (s) => (done = s),
      () => (done = "rejected"),
    );
    for (let i = 0; i < 500 && rev.calls.length === 0; i++) await settle();
    assert.equal(rev.calls.length, 1, "a stop attempt that didn't call revoke");
    assert.notEqual(done, "stopped", "a stop completed before its revoke answered");
    assert.equal(await within(lc.mintPageToken(), "mintPageToken()"), null, "a page token minted while a revoke was in flight");
    assert.notEqual(done, "stopped", "a stop completed before its revoke answered");
    rev.release();
    rev.answer = "true"; // (a retry, if the lifecycle needs one, is acked at once)
    await within(p, "stop()");
    assert.equal(rev.calls.length, 1, "a stop attempt made more than one revoke call (the one in flight)");
    // (the retry: a lifecycle that already learned of the held ack may answer "stopped" with no new call, one that
    // didn't makes one new call; never more)
    const before = rev.calls.length;
    const after = done === "stopped" ? "stopped" : await attempt(lc);
    const made = rev.calls.length - before;
    assert.ok(made <= 1, `a stop attempt made ${made} revoke calls, more than one (the retry after the one in flight)`);
    assert.equal(after, "stopped", "a stop not completed after its revoke was acknowledged");
    callsAreForThisIncarnation(rev, lc);
  }
}
