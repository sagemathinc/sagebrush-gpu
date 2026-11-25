// The Shadeform adapter, over Shadeform's public REST API (https://api.shadeform.ai/v1). Mock-only:
// no test or code path here has called Shadeform.
//
// Every Shadeform launch is a VM (a startup script, or a container on a VM with the account's SSH
// key), and VM mode is refused (machine DESIGN.md section 2). So launch() refuses before any
// request; offers, status, the machine list and terminate work, so the watchdog and reconcile can
// see and clean up anything that exists.

import { ProviderError, type ProviderErrorKind } from "../errors.ts";
import { failureName, retryAfterSeconds, type Fetch } from "../http.ts";
import { parseMachineName } from "../machine-name.ts";
import type {
  AdapterInfo,
  LaunchOptions,
  LaunchResult,
  LaunchSpec,
  MachineState,
  Offer,
  OfferQuery,
  ProviderAdapter,
  ProviderMachineStatus,
} from "../types.ts";
import { gpuFromShadeform, shadeformCountry, shadeformDataCenter } from "./catalog.ts";

export const SHADEFORM_API = "https://api.shadeform.ai";
export const BOOT_TOKEN_ENV = "SBGPU_BOOT_TOKEN";
/** Instances per page of the machine list (Shadeform's maximum). */
const PAGE = 100;
const MAX_PAGES = 50;
const TIMEOUT_MS = 30_000;

export interface ShadeformOptions {
  /** From the control plane's secrets. Only ever sent in the X-API-KEY header. */
  apiKey: string;
  fetch: Fetch;
  baseUrl?: string;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Map one Shadeform HTTP error to a ProviderError. Shadeform's bodies (plain text, or JSON with an
 * error_code) are never read or kept: they can echo request values. Messages hold only the status
 * and our kind.
 */
export function shadeformError(status: number, retryAfter: string | null): ProviderError {
  const kind: ProviderErrorKind =
    status === 400 || status === 422
      ? "invalid_request"
      : status === 401
        ? "auth"
        : status === 402
          ? "insufficient_funds"
          : status === 403
            ? "forbidden"
            : status === 404
              ? "not_found"
              : status === 409
                ? "unplaceable"
                : status === 429
                  ? "rate_limited"
                  : status >= 500 && status <= 599
                    ? "transient"
                    : "unknown";
  return new ProviderError(
    "shadeform",
    kind,
    `Shadeform HTTP ${status} (${kind})`,
    status,
    status === 429 ? retryAfterSeconds(retryAfter) : null,
  );
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const STATES: Readonly<Record<string, MachineState>> = {
  creating: "provisioning",
  pending_provider: "provisioning",
  pending: "provisioning",
  active: "running",
  error: "failed",
  // Billing stops at "deleting", but the machine isn't gone until "deleted".
  deleting: "stopping",
  deleted: "terminated",
};

/**
 * The value that stands for a field Shadeform sent malformed or not at all. It never equals an
 * expected value, so specDrift reports the field.
 */
export const UNREADABLE = "<unreadable>";

/**
 * The command of every Shadeform machine. Shadeform runs a startup script or a container on a VM
 * and has no entrypoint, so no Shadeform machine ever matches a launcher (VM mode is refused).
 */
export const VM_COMMAND: readonly string[] = Object.freeze(["<shadeform-vm>"]);

/** A non-negative integer, or NaN (which never equals an expected number). */
function count(x: unknown): number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : Number.NaN;
}

/** Whole cents per hour as micro-USD, or null. */
function centsToMicros(x: unknown): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && Number.isSafeInteger(x * 10_000) ? x * 10_000 : null;
}

/** Names of a `[{name, value}]` list, or null when it is malformed. */
function envNames(x: unknown): string[] | null {
  if (x === null || x === undefined) return [];
  if (!Array.isArray(x)) return null;
  const out: string[] = [];
  for (const e of x) {
    if (!isObject(e) || typeof e["name"] !== "string" || typeof e["value"] !== "string") return null;
    out.push(e["name"]);
  }
  return out;
}

/** A list field that must be empty: [] for null, absent or [], the given marker otherwise. */
function emptyList(x: unknown, marker: (n: number) => string[]): string[] {
  if (x === null || x === undefined) return [];
  if (!Array.isArray(x)) return [UNREADABLE];
  return x.length === 0 ? [] : marker(x.length);
}

/** Shadeform settings that differ from anything we'd accept; missing or malformed ones too. */
function unexpectedSettings(inst: Record<string, unknown>): string[] {
  const out: string[] = [];
  // Every Shadeform VM carries an SSH key: never our launch shape.
  if (inst["ssh_key_id"] !== null && inst["ssh_key_id"] !== undefined) out.push("ssh:key");
  if (inst["shade_cloud"] !== true) out.push(`shade_cloud:${inst["shade_cloud"] === false ? "false" : UNREADABLE}`);
  const terms = inst["rental_terms"];
  const rental = isObject(terms) ? terms["rental_type"] : undefined;
  if (rental !== "on_demand") out.push(`rental:${typeof rental === "string" ? rental : UNREADABLE}`);
  for (const k of ["template_id", "cluster_id", "commitment_id"]) {
    if (inst[k] !== null && inst[k] !== undefined) out.push(`${k}:${typeof inst[k] === "string" ? "set" : UNREADABLE}`);
  }
  return out;
}

/**
 * A Shadeform Instance object as our ProviderMachineStatus. Only a missing id throws: every other
 * field that is missing or malformed is kept as an unreadable value, so the drift check fails
 * closed on it.
 */
export function instanceStatus(inst: unknown, observedAt: string): ProviderMachineStatus {
  if (!isObject(inst) || typeof inst["id"] !== "string" || inst["id"] === "") {
    throw new ProviderError("shadeform", "unknown", "Shadeform returned an instance without an id");
  }
  const conf = isObject(inst["configuration"]) ? inst["configuration"] : {};
  const rawStatus = typeof inst["status"] === "string" ? inst["status"] : "";
  const launch = isObject(inst["launch_configuration"]) ? inst["launch_configuration"] : {};
  const docker = isObject(launch["docker_configuration"]) ? launch["docker_configuration"] : {};
  const names = [envNames(inst["envs"]), envNames(docker["envs"])];
  const ports = [
    ...emptyList(inst["port_forwards"], (n) => [`port_forwards:${n}`]),
    ...emptyList(docker["port_mappings"], (n) => [`port_mappings:${n}`]),
  ];
  const volumes = inst["volume_ids"];
  return {
    provider: "shadeform",
    providerMachineId: inst["id"],
    machineId: typeof inst["name"] === "string" ? parseMachineName(inst["name"]) : null,
    state: Object.hasOwn(STATES, rawStatus) ? STATES[rawStatus]! : "unknown",
    rawStatus,
    gpuType: gpuFromShadeform(conf["gpu_type"], conf["interconnect"]),
    gpuCount: count(conf["num_gpus"]),
    dataCenter: shadeformDataCenter(inst["cloud"], inst["region"]),
    // A Shadeform "image" is the VM's OS; the disk is fixed by the instance type.
    image: typeof conf["os"] === "string" ? conf["os"] : UNREADABLE,
    diskGb: count(conf["storage_in_gb"]),
    volumeGb:
      volumes === null || volumes === undefined || (Array.isArray(volumes) && volumes.length === 0)
        ? 0
        : Array.isArray(volumes) && volumes.every((v) => typeof v === "string")
          ? Number.POSITIVE_INFINITY
          : Number.NaN,
    envNames: names.every((n) => n !== null) ? names.flat() : [UNREADABLE],
    exposedPorts: ports,
    unexpectedSettings: unexpectedSettings(inst),
    command: [...VM_COMMAND],
    providerCostPerHour: centsToMicros(inst["hourly_price"]),
    observedAt,
  };
}

export class ShadeformAdapter implements ProviderAdapter {
  readonly info: AdapterInfo = {
    provider: "shadeform",
    selfIdentity: null,
    bootTokenEnv: BOOT_TOKEN_ENV,
  };

  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #base: string;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(opts: ShadeformOptions) {
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch;
    this.#base = opts.baseUrl ?? SHADEFORM_API;
    this.#now = opts.now ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  /** One API call. Network failures and timeouts throw kind "outcome_unknown". */
  async #call(method: "GET" | "POST", path: string): Promise<unknown> {
    const init: Parameters<Fetch>[1] = {
      method,
      headers: { "X-API-KEY": this.#apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    let res;
    let text;
    try {
      res = await this.#fetch(this.#base + path, init);
      text = await res.text();
    } catch (e) {
      // Never include the request (it carries the key), nor the exception's text: a fixed name.
      const name = failureName(e);
      throw new ProviderError("shadeform", "outcome_unknown", `Shadeform ${method} ${path.split("?")[0]}: no response (${name})`);
    }
    if (res.status >= 300) throw shadeformError(res.status, res.headers.get("Retry-After"));
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      // A request that changes something (POST) succeeded but its reply is unreadable: the change
      // may have happened. Only a read can be called a plain failure.
      const kind: ProviderErrorKind = method === "GET" ? "unknown" : "outcome_unknown";
      throw new ProviderError("shadeform", kind, `Shadeform ${method} ${path.split("?")[0]}: response is not JSON`, res.status);
    }
  }

  #observedAt(): string {
    return this.#now().toISOString();
  }

  /**
   * On-demand offers in Shade Cloud (billed through Shadeform), one per cloud/region we know the
   * country of. Shadeform says only whether a region can launch now, never how much stock it has.
   */
  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (!Number.isInteger(query.gpuCount) || query.gpuCount < 1) throw new RangeError("gpuCount must be a positive integer");
    const qs = new URLSearchParams({ num_gpus: String(query.gpuCount), shade_cloud: "true" });
    const json = await this.#call("GET", `/v1/instances/types?${qs}`);
    if (!isObject(json) || !Array.isArray(json["instance_types"])) {
      throw new ProviderError("shadeform", "unknown", "Shadeform instance types are malformed");
    }
    const observedAt = this.#observedAt();
    // One offer per GPU type and place: several instance types can carry the same GPU there.
    const best = new Map<string, Offer>();
    for (const t of json["instance_types"]) {
      if (!isObject(t) || !isObject(t["configuration"]) || !Array.isArray(t["availability"])) continue;
      const conf = t["configuration"];
      // The filter is a request, not a guarantee: check the count we were given.
      if (conf["num_gpus"] !== query.gpuCount) continue;
      const gpuType = gpuFromShadeform(conf["gpu_type"], conf["interconnect"]);
      const price = centsToMicros(t["hourly_price"]);
      if (gpuType === null || price === null || price === 0) continue;
      for (const a of t["availability"]) {
        if (!isObject(a) || a["rental_type"] !== "on_demand" || typeof a["available"] !== "boolean") continue;
        const dataCenter = shadeformDataCenter(t["cloud"], a["region"]);
        // A place we can't put in a country is never offered: no locality can be checked.
        const country = dataCenter === null ? null : shadeformCountry(dataCenter);
        if (dataCenter === null || country === null) continue;
        const offer: Offer = {
          provider: "shadeform",
          gpuType,
          gpuCount: query.gpuCount,
          dataCenter,
          country,
          providerCostPerHour: price,
          stock: a["available"] ? "unknown" : "none",
          observedAt,
        };
        // The cheapest wins; at the same price, one that can launch now.
        const key = `${gpuType}\u0000${dataCenter}`;
        const prev = best.get(key);
        if (prev === undefined || price < prev.providerCostPerHour || (price === prev.providerCostPerHour && prev.stock === "none")) {
          best.set(key, offer);
        }
      }
    }
    return [...best.values()];
  }

  /** Refused before any request: every Shadeform launch is a VM, and VM mode is not supported. */
  async launch(_spec: LaunchSpec, _opts?: LaunchOptions): Promise<LaunchResult> {
    throw new ProviderError("shadeform", "invalid_request", "Shadeform: VM mode is not supported");
  }

  async status(providerMachineId: string): Promise<ProviderMachineStatus> {
    try {
      const json = await this.#call("GET", `/v1/instances/${encodeURIComponent(providerMachineId)}/info`);
      const s = instanceStatus(json, this.#observedAt());
      if (s.providerMachineId !== providerMachineId) {
        throw new ProviderError("shadeform", "unknown", "Shadeform answered an instance query with another instance");
      }
      return s;
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "not_found") return goneStatus(providerMachineId, this.#observedAt());
      throw e;
    }
  }

  /**
   * Idempotent: an instance Shadeform doesn't know, or one already deleting or deleted, is done.
   * A refusal (409) is accepted only when a fresh status read shows the instance on its way out.
   */
  async terminate(providerMachineId: string): Promise<void> {
    try {
      await this.#call("POST", `/v1/instances/${encodeURIComponent(providerMachineId)}/delete`);
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.kind === "not_found") return;
      if (e.kind !== "unplaceable") throw e;
      const s = await this.status(providerMachineId);
      if (s.state === "terminated" || s.state === "stopping") return;
      throw e;
    }
  }

  /**
   * Every machine of ours Shadeform lists (deleted ones are not listed). Pages are read by offset;
   * the list must keep the same total throughout, fill every page but the last, never repeat an
   * instance and name every row, or it fails: a list that moved while we read it may have skipped
   * a machine, and a row without a name may be one of ours.
   */
  async listMachines(): Promise<ProviderMachineStatus[]> {
    const out: ProviderMachineStatus[] = [];
    let total: number | null = null;
    let offset = 0;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      const json = await this.#call("GET", `/v1/instances?${qs}`);
      const observedAt = this.#observedAt();
      if (!isObject(json) || !Array.isArray(json["instances"]) || !Number.isSafeInteger(json["total"]) || (json["total"] as number) < 0) {
        throw new ProviderError("shadeform", "unknown", "Shadeform instance list is malformed");
      }
      const t = json["total"] as number;
      if (total !== null && t !== total) throw new ProviderError("shadeform", "unknown", "Shadeform instance list changed while it was read");
      total = t;
      const instances = json["instances"];
      const expected = Math.min(PAGE, total - offset);
      if (instances.length !== Math.max(0, expected)) {
        throw new ProviderError("shadeform", "unknown", "Shadeform instance list page has the wrong length");
      }
      for (const inst of instances) {
        const s = instanceStatus(inst, observedAt);
        // Every row counts, foreign ones too: a repeated id means pages overlapped, and the
        // machines they pushed out of the list are missing from it.
        if (seen.has(s.providerMachineId)) {
          throw new ProviderError("shadeform", "unknown", "Shadeform instance list has an instance twice");
        }
        seen.add(s.providerMachineId);
        // Only a readable name can say whether a machine is ours: a row without one fails the list.
        if (typeof (inst as Record<string, unknown>)["name"] !== "string") {
          throw new ProviderError("shadeform", "unknown", "Shadeform instance list has an instance without a name");
        }
        if (s.machineId !== null) out.push(s);
      }
      offset += instances.length;
      if (offset >= total) return out;
    }
    // A partial list would hide machines from the watchdog: fail instead.
    throw new ProviderError("shadeform", "unknown", `Shadeform instance list has more than ${MAX_PAGES} pages`);
  }
}

function goneStatus(providerMachineId: string, observedAt: string): ProviderMachineStatus {
  return {
    provider: "shadeform",
    providerMachineId,
    machineId: null,
    state: "terminated",
    rawStatus: "NOT_FOUND",
    gpuType: null,
    gpuCount: 0,
    dataCenter: null,
    image: "",
    diskGb: 0,
    volumeGb: 0,
    envNames: [],
    exposedPorts: [],
    unexpectedSettings: [],
    command: [],
    providerCostPerHour: null,
    observedAt,
  };
}
