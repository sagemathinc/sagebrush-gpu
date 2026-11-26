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

import type { ProviderMachineStatus } from "@sbgpu/providers";
import type { ContainerEnv } from "./container.ts";
import { WATCHDOG_BUDGET_MS, withDeadline } from "./vm.ts";

/** Terminations the sweep attempts a run, at most (attempts, not confirmations). */
export const SWEEP_END_BATCH = 20;

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
  for (const s of list) {
    const n = s.parsedName;
    if (n === null || s.state === "terminated") continue;
    if (n.installation !== env.installation) {
      foreign++;
      continue;
    }
    let why: OrphanReason | null;
    try {
      why = await orphanReason(env, n.machineId, n.incarnation, s.providerMachineId);
    } catch {
      problems.push(`${s.providerMachineId}: its launch couldn't be read`);
      continue;
    }
    if (why === null) continue;
    if (attempted >= SWEEP_END_BATCH) {
      problems.push("more orphans than one run ends");
      break;
    }
    if (env.elapsedMs() >= WATCHDOG_BUDGET_MS) {
      problems.push("the run's time was spent with orphans left");
      break;
    }
    attempted++; // (before the call: whatever the outcome, it may have ended the pod)
    const took = await withDeadline(() => p.terminate(s.providerMachineId).then(() => true), false);
    if (took) {
      ended++;
      env.alert(`orphan pod ${s.providerMachineId} (${n.machineId} incarnation ${n.incarnation}): ${why}; ended`);
    } else {
      problems.push(`${s.providerMachineId}: its termination wasn't taken`);
    }
  }
  if (foreign > 0) env.alert(`${foreign} pod(s) of another installation; left as they are`);
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
