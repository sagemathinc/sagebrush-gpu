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
    this.busy.value = new Set([...this.busy.value, key]);
    try {
      const result = await fn();
      this.error.value = null;
      return result;
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthenticated") {
        batch(() => {
          this.me.value = null;
          this.meLoaded.value = true;
        });
      }
      this.error.value = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      const next = new Set(this.busy.value);
      next.delete(key);
      this.busy.value = next;
    }
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
      batch(() => {
        this.me.value = me;
        this.meLoaded.value = true;
      });
    }
    return me != null;
  }

  async signOut(): Promise<void> {
    await this.#act("signout", () => this.client.call("signOut", { body: {} }));
    batch(() => {
      this.me.value = null;
      this.projectId.value = null;
      this.project.value = null;
    });
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
    await this.#act("load", async () => {
      const params = { projectId };
      const [project, gpuTypes] = await Promise.all([
        this.client.call("getProject", { params }),
        this.client.call("listGpuTypes", { params }),
      ]);
      batch(() => {
        this.project.value = project;
        this.gpuTypes.value = gpuTypes.items;
      });
      await this.refresh();
    });
  }

  /** Reload what changes over time: meters, machines and quotes. */
  async refresh(): Promise<void> {
    const projectId = this.projectId.value;
    if (projectId == null) return;
    const params = { projectId };
    const [spend, machines, quotes] = await Promise.all([
      this.client.call("getSpend", { params }),
      this.client.call("listMachines", { params }),
      Promise.all(this.gpuTypes.value.map((t) => this.client.call("quote", { params, body: { gpuType: t.gpuType, gpuCount: t.gpuCount } }))),
    ]);
    if (this.projectId.value !== projectId) return; // navigated away meanwhile
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

  /** A one-time Jupyter link; the caller opens it in a new tab (never on our origin). */
  async jupyterLink(machineId: string): Promise<string | null> {
    const link = await this.#act(`jupyter:${machineId}`, () => this.client.call("openJupyterLink", { params: { machineId }, body: {} }));
    return link?.url ?? null;
  }
}
