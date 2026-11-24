// An in-memory stand-in for the control plane, for UI development and tests. It speaks
// the @sbgpu/api contract (routes, access rules, objects, error codes) and simulates time
// with a fake clock: machines boot, save, stop and accrue per-minute ledger entries, and
// the budget rules of @sbgpu/api's budget.ts stop them. It is not the control plane: the
// real rules live there, and the mock follows them only as far as the UI needs.
//
// As the control plane does (contract answers, Nov 24): a caller with no role in a project
// gets notFound and one with too low a role forbidden; allocations may not add up to more
// than the project budget (conflict); member changes follow @sbgpu/api's authz. Mock-only:
// pages are never split (next is always null), and a removed member's allocation still
// counts toward the budget.

import {
  ACCRUING_STATES,
  DEFAULT_POLICY,
  ERROR_STATUS,
  ID_ALPHABET,
  ID_PREFIXES,
  ID_RANDOM_LENGTH,
  ROUTES,
  SPEND_CSV_GROUPINGS,
  addSplits,
  canInvite,
  canRemoveMember,
  canTransition,
  canUpdateMember,
  entrySplit,
  errorBody,
  isGpuTypeId,
  isIsoTime,
  isNonNegativeMicros,
  matchRoute,
  meterRemaining,
  minuteStart,
  orgRoleAtLeast,
  priceSplit,
  projectRoleAtLeast,
  requiredToStart,
  reserveCharge,
  reserveSeconds,
  shouldHardStop,
  toIso,
  type Allocation,
  type BasisPoints,
  type EndpointName,
  type Endpoints,
  type ErrorCode,
  type IdKind,
  type LedgerEntry,
  type Machine,
  type MachineState,
  type Me,
  type Member,
  type MembershipDecision,
  type MeteredMachine,
  type Micros,
  type Offer,
  type Organization,
  type OrgRole,
  type PriceListItem,
  type PriceSplit,
  type PricedOffer,
  type Project,
  type ProjectPolicy,
  type ProjectRole,
  type Quote,
  type QuoteRefusal,
  type SpendCsvGrouping,
  type SpendMeter,
  type StopReason,
  type Team,
  type User,
} from "@sbgpu/api";
import { isEmail } from "../emails.ts";
import { toCsv, type CsvValue } from "../csv.ts";

// ---------------------------------------------------------------- simulation constants

/** How often the mock's metering check runs (the ledger accrues and hard stops happen). */
export const CHECK_INTERVAL_SECONDS = 60;
/** The slack the budget rules add for a late check or a slow provider stop. */
export const SAFETY_SECONDS = 60;
export const BOOT_SECONDS = 90;
export const PROVIDER_STOP_SECONDS = 15;
/** Each save uploads this much, at SAVE_BYTES_PER_SECOND. */
export const SAVE_BYTES = 120 * 1024 * 1024;
export const SAVE_BYTES_PER_SECOND = 20 * 1024 * 1024;
export const PAGE_TOKEN_SECONDS = 60;

/** Mock-only country sets for the locality presets; the real table is @sbgpu/providers' localityFor. */
const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
const LOCALITY_COUNTRIES: Record<ProjectPolicy["locality"], readonly string[] | null> = {
  any: null,
  europe: [...EU, "IS", "LI", "NO", "GB"],
  uk: ["GB"],
  eu: EU,
  us: ["US"],
  ca: ["CA"],
};

/** GPU memory per type, for the price list (mock data). */
export const GPU_MEMORY_GB: Readonly<Record<string, number>> = { L4: 24, A10: 24, A6000: 48, "A100-80GB": 80, H100: 80 };

const ZERO: PriceSplit = Object.freeze({ providerCost: 0, margin: 0, total: 0 });

function metered(rec: { m: Machine; marginBps: BasisPoints }): MeteredMachine {
  return { providerCostPerHour: rec.m.pricePerHour.providerCost, marginBps: rec.marginBps };
}

/** An authz refusal as an API error. */
function enforce(decision: MembershipDecision, what: string): void {
  if (decision.ok) return;
  if (decision.reason === "lastOwner") throw new ApiFail("conflict", `${what}: the project must keep an owner`);
  if (decision.reason === "badInput") throw new ApiFail("badRequest", `${what}: invalid role`);
  throw new ApiFail("forbidden", `${what}: not allowed for your role`);
}

// ---------------------------------------------------------------- errors and responses

export class ApiFail extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MockResponse {
  status: number;
  contentType: "application/json" | "text/csv";
  body: unknown;
}

// ---------------------------------------------------------------- internal records

interface MachineRec {
  m: Machine;
  /** When the current timed state (starting, stopping) ends, ms. */
  timerEnd: number | null;
  /** The ledger has charged this machine up to here, ms; null when not accruing. */
  accruedUntil: number | null;
  marginBps: BasisPoints;
}

interface OrgRoleRec {
  orgId: string;
  userId: string;
  role: OrgRole;
}

type Handler<N extends EndpointName> = (req: {
  params: Endpoints[N]["params"];
  query: Endpoints[N]["query"];
  body: Endpoints[N]["body"];
  user: User | null;
}) => Endpoints[N]["response"];

// ---------------------------------------------------------------- the backend

export interface MockBackendOptions {
  /** The fake clock's start, ms since the epoch; a whole minute keeps ledger entries whole. */
  startMs?: number;
}

export class MockBackend {
  #now: number;
  #idCounter = 0;
  #tokenCounter = 0;
  readonly users = new Map<string, User>();
  readonly orgs = new Map<string, Organization>();
  readonly orgRoles: OrgRoleRec[] = [];
  readonly projects = new Map<string, Project>();
  readonly members = new Map<string, Member>();
  readonly teams = new Map<string, Team>();
  readonly allocations = new Map<string, Allocation>();
  readonly machines = new Map<string, MachineRec>();
  readonly ledger: LedgerEntry[] = [];
  readonly storageUsed = new Map<string, number>();
  offers: Offer[] = [];
  /** The signed-in user; the mock's stand-in for the session cookie. */
  currentUserId: string | null = null;

  constructor(options: MockBackendOptions = {}) {
    this.#now = options.startMs ?? Date.parse("2027-02-01T09:00:00.000Z");
  }

  // ---------------------------------------------------------------- clock

  now(): number {
    return this.#now;
  }

  /** Move the fake clock forward, simulating each second. */
  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0 || ms % 1000 !== 0) {
      throw new RangeError(`advance takes whole non-negative seconds in ms, got ${ms}`);
    }
    const end = this.#now + ms;
    while (this.#now < end) {
      this.#now += 1000;
      this.#tick();
    }
  }

  // ---------------------------------------------------------------- ids

  /** Deterministic, well-formed ids (a counter in the id alphabet). */
  newId(kind: IdKind): string {
    let n = ++this.#idCounter;
    let body = "";
    while (n > 0) {
      body = ID_ALPHABET[n % 32] + body;
      n = Math.floor(n / 32);
    }
    return `${ID_PREFIXES[kind]}_${body.padStart(ID_RANDOM_LENGTH, "0")}`;
  }

  // ---------------------------------------------------------------- setup helpers (seeding and tests)

  addUser(email: string, name: string | null = null): User {
    const user: User = { id: this.newId("user"), email: email.toLowerCase(), name, createdAt: toIso(this.#now) };
    this.users.set(user.id, user);
    return user;
  }

  addOrg(name: string, marginBps: BasisPoints, credit: Micros): Organization {
    const org: Organization = {
      id: this.newId("org"),
      name,
      marginBps,
      unassignedCredit: credit,
      totalCredit: credit,
      createdAt: toIso(this.#now),
    };
    this.orgs.set(org.id, org);
    return org;
  }

  setOrgRole(orgId: string, userId: string, role: OrgRole): void {
    const existing = this.orgRoles.find((r) => r.orgId === orgId && r.userId === userId);
    if (existing) existing.role = role;
    else this.orgRoles.push({ orgId, userId, role });
  }

  addProject(
    orgId: string,
    init: { name: string; budget: Micros; startsAt: string; endsAt: string; policy?: Partial<ProjectPolicy>; labels?: Project["labels"] },
  ): Project {
    const org = this.#org(orgId);
    if (init.budget > org.unassignedCredit) throw new ApiFail("budgetExhausted", "not enough unassigned credit");
    org.unassignedCredit -= init.budget;
    const project: Project = {
      id: this.newId("project"),
      orgId,
      name: init.name,
      labels: init.labels ?? null,
      startsAt: init.startsAt,
      endsAt: init.endsAt,
      marginBpsOverride: null,
      budget: init.budget,
      allocated: 0,
      spent: ZERO,
      policy: { ...DEFAULT_POLICY, ...init.policy },
      createdAt: toIso(this.#now),
    };
    this.projects.set(project.id, project);
    return project;
  }

  addMember(
    projectId: string,
    init: { email: string; name?: string | null; role?: ProjectRole; allocation?: Micros; userId?: string | null },
  ): Member {
    const allocationId = this.newId("allocation");
    const member: Member = {
      id: this.newId("member"),
      projectId,
      userId: init.userId ?? null,
      email: init.email.toLowerCase(),
      name: init.name ?? null,
      role: init.role ?? "member",
      status: init.userId ? "active" : "invited",
      teamId: null,
      allocationId,
      createdAt: toIso(this.#now),
    };
    this.members.set(member.id, member);
    this.allocations.set(allocationId, {
      id: allocationId,
      projectId,
      holder: { kind: "member", memberId: member.id },
      amount: init.allocation ?? 0,
      updatedAt: toIso(this.#now),
    });
    return member;
  }

  addTeam(projectId: string, name: string, memberIds: string[], allocation: Micros): Team {
    for (const id of memberIds) this.#member(projectId, id);
    const allocationId = this.newId("allocation");
    const team: Team = { id: this.newId("team"), projectId, name, memberIds: [], allocationId, createdAt: toIso(this.#now) };
    this.teams.set(team.id, team);
    this.allocations.set(allocationId, {
      id: allocationId,
      projectId,
      holder: { kind: "team", teamId: team.id },
      amount: allocation,
      updatedAt: toIso(this.#now),
    });
    this.#setTeamMembers(team, memberIds);
    return team;
  }

  /** Test hook: the agent reports the machine idle; it saves and stops. */
  markIdle(machineId: string): void {
    this.#beginStop(this.#machine(machineId), "idle", true);
  }

  /** Test hook: the provider loses the machine. It stops accruing at once. */
  failMachine(machineId: string, error: string): void {
    const rec = this.#machine(machineId);
    this.#accrue(rec, this.#now);
    rec.accruedUntil = null;
    rec.timerEnd = null;
    this.#setState(rec, "failed");
    Object.assign(rec.m, {
      stopReason: "provider",
      error,
      stoppedAt: toIso(this.#now),
      terminalAvailable: false,
      jupyterAvailable: false,
      save: { ...rec.m.save, state: rec.m.save.state === "saving" ? "failed" : rec.m.save.state, progress: null },
    });
  }

  // ---------------------------------------------------------------- dispatch

  /** Handle one request as the current user. Never throws: errors become API error bodies. */
  request(method: string, path: string, query: Record<string, string>, body: unknown): MockResponse {
    const match = matchRoute(method, path);
    if (match == null) return this.#error("notFound", `no route for ${method} ${path}`);
    try {
      const user = this.currentUserId ? (this.users.get(this.currentUserId) ?? null) : null;
      this.#checkAccess(match.name, match.params, user);
      const handler = this.#handlers[match.name] as Handler<EndpointName> | undefined;
      if (handler == null) throw new ApiFail("internal", `${match.name} is not in the mock`);
      const result = handler({ params: match.params as never, query: query as never, body: (body ?? {}) as never, user });
      if (match.name === "getSpendCsv") return { status: 200, contentType: "text/csv", body: result };
      return { status: 200, contentType: "application/json", body: structuredClone(result) };
    } catch (err) {
      if (err instanceof ApiFail) return this.#error(err.code, err.message);
      return this.#error("internal", String(err));
    }
  }

  #error(code: ErrorCode, message: string): MockResponse {
    return { status: ERROR_STATUS[code], contentType: "application/json", body: errorBody(code, message) };
  }

  // ---------------------------------------------------------------- access

  #checkAccess(name: EndpointName, params: Record<string, string>, user: User | null): void {
    const access = ROUTES[name].access;
    if (access.auth === "public") return;
    if (access.auth === "agent" || access.auth === "system") throw new ApiFail("forbidden", `${name} is not for browser sessions`);
    if (user == null) throw new ApiFail("unauthenticated", "sign in first");
    if (access.scope === "none") return;
    if (access.scope === "org") {
      const role = this.#orgRole(params.orgId ?? "", user.id);
      if (role == null) throw new ApiFail("notFound", "no such organization");
      if (!orgRoleAtLeast(role, access.minRole)) throw new ApiFail("forbidden", `needs org role ${access.minRole}`);
      return;
    }
    let projectId: string;
    if (access.scope === "machine") {
      const rec = this.machines.get(params.machineId ?? "");
      if (rec == null || rec.m.state === "deleted") throw new ApiFail("notFound", "no such machine");
      projectId = rec.m.projectId;
    } else {
      projectId = params.projectId ?? "";
    }
    const role = this.#projectRole(projectId, user.id);
    if (role == null) throw new ApiFail("notFound", access.scope === "machine" ? "no such machine" : "no such project");
    if (!projectRoleAtLeast(role, access.minRole)) throw new ApiFail("forbidden", `needs project role ${access.minRole}`);
    if (access.scope === "machine" && role === "member") {
      // A member acts only on their own machines; others' are invisible to them.
      const rec = this.#machine(params.machineId ?? "");
      if (rec.m.memberId !== this.#callerMember(projectId, user.id)?.id) throw new ApiFail("notFound", "no such machine");
    }
  }

  #orgRole(orgId: string, userId: string): OrgRole | null {
    return this.orgRoles.find((r) => r.orgId === orgId && r.userId === userId)?.role ?? null;
  }

  #callerMember(projectId: string, userId: string): Member | null {
    for (const m of this.members.values()) {
      if (m.projectId === projectId && m.userId === userId && m.status !== "removed") return m;
    }
    return null;
  }

  /** The caller's role in a project: owner for an org owner, otherwise their membership's. */
  #projectRole(projectId: string, userId: string): ProjectRole | null {
    const project = this.projects.get(projectId);
    if (project == null) return null;
    if (this.#orgRole(project.orgId, userId) === "owner") return "owner";
    return this.#callerMember(projectId, userId)?.role ?? null;
  }

  #requireRole(projectId: string, user: User | null, min: ProjectRole, what: string): void {
    const role = user ? this.#projectRole(projectId, user.id) : null;
    if (role == null || !projectRoleAtLeast(role, min)) throw new ApiFail("forbidden", `${what} needs project role ${min}`);
  }

  // ---------------------------------------------------------------- lookups

  #org(id: string): Organization {
    const org = this.orgs.get(id);
    if (org == null) throw new ApiFail("notFound", "no such organization");
    return org;
  }

  #project(id: string): Project {
    const project = this.projects.get(id);
    if (project == null) throw new ApiFail("notFound", "no such project");
    return project;
  }

  #machine(id: string): MachineRec {
    const rec = this.machines.get(id);
    if (rec == null || rec.m.state === "deleted") throw new ApiFail("notFound", "no such machine");
    return rec;
  }

  #member(projectId: string, id: string): Member {
    const member = this.members.get(id);
    if (member == null || member.projectId !== projectId) throw new ApiFail("notFound", "no such member");
    return member;
  }

  #team(projectId: string, id: string): Team {
    const team = this.teams.get(id);
    if (team == null || team.projectId !== projectId) throw new ApiFail("notFound", "no such team");
    return team;
  }

  #marginBps(project: Project): BasisPoints {
    return project.marginBpsOverride ?? this.#org(project.orgId).marginBps;
  }

  #projectView(project: Project): Project {
    let allocated = 0;
    for (const a of this.allocations.values()) if (a.projectId === project.id) allocated += a.amount;
    const spent = addSplits(...this.ledger.filter((e) => e.projectId === project.id).map((e) => e.amount));
    return { ...project, allocated, spent };
  }

  #allocationSpent(allocationId: string): PriceSplit {
    return addSplits(...this.ledger.filter((e) => e.allocationId === allocationId).map((e) => e.amount));
  }

  #accruingOn(allocationId: string): MachineRec[] {
    return [...this.machines.values()].filter((r) => r.m.allocationId === allocationId && ACCRUING_STATES.includes(r.m.state));
  }

  /** Seconds since the last ledger minute was billed: the metering check bills every minute. */
  #unbilledSeconds(): number {
    return Math.ceil((this.#now - minuteStart(this.#now)) / 1000);
  }

  #reserveSeconds(project: Project): number {
    return reserveSeconds(project.policy.finalSaveReserveMinutes, 0);
  }

  #meter(allocation: Allocation): SpendMeter {
    const project = this.#project(allocation.projectId);
    const spent = this.#allocationSpent(allocation.id);
    const accruing = this.#accruingOn(allocation.id);
    const reserved = reserveCharge(accruing.map(metered), this.#reserveSeconds(project));
    const quotaBytes =
      allocation.holder.kind === "member" ? project.policy.storageQuotaBytesPerMember : project.policy.storageQuotaBytesPerTeam;
    return {
      allocationId: allocation.id,
      holder: allocation.holder,
      amount: allocation.amount,
      spent,
      reserved,
      remaining: meterRemaining(allocation.amount, spent.total, reserved),
      currentRatePerHour: addSplits(...accruing.map((r) => r.m.pricePerHour)),
      storage: { usedBytes: this.storageUsed.get(allocation.id) ?? 0, quotaBytes },
      asOf: toIso(minuteStart(this.#now)),
    };
  }

  // ---------------------------------------------------------------- quotes

  #allowedOffers(project: Project, gpuType: string, gpuCount: number): PricedOffer[] {
    const policy = project.policy;
    const countries = LOCALITY_COUNTRIES[policy.locality];
    const marginBps = this.#marginBps(project);
    return this.offers
      .filter(
        (o) =>
          o.gpuType === gpuType &&
          o.gpuCount === gpuCount &&
          policy.allowedProviders.includes(o.provider) &&
          (countries == null || countries.includes(o.country)) &&
          (policy.allowedCountries == null || policy.allowedCountries.includes(o.country)),
      )
      .map((o) => ({
        provider: o.provider,
        gpuType: o.gpuType,
        gpuCount: o.gpuCount,
        dataCenter: o.dataCenter,
        country: o.country,
        pricePerHour: priceSplit(o.providerCostPerHour, marginBps),
        stock: o.stock,
      }))
      .sort((a, b) => a.pricePerHour.total - b.pricePerHour.total || a.provider.localeCompare(b.provider));
  }

  #chargeAllocation(project: Project, member: Member, chargeTo: "member" | "team"): Allocation | null {
    if (chargeTo === "member") return this.allocations.get(member.allocationId) ?? null;
    if (member.teamId == null) return null;
    const team = this.teams.get(member.teamId);
    return team && team.projectId === project.id ? (this.allocations.get(team.allocationId) ?? null) : null;
  }

  /** The quote for `member` starting `gpuType`, refused with the first reason that applies. */
  #quote(project: Project, member: Member, gpuType: string, gpuCount: number, chargeTo: "member" | "team"): Quote {
    const allocation = this.#chargeAllocation(project, member, chargeTo);
    const allowed = project.policy.allowedGpuTypes.includes(gpuType) ? this.#allowedOffers(project, gpuType, gpuCount) : [];
    const underCap = allowed.filter((o) => o.pricePerHour.total <= project.policy.maxPricePerHour);
    const withStock = underCap.filter((o) => o.stock !== "none");
    const cheapest = withStock[0] ?? null;
    let required: Micros | null = null;
    let unspent = 0;
    if (allocation && cheapest) {
      unspent = allocation.amount - this.#allocationSpent(allocation.id).total;
      required = requiredToStart({
        unspent,
        newMachine: { providerCostPerHour: cheapest.pricePerHour.providerCost, marginBps: this.#marginBps(project) },
        running: this.#accruingOn(allocation.id).map(metered),
        unbilledSeconds: this.#unbilledSeconds(),
        minStartMinutes: project.policy.minStartMinutes,
        checkIntervalSeconds: CHECK_INTERVAL_SECONDS,
        safetySeconds: SAFETY_SECONDS,
        reserveSeconds: this.#reserveSeconds(project),
      });
    }
    const accruing = [...this.machines.values()].filter((r) => r.m.projectId === project.id && ACCRUING_STATES.includes(r.m.state));
    let reason: QuoteRefusal | null = null;
    if (this.#now < Date.parse(project.startsAt)) reason = "projectNotStarted";
    else if (this.#now >= Date.parse(project.endsAt)) reason = "projectEnded";
    else if (allowed.length === 0 || allocation == null) reason = "policy";
    else if (underCap.length === 0) reason = "priceCap";
    else if (withStock.length === 0) reason = "noCapacity";
    else if (
      accruing.length >= project.policy.maxConcurrentMachines ||
      accruing.filter((r) => r.m.memberId === member.id).length >= project.policy.maxMachinesPerMember
    )
      reason = "concurrencyCap";
    else if (required == null || unspent < required) reason = "allocationTooLow";
    const quote: Quote = {
      gpuType,
      gpuCount,
      offers: withStock.length > 0 ? withStock : underCap.length > 0 ? underCap : allowed,
      allocationId: allocation?.id ?? null,
      remaining: allocation ? this.#meter(allocation).remaining : 0,
      requiredToStart: required,
      canStart: reason == null,
    };
    if (reason != null) quote.reason = reason;
    return quote;
  }

  // ---------------------------------------------------------------- machines

  #setState(rec: MachineRec, to: MachineState): void {
    if (!canTransition(rec.m.state, to)) throw new ApiFail("invalidState", `machine is ${rec.m.state}, cannot become ${to}`);
    rec.m.state = to;
  }

  #placeAndBoot(rec: MachineRec, offer: PricedOffer): void {
    rec.m.provider = offer.provider;
    rec.m.dataCenter = offer.dataCenter;
    rec.m.pricePerHour = offer.pricePerHour;
    rec.timerEnd = this.#now + BOOT_SECONDS * 1000;
    rec.accruedUntil = this.#now;
  }

  #toStopping(rec: MachineRec): void {
    this.#setState(rec, "stopping");
    rec.timerEnd = this.#now + PROVIDER_STOP_SECONDS * 1000;
  }

  /** Stop a machine, saving first when asked and there's anything to save. */
  #beginStop(rec: MachineRec, reason: StopReason, save: boolean): void {
    const m = rec.m;
    if (m.state === "starting" || m.state === "failed") {
      this.#toStopping(rec);
    } else if (m.state === "running" && save) {
      this.#setState(rec, "saving");
      m.save = { ...m.save, state: "saving", progress: { bytesDone: 0, bytesTotal: SAVE_BYTES }, error: null };
      rec.timerEnd = null;
    } else if (m.state === "running" || (m.state === "saving" && !save)) {
      this.#toStopping(rec);
      m.finalSaveIncomplete = true;
      m.save = { ...m.save, state: "idle", progress: null };
    } else {
      return; // already saving, stopping, stopped or deleted
    }
    if (m.stopReason == null) m.stopReason = reason;
    m.terminalAvailable = false;
    m.jupyterAvailable = false;
  }

  /** Charge the machine's allocation up to `until`, one ledger entry per UTC minute. */
  #accrue(rec: MachineRec, until: number): void {
    while (rec.accruedUntil != null && rec.accruedUntil < until) {
      const from = rec.accruedUntil;
      const to = Math.min(minuteStart(from) + 60_000, until);
      const seconds = Math.ceil((to - from) / 1000);
      const amount = entrySplit(rec.m.pricePerHour.providerCost, seconds, rec.marginBps);
      const project = this.#project(rec.m.projectId);
      this.ledger.push({
        id: this.newId("ledgerEntry"),
        orgId: project.orgId,
        projectId: project.id,
        allocationId: rec.m.allocationId,
        kind: "compute",
        machineId: rec.m.id,
        provider: rec.m.provider,
        periodStart: toIso(minuteStart(from)),
        seconds,
        providerCostPerHour: rec.m.pricePerHour.providerCost,
        marginBps: rec.marginBps,
        amount,
        note: null,
        createdAt: toIso(this.#now),
      });
      rec.m.spent = addSplits(rec.m.spent, amount);
      rec.accruedUntil = to;
    }
  }

  /** One second of upload; true when the save is complete. */
  #advanceSave(rec: MachineRec): boolean {
    const progress = rec.m.save.progress;
    if (progress == null) return true;
    const bytesDone = Math.min(progress.bytesTotal, progress.bytesDone + SAVE_BYTES_PER_SECOND);
    if (bytesDone < progress.bytesTotal) {
      rec.m.save = { ...rec.m.save, progress: { bytesDone, bytesTotal: progress.bytesTotal } };
      return false;
    }
    rec.m.save = { ...rec.m.save, state: "idle", progress: null, lastSavedAt: toIso(this.#now), snapshotId: this.newId("snapshot") };
    return true;
  }

  #tick(): void {
    const t = this.#now;
    for (const rec of this.machines.values()) {
      const m = rec.m;
      if (m.state === "starting" && rec.timerEnd != null && t >= rec.timerEnd) {
        this.#setState(rec, "running");
        rec.timerEnd = null;
        m.startedAt = toIso(t);
        m.maxSessionEndsAt = toIso(t + this.#project(m.projectId).policy.maxSessionMinutes * 60_000);
        m.terminalAvailable = true;
        m.jupyterAvailable = true;
      } else if (m.state === "running") {
        if (m.save.state === "saving") this.#advanceSave(rec);
        if (m.maxSessionEndsAt != null && t >= Date.parse(m.maxSessionEndsAt)) this.#beginStop(rec, "maxSession", true);
      } else if (m.state === "saving") {
        if (this.#advanceSave(rec)) this.#toStopping(rec);
      } else if (m.state === "stopping" && rec.timerEnd != null && t >= rec.timerEnd) {
        this.#accrue(rec, t);
        rec.accruedUntil = null;
        rec.timerEnd = null;
        this.#setState(rec, "stopped");
        m.stoppedAt = toIso(t);
        m.maxSessionEndsAt = null;
      }
    }
    if (t % (CHECK_INTERVAL_SECONDS * 1000) === 0) this.#meteringCheck(t);
  }

  /** The scheduled job: accrue every accruing machine, then stop what the rules say to. */
  #meteringCheck(t: number): void {
    for (const rec of this.machines.values()) this.#accrue(rec, t);
    for (const project of this.projects.values()) {
      if (t < Date.parse(project.endsAt)) continue;
      for (const rec of this.machines.values()) {
        if (rec.m.projectId === project.id) this.#beginStop(rec, "projectEnded", true);
      }
    }
    for (const allocation of this.allocations.values()) {
      const accruing = this.#accruingOn(allocation.id);
      if (accruing.length === 0) continue;
      const stop = shouldHardStop({
        unspent: allocation.amount - this.#allocationSpent(allocation.id).total,
        machines: accruing.map(metered),
        unbilledSeconds: this.#unbilledSeconds(),
        checkIntervalSeconds: CHECK_INTERVAL_SECONDS,
        safetySeconds: SAFETY_SECONDS,
        reserveSeconds: this.#reserveSeconds(this.#project(allocation.projectId)),
      });
      if (stop) for (const rec of accruing) this.#beginStop(rec, "budget", true);
    }
  }

  // ---------------------------------------------------------------- spend CSV

  #spendCsv(project: Project, by: SpendCsvGrouping): string {
    // Exact: a safe integer over 1e6, printed to 6 places, parses back to the nearest double.
    const usd = (micros: Micros): number => Number((micros / 1_000_000).toFixed(6));
    const rows: CsvValue[][] = [];
    if (by === "member") {
      rows.push(["email", "name", "team", "allocation_usd", "provider_cost_usd", "margin_usd", "total_usd", "remaining_usd"]);
      for (const m of this.members.values()) {
        const a = this.allocations.get(m.allocationId);
        if (m.projectId !== project.id || a == null) continue;
        const meter = this.#meter(a);
        const team = m.teamId ? (this.teams.get(m.teamId)?.name ?? null) : null;
        rows.push([m.email, m.name, team, usd(a.amount), usd(meter.spent.providerCost), usd(meter.spent.margin), usd(meter.spent.total), usd(meter.remaining)]);
      }
    } else if (by === "team") {
      rows.push(["team", "members", "allocation_usd", "provider_cost_usd", "margin_usd", "total_usd", "remaining_usd"]);
      for (const team of this.teams.values()) {
        const a = this.allocations.get(team.allocationId);
        if (team.projectId !== project.id || a == null) continue;
        const meter = this.#meter(a);
        rows.push([team.name, team.memberIds.length, usd(a.amount), usd(meter.spent.providerCost), usd(meter.spent.margin), usd(meter.spent.total), usd(meter.remaining)]);
      }
    } else {
      rows.push(["date_utc", "provider_cost_usd", "margin_usd", "total_usd"]);
      const byDay = new Map<string, PriceSplit>();
      for (const e of this.ledger) {
        if (e.projectId !== project.id) continue;
        const day = e.periodStart.slice(0, 10);
        byDay.set(day, addSplits(byDay.get(day) ?? ZERO, e.amount));
      }
      for (const [day, s] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
        rows.push([day, usd(s.providerCost), usd(s.margin), usd(s.total)]);
      }
    }
    return toCsv(rows);
  }

  // ---------------------------------------------------------------- teams and allocations

  /** Make `memberIds` exactly the team's members; a member is in at most one team. */
  #setTeamMembers(team: Team, memberIds: string[]): void {
    const ids = [...new Set(memberIds)];
    for (const id of ids) this.#member(team.projectId, id);
    for (const m of this.members.values()) {
      if (m.teamId === team.id && !ids.includes(m.id)) m.teamId = null;
    }
    for (const id of ids) {
      const m = this.#member(team.projectId, id);
      if (m.teamId != null && m.teamId !== team.id) {
        const old = this.teams.get(m.teamId);
        if (old) old.memberIds = old.memberIds.filter((x) => x !== id);
      }
      m.teamId = team.id;
    }
    team.memberIds = ids;
  }

  /** Refuse (conflict) when the project's allocations would add up to more than its budget. */
  #checkAllocatable(projectId: string, added: Micros, replacing: string | null = null): void {
    let total = added;
    for (const a of this.allocations.values()) {
      if (a.projectId === projectId && a.id !== replacing) total += a.amount;
    }
    const budget = this.#project(projectId).budget;
    if (total > budget) throw new ApiFail("conflict", `allocations would add up to more than the budget (${total} > ${budget} micro-USD)`);
  }

  #setAllocation(allocationId: string, amount: unknown): Allocation {
    if (!isNonNegativeMicros(amount)) throw new ApiFail("badRequest", "amount must be non-negative micros");
    const allocation = this.allocations.get(allocationId) as Allocation;
    this.#checkAllocatable(allocation.projectId, amount, allocation.id);
    allocation.amount = amount;
    allocation.updatedAt = toIso(this.#now);
    return allocation;
  }

  /** The caller's effective role; access checks have already made sure there is one. */
  #actor(projectId: string, user: User | null): ProjectRole {
    const role = user ? this.#projectRole(projectId, user.id) : null;
    if (role == null) throw new ApiFail("forbidden", "no role in this project");
    return role;
  }

  #ownerCount(projectId: string): number {
    let n = 0;
    for (const m of this.members.values()) if (m.projectId === projectId && m.status !== "removed" && m.role === "owner") n++;
    return n;
  }

  #requireOwnMachine(rec: MachineRec, user: User | null): void {
    if (user == null || this.#callerMember(rec.m.projectId, user.id)?.id !== rec.m.memberId) {
      throw new ApiFail("forbidden", "only the machine's own member can open it");
    }
  }

  #me(user: User): Me {
    const orgs = this.orgRoles
      .filter((r) => r.userId === user.id)
      .map((r) => ({ orgId: r.orgId, name: this.#org(r.orgId).name, role: r.role }));
    const projects: Me["projects"] = [];
    for (const m of this.members.values()) {
      if (m.userId !== user.id || m.status === "removed") continue;
      const p = this.#project(m.projectId);
      projects.push({ projectId: p.id, orgId: p.orgId, name: p.name, role: this.#projectRole(p.id, user.id) ?? m.role, memberId: m.id });
    }
    return { user, orgs, projects };
  }

  // ---------------------------------------------------------------- handlers

  readonly #handlers: { [N in EndpointName]?: Handler<N> } = {
    requestSignInLink: () => ({ ok: true }),

    verifySignInLink: ({ body }) => {
      // The mock's sign-in token is "mock:<email>".
      const token = typeof body.token === "string" ? body.token : "";
      const email = token.startsWith("mock:") ? token.slice(5).toLowerCase() : "";
      if (!isEmail(email)) throw new ApiFail("unauthenticated", "invalid or expired sign-in link");
      const user = [...this.users.values()].find((u) => u.email === email) ?? this.addUser(email);
      for (const m of this.members.values()) {
        if (m.email === email && m.status === "invited") {
          m.userId = user.id;
          m.status = "active";
        }
      }
      this.currentUserId = user.id;
      return this.#me(user);
    },

    signOut: () => {
      this.currentUserId = null;
      return { ok: true };
    },

    getMe: ({ user }) => this.#me(user as User),

    getOrg: ({ params }) => this.#org(params.orgId),

    listProjects: ({ params }) => ({
      items: [...this.projects.values()].filter((p) => p.orgId === params.orgId).map((p) => this.#projectView(p)),
      next: null,
    }),

    getProject: ({ params }) => this.#projectView(this.#project(params.projectId)),

    updateProject: ({ params, body }) => {
      const project = this.#project(params.projectId);
      if (body.startsAt !== undefined && !isIsoTime(body.startsAt)) throw new ApiFail("badRequest", "startsAt must be an ISO time");
      if (body.endsAt !== undefined && !isIsoTime(body.endsAt)) throw new ApiFail("badRequest", "endsAt must be an ISO time");
      if (body.policy?.maxPricePerHour !== undefined && !isNonNegativeMicros(body.policy.maxPricePerHour)) {
        throw new ApiFail("badRequest", "maxPricePerHour must be non-negative micros");
      }
      if (body.name !== undefined) project.name = body.name;
      if (body.startsAt !== undefined) project.startsAt = body.startsAt;
      if (body.endsAt !== undefined) project.endsAt = body.endsAt;
      if (body.labels !== undefined) project.labels = body.labels;
      if (body.policy !== undefined) project.policy = { ...project.policy, ...body.policy };
      return this.#projectView(project);
    },

    listMembers: ({ params }) => ({
      items: [...this.members.values()].filter((m) => m.projectId === params.projectId),
      next: null,
    }),

    inviteMembers: ({ params, body, user }) => {
      if (!Array.isArray(body.members)) throw new ApiFail("badRequest", "members must be a list");
      for (const inv of body.members) {
        if (typeof inv.email !== "string" || !isEmail(inv.email.toLowerCase())) throw new ApiFail("badRequest", `invalid email: ${inv.email}`);
        if (inv.allocation !== undefined && !isNonNegativeMicros(inv.allocation)) throw new ApiFail("badRequest", "allocation must be non-negative micros");
        enforce(canInvite(this.#actor(params.projectId, user), inv.role ?? "member"), "invite");
        if (inv.teamId !== undefined) this.#team(params.projectId, inv.teamId);
      }
      this.#checkAllocatable(params.projectId, body.members.reduce((sum, inv) => sum + (inv.allocation ?? 0), 0));
      const out: Member[] = [];
      for (const inv of body.members) {
        const email = inv.email.toLowerCase();
        const existing = [...this.members.values()].find((m) => m.projectId === params.projectId && m.email === email && m.status !== "removed");
        if (existing) {
          out.push(existing);
          continue;
        }
        const known = [...this.users.values()].find((u) => u.email === email);
        const member = this.addMember(params.projectId, {
          email,
          name: inv.name ?? null,
          role: inv.role ?? "member",
          allocation: inv.allocation ?? 0,
          userId: known?.id ?? null,
        });
        if (inv.teamId !== undefined) {
          const team = this.#team(params.projectId, inv.teamId);
          this.#setTeamMembers(team, [...team.memberIds, member.id]);
        }
        out.push(member);
      }
      return { members: out };
    },

    updateMember: ({ params, body, user }) => {
      const member = this.#member(params.projectId, params.memberId);
      if (member.status === "removed") throw new ApiFail("notFound", "no such member");
      enforce(canUpdateMember(this.#actor(params.projectId, user), member.role, body.role, this.#ownerCount(params.projectId)), "update member");
      if (body.teamId != null) this.#team(params.projectId, body.teamId);
      if (body.role !== undefined) member.role = body.role;
      if (body.name !== undefined) member.name = body.name;
      if (body.teamId === null && member.teamId != null) {
        const old = this.#team(params.projectId, member.teamId);
        this.#setTeamMembers(old, old.memberIds.filter((x) => x !== member.id));
      } else if (body.teamId != null) {
        const team = this.#team(params.projectId, body.teamId);
        this.#setTeamMembers(team, [...team.memberIds, member.id]);
      }
      return member;
    },

    removeMember: ({ params, user }) => {
      const member = this.#member(params.projectId, params.memberId);
      if (member.status === "removed") throw new ApiFail("notFound", "no such member");
      enforce(canRemoveMember(this.#actor(params.projectId, user), member.role, this.#ownerCount(params.projectId)), "remove member");
      member.status = "removed";
      for (const rec of this.machines.values()) {
        if (rec.m.memberId === member.id) this.#beginStop(rec, "manager", true);
      }
      return { ok: true };
    },

    setMemberAllocation: ({ params, body }) =>
      this.#setAllocation(this.#member(params.projectId, params.memberId).allocationId, body.amount),

    listTeams: ({ params, user }) => {
      const teams = [...this.teams.values()].filter((t) => t.projectId === params.projectId);
      const userId = (user as User).id;
      if (this.#projectRole(params.projectId, userId) === "member") {
        const own = this.#callerMember(params.projectId, userId)?.teamId ?? null;
        return { teams: teams.filter((t) => t.id === own) };
      }
      return { teams };
    },

    createTeam: ({ params, body }) => {
      if (typeof body.name !== "string" || body.name.trim() === "") throw new ApiFail("badRequest", "a team needs a name");
      if (body.allocation !== undefined && !isNonNegativeMicros(body.allocation)) throw new ApiFail("badRequest", "allocation must be non-negative micros");
      this.#checkAllocatable(params.projectId, body.allocation ?? 0);
      return this.addTeam(params.projectId, body.name.trim(), body.memberIds ?? [], body.allocation ?? 0);
    },

    updateTeam: ({ params, body }) => {
      const team = this.#team(params.projectId, params.teamId);
      if (body.name !== undefined) team.name = body.name;
      if (body.memberIds !== undefined) this.#setTeamMembers(team, body.memberIds);
      return team;
    },

    deleteTeam: ({ params }) => {
      const team = this.#team(params.projectId, params.teamId);
      if (this.#accruingOn(team.allocationId).length > 0) throw new ApiFail("invalidState", "the team has running machines");
      this.#setTeamMembers(team, []);
      this.teams.delete(team.id);
      return { ok: true };
    },

    setTeamAllocation: ({ params, body }) =>
      this.#setAllocation(this.#team(params.projectId, params.teamId).allocationId, body.amount),

    listGpuTypes: ({ params }) => {
      const project = this.#project(params.projectId);
      const items: PriceListItem[] = project.policy.allowedGpuTypes.map((gpuType) => {
        const offers = this.#allowedOffers(project, gpuType, 1).filter((o) => o.pricePerHour.total <= project.policy.maxPricePerHour);
        const best = offers.find((o) => o.stock !== "none") ?? null;
        return {
          gpuType,
          gpuCount: 1,
          gpuMemoryGb: GPU_MEMORY_GB[gpuType] ?? 0,
          pricePerHour: best?.pricePerHour ?? null,
          stock: best?.stock ?? "none",
        };
      });
      return { items, asOf: toIso(this.#now) };
    },

    quote: ({ params, body, user }) => {
      const project = this.#project(params.projectId);
      if (!isGpuTypeId(body.gpuType)) throw new ApiFail("badRequest", "invalid gpuType");
      const member = this.#callerMember(project.id, (user as User).id);
      if (member == null) throw new ApiFail("forbidden", "only members of the project can start machines");
      return this.#quote(project, member, body.gpuType, body.gpuCount ?? 1, body.chargeTo ?? "member");
    },

    getSpend: ({ params, user }) => {
      const userId = (user as User).id;
      let allocations = [...this.allocations.values()].filter((a) => a.projectId === params.projectId);
      if (this.#projectRole(params.projectId, userId) === "member") {
        const me = this.#callerMember(params.projectId, userId);
        const team = me?.teamId ? this.teams.get(me.teamId) : undefined;
        allocations = allocations.filter((a) => a.id === me?.allocationId || a.id === team?.allocationId);
      }
      return { meters: allocations.map((a) => this.#meter(a)), asOf: toIso(minuteStart(this.#now)) };
    },

    getSpendCsv: ({ params, query }) => {
      if (!(SPEND_CSV_GROUPINGS as readonly string[]).includes(query.by)) throw new ApiFail("badRequest", "by must be member, team or day");
      return this.#spendCsv(this.#project(params.projectId), query.by);
    },

    listLedger: ({ params }) => ({ items: this.ledger.filter((e) => e.projectId === params.projectId), next: null }),

    listMachines: ({ params, query, user }) => {
      const all = query.all === "1";
      if (all) this.#requireRole(params.projectId, user, "assistant", "listing all machines");
      const me = this.#callerMember(params.projectId, (user as User).id);
      const items = [...this.machines.values()]
        .map((r) => r.m)
        .filter((m) => m.projectId === params.projectId && m.state !== "deleted" && (all || m.memberId === me?.id));
      return { items, next: null };
    },

    startMachine: ({ params, body, user }) => {
      const project = this.#project(params.projectId);
      if (!isGpuTypeId(body.gpuType)) throw new ApiFail("badRequest", "invalid gpuType");
      const member = this.#callerMember(project.id, (user as User).id);
      if (member == null) throw new ApiFail("forbidden", "only members of the project can start machines");
      const gpuCount = body.gpuCount ?? 1;
      const quote = this.#quote(project, member, body.gpuType, gpuCount, body.chargeTo ?? "member");
      const offer = quote.offers[0];
      if (!quote.canStart || quote.allocationId == null || offer == null) {
        throw new ApiFail(quote.reason ?? "policy", `cannot start: ${quote.reason}`);
      }
      if (body.maxPricePerHour !== undefined && offer.pricePerHour.total > body.maxPricePerHour) {
        throw new ApiFail("priceCap", "the price is now above what you accepted");
      }
      const rec: MachineRec = {
        m: {
          id: this.newId("machine"),
          projectId: project.id,
          memberId: member.id,
          allocationId: quote.allocationId,
          gpuType: body.gpuType,
          gpuCount,
          provider: offer.provider,
          dataCenter: offer.dataCenter,
          pricePerHour: offer.pricePerHour,
          state: "starting",
          incarnation: 1,
          stopReason: null,
          finalSaveIncomplete: false,
          save: { state: "idle", lastSavedAt: null, progress: null, error: null, snapshotId: null },
          spent: ZERO,
          createdAt: toIso(this.#now),
          startedAt: null,
          stoppedAt: null,
          maxSessionEndsAt: null,
          terminalAvailable: false,
          jupyterAvailable: false,
          error: null,
        },
        timerEnd: null,
        accruedUntil: null,
        marginBps: this.#marginBps(project),
      };
      this.#placeAndBoot(rec, offer);
      this.machines.set(rec.m.id, rec);
      return rec.m;
    },

    stopAllMachines: ({ params, body, user }) => {
      const save = body.save ?? true;
      if (!save) this.#requireRole(params.projectId, user, "manager", "stopping without a save");
      const stopping: string[] = [];
      for (const rec of this.machines.values()) {
        if (rec.m.projectId !== params.projectId || !ACCRUING_STATES.includes(rec.m.state)) continue;
        this.#beginStop(rec, "manager", save);
        stopping.push(rec.m.id);
      }
      return { stopping };
    },

    getMachine: ({ params }) => this.#machine(params.machineId).m,

    stopMachine: ({ params, body, user }) => {
      const rec = this.#machine(params.machineId);
      const save = body.save ?? true;
      if (!save) this.#requireRole(rec.m.projectId, user, "manager", "stopping without a save");
      const own = this.#callerMember(rec.m.projectId, (user as User).id)?.id === rec.m.memberId;
      this.#beginStop(rec, own ? "user" : "manager", save);
      return rec.m;
    },

    restartMachine: ({ params }) => {
      const rec = this.#machine(params.machineId);
      if (rec.m.state !== "stopped") throw new ApiFail("invalidState", `machine is ${rec.m.state}`);
      const project = this.#project(rec.m.projectId);
      const member = this.#member(project.id, rec.m.memberId);
      const allocation = this.allocations.get(rec.m.allocationId) as Allocation;
      const quote = this.#quote(project, member, rec.m.gpuType, rec.m.gpuCount, allocation.holder.kind);
      const offer = quote.offers[0];
      if (!quote.canStart || offer == null) throw new ApiFail(quote.reason ?? "policy", `cannot start: ${quote.reason}`);
      this.#setState(rec, "starting");
      Object.assign(rec.m, {
        incarnation: rec.m.incarnation + 1,
        stopReason: null,
        finalSaveIncomplete: false,
        error: null,
        startedAt: null,
        stoppedAt: null,
      });
      this.#placeAndBoot(rec, offer);
      return rec.m;
    },

    saveMachine: ({ params }) => {
      const rec = this.#machine(params.machineId);
      if (rec.m.state !== "running") throw new ApiFail("invalidState", `machine is ${rec.m.state}`);
      if (rec.m.save.state !== "saving") {
        rec.m.save = { ...rec.m.save, state: "saving", progress: { bytesDone: 0, bytesTotal: SAVE_BYTES }, error: null };
      }
      return rec.m;
    },

    deleteMachine: ({ params }) => {
      const rec = this.#machine(params.machineId);
      this.#setState(rec, "deleted");
      return { ok: true };
    },

    openMachineSession: ({ params, user }) => {
      const rec = this.#machine(params.machineId);
      this.#requireOwnMachine(rec, user);
      if (rec.m.state !== "running") throw new ApiFail("invalidState", "the machine is not running");
      return {
        token: `mock-page-${++this.#tokenCounter}`,
        relayUrl: "wss://mock.invalid/api/relay/v1/page",
        expiresAt: toIso(this.#now + PAGE_TOKEN_SECONDS * 1000),
      };
    },

    openJupyterLink: ({ params, user }) => {
      const rec = this.#machine(params.machineId);
      this.#requireOwnMachine(rec, user);
      if (rec.m.state !== "running") throw new ApiFail("invalidState", "the machine is not running");
      return {
        url: `https://m-${rec.m.id}.mock.invalid/?code=mock-${++this.#tokenCounter}`,
        expiresAt: toIso(this.#now + PAGE_TOKEN_SECONDS * 1000),
      };
    },
  };
}
