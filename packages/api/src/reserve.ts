// The final-save reserve (packages/machine/DESIGN.md section 5.6): how much running time the ledger holds back so a machine's
// final save can finish before a hard stop.  budget.reserveSeconds() takes the larger of this and the project
// policy's floor.  (Lane: machine.)

/** Assumed upload throughput for a final save, bytes per second (conservative: 20 MB/s). */
export const FINAL_SAVE_BYTES_PER_SECOND = 20_000_000;
/** Fixed time on top: stopping the member's processes (10 s), walking and hashing the tree, committing. */
export const FINAL_SAVE_FIXED_SECONDS = 60;
/** The most this estimate asks for, whatever the agent reports (an hour: about 70 GB at the assumed rate). */
export const FINAL_SAVE_MAX_SECONDS = 3600;

/**
 * Seconds to reserve for a final save of `dirtyBytes` (bytes changed since the last save, as the agent reports in
 * its heartbeat).  The agent runs on a machine the member controls, so the figure is untrusted: anything not a
 * non-negative finite number gets the maximum, and every answer is capped.  A member who under-reports only puts
 * their own final save at risk (the last periodic snapshot stays); over-reporting only stops their machine sooner.
 */
export function finalSaveReserveSeconds(dirtyBytes: number): number {
  if (typeof dirtyBytes !== "number" || !Number.isFinite(dirtyBytes) || dirtyBytes < 0) return FINAL_SAVE_MAX_SECONDS;
  const seconds = FINAL_SAVE_FIXED_SECONDS + Math.ceil(dirtyBytes / FINAL_SAVE_BYTES_PER_SECOND);
  return Math.min(seconds, FINAL_SAVE_MAX_SECONDS);
}
