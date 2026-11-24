// The UI's state: signals filled from the API, and the actions that change them. No DOM
// here, so the store is tested in Node against the mock backend.

import { batch, computed, signal } from "@preact/signals";
import {
  ACCRUING_STATES,
  type Machine,
  type Me,
  type PriceListItem,
  type Project,
  type ProjectRole,
  type Quote,
  type SpendMeter,
} from "@sbgpu/api";
import { ApiError, type Client } from "../client.ts";
import { resolveLabels } from "../labels.ts";
import { jupyterUrl } from "../view.ts";

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
  /** The last failed action's message, shown until dismissed or the next success. */
  readonly error = signal<string | null>(null);
  /** Keys of actions in flight ("start:L4", "stop:mch_..."), to disable their buttons. */
  readonly busy = signal<ReadonlySet<string>>(new Set());

  readonly projectId = signal<string | null>(null);
  readonly project = signal<Project | null>(null);
  readonly meters = signal<SpendMeter[]>([]);
  readonly machines = signal<Machine[]>([]);
  readonly gpuTypes = signal<PriceListItem[]>([]);
  readonly quotes = signal<Readonly<Record<string, Quote>>>({});

  readonly membership = computed(() => this.me.value?.projects.find((p) => p.projectId === this.projectId.value) ?? null);
  readonly role = computed<ProjectRole | null>(() => this.membership.value?.role ?? null);
  readonly labels = computed(() => resolveLabels(this.project.value?.labels));
  readonly myMeter = computed(() => {
    const memberId = this.membership.value?.memberId;
    return this.meters.value.find((m) => m.holder.kind === "member" && m.holder.memberId === memberId) ?? null;
  });
  /** A member's team meter (members get only their own team's; others see every team's elsewhere). */
  readonly teamMeter = computed(() =>
    this.role.value === "member" ? (this.meters.value.find((m) => m.holder.kind === "team") ?? null) : null,
  );
  readonly activeMachines = computed(() => this.machines.value.filter((m) => ACCRUING_STATES.includes(m.state)));

  /** Increments on every navigation (openProject, and any session change); results of older ones are dropped. */
  #generation = 0;
  /** Increments when a session starts (sign-in): a 401 answers only the session it was asked in. */
  #sessionGeneration = 0;
  /** The banner message the last failed poll set, so a later good poll can clear it (and only it). */
  #pollError: string | null = null;

  constructor(client: Client, now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  pollDelayMs(): number {
    return this.machines.value.some(isChanging) ? FAST_POLL_MS : SLOW_POLL_MS;
  }

  // ---------------------------------------------------------------- errors and busy keys

  /** Run an action: mark it busy, record its error, and clear a session that has ended. */
  async #act<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    if (this.busy.value.has(key)) return null;
    const session = this.#sessionGeneration;
    this.busy.value = new Set([...this.busy.value, key]);
    try {
      const result = await fn();
      this.error.value = null;
      return result;
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthenticated" && session === this.#sessionGeneration) this.#endSession();
      this.error.value = err instanceof Error ? err.message : String(err);
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
    batch(() => {
      this.me.value = null;
      this.meLoaded.value = true;
      this.projectId.value = null;
      this.project.value = null;
      this.meters.value = [];
      this.machines.value = [];
      this.gpuTypes.value = [];
      this.quotes.value = {};
    });
  }

  isBusy(key: string): boolean {
    return this.busy.value.has(key);
  }

  // ---------------------------------------------------------------- session

  async loadMe(): Promise<void> {
    try {
      this.me.value = await this.client.call("getMe");
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "unauthenticated")) {
        this.error.value = err instanceof Error ? err.message : String(err);
      }
      this.me.value = null;
    } finally {
      this.meLoaded.value = true;
    }
  }

  async requestSignInLink(email: string): Promise<boolean> {
    return (await this.#act("signin", () => this.client.call("requestSignInLink", { body: { email } }))) != null;
  }

  async verifySignIn(token: string): Promise<boolean> {
    const me = await this.#act("signin", () => this.client.call("verifySignInLink", { body: { token } }));
    if (me != null) {
      // A new session: answers still owed to an older one (a 401 included) don't apply.
      this.#generation++;
      this.#sessionGeneration++;
      batch(() => {
        this.me.value = me;
        this.meLoaded.value = true;
      });
    }
    return me != null;
  }

  async signOut(): Promise<void> {
    await this.#act("signout", () => this.client.call("signOut", { body: {} }));
    this.#endSession();
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

  async #refresh(generation: number): Promise<void> {
    const projectId = this.projectId.value;
    if (projectId == null) return;
    const params = { projectId };
    const gpuTypes = this.gpuTypes.value;
    const [spend, machines, quotes] = await Promise.all([
      this.client.call("getSpend", { params }),
      this.client.call("listMachines", { params }),
      Promise.all(gpuTypes.map((t) => this.client.call("quote", { params, body: { gpuType: t.gpuType, gpuCount: t.gpuCount } }))),
    ]);
    if (generation !== this.#generation) return; // navigated meanwhile
    batch(() => {
      this.meters.value = spend.meters;
      this.machines.value = machines.items;
      this.quotes.value = Object.fromEntries(quotes.map((q) => [q.gpuType, q]));
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
