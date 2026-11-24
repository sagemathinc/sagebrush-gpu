// The RunPod adapter, over RunPod's public REST API v2 (https://api.runpod.io/v2).
//
// Launch shape (SEC ruling on RunPod's injected pod key, Nov 24 2026): our launcher is the
// container entrypoint (PID 1); no ports, no RunPod SSH or Jupyter, no template, no volume; the
// only environment variable is the boot token. Secure Cloud only.

import { specDrift, expectedSpec } from "../drift.ts";
import { ProviderError, type ProviderErrorKind } from "../errors.ts";
import { retryAfterSeconds, type Fetch } from "../http.ts";
import { machineName, parseMachineName } from "../machine-name.ts";
import { usdToMicros } from "../money.ts";
import type {
  AdapterInfo,
  LaunchResult,
  LaunchSpec,
  MachineState,
  Offer,
  OfferQuery,
  ProviderAdapter,
  ProviderMachineStatus,
  StockLevel,
} from "../types.ts";
import { gpuFromRunPod, gpuToRunPod, runpodCountry } from "./catalog.ts";

export const RUNPOD_API = "https://api.runpod.io";
export const BOOT_TOKEN_ENV = "SBGPU_BOOT_TOKEN";
const MAX_PAGES = 50;
const TIMEOUT_MS = 30_000;

export interface RunPodOptions {
  /** From the control plane's secrets. Only ever sent in the Authorization header. */
  apiKey: string;
  fetch: Fetch;
  baseUrl?: string;
  now?: () => Date;
  timeoutMs?: number;
}

/** A RunPod refusal that means capacity (RunPod has no machine-readable code for it). */
const NO_CAPACITY = /no longer any instances available|no (gpu )?capacity|not enough (free )?gpus|no available (machines|gpus|instances)/i;

/**
 * Map one RunPod HTTP error to a ProviderError (see RunPod's create-pod retry table). The
 * provider's response text is read only to recognise a capacity refusal and is never kept: it
 * can echo request values such as the boot token. Messages hold only the status and our kind.
 */
export function runpodError(status: number, body: string, retryAfter: string | null): ProviderError {
  const kind: ProviderErrorKind =
    status === 400
      ? NO_CAPACITY.test(errorDetail(body)) ? "no_capacity" : "unplaceable"
      : status === 401
        ? "auth"
        : status === 402
          ? "insufficient_funds"
          : status === 403
            ? "forbidden"
            : status === 404
              ? "not_found"
              : status === 409 || status === 413 || status === 422
                ? "invalid_request"
                : status === 429
                  ? "rate_limited"
                  : status >= 500 && status <= 599
                    ? "transient"
                    : "unknown";
  return new ProviderError(
    "runpod",
    kind,
    `RunPod HTTP ${status} (${kind})`,
    status,
    status === 429 ? retryAfterSeconds(retryAfter) : null,
  );
}

/** The `detail` of a problem+json body (or the raw text), for classification only. */
function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObject(parsed) && typeof parsed["detail"] === "string") return parsed["detail"].slice(0, 1000);
  } catch {
    // not JSON
  }
  return body.slice(0, 1000);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const STATES: Readonly<Record<string, MachineState>> = {
  PROVISIONING: "provisioning",
  STARTING: "provisioning",
  RUNNING: "running",
  // Our launcher is PID 1: if the container exited, the machine is of no use.
  EXITED: "failed",
  ERROR: "failed",
  TERMINATED: "terminated",
};

const STOCK: Readonly<Record<string, StockLevel>> = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  NONE: "none",
};

/**
 * The value that stands for a field RunPod sent malformed or not at all. It never equals an
 * expected value, so specDrift reports the field and the machine is terminated.
 */
export const UNREADABLE = "<unreadable>";

/** An array of strings, or null when `x` is anything else (including an array with a non-string). */
function stringArray(x: unknown): string[] | null {
  return Array.isArray(x) && x.every((s) => typeof s === "string") ? [...x] : null;
}

/** A non-negative integer, or NaN (which never equals an expected number). */
function count(x: unknown): number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : Number.NaN;
}

const MOUNT_KEYS = new Set(["persistent", "network", "global"]);

/**
 * GB of volume attached, from a Pod's `mounts`: 0 for `{}`, the size of a persistent mount,
 * Infinity for any network or global volume (never expected), NaN when unreadable.
 */
function volumeGb(mounts: unknown): number {
  if (!isObject(mounts) || Object.keys(mounts).some((k) => !MOUNT_KEYS.has(k))) return Number.NaN;
  let gb = 0;
  const persistent = mounts["persistent"];
  if (persistent !== undefined && persistent !== null) {
    if (!isObject(persistent)) return Number.NaN;
    // A persistent mount is a volume whatever its reported size: never "no volume".
    const size = count(persistent["size"]);
    gb += size > 0 ? size : Number.NaN;
  }
  for (const k of ["network", "global"]) {
    const v = mounts[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) return Number.NaN;
    if (v.length > 0) gb = Number.POSITIVE_INFINITY;
  }
  return gb;
}

/**
 * RunPod settings that differ from our launch shape: Secure Cloud, no SSH endpoint, no template,
 * no global networking. Missing or malformed values are reported too.
 */
function unexpectedSettings(pod: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (pod["cloud"] !== "SECURE") out.push(`cloud:${typeof pod["cloud"] === "string" ? pod["cloud"] : UNREADABLE}`);
  const ssh = pod["ssh"];
  if (!isObject(ssh)) out.push(`ssh:${UNREADABLE}`);
  else {
    // Both known endpoints must be reported, and null; any other endpoint kind must be null.
    for (const k of ["proxy", "direct"]) if (!Object.hasOwn(ssh, k)) out.push(`ssh:${k}:${UNREADABLE}`);
    for (const k of Object.keys(ssh)) if (ssh[k] !== null) out.push(`ssh:${k}`);
  }
  if (pod["template"] !== null) out.push(`template:${typeof pod["template"] === "string" ? pod["template"] : UNREADABLE}`);
  const gn = pod["globalNetworking"];
  if (!isObject(gn) || gn["enabled"] !== false) out.push(`globalNetworking:${isObject(gn) && gn["enabled"] === true ? "enabled" : UNREADABLE}`);
  return out;
}

/**
 * A RunPod Pod object as our ProviderMachineStatus. Only a missing id throws: every other field
 * that is missing or malformed is kept as an unreadable value, so the drift check fails closed
 * on it (and a fresh pod with such a field is terminated, not left running).
 */
export function podStatus(pod: unknown, observedAt: string): ProviderMachineStatus {
  if (!isObject(pod) || typeof pod["id"] !== "string" || pod["id"] === "") {
    throw new ProviderError("runpod", "unknown", "RunPod returned a pod without an id");
  }
  const gpu = isObject(pod["gpu"]) ? pod["gpu"] : {};
  const env = pod["env"];
  const envNames =
    isObject(env) && Object.values(env).every((v) => typeof v === "string") ? Object.keys(env) : [UNREADABLE];
  const rawStatus = typeof pod["status"] === "string" ? pod["status"] : "";
  // RunPod returns both forms (args, and entrypoint + cmd); we read entrypoint + cmd.
  const entrypoint = stringArray(pod["entrypoint"]);
  const cmd = stringArray(pod["cmd"]);
  const command = entrypoint !== null && cmd !== null ? [...entrypoint, ...cmd] : [UNREADABLE];
  const cost = pod["cost"];
  return {
    provider: "runpod",
    providerMachineId: pod["id"],
    machineId: typeof pod["name"] === "string" ? parseMachineName(pod["name"]) : null,
    state: STATES[rawStatus] ?? "unknown",
    rawStatus,
    gpuType: typeof gpu["id"] === "string" ? gpuFromRunPod(gpu["id"]) : null,
    gpuCount: count(gpu["count"]),
    dataCenter: typeof pod["dataCenterId"] === "string" ? pod["dataCenterId"] : null,
    image: typeof pod["image"] === "string" ? pod["image"] : UNREADABLE,
    diskGb: count(pod["disk"]),
    volumeGb: volumeGb(pod["mounts"]),
    envNames,
    exposedPorts: stringArray(pod["ports"]) ?? [UNREADABLE],
    unexpectedSettings: unexpectedSettings(pod),
    command,
    providerCostPerHour: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? usdToMicros(cost) : null,
    observedAt,
  };
}

export class RunPodAdapter implements ProviderAdapter {
  readonly info: AdapterInfo = {
    provider: "runpod",
    selfIdentity: { env: "RUNPOD_POD_ID" },
    bootTokenEnv: BOOT_TOKEN_ENV,
  };

  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #base: string;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(opts: RunPodOptions) {
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch;
    this.#base = opts.baseUrl ?? RUNPOD_API;
    this.#now = opts.now ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  /** One API call. Network failures and timeouts throw kind "outcome_unknown". */
  async #call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const init: Parameters<Fetch>[1] = {
      method,
      headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    let text;
    try {
      res = await this.#fetch(this.#base + path, init);
      text = await res.text();
    } catch (e) {
      // Never include the request (it carries the key); the error's own name is enough.
      const name = e instanceof Error ? e.name : "error";
      throw new ProviderError("runpod", "outcome_unknown", `RunPod ${method} ${path.split("?")[0]}: no response (${name})`);
    }
    if (res.status >= 300) throw runpodError(res.status, text, res.headers.get("Retry-After"));
    if (text === "") return { status: res.status, json: null };
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      throw new ProviderError("runpod", "unknown", `RunPod ${method} ${path.split("?")[0]}: response is not JSON`, res.status);
    }
  }

  #observedAt(): string {
    return this.#now().toISOString();
  }

  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (!Number.isInteger(query.gpuCount) || query.gpuCount < 1) throw new RangeError("gpuCount must be a positive integer");
    const qs = new URLSearchParams({ include: "AVAILABILITY", product: "POD", cloud: "SECURE", count: String(query.gpuCount) });
    const { json } = await this.#call("GET", `/v2/catalog/gpus?${qs}`);
    if (!isObject(json) || !Array.isArray(json["gpus"])) {
      throw new ProviderError("runpod", "unknown", "RunPod GPU catalog is malformed");
    }
    const gpus = json["gpus"];
    const observedAt = this.#observedAt();
    const offers: Offer[] = [];
    for (const g of gpus) {
      if (!isObject(g) || typeof g["id"] !== "string" || g["secure"] !== true) continue;
      const gpuType = gpuFromRunPod(g["id"]);
      const price = isObject(g["price"]) ? g["price"]["secure"] : undefined;
      if (gpuType === null || typeof price !== "number" || !(price > 0)) continue;
      const perGpu = usdToMicros(price);
      for (const dc of Array.isArray(g["dataCenters"]) ? g["dataCenters"] : []) {
        if (!isObject(dc) || typeof dc["id"] !== "string") continue;
        // A data center we can't place in a country is never offered: no locality can be checked.
        const country = runpodCountry(dc["id"]);
        if (country === null) continue;
        offers.push({
          provider: "runpod",
          gpuType,
          gpuCount: query.gpuCount,
          dataCenter: dc["id"],
          country,
          providerCostPerHour: perGpu * query.gpuCount,
          stock: (typeof dc["availability"] === "string" ? STOCK[dc["availability"]] : undefined) ?? "unknown",
          observedAt,
        });
      }
    }
    return offers;
  }

  /** The create-pod request body for a spec. */
  createBody(spec: LaunchSpec): Record<string, unknown> {
    const gpuId = gpuToRunPod(spec.gpuType);
    if (gpuId === null) throw new ProviderError("runpod", "invalid_request", `RunPod has no GPU type ${spec.gpuType}`);
    if (spec.launcher.length === 0) throw new ProviderError("runpod", "invalid_request", "empty launcher");
    if (spec.bootToken === "") throw new ProviderError("runpod", "invalid_request", "empty boot token");
    return {
      name: machineName(spec.machineId),
      cloud: "SECURE",
      gpu: { id: gpuId, count: spec.gpuCount },
      dataCenterIds: [spec.dataCenter],
      image: spec.image,
      disk: spec.diskGb,
      mounts: {},
      env: { [BOOT_TOKEN_ENV]: spec.bootToken },
      entrypoint: [...spec.launcher],
      cmd: [],
      ports: [],
      startSsh: false,
      startJupyter: false,
    };
  }

  async launch(spec: LaunchSpec): Promise<LaunchResult> {
    const body = this.createBody(spec);
    let json: unknown;
    try {
      ({ json } = await this.#call("POST", "/v2/pods", body));
    } catch (e) {
      if (!(e instanceof ProviderError) || (e.kind !== "outcome_unknown" && e.kind !== "transient")) throw e;
      // The pod may exist even though the call failed: look for it by name before anyone retries.
      const found = await this.#findByMachineId(spec.machineId).catch(() => {
        throw new ProviderError("runpod", "outcome_unknown", `${e.message}; the pod list could not be read`);
      });
      if (found.length === 0) throw e;
      if (found.length > 1) {
        throw new ProviderError("runpod", "outcome_unknown", `${found.length} pods carry machine ${spec.machineId}`);
      }
      return this.#accept(spec, found[0]!);
    }
    let status: ProviderMachineStatus;
    try {
      status = podStatus(json, this.#observedAt());
    } catch {
      // Created, but we can't tell which pod: only a listing by name can find it.
      throw new ProviderError("runpod", "outcome_unknown", "RunPod created a pod but its response has no id");
    }
    return this.#accept(spec, status);
  }

  /**
   * Check a fresh pod against the spec. A pod that doesn't match is reported, not cleaned up
   * here: the caller revokes its boot token first, then terminates it and confirms it is gone
   * (placement's launchWithFallback does).
   */
  #accept(spec: LaunchSpec, status: ProviderMachineStatus): LaunchResult {
    // The scheduler may not have reported the data center yet; the watchdog checks it later.
    const drift = specDrift(expectedSpec(spec, this.info, status.providerMachineId), status).filter(
      (d) => !(d.field === "dataCenter" && status.dataCenter === null),
    );
    if (drift.length > 0) {
      const priceOnly = drift.every((d) => d.field === "providerCostPerHour") && status.providerCostPerHour !== null;
      throw new ProviderError(
        "runpod",
        priceOnly ? "price_above_cap" : "spec_mismatch",
        `launched pod does not match the spec in: ${drift.map((d) => d.field).join(", ")}`,
        null,
        null,
        status.providerMachineId,
      );
    }
    return { providerMachineId: status.providerMachineId, status };
  }

  async status(providerMachineId: string): Promise<ProviderMachineStatus> {
    try {
      const { json } = await this.#call("GET", `/v2/pods/${encodeURIComponent(providerMachineId)}`);
      const s = podStatus(json, this.#observedAt());
      if (s.providerMachineId !== providerMachineId) {
        throw new ProviderError("runpod", "unknown", "RunPod answered a pod query with another pod");
      }
      return s;
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "not_found") return goneStatus(providerMachineId, this.#observedAt());
      throw e;
    }
  }

  async terminate(providerMachineId: string): Promise<void> {
    try {
      await this.#call("DELETE", `/v2/pods/${encodeURIComponent(providerMachineId)}`);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "not_found") return;
      throw e;
    }
  }

  async listMachines(): Promise<ProviderMachineStatus[]> {
    const out: ProviderMachineStatus[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ limit: "1000" });
      if (cursor !== null) qs.set("cursor", cursor);
      const { json } = await this.#call("GET", `/v2/pods?${qs}`);
      const observedAt = this.#observedAt();
      // A malformed page proves nothing: not that a machine is absent, nor that the list is complete.
      if (!isObject(json) || !Array.isArray(json["pods"]) || !isObject(json["pagination"])) {
        throw new ProviderError("runpod", "unknown", "RunPod pod list is malformed");
      }
      const pagination = json["pagination"];
      if (typeof pagination["hasNextPage"] !== "boolean") {
        throw new ProviderError("runpod", "unknown", "RunPod pod list has no hasNextPage");
      }
      for (const pod of json["pods"]) {
        const s = podStatus(pod, observedAt);
        if (s.machineId !== null) out.push(s);
      }
      if (!pagination["hasNextPage"]) return out;
      if (typeof pagination["nextCursor"] !== "string" || pagination["nextCursor"] === "") {
        throw new ProviderError("runpod", "unknown", "RunPod said there is another page but gave no cursor");
      }
      cursor = pagination["nextCursor"];
    }
    // A partial list would hide machines from the watchdog: fail instead.
    throw new ProviderError("runpod", "unknown", `RunPod pod list has more than ${MAX_PAGES} pages`);
  }

  async #findByMachineId(machineId: string): Promise<ProviderMachineStatus[]> {
    return (await this.listMachines()).filter((s) => s.machineId === machineId && s.state !== "terminated");
  }
}

function goneStatus(providerMachineId: string, observedAt: string): ProviderMachineStatus {
  return {
    provider: "runpod",
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
