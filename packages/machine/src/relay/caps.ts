// The relay's caps table (DESIGN.md section 4): every limit the relay enforces, in one place, read by its code and
// listed in the PR body for LIMITS.  Kept apart from relay.ts so the Worker's routes don't import the Durable Object.

/** The page channels a machine serves (an allowlist: anything else is refused at the hello). */
export type Chan = "terminal";
export const CHANNELS: readonly Chan[] = Object.freeze(["terminal"]);

/** Per channel: how many page legs at once, each message's cap each way, and a receiver's window. */
export const CHANNEL_CAPS: Readonly<Record<Chan, { legs: number; pageToPeer: number; peerToPage: number; window: number }>> = Object.freeze({
  // (as Sagebrush's runner terminal: 4 legs, 64 KiB messages, a 1 MiB window per page)
  terminal: Object.freeze({ legs: 4, pageToPeer: 65_536, peerToPage: 65_536, window: 1024 * 1024 }),
});

export const RELAY_LIMITS = Object.freeze({
  // ---- legs
  /** Page legs on a machine at once, all channels together (the sum of the channel caps). */
  pages: 4,
  /** Legs accepted but not yet authenticated (both kinds together): past this, a new upgrade is refused 429. */
  pending: 4,
  /** A leg must authenticate (its hello) within this long, ... */
  helloMs: 10_000,
  /** ... in one message of at most this many bytes (the hello carries a token of at most 4,096 characters). */
  helloBytes: 4_608,
  /** Upgrade attempts per machine: a durable bucket, this many a minute, ... */
  attemptsPerMinute: 30,
  /** ... with this burst. */
  attemptsBurst: 30,
  // ---- the wire
  /** A control message's most bytes. */
  control: 256,
  /** The generation prefix's most bytes (16 digits and the newline). */
  prefix: 17,
  /** Receipts outstanding per receiver connection. */
  tokens: 16,
  /** Bytes sent to a receiver between receipts (at most a quarter of its window). */
  receiptEvery: 256 * 1024,
  /** What each message sent to a receiver is charged on top of its bytes (so empty and small ones count). */
  overhead: 256,
  /** The peer leg's window as a receiver (all its pages' messages to it). */
  peerWindow: 8 * 1024 * 1024,
  // ---- rates
  /** Messages per second per leg, from the leg's own bucket (its attachment, so it survives hibernation), ... */
  legRate: 120,
  /** ... with this burst. */
  legBurst: 200,
  /** Bytes per second through the whole machine (every message to every receiver: data, controls, receipts and the
   * revoke notice, each counted with its overhead): one machine-wide bucket, which neither a reconnect nor a restart
   * refills, ... */
  machineBytesPerSecond: 4 * 1024 * 1024,
  /** ... with this burst. */
  machineBytesBurst: 16 * 1024 * 1024,
  /** Credit moves from the stored bucket to memory in reservations of this many ms of the rate (or what one message
   * needs, if more): each is written to storage before any of it is spent, so a restart can only lose credit (the
   * reservation's unspent rest, at most 1 MiB), never get it back.  At most about 4 writes a second at full rate. */
  machineReserveMs: 250,
  // ---- liveness and single use
  /** A leg with no valid ping for this long is closed. */
  deadMs: 40_000,
  /** Used page-token ids kept (each until its own expiry): past this many unexpired, a hello is refused. */
  usedJtis: 10_000,
});

/** Close codes. */
export const CLOSE = Object.freeze({
  closedByPeer: 4000, // a page the agent ended
  peerGone: 4001, // a page whose agent left
  rate: 4008, // a leg over its message rate
  replaced: 4009, // a leg replaced by a newer one
  forbidden: 4403, // refused or revoked
  machineRate: 4429, // the machine over its byte rate
});
