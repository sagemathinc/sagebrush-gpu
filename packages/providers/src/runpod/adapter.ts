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

/** Map one RunPod HTTP error to a ProviderError (see RunPod's create-pod retry table). */
export function runpodError(status: number, body: string, retryAfter: string | null): ProviderError {
  const detail = errorDetail(body);
  const kind: ProviderErrorKind =
    status === 400
      ? NO_CAPACITY.test(detail) ? "no_capacity" : "unplaceable"
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
    `RunPod ${status}: ${detail}`,
    status,
    status === 429 ? retryAfterSeconds(retryAfter) : null,
  );
}

function errorDetail(body: string): string {
  let detail = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isObject(parsed)) {
      const d = parsed["detail"];
      const errs = parsed["errors"];
      detail = typeof d === "string" ? d : body;
      if (Array.isArray(errs) && errs.length > 0) detail += ` (${errs.filter((e) => typeof e === "string").join("; ")})`;
    }
  } catch {
    // not JSON: keep the raw text
  }
  return detail.slice(0, 300);
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

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
}

function num(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

/** A RunPod Pod object as our ProviderMachineStatus. Unknown or missing values stay visible. */
export function podStatus(pod: unknown, observedAt: string): ProviderMachineStatus {
  if (!isObject(pod) || typeof pod["id"] !== "string") {
    throw new ProviderError("runpod", "unknown", "RunPod returned a pod without an id");
  }
  const gpu = isObject(pod["gpu"]) ? pod["gpu"] : {};
  const mounts = isObject(pod["mounts"]) ? pod["mounts"] : {};
  const persistent = isObject(mounts["persistent"]) ? mounts["persistent"] : {};
  const network = Array.isArray(mounts["network"]) ? mounts["network"].length : 0;
  const globalVolumes = Array.isArray(mounts["global"]) ? mounts["global"].length : 0;
  const env = isObject(pod["env"]) ? Object.keys(pod["env"]) : [];
  const rawStatus = typeof pod["status"] === "string" ? pod["status"] : "";
  const entrypoint = strings(pod["entrypoint"]);
  const cmd = strings(pod["cmd"]);
  const args = typeof pod["args"] === "string" ? pod["args"] : "";
  // RunPod returns both forms; if only the raw string is there, keep it so it can't match an argv.
  const command =
    pod["entrypoint"] === undefined && pod["cmd"] === undefined && args !== "" ? [`args:${args}`] : [...entrypoint, ...cmd];
  const cost = pod["cost"];
  return {
    provider: "runpod",
    providerMachineId: pod["id"],
    machineId: typeof pod["name"] === "string" ? parseMachineName(pod["name"]) : null,
    state: STATES[rawStatus] ?? "unknown",
    rawStatus,
    gpuType: typeof gpu["id"] === "string" ? gpuFromRunPod(gpu["id"]) : null,
    gpuCount: num(gpu["count"], 0),
    dataCenter: typeof pod["dataCenterId"] === "string" ? pod["dataCenterId"] : null,
    image: typeof pod["image"] === "string" ? pod["image"] : "",
    diskGb: num(pod["disk"], 0),
    // Any network or global volume counts as a volume of unknown size: never expected.
    volumeGb: num(persistent["size"], 0) + (network + globalVolumes > 0 ? Number.POSITIVE_INFINITY : 0),
    envNames: env,
    exposedPorts: strings(pod["ports"]),
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
    const gpus = isObject(json) && Array.isArray(json["gpus"]) ? json["gpus"] : [];
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
    return this.#accept(spec, podStatus(json, this.#observedAt()));
  }

  /** Check a fresh pod against the spec; anything wrong terminates it before it is used. */
  async #accept(spec: LaunchSpec, status: ProviderMachineStatus): Promise<LaunchResult> {
    // The scheduler may not have reported the data center yet; the watchdog checks it later.
    const drift = specDrift(expectedSpec(spec, this.info, status.providerMachineId), status).filter(
      (d) => !(d.field === "dataCenter" && status.dataCenter === null),
    );
    if (drift.length > 0) {
      await this.terminate(status.providerMachineId);
      const priceOnly = drift.every((d) => d.field === "providerCostPerHour") && status.providerCostPerHour !== null;
      throw new ProviderError(
        "runpod",
        priceOnly ? "price_above_cap" : "invalid_request",
        `launched pod did not match the spec and was terminated: ${drift.map((d) => `${d.field} ${d.observed} (expected ${d.expected})`).join("; ")}`,
      );
    }
    return { providerMachineId: status.providerMachineId, status };
  }

  async status(providerMachineId: string): Promise<ProviderMachineStatus> {
    try {
      const { json } = await this.#call("GET", `/v2/pods/${encodeURIComponent(providerMachineId)}`);
      return podStatus(json, this.#observedAt());
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
      const pods = isObject(json) && Array.isArray(json["pods"]) ? json["pods"] : [];
      for (const pod of pods) {
        const s = podStatus(pod, observedAt);
        if (s.machineId !== null) out.push(s);
      }
      const pagination = isObject(json) && isObject(json["pagination"]) ? json["pagination"] : {};
      if (pagination["hasNextPage"] !== true) return out;
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
    command: [],
    providerCostPerHour: null,
    observedAt,
  };
}
