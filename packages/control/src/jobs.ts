// The scheduled jobs (the Worker's cron, every minute), in the order they run. Each one is
// bounded per run, so a backlog is worked off over several runs instead of in one long
// one. The ledger's accrual and the hard stops join this list with the scheduler.

import { runVmWatchdog, type JobEnv } from "./vm.ts";
import { runHeartbeatWatchdog } from "./heartbeat.ts";
import { runContainerLifetime } from "./container.ts";

export type { JobEnv };

export interface ScheduledJob {
  name: string;
  /** Does one run's work (at env.now); returns how many rows it changed or attempted. */
  run(env: JobEnv): Promise<number>;
}

/** Rows each prune deletes per run, at most. */
export const PRUNE_BATCH = 500;

/** Expired sessions, soonest expired first (a session past its expiry never authenticates). */
export const pruneSessions: ScheduledJob = {
  name: "prune sessions",
  async run({ db, now: nowMs }) {
    const r = await db.run(
      `DELETE FROM sessions WHERE id_sha256 IN (SELECT id_sha256 FROM sessions WHERE expires_ms <= ? ORDER BY expires_ms LIMIT ?)`,
      [nowMs, PRUNE_BATCH],
    );
    return r.changes;
  },
};

/** Spent sign-in states past their expiry (a state can't be used after it anyway), soonest expired first. */
export const pruneAuthStates: ScheduledJob = {
  name: "prune sign-in states",
  async run({ db, now: nowMs }) {
    const r = await db.run(
      `DELETE FROM auth_states WHERE nonce_sha256 IN (SELECT nonce_sha256 FROM auth_states WHERE expires_ms <= ? ORDER BY expires_ms LIMIT ?)`,
      [nowMs, PRUNE_BATCH],
    );
    return r.changes;
  },
};

/** VM mode's watchdog (vm.ts): launches that must end, terminated until the provider confirms it. */
export const vmWatchdog: ScheduledJob = { name: "vm watchdog", run: runVmWatchdog };

/** Enrolled VMs whose heartbeats stopped (heartbeat.ts): marked heartbeat-lost, for the VM watchdog to end. */
export const heartbeatWatchdog: ScheduledJob = { name: "heartbeat watchdog", run: runHeartbeatWatchdog };

/** Enrolled containers past their hard lifetime (container.ts): marked max-session, for the container watchdog to end. */
export const containerLifetime: ScheduledJob = { name: "container lifetime", run: runContainerLifetime };

export const SCHEDULED_JOBS: readonly ScheduledJob[] = Object.freeze([pruneSessions, pruneAuthStates, heartbeatWatchdog, containerLifetime, vmWatchdog]);
