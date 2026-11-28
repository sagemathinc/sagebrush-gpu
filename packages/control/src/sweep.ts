// The orphan sweep for container mode (scheduled, with the container watchdog's adapter): one
// read of RunPod's pod list, then every live pod carrying this installation's name is checked
// against its own launch row (its machine and incarnation, from the name):
//
// - kept: the launch is live (creating, issued or enrolled) and has this pod's id, or no id yet
//   (the watchdog finds a pod by its name once the create deadline passes); or the launch is
//   already marked to terminate (the watchdog is ending it, its ids recorded);
// - ended by its id: no launch row for that machine and incarnation (a stale incarnation
//   included), a launch already terminated, or a live launch holding another pod's id. Each is
//   alerted, with why. No row can be revoked for such a pod: its launch has none, or its boot
//   token was used when that launch was ended.
//
// A pod of another installation is reported (one count a run) and never touched. A list that
// can't be read (or is partial: the adapter throws) proves nothing, so nothing is ended and the
// run fails by name; so does a launch row that can't be read for a pod (that pod is left). At
// most SWEEP_END_BATCH terminations are attempted a run, counted before each call whatever its
// outcome (a rejection or a lost reply doesn't prove the pod wasn't ended), and none once the
// run's time budget is spent; orphans left over are reported, for the next run. A pod whose name
// doesn't parse isn't listed by the adapter, so it is outside this sweep.
//
// Back-off (0030's sweep_attempts; William's fleet rule): an orphan is tried at once the first time it
// is seen; after n attempts the next waits backoffMs(n) from the last one, so a provider that keeps
// refusing isn't asked every run. Each attempt is recorded before the call. An orphan still waiting
// isn't a failure of the run: they are alerted as one count a run. A run that read the list whole
// forgets the attempts of machines that are no longer orphans.

import type { ProviderMachineStatus } from "@sbgpu/providers";
import type { ContainerEnv } from "./container.ts";
import { WATCHDOG_BUDGET_MS, withDeadline } from "./vm.ts";

/** Terminations the sweep attempts a run, at most (attempts, not confirmations). */
export const SWEEP_END_BATCH = 20;
/** The wait after an orphan's first attempt; it doubles with each attempt, up to the cap. */
export const SWEEP_BACKOFF_BASE_MS = 60_000;
export const SWEEP_BACKOFF_CAP_MS = 60 * 60_000;
/** The provider this sweep's attempts are recorded under (container mode is RunPod's). */
const SWEEP_PROVIDER = "runpod";

/** How long after an orphan's n-th attempt (n >= 1) the next may be made: deterministic, capped. */
export function backoffMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError("attempts is a count of at least 1");
  // (2^(n-1) reaches the cap long before it could lose precision)
  return Math.min(SWEEP_BACKOFF_CAP_MS, SWEEP_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 30));
}

export interface SweepEnv extends ContainerEnv {
  alert(line: string): void;
}

/** Why a pod is ended: no launch row, a terminated launch, or a live launch holding another pod. */
export type OrphanReason = "no-launch" | "launch-terminated" | "not-the-launch-pod";

/**
 * Sweeps once. Returns how many pods it ended (the provider took the termination). Throws, after
 * ending what it could, when the list or a launch row couldn't be read, a termination wasn't
 * taken, or orphans were left (the attempt cap or the time budget); the run then fails by name
 * and the next run goes on.
 */
export async function runContainerSweep(env: SweepEnv): Promise<number> {
  const p = env.provider;
  if (!p || env.installation === null) throw new Error("the sweep has no adapter or installation");
  const list = await withDeadline<ProviderMachineStatus[] | "unavailable">(() => p.listMachines(), "unavailable");
  if (list === "unavailable") throw new Error("the pod list couldn't be read");
  const problems: string[] = [];
  let foreign = 0;
  let attempted = 0;
  let ended = 0;
  let waiting = 0;
  const orphans = new Set<string>();
  const now = env.clock();
  // (read once a pod of ours is listed: a run with none touches no table)
  let tried: Map<string, { attempts: number; last_ms: number }> | null = null;
  const attemptsSoFar = async () =>
    (tried ??= new Map(
      (await env.db.all<{ provider_machine_id: string; attempts: number; last_ms: number }>(
        `SELECT provider_machine_id, attempts, last_ms FROM sweep_attempts WHERE provider = ?`,
        [SWEEP_PROVIDER],
      )).map((r) => [r.provider_machine_id, r]),
    ));
  for (const s of list) {
    const n = s.parsedName;
    if (n === null || s.state === "terminated") continue;
    if (n.installation !== env.installation) {
      foreign++;
      continue;
    }
    let why: OrphanReason | null;
    let before: { attempts: number; last_ms: number } | undefined;
    try {
      why = await orphanReason(env, n.machineId, n.incarnation, s.providerMachineId);
      before = (await attemptsSoFar()).get(s.providerMachineId);
    } catch {
      problems.push(`${s.providerMachineId}: its launch couldn't be read`);
      continue;
    }
    if (why === null) continue;
    orphans.add(s.providerMachineId);
    if (before !== undefined && now < before.last_ms + backoffMs(before.attempts)) {
      waiting++;
      continue;
    }
    if (attempted >= SWEEP_END_BATCH) {
      problems.push("more orphans than one run ends");
      break;
    }
    if (env.elapsedMs() >= WATCHDOG_BUDGET_MS) {
      problems.push("the run's time was spent with orphans left");
      break;
    }
    attempted++; // (before the call: whatever the outcome, it may have ended the pod)
    await env.db.run(
      `INSERT INTO sweep_attempts (provider, provider_machine_id, attempts, last_ms) VALUES (?, ?, 1, ?)
       ON CONFLICT (provider, provider_machine_id) DO UPDATE SET attempts = min(attempts + 1, 1000000), last_ms = excluded.last_ms`,
      [SWEEP_PROVIDER, s.providerMachineId, now],
    );
    const took = await withDeadline(() => p.terminate(s.providerMachineId).then(() => true), false);
    if (took) {
      ended++;
      env.alert(`orphan pod ${s.providerMachineId} (${n.machineId} incarnation ${n.incarnation}): ${why}; ended`);
    } else {
      problems.push(`${s.providerMachineId}: its termination wasn't taken`);
    }
  }
  if (foreign > 0) env.alert(`${foreign} pod(s) of another installation; left as they are`);
  if (waiting > 0) env.alert(`${waiting} orphan pod(s) waiting to be tried again (back-off)`);
  // The list was read whole: attempts of machines that are no longer orphans are forgotten (once a pod of
  // ours was listed; a run with none leaves the rows for the next that has one).
  const gone = tried === null ? [] : [...(tried as Map<string, unknown>).keys()].filter((id) => !orphans.has(id));
  for (const id of gone) await env.db.run(`DELETE FROM sweep_attempts WHERE provider = ? AND provider_machine_id = ?`, [SWEEP_PROVIDER, id]);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return ended;
}

/** Why the pod is an orphan, or null when its launch keeps it. Throws when the row can't be read. */
async function orphanReason(env: ContainerEnv, machineId: string, incarnation: number, podId: string): Promise<OrphanReason | null> {
  const rows = await env.db.all<{ outcome: string; provider_machine_id: string | null }>(
    `SELECT outcome, provider_machine_id FROM launches WHERE machine_id = ? AND incarnation = ? AND mode = 'container'`,
    [machineId, incarnation],
  );
  const r = rows[0];
  if (!r) return "no-launch";
  if (r.outcome === "terminate") return null;
  if (r.outcome === "terminated") return "launch-terminated";
  if (r.provider_machine_id === null || r.provider_machine_id === podId) return null;
  return "not-the-launch-pod";
}
