// The project page's polling loop, apart from the component so its lifecycle is tested
// with fake timers: one round at a time, never two in flight; a failed round backs off
// (bounded); a good round resets; it stops for good when stopped or when the session ends.

import type { Store } from "./store.ts";

export interface PollTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_TIMERS: PollTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const FIRST_BACKOFF_MS = 2_000;
export const MAX_BACKOFF_MS = 60_000;

/** The wait after `failures` failed rounds in a row (>= 1): 2 s, 4 s, 8 s ... at most 60 s. */
export function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(failures - 1, 30));
}

export interface PollingOptions {
  timers?: PollTimers;
  /** Skip rounds while this is false (a hidden tab); the loop keeps its schedule. */
  visible?: () => boolean;
}

/** Start polling `store`; returns stop(). */
export function startPolling(store: Store, options: PollingOptions = {}): () => void {
  const timers = options.timers ?? REAL_TIMERS;
  const visible = options.visible ?? (() => true);
  let stopped = false;
  let handle: unknown;
  let failures = 0;

  const schedule = (ms: number) => {
    if (!stopped) handle = timers.setTimeout(round, ms);
  };
  const round = async () => {
    handle = undefined;
    if (stopped) return;
    if (visible()) {
      let ok = false;
      try {
        ok = await store.poll();
      } catch {
        ok = false; // poll() never throws; this is belt and braces
      }
      failures = ok ? 0 : failures + 1;
    }
    // Signed out (here or in the round): the page goes away, and so does the loop.
    if (store.me.value == null) stopped = true;
    schedule(failures === 0 ? store.pollDelayMs() : backoffMs(failures));
  };

  schedule(store.pollDelayMs());
  return () => {
    stopped = true;
    if (handle !== undefined) timers.clearTimeout(handle);
    handle = undefined;
  };
}
