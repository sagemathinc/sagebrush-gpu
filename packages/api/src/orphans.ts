// The orphan report: every provider machine whose name starts with "sbg-", in our accounts
// and in each organization's own (BYOK), and what the sweep did with it. The sweep runs
// only in the scheduled job; operators read its stored report, and getOrphanReport (a
// system route) only reads it too.
//
// The sweep decides by the launch record, never by accrual or ledger state. A row binds
// to a launch row by "providerId" (launches.(provider, provider_machine_id), unique) or,
// failing that, by "launchIntent" (a launch row with no provider id yet, of the same
// provider, machine and incarnation as the parsed name, which must be this
// installation's). Either binding also needs the launch's account to equal the account
// that listed the row: a launch made with our credential binds only to a platform listing,
// one made with an organization's key only to that exact organization's listing. The
// launch's account (its kind and exact org id) is pinned on the launch row at intent and
// immutable after: it is never derived from the machine's or project's current owner,
// since machines and projects can move. A launch with no pinned account can't be proven
// and never binds. In this order, first match wins:
//   1. unparsed name: reportOnly "unparsed", or "nameMismatch" when a providerId binds it
//   2. another installation's: reportOnly "otherInstallation", or "nameMismatch" likewise
//   3. a providerId binding whose machine or incarnation differs from the name: "nameMismatch"
//   4. no binding: reportOnly "accountUnproven" when the same lookup without the account
//      finds a launch whose account can't be proven, "accountMismatch" when it finds one
//      in another account, and "unbound" otherwise
//   5. bound to an incarnation below the machine's current one: terminate, "staleIncarnation"
//   6. bound to a 'terminated' launch row: terminate, "launchTerminated"
//   7. otherwise: kept "launchActive" (its watchdog owns it)
// Only 5 and 6 terminate, so a launch still in progress (even one whose create reply is in
// flight) is never terminated here.

import type { Micros } from "./money.ts";
import type { MachineId, OrgId } from "./ids.ts";
import type { IsoTime } from "./time.ts";
import type { MachineState } from "./objects.ts";
import type { ProviderId } from "./providers.ts";

/** The launch record's outcomes (control's launches.outcome), in lifecycle order. */
export const LAUNCH_RECORD_OUTCOMES = Object.freeze(["creating", "launched", "issued", "enrolled", "terminate", "terminated"] as const);
export type LaunchRecordOutcome = (typeof LAUNCH_RECORD_OUTCOMES)[number];

export const ORPHAN_BINDINGS = Object.freeze(["providerId", "launchIntent", "none"] as const);
export type OrphanBinding = (typeof ORPHAN_BINDINGS)[number];

export const ORPHAN_REPORT_ONLY_REASONS = Object.freeze([
  "unparsed",
  "otherInstallation",
  "nameMismatch",
  "accountUnproven",
  "accountMismatch",
  "unbound",
] as const);
export type OrphanReportOnlyReason = (typeof ORPHAN_REPORT_ONLY_REASONS)[number];

export const ORPHAN_TERMINATE_CAUSES = Object.freeze(["staleIncarnation", "launchTerminated"] as const);
export type OrphanTerminateCause = (typeof ORPHAN_TERMINATE_CAUSES)[number];

/** Fixed codes only: never the provider's text, and nothing about a key. */
export const ORPHAN_FAILURES = Object.freeze(["credentialUnusable", "providerError", "timeout"] as const);
export type OrphanFailure = (typeof ORPHAN_FAILURES)[number];

/** Whose provider account a machine was found in (the credential that listed it): ours, or an organization's own key. */
export type OrphanAccount = { kind: "platform" } | { kind: "org"; orgId: OrgId };

export interface OrphanCoverage {
  provider: ProviderId;
  account: OrphanAccount;
  listed: "ok" | "failed";
  /** Set exactly when listed is "failed". */
  failure?: OrphanFailure;
}

export type OrphanSweepResult =
  | { action: "kept"; reason: "launchActive" }
  | { action: "reportOnly"; reason: OrphanReportOnlyReason }
  | { action: "terminated"; at: IsoTime; because: OrphanTerminateCause }
  | { action: "terminateFailed"; at: IsoTime; because: OrphanTerminateCause; failure: OrphanFailure; nextAttemptAt: IsoTime };

export interface OrphanRow {
  provider: ProviderId;
  account: OrphanAccount;
  /** Provider-controlled, like rawName: bounded, and never rendered as HTML. */
  providerMachineId: string;
  /** The provider-side name as listed (it starts with "sbg-"). */
  rawName: string;
  /** null when the name doesn't parse. */
  parsed: { installation: string; machineId: MachineId; incarnation: number } | null;
  binding: OrphanBinding;
  /** The bound launch row; null exactly when binding is "none". */
  launch: { incarnation: number; outcome: LaunchRecordOutcome; currentIncarnation: number } | null;
  /** The bound machine's ledger state, for the reader only: the sweep never decides by it. */
  ledgerState: MachineState | null;
  firstSeenAt: IsoTime;
  /** The provider's listed cost; null when the provider doesn't say. */
  providerCostPerHour: Micros | null;
  sweep: OrphanSweepResult;
}

export interface OrphanReport {
  /** This deployment's installation slug. */
  installation: string;
  /** When the sweep that produced this report started and finished. */
  startedAt: IsoTime;
  finishedAt: IsoTime;
  /** One entry per (provider, account) listed: a failed listing makes the report partial, never clean. */
  coverage: OrphanCoverage[];
  rows: OrphanRow[];
}
