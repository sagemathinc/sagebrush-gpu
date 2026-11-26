// The API's objects, as they appear on the wire. Generic words throughout: a project
// can choose display labels ("course", "student"), but the API never uses them.

import type { BasisPoints, Micros, PriceSplit } from "./money.ts";
import type {
  AllocationId,
  CommandId,
  LedgerEntryId,
  MachineId,
  MemberId,
  OrgId,
  ProjectId,
  SnapshotId,
  TeamId,
  UserId,
} from "./ids.ts";
import type { IsoTime } from "./time.ts";
import type { CountryCode, GpuTypeId, ProviderId, StockLevel } from "./providers.ts";

// ---------------------------------------------------------------- roles

/** Project roles, lowest first. */
export const PROJECT_ROLES = ["member", "assistant", "manager", "owner"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** Organization roles, lowest first. Org owners own every project in the org. */
export const ORG_ROLES = ["viewer", "owner"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** True when `role` is at least `min` in the project role order. */
export function projectRoleAtLeast(role: ProjectRole, min: ProjectRole): boolean {
  return PROJECT_ROLES.indexOf(role) >= PROJECT_ROLES.indexOf(min);
}

export function orgRoleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return ORG_ROLES.indexOf(role) >= ORG_ROLES.indexOf(min);
}

// ---------------------------------------------------------------- users

export interface User {
  id: UserId;
  email: string;
  name: string | null;
  createdAt: IsoTime;
}

/** GET /v1/me: the user and their roles, so the UI can hide what the server would refuse. */
export interface Me {
  user: User;
  orgs: Array<{ orgId: OrgId; name: string; role: OrgRole }>;
  projects: Array<{ projectId: ProjectId; orgId: OrgId; name: string; role: ProjectRole; memberId: MemberId }>;
  /**
   * How long, in milliseconds from when the server answers, the user may still change an
   * organization's provider keys: the remaining life of their newest live, unused assurance
   * (verifyCredentialAssurance) for it, an integer from 0 to RECENT_AUTH_WINDOW_MS; null or
   * missing when they would have to sign in again and enter a code first. Anything that isn't
   * isRecentAuthForMs means the same. The page counts it from just before it sent the
   * request, so the window it shows never outlasts the server's.
   */
  recentAuthForMs?: number | null;
}

// ---------------------------------------------------------------- organizations

/**
 * How an organization pays for machines. "resold": our provider account, our margin, our
 * invoices. "byok": the organization's own provider account, so the provider bills it; our
 * ledger runs at margin 0, and its credit is a budget it grants itself rather than money
 * owed to us. (A byok organization pays a negotiated flat fee by contract, outside the
 * ledger; the ledger still enforces its members' budgets.)
 */
export const BILLING_MODES = ["resold", "byok"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export function isBillingMode(x: unknown): x is BillingMode {
  return typeof x === "string" && (BILLING_MODES as readonly string[]).includes(x);
}

export interface Organization {
  id: OrgId;
  name: string;
  /** Fixed when the organization is created. */
  billingMode: BillingMode;
  /** The default margin for its projects; negotiated per organization (3000 = 30%). */
  marginBps: BasisPoints;
  /** Credit bought and not yet assigned to a project. */
  unassignedCredit: Micros;
  /** All credit ever added, for the record. */
  totalCredit: Micros;
  createdAt: IsoTime;
}

// ---------------------------------------------------------------- projects

/**
 * Named sets of countries for where machines may run and data may live. "europe" is the
 * EU, the rest of the EEA (IS, LI, NO) and GB; "eu" is the EU only. The country sets
 * themselves are in @sbgpu/providers (localityFor).
 */
export const LOCALITY_PRESETS = ["any", "europe", "uk", "eu", "us", "ca"] as const;
export type LocalityPreset = (typeof LOCALITY_PRESETS)[number];

export interface ProjectPolicy {
  /** Empty means none: nothing can start until a manager allows a GPU type. */
  allowedGpuTypes: GpuTypeId[];
  allowedProviders: ProviderId[];
  locality: LocalityPreset;
  /** Extra restriction to these countries; null for no extra restriction. */
  allowedCountries: CountryCode[] | null;
  /** A cap on the total hourly price (provider + margin) per machine. */
  maxPricePerHour: Micros;
  maxConcurrentMachines: number;
  maxMachinesPerMember: number;
  idleStopMinutes: number;
  maxSessionMinutes: number;
  /** The least a start must be able to pay for, beyond the reserve. */
  minStartMinutes: number;
  /** At least this much running time is held back for the final save. */
  finalSaveReserveMinutes: number;
  /** Run on each new machine, e.g. "pip install peft datasets"; null for none. */
  setupScript: string | null;
  storageQuotaBytesPerMember: number;
  storageQuotaBytesPerTeam: number;
}

export const DEFAULT_POLICY: Readonly<ProjectPolicy> = Object.freeze({
  allowedGpuTypes: [],
  allowedProviders: [],
  locality: "any",
  allowedCountries: null,
  maxPricePerHour: 2_000_000,
  maxConcurrentMachines: 10,
  maxMachinesPerMember: 1,
  idleStopMinutes: 30,
  maxSessionMinutes: 8 * 60,
  minStartMinutes: 15,
  finalSaveReserveMinutes: 10,
  setupScript: null,
  storageQuotaBytesPerMember: 50 * 1024 ** 3,
  storageQuotaBytesPerTeam: 50 * 1024 ** 3,
});

/** Display words a project may choose; the API itself always uses the generic ones. */
export interface ProjectLabels {
  project: string;
  member: string;
  manager: string;
  assistant: string;
  team: string;
}

export interface Project {
  id: ProjectId;
  orgId: OrgId;
  /** The organization's (read-only here), so the project's pages can word prices without the org. */
  billingMode: BillingMode;
  name: string;
  labels: ProjectLabels | null;
  startsAt: IsoTime;
  endsAt: IsoTime;
  /** The project's margin; null means the organization's. */
  marginBpsOverride: BasisPoints | null;
  /** Credit assigned to the project from the organization. */
  budget: Micros;
  /** Of the budget, how much is given out as allocations. */
  allocated: Micros;
  /** Total charged so far, across all allocations. */
  spent: PriceSplit;
  policy: ProjectPolicy;
  createdAt: IsoTime;
}

// ---------------------------------------------------------------- members and teams

export const MEMBER_STATUSES = ["invited", "active", "removed"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface Member {
  id: MemberId;
  projectId: ProjectId;
  /** Null until the invitation is accepted. */
  userId: UserId | null;
  email: string;
  name: string | null;
  role: ProjectRole;
  status: MemberStatus;
  teamId: TeamId | null;
  allocationId: AllocationId;
  createdAt: IsoTime;
}

export interface Team {
  id: TeamId;
  projectId: ProjectId;
  name: string;
  /** How many members (not removed) the team has; list them with listMembers?teamId=. */
  memberCount: number;
  allocationId: AllocationId;
  createdAt: IsoTime;
}

// ---------------------------------------------------------------- allocations and spend

export type AllocationHolder = { kind: "member"; memberId: MemberId } | { kind: "team"; teamId: TeamId };

/** A sub-budget. Each machine is charged to exactly one allocation, chosen at start. */
export interface Allocation {
  id: AllocationId;
  projectId: ProjectId;
  holder: AllocationHolder;
  /** The amount granted (total price, provider + margin). */
  amount: Micros;
  updatedAt: IsoTime;
}

/** The spend meter for one allocation. remaining = amount - spent.total - reserved. */
export interface SpendMeter {
  allocationId: AllocationId;
  holder: AllocationHolder;
  amount: Micros;
  spent: PriceSplit;
  /** Held back for the final save of running machines. */
  reserved: Micros;
  remaining: Micros;
  /** The sum over this allocation's running machines. */
  currentRatePerHour: PriceSplit;
  storage: { usedBytes: number; quotaBytes: number };
  /** The last ledger minute included. */
  asOf: IsoTime;
}

export const LEDGER_ENTRY_KINDS = ["compute", "storage", "egress", "adjustment"] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** One ledger row. Compute entries are per machine per minute, and idempotent on that pair. */
export interface LedgerEntry {
  id: LedgerEntryId;
  orgId: OrgId;
  projectId: ProjectId;
  allocationId: AllocationId;
  kind: LedgerEntryKind;
  machineId: MachineId | null;
  provider: ProviderId | null;
  /** The start of the period charged (a UTC minute for compute). */
  periodStart: IsoTime;
  seconds: number;
  /** The provider's rate when the entry was made. */
  providerCostPerHour: Micros | null;
  marginBps: BasisPoints;
  amount: PriceSplit;
  note: string | null;
  createdAt: IsoTime;
}

/** GET /v1/projects/:projectId/spend.csv?by=... */
export const SPEND_CSV_GROUPINGS = ["member", "team", "day"] as const;
export type SpendCsvGrouping = (typeof SPEND_CSV_GROUPINGS)[number];

// ---------------------------------------------------------------- prices and quotes

/** A GPU type as a member sees it in a project: the cheapest allowed offer's price. */
export interface PriceListItem {
  gpuType: GpuTypeId;
  gpuCount: number;
  gpuMemoryGb: number;
  /** Per hour, provider + margin, for the cheapest allowed offer with stock. */
  pricePerHour: PriceSplit | null;
  stock: StockLevel;
}

export interface PricedOffer {
  provider: ProviderId;
  gpuType: GpuTypeId;
  gpuCount: number;
  dataCenter: string;
  country: CountryCode;
  pricePerHour: PriceSplit;
  stock: StockLevel;
}

/**
 * In precedence order: when several apply, a quote reports the first. "policy" covers a
 * GPU type, provider or locality the project doesn't allow, and chargeTo "team" without a
 * team allocation. "credentialUnusable": offers on a provider whose organization key is
 * paused (see ProviderPause) are dropped, and every allowed offer was dropped that way; it
 * comes before "noCapacity" because it says why no offers remain.
 */
export const QUOTE_REFUSALS = [
  "projectNotStarted",
  "projectEnded",
  "policy",
  "priceCap",
  "credentialUnusable",
  "noCapacity",
  "concurrencyCap",
  "allocationTooLow",
] as const;
export type QuoteRefusal = (typeof QUOTE_REFUSALS)[number];

export interface QuoteRequest {
  gpuType: GpuTypeId;
  gpuCount?: number;
  /** Charge a team's allocation instead of the member's own. */
  chargeTo?: "member" | "team";
}

export interface Quote {
  gpuType: GpuTypeId;
  gpuCount: number;
  /** Allowed offers, cheapest first; placement tries them in this order. */
  offers: PricedOffer[];
  allocationId: AllocationId | null;
  remaining: Micros;
  /** What a start needs at the cheapest offer: minStartMinutes plus the final-save reserve. */
  requiredToStart: Micros | null;
  canStart: boolean;
  /** Set exactly when canStart is false. */
  reason?: QuoteRefusal;
  /**
   * Set exactly when reason is "credentialUnusable": the paused provider, the first in
   * PROVIDER_IDS order when several are.
   */
  reasonProvider?: ProviderId;
}

// ---------------------------------------------------------------- machines

export const MACHINE_STATES = ["starting", "running", "saving", "stopping", "stopped", "failed", "deleted"] as const;
/**
 * starting: placed and booting. running: the agent is enrolled. saving: the final save
 * before a stop (a "Save now" while running shows only in `save`). stopping: the
 * provider is stopping it. stopped: no provider cost accrues. failed: it never started
 * or the provider lost it. deleted: gone, kept for the record.
 */
export type MachineState = (typeof MACHINE_STATES)[number];

/** Allowed transitions; anything else is a bug or a race to refuse. */
export const MACHINE_TRANSITIONS: Readonly<Record<MachineState, readonly MachineState[]>> = Object.freeze({
  starting: ["running", "stopping", "failed"],
  running: ["saving", "stopping", "failed"],
  saving: ["stopping", "failed"],
  stopping: ["stopped", "failed"],
  stopped: ["starting", "deleted"],
  failed: ["stopping", "deleted"],
  deleted: [],
});

export function canTransition(from: MachineState, to: MachineState): boolean {
  return MACHINE_TRANSITIONS[from].includes(to);
}

/** States in which the provider may be charging us, so the ledger accrues. */
export const ACCRUING_STATES: readonly MachineState[] = ["starting", "running", "saving", "stopping"];

export const STOP_REASONS = [
  "user",
  "idle",
  "maxSession",
  "budget",
  "watchdog",
  "provider",
  "manager",
  "projectEnded",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface SaveStatus {
  state: "idle" | "saving" | "failed";
  lastSavedAt: IsoTime | null;
  progress: { bytesDone: number; bytesTotal: number } | null;
  error: string | null;
  snapshotId: SnapshotId | null;
}

export interface Machine {
  id: MachineId;
  projectId: ProjectId;
  /** The member who started it. */
  memberId: MemberId;
  /** The one allocation it is charged to. */
  allocationId: AllocationId;
  gpuType: GpuTypeId;
  gpuCount: number;
  provider: ProviderId;
  dataCenter: string;
  pricePerHour: PriceSplit;
  state: MachineState;
  /** Increments on every start; machine-scoped tokens of an older incarnation are dead. */
  incarnation: number;
  /** Set once it has stopped (or failed). */
  stopReason: StopReason | null;
  /** True when it stopped before the final save was confirmed. */
  finalSaveIncomplete: boolean;
  save: SaveStatus;
  /** Charged so far by this machine. */
  spent: PriceSplit;
  createdAt: IsoTime;
  startedAt: IsoTime | null;
  stoppedAt: IsoTime | null;
  /** When the max session length stops it, if it is still running. */
  maxSessionEndsAt: IsoTime | null;
  /** Running only: get a page token (POST .../session) to open these through the relay. */
  terminalAvailable: boolean;
  jupyterAvailable: boolean;
  error: string | null;
}

export interface StartMachineRequest {
  gpuType: GpuTypeId;
  gpuCount?: number;
  chargeTo?: "member" | "team";
  /** Refuse if the best offer is above this total per hour (the member saw a quote). */
  maxPricePerHour?: Micros;
}

export interface StopMachineRequest {
  /** Default true: save first, then stop. A manager may skip the save. */
  save?: boolean;
}

export interface MachineSession {
  token: string;
  relayUrl: string;
  expiresAt: IsoTime;
}

// ---------------------------------------------------------------- agent

export const AGENT_MODES = ["container", "vm"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/**
 * The machine asserts no provider: control knows it from the boot token's record (the
 * launch bound it), and the launcher can't know it.
 */
export interface AgentEnrollRequest {
  bootToken: string;
  agentVersion: string;
  /** Lowercase hex SHA-256 of the agent; must equal the pin control put in this launch. */
  agentSha256: string;
  /**
   * VM mode: absent. The VM can't know its provider instance id (its boot script is rendered
   * before the create), so control uses the id bound to the boot token's launch, and refuses a
   * request that carries one. Container mode: as the container design says.
   */
  providerMachineId?: string | null;
  mode: AgentMode;
  /**
   * The launcher's credential-eradication checks. In container mode, enroll is refused
   * and the machine terminated unless ok is true. There is no re-enroll in container mode.
   */
  eradication: { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
  gpu: { name: string; count: number; memoryMiB: number } | null;
  hostname: string;
  /** VM mode only (and required there): the second gate run's report, canonical (see parseGateReport). */
  gate?: VmGateReport;
}

/**
 * The VM gate's failure words: a closed list, the same as the gate's own (vmgate.WORDS),
 * pinned by a shared fixture that both sides test against. Sorted.
 */
export const VM_GATE_WORDS = [
  "agent-active", "authorized-keys", "config-drive", "console-login", "container-runtime", "credential-shape",
  "gate-budget", "imds", "known-value", "listener-22", "listener-loopback", "listener-public", "mount-crossing",
  "password", "process", "process-churn", "provider-agent", "ssh-running", "ssh-unit", "sudo", "unreadable", "user-session",
] as const;
export type VmGateWord = (typeof VM_GATE_WORDS)[number];

/**
 * What the gate printed, as the machine reports it: the machine's own claim about its
 * in-guest state, never evidence against a hostile guest.
 */
export interface VmGateReport {
  v: 1;
  pass: boolean;
  fail: VmGateWord[];
}

/**
 * The report if it is canonical, else null: exactly the keys v, pass and fail; v is 1;
 * fail is sorted, without duplicates, every word known; pass is true exactly when fail is
 * empty. So one report has one spelling. (An array has no such keys; a longer `fail` than the
 * vocabulary can't be sorted, distinct and known.)
 */
export function parseGateReport(x: unknown): VmGateReport | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "fail,pass,v") return null;
  if (o.v !== 1 || typeof o.pass !== "boolean" || !Array.isArray(o.fail)) return null;
  const fail = o.fail as unknown[];
  for (let i = 0; i < fail.length; i++) {
    const w = fail[i];
    if (typeof w !== "string" || !(VM_GATE_WORDS as readonly string[]).includes(w)) return null;
    if (i > 0 && !((fail[i - 1] as string) < w)) return null;
  }
  if (o.pass !== (fail.length === 0)) return null;
  return { v: 1, pass: o.pass, fail: [...fail] as VmGateWord[] };
}

/**
 * VM mode (draft 5): the launcher's one announce, from the VM's own IPv4, after its local
 * gate. Exactly these keys. A refusal of any kind is one fixed 403; a second announce
 * terminates the machine.
 */
export interface AgentAnnounceRequest {
  machineId: MachineId;
  /** The launch's single-use nonce (16 random bytes, base64url, from user_data). */
  nonce: string;
  /** SHA-256 (lowercase hex) of the exact UTF-8 bytes of the VM-mode boot script the VM received. */
  bootScriptSha256: string;
}
export const ANNOUNCE_NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface AgentAnnounceResponse {
  /** Single use, for enroll, within 120 s. */
  bootToken: string;
  expiresAt: IsoTime;
}

/** Closed list: the machine never sends free text here. */
export const AGENT_ABORT_REASONS = ["env-not-clean", "extra-process", "key-file", "other"] as const;
export type AgentAbortReason = (typeof AGENT_ABORT_REASONS)[number];

/** Uses up the boot token; control terminates the machine at once. */
export interface AgentAbortRequest {
  bootToken: string;
  reason: AgentAbortReason;
}

export interface AgentEnrollResponse {
  machineId: MachineId;
  agentToken: string;
  agentTokenExpiresAt: IsoTime;
  incarnation: number;
  relayUrl: string;
  heartbeatSeconds: number;
  idle: { minutes: number; gpuUtilThresholdPct: number };
  maxSessionEndsAt: IsoTime;
  setupScript: string | null;
  workspace: { restore: boolean };
}

export const AGENT_COMMAND_OPS = ["save", "stop", "stop-after-save", "revoke"] as const;
export type AgentCommandOp = (typeof AGENT_COMMAND_OPS)[number];

export interface AgentCommand {
  id: CommandId;
  op: AgentCommandOp;
}

export interface AgentHeartbeatRequest {
  incarnation: number;
  uptimeS: number;
  activity: {
    lastTerminalInputAt: IsoTime | null;
    lastJupyterActivityAt: IsoTime | null;
    gpuUtilPct: number | null;
    gpuMemUsedMiB: number | null;
  };
  idleSince: IsoTime | null;
  save: SaveStatus & { dirtyBytes: number };
}

export interface AgentHeartbeatResponse {
  /** A fresh agent token, sent before the current one expires. */
  agentToken?: string;
  agentTokenExpiresAt?: IsoTime;
  commands: AgentCommand[];
}

export interface AgentWorkspaceTokenResponse {
  token: string;
  expiresAt: IsoTime;
  gatewayUrl: string;
}

export interface AgentSaveStatusRequest {
  incarnation: number;
  /** The command this answers, or null for a periodic save. */
  commandId: CommandId | null;
  save: SaveStatus;
}
