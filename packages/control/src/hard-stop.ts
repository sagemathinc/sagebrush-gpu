// The budget hard stop for container machines (scheduled, every minute). In one run, in this
// order: the ledger bills every machine's closed minutes (accrueAll), then finds the allocations
// whose accruing machines must stop now (findHardStops, with admission's periods, so a start
// admitted at the edge isn't stopped at the next run), then marks each such container machine's
// live launch to terminate (hard-stop), in one batch with its revocation (the machine leaves
// running). The container watchdog then ends the pod through the provider, and the accrual
// closes once the pod is confirmed gone. findHardStops fails closed: an allocation whose figures
// can't be computed is stopped.
//
// A VM machine it names is left to VM mode's own stop path (VM mode is unreachable: no VM
// provider is wired). A machine still starting with no accrual isn't accruing, so it's never
// named: admission counts it as a pending liability instead.

import type { Stmt } from "./db.ts";
import { stopMachineStmt } from "./container.ts";
import { accrueAll, findHardStops } from "./ledger.ts";
import type { JobEnv } from "./vm.ts";

/**
 * The hard stop's check and safety periods: the same as admission's (the start path's
 * HARD_STOP_PERIODS), so admission and the scheduled stop agree on the edge.
 */
export const HARD_STOP_PERIODS = Object.freeze({ checkIntervalSeconds: 60, safetySeconds: 60 });

const TOOK: Stmt = { sql: `INSERT INTO enroll_guard (ok) SELECT 0 WHERE changes() <> 1`, params: [] };

/** A machine's live container launch at its current incarnation, if any. */
const LIVE_CONTAINER_LAUNCH = `SELECT l.incarnation, l.watchdog_version FROM launches l
     JOIN machines m ON m.id = l.machine_id AND m.incarnation = l.incarnation
     WHERE l.machine_id = ? AND l.mode = 'container' AND l.outcome IN ('creating', 'issued', 'enrolled')`;

/**
 * Accrue, find, mark. The stop never depends on the accrual: if it fails (for some machines, or
 * as a whole), the hard stops are still found (findHardStops counts unbilled time itself) and
 * marked. Each mark is one batch that rechecks what was read (the launch live at its version) and
 * fails whole unless it changed exactly that row. A mark that throws is a lost race only when a
 * fresh read proves it: the launch is no longer live at the version read (another mark or move won,
 * or this mark committed). If the same live launch at the same version is still there, or that
 * read fails too, the stop wasn't made: its error is kept, the other marks still run, and the job
 * then fails naming them. Returns how many it marked. Throws after marking when the accrual
 * failed or any stop wasn't made, so the run reports it by name.
 */
export async function runContainerHardStop(env: JobEnv): Promise<number> {
  const problems: string[] = [];
  try {
    const accrued = await accrueAll(env.db, env.now);
    if (accrued.failed.length > 0) problems.push(`the accrual failed for ${accrued.failed.length} machine(s)`);
  } catch {
    problems.push("the accrual failed");
  }
  const stops = await findHardStops(env.db, env.now, HARD_STOP_PERIODS);
  let marked = 0;
  const notMarked: string[] = [];
  for (const s of stops) {
    for (const machineId of s.machineIds) {
      const live = (await env.db.all<{ incarnation: number; watchdog_version: number }>(LIVE_CONTAINER_LAUNCH, [machineId]))[0];
      if (!live) continue; // (a VM's machine, or one whose launch is already ending)
      try {
        await env.db.batch([
          {
            sql: `UPDATE launches SET outcome = 'terminate', terminate_reason = 'hard-stop', next_ms = ?, watchdog_version = watchdog_version + 1
                  WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND outcome IN ('creating', 'issued', 'enrolled') AND watchdog_version = ?`,
            params: [env.now, machineId, live.incarnation, live.watchdog_version],
          },
          TOOK,
          stopMachineStmt(machineId, live.incarnation),
        ]);
        marked++;
      } catch (e) {
        if (!(await movedOn(env, machineId, live))) notMarked.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (notMarked.length > 0) problems.push(`${notMarked.length} hard stop(s) not marked (${notMarked.join("; ")})`);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return marked;
}

/**
 * Whether a fresh read proves the launch read at `live` is no longer live at that version (a lost
 * race, or this mark committed). False when it still is, or when the read fails.
 */
async function movedOn(env: JobEnv, machineId: string, live: { incarnation: number; watchdog_version: number }): Promise<boolean> {
  try {
    const now = await env.db.all<{ one: number }>(
      `SELECT 1 AS one FROM launches WHERE machine_id = ? AND incarnation = ? AND mode = 'container'
         AND outcome IN ('creating', 'issued', 'enrolled') AND watchdog_version = ?`,
      [machineId, live.incarnation, live.watchdog_version],
    );
    return now.length === 0;
  } catch {
    return false;
  }
}
