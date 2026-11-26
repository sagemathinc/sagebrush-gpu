// The UI's state: signals filled from the API, and the actions that change them. No DOM
// here, so the store is tested in Node against the mock backend.

import { batch, computed, signal } from "@preact/signals";
import {
  ACCRUING_STATES,
  projectRoleAtLeast,
  type Machine,
  type Me,
  type Organization,
  type Member,
  type Micros,
  type SpendCsvGrouping,
  type Team,
  type PriceListItem,
  type Project,
  type ProjectRole,
  type Quote,
  type SignInOutcome,
  type SpendMeter,
  type UpdateProjectRequest,
  type ProviderPause,
} from "@sbgpu/api";
import { ApiError, type Client, type FetchFn } from "../client.ts";
import { resolveLabels } from "../labels.ts";
import { jupyterUrl, pausedStartText } from "../view.ts";
import { terminalUrl } from "../terminal/session.ts";
import type { PollTimers } from "./polling.ts";
import { ProviderKeys, WINDOW_TIMERS } from "./provider-keys.ts";

export interface StoreOptions {
  /** The UI's own host (location.host); the terminal relay must be on it. */
  uiHost?: string;
  /** Demo build only: a local mock terminal to use instead of the relay. */
  devTerminal?: { url: string; token: string };
  /** Pages read per list per refresh (default MAX_LIST_PAGES); tests use a smaller cap. */
  maxListPages?: number;
  /** The provider keys' own request path (default: fetch), apart from the client's. */
  credentialFetch?: FetchFn;
  /** A monotonic clock, ms (default performance.now): the reauth window is measured on it. */
  monotonic?: () => number;
  /** The reauth window's timer (default the real one). */
  timers?: PollTimers;
}

/**
 * The most a list is read to, page by page (25 pages of 200): enough for any pilot-sized
 * project, and a bound on what one refresh can fetch. Past it the page says so.
 */
export const MAX_LIST_PAGES = 25;

/** Poll fast while something is changing, slowly otherwise. */
export const FAST_POLL_MS = 2_000;
export const SLOW_POLL_MS = 15_000;

export function isChanging(m: Machine): boolean {
  return m.state === "starting" || m.state === "saving" || m.state === "stopping" || m.save.state === "saving";
}

export class Store {
  readonly client: Client;
  /** The clock "now" is read from: Date.now, or the mock's fake clock. */
  readonly now: () => number;

  readonly me = signal<Me | null>(null);
  readonly meLoaded = signal(false);
  /** Why the sign-in screen is showing: a sign-in that didn't work, or a sign-out. */
  readonly signInNotice = signal<SignInOutcome | "signedOut" | null>(null);
  /** The last failed action's message, shown until dismissed or the next success. */
  readonly error = signal<string | null>(null);
  /** Keys of actions in flight ("start:L4", "stop:mch_..."), to disable their buttons. */
  readonly busy = signal<ReadonlySet<string>>(new Set());

  readonly projectId = signal<string | null>(null);
  readonly project = signal<Project | null>(null);
  /** The organization page's: the organization and its projects. */
  readonly orgId = signal<string | null>(null);
  readonly org = signal<Organization | null>(null);
  readonly orgProjects = signal<Project[]>([]);
  readonly meters = signal<SpendMeter[]>([]);
  readonly machines = signal<Machine[]>([]);
  readonly gpuTypes = signal<PriceListItem[]>([]);
  readonly quotes = signal<Readonly<Record<string, Quote>>>({});
  /** Providers whose launches are paused for the project's organization (the reason only for manager and above). */
  readonly paused = signal<ProviderPause[]>([]);
  /** Staff only (assistant and up): everyone in the project, its teams, and every machine. */
  readonly members = signal<Member[]>([]);
  readonly teams = signal<Team[]>([]);
  readonly allMachines = signal<Machine[]>([]);
  /** Lists cut at MAX_LIST_PAGES: "members", "machines" and "allMachines". */
  readonly truncated = signal<ReadonlySet<string>>(new Set());

  readonly membership = computed(() => this.me.value?.projects.find((p) => p.projectId === this.projectId.value) ?? null);
  readonly role = computed<ProjectRole | null>(() => this.membership.value?.role ?? null);
  readonly labels = computed(() => resolveLabels(this.project.value?.labels));
  /** How the project's organization pays for machines: the words for prices and spend follow it. */
  readonly billingMode = computed(() => this.project.value?.billingMode ?? "resold");
  readonly myMeter = computed(() => {
    const memberId = this.membership.value?.memberId;
    return this.meters.value.find((m) => m.holder.kind === "member" && m.holder.memberId === memberId) ?? null;
  });
  /** A member's team meter (members get only their own team's; others see every team's elsewhere). */
  readonly teamMeter = computed(() =>
    this.role.value === "member" ? (this.meters.value.find((m) => m.holder.kind === "team") ?? null) : null,
  );
  readonly activeMachines = computed(() => this.machines.value.filter((m) => ACCRUING_STATES.includes(m.state)));
  /** Assistants and up see the manager's pages; managers and owners can change things there. */
  readonly isStaff = computed(() => this.role.value != null && projectRoleAtLeast(this.role.value, "assistant"));
  readonly canManage = computed(() => this.role.value != null && projectRoleAtLeast(this.role.value, "manager"));

  /** Increments on every navigation (openProject, and any session change); results of older ones are dropped. */
  #generation = 0;
  /** Counts the organization's loads, so only the latest one publishes. */
  #orgLoad = 0;
  /** Increments when a session starts (sign-in): a 401 answers only the session it was asked in. */
  #sessionGeneration = 0;
  /** The banner message the last failed poll set, so a later good poll can clear it (and only it). */
  #pollError: string | null = null;

  readonly #options: StoreOptions;
  readonly #monotonic: () => number;
  /** An organization's provider keys (its owners', under byok): on the organization's page. */
  readonly keys: ProviderKeys;

  constructor(client: Client, now: () => number = Date.now, options: StoreOptions = {}) {
    this.client = client;
    this.now = now;
    this.#options = options;
    this.#monotonic = options.monotonic ?? (() => performance.now());
    this.keys = new ProviderKeys(
      options.credentialFetch ?? ((input, init) => fetch(input, init)),
      { monotonic: this.#monotonic, timers: options.timers ?? WINDOW_TIMERS },
      () => this.#endSession(),
    );
  }

  pollDelayMs(): number {
    return this.machines.value.some(isChanging) ? FAST_POLL_MS : SLOW_POLL_MS;
  }

  // ---------------------------------------------------------------- errors and busy keys

  /** Run an action: mark it busy, record its error, and clear a session that has ended. */
  async #act<T>(key: string, fn: () => Promise<T>, clearsError: (result: T) => boolean = () => true): Promise<T | null> {
    if (this.busy.value.has(key)) return null;
    const session = this.#sessionGeneration;
    const generation = this.#generation;
    this.busy.value = new Set([...this.busy.value, key]);
    try {
      const result = await fn();
      // A success that answers an earlier navigation or a replaced session is moot too: it
      // returns nothing (no link to open, no result to show) and leaves the banner alone.
      // (Every session change is also a navigation, so the one counter covers both.)
      if (generation !== this.#generation) return null;
      // (unless the success says it published nothing: an older refresh, superseded by
      // a newer one whose error must stay shown)
      if (clearsError(result)) this.error.value = null;
      return result;
    } catch (err) {
      // An answer for a session that has since been replaced (sign-out, sign-in) is moot:
      // neither its 401 nor its message may touch the new session.
      if (session !== this.#sessionGeneration) return null;
      if (err instanceof ApiError && err.code === "unauthenticated") this.#endSession();
      this.error.value =
        err instanceof ApiError && err.code === "credentialUnusable" ? pausedStartText(err.provider, err.message) : err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      const next = new Set(this.busy.value);
      next.delete(key);
      this.busy.value = next;
    }
  }

  /**
   * The session is over (signed out, or the server says unauthenticated): forget the user
   * and every protected object, and drop the results of anything still in flight.
   */
  #endSession(): void {
    this.#generation++;
    this.keys.endSession();
    batch(() => {
      this.me.value = null;
      this.meLoaded.value = true;
      this.projectId.value = null;
      this.project.value = null;
      this.meters.value = [];
      this.machines.value = [];
      this.gpuTypes.value = [];
      this.quotes.value = {};
      this.paused.value = [];
      this.members.value = [];
      this.teams.value = [];
      this.allMachines.value = [];
      this.orgId.value = null;
      this.org.value = null;
      this.orgProjects.value = [];
    });
  }

  isBusy(key: string): boolean {
    return this.busy.value.has(key);
  }

  // ---------------------------------------------------------------- session

  async loadMe(): Promise<void> {
    // (the reauth window counts from just before the request is sent, never from its answer)
    const sentAt = this.#monotonic();
    try {
      const me = await this.client.call("getMe");
      this.me.value = me;
      this.keys.setWindow(sentAt, me.recentAuthForMs);
    } catch (err) {
      this.keys.closeWindow();
      if (!(err instanceof ApiError && err.code === "unauthenticated")) {
        this.error.value = err instanceof Error ? err.message : String(err);
      }
      this.me.value = null;
    } finally {
      this.meLoaded.value = true;
    }
  }

  /**
   * A sign-in that happened outside the store (the demo's accounts; a real one reloads the
   * page): answers still owed to an older session (a 401 included) don't apply, then /me.
   */
  async sessionStarted(): Promise<void> {
    this.#generation++;
    this.#sessionGeneration++;
    this.signInNotice.value = null;
    await this.loadMe();
  }

  async signOut(): Promise<void> {
    const ok = await this.#act("signout", () => this.client.call("signOut", { body: {} }));
    this.#endSession();
    // Only this site's session ends; the person stays signed in to Sagebrush.
    if (ok != null) this.signInNotice.value = "signedOut";
  }

  // ---------------------------------------------------------------- organization

  /** Load an organization and its projects (for anyone with a role in it). */
  async openOrg(orgId: string): Promise<void> {
    if (this.orgId.value !== orgId) {
      batch(() => {
        this.orgId.value = orgId;
        this.org.value = null;
        this.orgProjects.value = [];
      });
    }
    const generation = ++this.#generation;
    await this.#act(`load:${generation}`, () => this.#loadOrg(orgId, generation), (published) => published);
  }

  /**
   * The organization and every page of its projects, unless the page has moved on meanwhile
   * or a newer load was asked: true when this load's figures were the ones published.
   */
  async #loadOrg(orgId: string, generation: number): Promise<boolean> {
    // Loads can overlap (two moves on different projects each read the figures again):
    // only the latest one asked may publish, so an older answer arriving last can't
    // overwrite newer figures. A load for a page that has since moved on (a move whose
    // answer came after a navigation) takes no number: it mustn't outrank the new page's.
    if (generation !== this.#generation) return false;
    const load = ++this.#orgLoad;
    try {
      const params = { orgId };
      const [org, projects] = await Promise.all([
        this.client.call("getOrg", { params }),
        this.#allPages((cursor) => this.client.call("listProjects", { params, query: cursor === undefined ? {} : { cursor } })),
      ]);
      if (generation !== this.#generation || load !== this.#orgLoad) return false;
      batch(() => {
        this.org.value = org;
        this.orgProjects.value = projects.items;
        const cut = new Set(this.truncated.value);
        if (projects.truncated) cut.add("orgProjects");
        else cut.delete("orgProjects");
        this.truncated.value = cut;
      });
      return true;
    } catch (err) {
      if (generation === this.#generation && load === this.#orgLoad) throw err;
      return false;
    }
  }

  /**
   * Move budget between the open organization and one of its projects (an org owner's):
   * a positive amount adds to the project's budget, a negative one returns it to the
   * organization. Then both figures are read again.
   */
  async moveProjectBudget(projectId: string, amount: Micros): Promise<boolean> {
    const orgId = this.orgId.value;
    if (orgId == null) return false;
    const generation = this.#generation;
    // The move is done once the server says so; whether its refresh is the one shown (and
    // so may clear an error) is the refresh's own business.
    const published = await this.#act(
      `move:${projectId}`,
      async () => {
        await this.client.call("moveProjectBudget", { params: { projectId }, body: { amount } });
        return this.#loadOrg(orgId, generation);
      },
      (shown) => shown,
    );
    return published !== null;
  }

  // ---------------------------------------------------------------- project

  async openProject(projectId: string): Promise<void> {
    if (this.projectId.value !== projectId) {
      batch(() => {
        this.projectId.value = projectId;
        this.project.value = null;
        this.meters.value = [];
        this.machines.value = [];
        this.gpuTypes.value = [];
        this.quotes.value = {};
        this.paused.value = [];
        this.members.value = [];
        this.teams.value = [];
        this.allMachines.value = [];
      });
    }
    const generation = ++this.#generation;
    // Every navigation loads, even back to the same project: the latest one wins, and a
    // superseded load neither writes its results nor reports its errors.
    await this.#act(`load:${generation}`, async () => {
      try {
        const params = { projectId };
        const [project, gpuTypes] = await Promise.all([
          this.client.call("getProject", { params }),
          this.client.call("listGpuTypes", { params }),
        ]);
        if (generation !== this.#generation) return;
        batch(() => {
          this.project.value = project;
          this.gpuTypes.value = gpuTypes.items;
        });
        await this.#refresh(generation);
      } catch (err) {
        if (generation === this.#generation) throw err;
      }
    });
  }

  /** Reload what changes over time: meters, machines and quotes. */
  refresh(): Promise<void> {
    return this.#refresh(this.#generation);
  }

  /**
   * One polling round; true when it succeeded. It never throws, so the polling loop
   * keeps going: a failure shows in the banner until a later round succeeds, and an ended
   * session signs the page out.
   */
  async poll(): Promise<boolean> {
    // A round answers the navigation and session it was asked in: a later one makes its
    // outcome moot (it's dropped, and counts as fine for the loop that asked).
    const generation = this.#generation;
    const session = this.#sessionGeneration;
    try {
      await this.refresh();
      if (generation !== this.#generation) return true;
      if (this.#pollError != null && this.error.value === this.#pollError) this.error.value = null;
      this.#pollError = null;
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthenticated") {
        // The session cookie is shared: a 401 asked within the current session ends it,
        // whatever project it was for; one from an older session is dropped.
        if (session !== this.#sessionGeneration) return true;
        this.#endSession();
        return false;
      }
      if (generation !== this.#generation) return true;
      this.#pollError = `Couldn't refresh: ${err instanceof Error ? err.message : String(err)}`;
      this.error.value = this.#pollError;
      return false;
    }
  }

  /**
   * Every page of a list, following `next`, up to MAX_LIST_PAGES; truncated when it stopped
   * there with more to come. A navigation meanwhile stops it early (the caller drops the
   * result anyway).
   */
  async #allPages<T>(fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; next: string | null }>): Promise<{ items: T[]; truncated: boolean }> {
    const generation = this.#generation;
    const items: T[] = [];
    let cursor: string | undefined;
    const max = this.#options.maxListPages ?? MAX_LIST_PAGES;
    for (let pages = 0; pages < max; pages++) {
      const page = await fetchPage(cursor);
      items.push(...page.items);
      if (page.next == null) return { items, truncated: false };
      if (generation !== this.#generation) return { items, truncated: false };
      cursor = page.next;
    }
    return { items, truncated: true };
  }

  async #refresh(generation: number): Promise<void> {
    const projectId = this.projectId.value;
    if (projectId == null) return;
    const params = { projectId };
    const gpuTypes = this.gpuTypes.value;
    const staff = this.isStaff.value;
    const [spend, machines, quotes, prices, managed] = await Promise.all([
      this.client.call("getSpend", { params }),
      this.#allPages((cursor) => this.client.call("listMachines", { params, query: cursor === undefined ? {} : { cursor } })),
      Promise.all(gpuTypes.map((t) => this.client.call("quote", { params, body: { gpuType: t.gpuType, gpuCount: t.gpuCount } }))),
      // (for the paused providers: a pause can begin or end while the page is open)
      this.client.call("listGpuTypes", { params }),
      staff
        ? Promise.all([
            this.client.call("getProject", { params }),
            this.#allPages((cursor) => this.client.call("listMembers", { params, query: cursor === undefined ? {} : { cursor } })),
            this.client.call("listTeams", { params }),
            this.#allPages((cursor) => this.client.call("listMachines", { params, query: cursor === undefined ? { all: "1" } : { all: "1", cursor } })),
          ])
        : null,
    ]);
    if (generation !== this.#generation) return; // navigated meanwhile
    batch(() => {
      this.meters.value = spend.meters;
      this.machines.value = machines.items;
      const cut = new Set<string>();
      if (machines.truncated) cut.add("machines");
      this.quotes.value = Object.fromEntries(quotes.map((q) => [q.gpuType, q]));
      this.paused.value = prices.paused;
      if (managed) {
        const [project, members, teams, all] = managed;
        this.project.value = project;
        this.members.value = members.items;
        this.teams.value = teams.teams;
        this.allMachines.value = all.items;
        if (members.truncated) cut.add("members");
        if (all.truncated) cut.add("allMachines");
      }
      this.truncated.value = cut;
    });
  }

  // ---------------------------------------------------------------- machines

  /** Start the GPU type at no more than the price the member was shown. */
  async start(gpuType: string): Promise<boolean> {
    const projectId = this.projectId.value;
    const quote = this.quotes.value[gpuType];
    const shown = quote?.offers[0]?.pricePerHour.total;
    if (projectId == null || quote == null || shown == null) return false;
    const m = await this.#act(`start:${gpuType}`, async () => {
      const machine = await this.client.call("startMachine", {
        params: { projectId },
        body: { gpuType, gpuCount: quote.gpuCount, maxPricePerHour: shown },
      });
      await this.refresh();
      return machine;
    });
    return m != null;
  }

  async #machineAction(kind: "stop" | "save" | "restart" | "delete", machineId: string): Promise<boolean> {
    const params = { machineId };
    const done = await this.#act(`${kind}:${machineId}`, async () => {
      if (kind === "stop") await this.client.call("stopMachine", { params, body: {} });
      else if (kind === "save") await this.client.call("saveMachine", { params, body: {} });
      else if (kind === "restart") await this.client.call("restartMachine", { params, body: {} });
      else await this.client.call("deleteMachine", { params });
      await this.refresh();
      return true;
    });
    return done === true;
  }

  stop(machineId: string): Promise<boolean> {
    return this.#machineAction("stop", machineId);
  }

  save(machineId: string): Promise<boolean> {
    return this.#machineAction("save", machineId);
  }

  restart(machineId: string): Promise<boolean> {
    return this.#machineAction("restart", machineId);
  }

  remove(machineId: string): Promise<boolean> {
    return this.#machineAction("delete", machineId);
  }

  // ---------------------------------------------------------------- managing (staff)

  /** Set one member's allocation. */
  /** Change the project's settings (a manager's); the request carries only what changed. */
  async updateProject(body: UpdateProjectRequest): Promise<boolean> {
    const projectId = this.projectId.value;
    if (projectId == null) return false;
    const done = await this.#act("settings", async () => {
      await this.client.call("updateProject", { params: { projectId }, body });
      await this.refresh();
      return true;
    });
    return done === true;
  }

  async setAllocation(memberId: string, amount: Micros): Promise<boolean> {
    const projectId = this.projectId.value;
    if (projectId == null) return false;
    const done = await this.#act(`allocation:${memberId}`, async () => {
      await this.client.call("setMemberAllocation", { params: { projectId, memberId }, body: { amount } });
      await this.refresh();
      return true;
    });
    return done === true;
  }

  // ---------------------------------------------------------------- teams

  /** Put a person in a team, or (null) in none. */
  async setMemberTeam(memberId: string, teamId: string | null): Promise<boolean> {
    const projectId = this.projectId.value;
    if (projectId == null) return false;
    const done = await this.#act(`memberTeam:${memberId}`, async () => {
      await this.client.call("updateMember", { params: { projectId, memberId }, body: { teamId } });
      await this.refresh();
      return true;
    });
    return done === true;
  }

  /** Create a team with an allocation; true when it was made. */
  async createTeam(name: string, allocation: Micros): Promise<boolean> {
    const projectId = this.projectId.value;
    if (projectId == null) return false;
    const done = await this.#act("team:create", async () => {
      await this.client.call("createTeam", { params: { projectId }, body: { name, allocation } });
      await this.refresh();
      return true;
    });
    return done === true;
  }

  async renameTeam(teamId: string, name: string): Promise<boolean> {
    const projectId = this.projectId.value;
    if (projectId == null) return false;
    const done = await this.#act(`team:${teamId}`, async () => {
      await this.client.call("updateTeam", { params: { projectId, teamId }, body: { name } });
      await this.refresh();
      return true;
    });
    return done === true;
  }

  async setTeamAllocation(teamId: string, amount: Micros): Promise<boolean> {
    const projectId = this.projectId.value;
    if (projectId == null) return false;
    const done = await this.#act(`team:${teamId}`, async () => {
      await this.client.call("setTeamAllocation", { params: { projectId, teamId }, body: { amount } });
      await this.refresh();
      return true;
    });
    return done === true;
  }

  /** Delete a team: its members leave it and its allocation returns to the project. */
  async deleteTeam(teamId: string): Promise<boolean> {
    const projectId = this.projectId.value;
    if (projectId == null) return false;
    const done = await this.#act(`team:${teamId}`, async () => {
      await this.client.call("deleteTeam", { params: { projectId, teamId } });
      await this.refresh();
      return true;
    });
    return done === true;
  }

  /**
   * Apply several allocation changes, one at a time; stops at the first refusal and says how
   * far it got. Returns how many were applied, or null when the page moved on meanwhile
   * (the rest isn't sent).
   */
  async setAllocations(changes: ReadonlyArray<{ memberId: string; to: Micros }>): Promise<number | null> {
    const projectId = this.projectId.value;
    if (projectId == null) return 0;
    const generation = this.#generation;
    let applied = 0;
    await this.#act("allocations", async () => {
      try {
        for (const c of changes) {
          // Navigated away or the session changed: stop quietly. What was already sent stays
          // done (the server is the record); nothing more goes to the old project.
          if (generation !== this.#generation) return applied;
          try {
            await this.client.call("setMemberAllocation", { params: { projectId, memberId: c.memberId }, body: { amount: c.to } });
          } catch (err) {
            if (err instanceof ApiError) {
              throw new ApiError(err.code, err.status, `${applied} of ${changes.length} allocations changed, then: ${err.message}`);
            }
            throw err;
          }
          applied++;
        }
        return applied;
      } finally {
        if (generation === this.#generation) await this.refresh().catch(() => undefined);
      }
    });
    // A refusal stops the loop (the banner says how far it got); a stale context returns nothing.
    return generation === this.#generation ? applied : null;
  }

  /** Invite these addresses, each with `allocation`. Returns how many members came back. */
  async invite(emails: readonly string[], allocation: Micros): Promise<number> {
    const projectId = this.projectId.value;
    if (projectId == null || emails.length === 0) return 0;
    const result = await this.#act("invite", async () => {
      const { members } = await this.client.call("inviteMembers", {
        params: { projectId },
        body: { members: emails.map((email) => ({ email, allocation })) },
      });
      await this.refresh();
      return members.length;
    });
    return result ?? 0;
  }

  async removeMember(memberId: string): Promise<boolean> {
    const projectId = this.projectId.value;
    if (projectId == null) return false;
    const done = await this.#act(`removeMember:${memberId}`, async () => {
      await this.client.call("removeMember", { params: { projectId, memberId } });
      await this.refresh();
      return true;
    });
    return done === true;
  }

  /** Stop every machine in the project (saving first). Returns how many were stopping. */
  async stopAll(): Promise<number | null> {
    const projectId = this.projectId.value;
    if (projectId == null) return null;
    return this.#act("stopAll", async () => {
      const { stopping } = await this.client.call("stopAllMachines", { params: { projectId }, body: {} });
      await this.refresh();
      return stopping.length;
    });
  }

  /** The spend CSV, as text, for a download. */
  async spendCsv(by: SpendCsvGrouping): Promise<string | null> {
    const projectId = this.projectId.value;
    if (projectId == null) return null;
    return this.#act(`csv:${by}`, () => this.client.call("getSpendCsv", { params: { projectId }, query: { by } }));
  }

  /**
   * What one terminal connection needs: a fresh single-use page token from the API and the
   * relay's terminal URL, checked to be wss: on the UI's own host (terminal/session.ts
   * terminalUrl) before the token is sent anywhere. Null when either can't be had; the
   * terminal then retries with backoff. Not an #act: a terminal's retries shouldn't touch
   * the busy keys, and its failures show in the terminal's own status line.
   */
  async terminalAccess(machineId: string): Promise<{ token: string; url: string } | null> {
    const dev = this.#options.devTerminal;
    if (dev) {
      const url = terminalUrl(dev.url, machineId, "", true);
      return url == null ? null : { token: dev.token, url };
    }
    let session: { token: string; relayUrl: string };
    try {
      session = await this.client.call("openMachineSession", { params: { machineId }, body: {} });
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthenticated") this.#endSession();
      return null;
    }
    const host = this.#options.uiHost ?? (typeof location === "undefined" ? "" : location.host);
    const url = terminalUrl(session.relayUrl, machineId, host);
    if (url == null) {
      this.error.value = "The server sent a terminal address that isn't this site's relay; the terminal was not opened.";
      return null;
    }
    return { token: session.token, url };
  }

  /**
   * A one-time Jupyter link, checked (view.ts jupyterUrl) before anyone opens it: the
   * caller opens it in a new tab, never on our origin. Null, with the reason in the
   * banner, when the request failed or the link is not one we'd open.
   */
  async jupyterLink(machineId: string): Promise<string | null> {
    const link = await this.#act(`jupyter:${machineId}`, () => this.client.call("openJupyterLink", { params: { machineId }, body: {} }));
    if (link == null) return null;
    const url = jupyterUrl(link.url, machineId);
    if (url == null) this.error.value = "The server sent a Jupyter link that isn't the machine's own address; it was not opened.";
    return url;
  }
}
