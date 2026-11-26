// The Vast.ai adapter, over Vast's public REST API (https://console.vast.ai/api). Mock-only: no
// test or code path here has called Vast, and no adapter is wired into the control plane.
//
// Launch shape (as RunPod's): a Docker container on an on-demand, verified, datacenter-hosted
// offer; our launcher in the `args` runtype, so the image must have no ENTRYPOINT of its own and
// the launcher is PID 1; no SSH or Jupyter runtype, no onstart, no template, no volume, no bid;
// never an SSH key (SEC ruling: no attach call and no ssh_key field, ever, and a readback showing
// SSH is refused; only the requests in ROUTES are ever sent);
// the only environment variable is the boot token. Vast's VMs (beta, consumer GPUs only) are never
// used. Offers are per host machine: our data-center id is "machine-<id>", and a launch searches
// that machine's current offer again (offer ids don't last) before accepting it.
//
// From Vast's docs alone, to be confirmed by a probe before any real launch: the response forms of
// GPU names and states, label echo and filtering, the reply to a missing instance, and whether a
// path needs a trailing slash (a redirect is never followed, so a wrong guess fails closed).

import { driftMarkers, specDrift, expectedSpec } from "../drift.ts";
import { ProviderError, type ProviderErrorKind } from "../errors.ts";
import { failureName, isSuccess, readBody, retryAfterSeconds, type Fetch } from "../http.ts";
import { nameFields, parseMachineName, sameMachineName, specNameMatches } from "../machine-name.ts";
import { usdToMicros } from "../money.ts";
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
import { gpuFromVast, gpuToVast, VAST_GPUS, vastCountry, vastDataCenter, vastFilterName, vastMachineId } from "./catalog.ts";

export const VAST_API = "https://console.vast.ai";
export const BOOT_TOKEN_ENV = "SBGPU_BOOT_TOKEN";
/** The most of one reply that is ever read. */
export const MAX_REPLY_BYTES = 4 * 1024 * 1024;
/** Instances per page of the machine list (Vast's maximum). */
const PAGE = 25;
/** A list longer than this many pages fails: a partial list would hide machines. */
export const MAX_PAGES = 100;
const TIMEOUT_MS = 30_000;
/** Offers are priced with this much disk (Vast's price includes storage). A launch prices its own. */
export const OFFER_DISK_GB = 50;
/** Hosts below this reliability score are never offered. */
export const MIN_RELIABILITY = 0.98;

export interface VastOptions {
  /** From the control plane's secrets. Only ever sent in the Authorization header. */
  apiKey: string;
  fetch: Fetch;
  baseUrl?: string;
  now?: () => Date;
  timeoutMs?: number;
}

/** Which kind of call failed: Vast's 404 means a bad key on a search and a gone offer on a create. */
export type VastCall = "offers" | "create" | "instance";

/**
 * Map one Vast HTTP error to a ProviderError. Vast's error bodies are never read or kept: they can
 * echo request values. Messages hold only the status and our kind.
 */
export function vastError(status: number, retryAfter: string | null, call: VastCall): ProviderError {
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
              ? call === "offers" ? "auth" : call === "create" ? "no_capacity" : "not_found"
              : status === 410 && call === "create"
                ? "no_capacity"
                : status === 409
                  ? "unplaceable"
                  : status === 429
                    ? "rate_limited"
                    : status >= 500 && status <= 599
                      ? "transient"
                      : "unknown";
  return new ProviderError("vast", kind, `Vast HTTP ${status} (${kind})`, status, status === 429 ? retryAfterSeconds(retryAfter) : null);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * The value that stands for a field Vast sent malformed or not at all. It never equals an
 * expected value, so specDrift reports the field and the machine is terminated.
 */
export const UNREADABLE = "<unreadable>";

/** A positive safe integer id, or null. */
function intId(x: unknown): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? x : null;
}

/** A non-negative integer, or NaN (which never equals an expected number). */
function count(x: unknown): number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : Number.NaN;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Bounds on what one status keeps of Vast's strings: a field past them is unreadable (so it
 * drifts), never copied whole. With the page size enforced and MAX_LIST_CHARS over the whole list,
 * a machine list retains a bounded amount whatever Vast sends.
 */
export const MAX_IMAGE_CHARS = 512;
export const MAX_ARGS = 64;
export const MAX_COMMAND_CHARS = 8192;
export const MAX_ENV = 32;
const MAX_ENV_ENTRY_CHARS = 8192;
export const MAX_PORTS = 32;
const MAX_PORT_CHARS = 32;
/** The most status text one machine list may retain; a longer list is refused, never returned in part. */
export const MAX_LIST_CHARS = 1_000_000;

/**
 * A short provider word, kept whole, or null when it is long. Never a slice: a short slice (or a
 * template over one) of a long string keeps the whole long string alive.
 */
function shortWord(x: unknown, max = 32): string | null {
  return typeof x === "string" && x.length <= max ? x : null;
}

/** A fresh copy of a short string, holding nothing of the string it was cut from. */
function detached(s: string): string {
  return JSON.parse(JSON.stringify(s)) as string;
}

/** The characters of text a status keeps: what MAX_LIST_CHARS counts. */
export function retainedChars(s: ProviderMachineStatus): number {
  const sum = (xs: readonly string[]) => xs.reduce((n, x) => n + x.length, 0);
  return (
    s.providerMachineId.length +
    (s.machineId?.length ?? 0) +
    s.rawStatus.length +
    (s.gpuType?.length ?? 0) +
    (s.dataCenter?.length ?? 0) +
    s.image.length +
    sum(s.envNames) +
    sum(s.exposedPorts) +
    sum(s.unexpectedSettings) +
    sum(s.command) +
    s.observedAt.length
  );
}

/**
 * Environment variable names from an instance's `extra_env`: entries "NAME=value" or
 * ["NAME", "value"]. Null or absent is none; anything else is unreadable (fails closed).
 */
function envNamesOf(extraEnv: unknown): string[] {
  if (extraEnv === null || extraEnv === undefined) return [];
  if (!Array.isArray(extraEnv) || extraEnv.length > MAX_ENV) return [UNREADABLE];
  const out: string[] = [];
  for (const e of extraEnv) {
    if (typeof e === "string" && e.length > MAX_ENV_ENTRY_CHARS) return [UNREADABLE];
    const name = typeof e === "string" ? (e.includes("=") ? e.slice(0, e.indexOf("=")) : undefined) : Array.isArray(e) && e.length === 2 && typeof e[1] === "string" ? e[0] : undefined;
    if (typeof name !== "string" || !ENV_NAME.test(name)) return [UNREADABLE];
    // its own copy: a slice would keep the whole entry, value included, alive
    out.push(detached(name));
  }
  return out;
}

/**
 * An instance's state, from Vast's actual and intended statuses. Running only when both say so.
 * A stopped instance still bills its disk and is of no use to us: failed, so it is terminated.
 */
export function vastState(actual: unknown, intended: unknown): MachineState {
  if (intended === "stopped" || actual === "stopped") return "failed";
  if (actual === "exited" || actual === "unknown" || actual === "offline") return "failed";
  if (intended !== "running") return "unknown";
  if (actual === "running") return "running";
  if (actual === null || actual === "created" || actual === "loading" || actual === "scheduling") return "provisioning";
  return "unknown";
}

/** Whether an instance field holds anything: not absent, null, empty, false or an empty list. */
function isSet(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0);
}

/**
 * SSH on an instance (SEC ruling: refused): a host or port, or any other field named for SSH that
 * holds anything (key material included), as "ssh:host", "ssh:port", "ssh:key" or "ssh:set".
 */
function sshSettings(inst: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (isSet(inst["ssh_host"])) out.push("ssh:host");
  if (isSet(inst["ssh_port"])) out.push("ssh:port");
  for (const k of Object.keys(inst)) {
    if (k === "ssh_host" || k === "ssh_port" || !/ssh/i.test(k) || !isSet(inst[k])) continue;
    out.push(/key/i.test(k) ? "ssh:key" : "ssh:set");
  }
  return [...new Set(out)];
}

/** Vast settings outside our launch shape, as "name:value"; missing or malformed ones too. */
function unexpectedSettings(inst: Record<string, unknown>): string[] {
  const out: string[] = sshSettings(inst);
  const rt = inst["image_runtype"];
  if (rt !== "args") out.push(`runtype:${shortWord(rt) ?? UNREADABLE}`);
  if (inst["is_bid"] !== false) out.push(`bid:${inst["is_bid"] === true ? "true" : UNREADABLE}`);
  const onstart = inst["onstart"];
  if (onstart !== null && onstart !== undefined && onstart !== "") out.push(`onstart:${typeof onstart === "string" ? "set" : UNREADABLE}`);
  const jt = inst["jupyter_token"];
  if (jt !== null && jt !== undefined && jt !== "") out.push(`jupyter:${typeof jt === "string" ? "set" : UNREADABLE}`);
  for (const k of ["template_id", "template_hash_id"]) {
    const v = inst[k];
    if (v !== null && v !== undefined && v !== "") out.push(`template:${k}`);
  }
  const ver = inst["verification"];
  if (ver !== "verified") out.push(`verification:${shortWord(ver) ?? UNREADABLE}`);
  return out;
}

/**
 * A Vast instance object as our ProviderMachineStatus. Only a missing id throws: every other field
 * that is missing or malformed is kept as an unreadable value, so the drift check fails closed.
 */
export function instanceStatus(inst: unknown, observedAt: string): ProviderMachineStatus {
  const id = isObject(inst) ? intId(inst["id"]) : null;
  if (!isObject(inst) || id === null) throw new ProviderError("vast", "unknown", "Vast returned an instance without an id");
  const actual = inst["actual_status"];
  const intended = inst["intended_status"];
  const ports = inst["ports"];
  const portNames = isObject(ports) ? Object.keys(ports) : null;
  const image = inst["image_uuid"];
  const args = inst["image_args"];
  const cost = inst["dph_total"];
  const vol = inst["volume_info"];
  return {
    provider: "vast",
    providerMachineId: String(id),
    ...nameFields(shortWord(inst["label"], 64)),
    state: vastState(actual, intended),
    rawStatus: `${statusWord(actual)}/${statusWord(intended)}`,
    gpuType: typeof inst["gpu_name"] === "string" ? gpuFromVast(inst["gpu_name"], inst["gpu_ram"]) : null,
    gpuCount: count(inst["num_gpus"]),
    dataCenter: vastDataCenter(inst["machine_id"]),
    image: typeof image === "string" && image.length <= MAX_IMAGE_CHARS ? image : UNREADABLE,
    diskGb: count(inst["disk_space"]),
    // Any attached volume is never ours (we attach none): never "no volume".
    volumeGb: vol === null || vol === undefined ? 0 : Number.POSITIVE_INFINITY,
    envNames: envNamesOf(inst["extra_env"]),
    exposedPorts:
      ports === null || ports === undefined
        ? []
        : portNames !== null && portNames.length <= MAX_PORTS && portNames.every((k) => k.length <= MAX_PORT_CHARS)
          ? portNames.sort()
          : [UNREADABLE],
    unexpectedSettings: unexpectedSettings(inst),
    // The launcher goes in `args` to an image without an ENTRYPOINT: the args are the command.
    command: commandOf(args),
    providerCostPerHour: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? usdToMicros(cost) : null,
    observedAt,
  };
}

/** A status word for rawStatus: a short string as is, null as "null", anything else unreadable. */
function statusWord(x: unknown): string {
  return x === null || x === undefined ? "null" : (shortWord(x) ?? UNREADABLE);
}

/** The image args, copied only within MAX_ARGS and MAX_COMMAND_CHARS; anything else is unreadable. */
function commandOf(args: unknown): string[] {
  if (!Array.isArray(args) || args.length > MAX_ARGS) return [UNREADABLE];
  let chars = 0;
  for (const a of args) {
    if (typeof a !== "string") return [UNREADABLE];
    chars += a.length;
    if (chars > MAX_COMMAND_CHARS) return [UNREADABLE];
  }
  return [...args];
}

/** One usable offer from a search reply, or null: every rule the search filters on, checked again. */
function usableOffer(o: unknown, gpuCount: number): { askId: number; gpuType: string; dataCenter: string; country: string; usdPerHour: number } | null {
  if (!isObject(o)) return null;
  const askId = intId(o["id"]);
  const gpuType = typeof o["gpu_name"] === "string" ? gpuFromVast(o["gpu_name"], o["gpu_ram"]) : null;
  const dataCenter = vastDataCenter(o["machine_id"]);
  const country = vastCountry(o["geolocation"]);
  const usd = o["dph_total"];
  const reliability = o["reliability"];
  if (askId === null || gpuType === null || dataCenter === null || country === null) return null;
  if (o["num_gpus"] !== gpuCount || o["rentable"] !== true || o["rented"] !== false || o["is_bid"] !== false || o["verification"] !== "verified") return null;
  // Datacenter hosting must be in the reply itself, not only asked for in the search: an offer
  // without an exact `datacenter: true` is never usable (Vast documents the field as a search
  // filter; whether replies carry it is a probe item, and until then no offer is usable).
  if (o["datacenter"] !== true) return null;
  if (typeof reliability !== "number" || !(reliability >= MIN_RELIABILITY)) return null;
  if (typeof usd !== "number" || !Number.isFinite(usd) || !(usd > 0)) return null;
  return { askId, gpuType, dataCenter, country, usdPerHour: usd };
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * The only requests this adapter ever sends, each an exact method, path and query shape: the
 * offer search, the create, one instance's show and delete, and the instance list. Never an
 * SSH-key call (SEC ruling).
 */
const ROUTES: ReadonlyArray<{ method: Method; path: RegExp; query: "none" | "list"; body: boolean }> = [
  { method: "POST", path: /^\/api\/v0\/bundles\/?$/, query: "none", body: true },
  { method: "PUT", path: /^\/api\/v0\/asks\/[0-9]{1,18}\/?$/, query: "none", body: true },
  { method: "GET", path: /^\/api\/v0\/instances\/[0-9]{1,18}\/?$/, query: "none", body: false },
  { method: "DELETE", path: /^\/api\/v0\/instances\/[0-9]{1,18}\/?$/, query: "none", body: false },
  { method: "GET", path: /^\/api\/v1\/instances\/?$/, query: "list", body: false },
];

/**
 * The list's query, decoded: exactly the keys the list sends, each once, each value in its shape:
 * `limit` (required), `select_filters` (exactly {"label": {"eq": <one of our machine names>}})
 * and `after_token` (the page token Vast gave). Any other key, encoded or not, is refused.
 */
function listQueryOk(query: string): boolean {
  if (!/^[A-Za-z0-9%._~&=+-]*$/.test(query)) return false;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return false;
  }
  const seen = new Set<string>();
  for (const [k, v] of params) {
    if (seen.has(k)) return false;
    seen.add(k);
    if (k === "limit") {
      if (!/^[1-9][0-9]{0,2}$/.test(v)) return false;
    } else if (k === "select_filters") {
      let f: unknown;
      try {
        f = JSON.parse(v);
      } catch {
        return false;
      }
      const label = isObject(f) && Object.keys(f).length === 1 && isObject(f["label"]) && Object.keys(f["label"]).length === 1 ? f["label"]["eq"] : undefined;
      if (typeof label !== "string" || parseMachineName(label) === null) return false;
    } else if (k === "after_token") {
      if (!/^[A-Za-z0-9._~+/=:-]{1,512}$/.test(v)) return false;
    } else {
      return false;
    }
  }
  return seen.has("limit");
}

/** Whether a body names SSH anywhere: in any key, at any depth. */
function namesSsh(x: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (Array.isArray(x)) return x.some((v) => namesSsh(v, depth + 1));
  if (!isObject(x)) return false;
  return Object.keys(x).some((k) => /ssh/i.test(k) || namesSsh(x[k], depth + 1));
}

/**
 * Whether a request is one of ours: a route's exact method and path, its query shape (none, or the
 * list's exact keys), a body exactly where the route has one, and no SSH field in that body.
 */
export function allowedRequest(method: string, path: string, body: unknown): boolean {
  const q = path.indexOf("?");
  const pathname = q < 0 ? path : path.slice(0, q);
  const query = q < 0 ? null : path.slice(q + 1);
  return ROUTES.some(
    (r) =>
      r.method === method &&
      r.path.test(pathname) &&
      (r.query === "none" ? query === null : query !== null && listQueryOk(query)) &&
      (r.body ? isObject(body) && !namesSsh(body) : body === undefined),
  );
}

/** A Docker image name we pass on (the control plane's allowlist decides which). */
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/:@-]{0,255}$/;
/** The boot token is base64url: safe inside Vast's Docker-flag `env` string. */
const BOOT_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

export class VastAdapter implements ProviderAdapter {
  readonly info: AdapterInfo = {
    provider: "vast",
    selfIdentity: { env: "CONTAINER_ID" },
    bootDelivery: { kind: "env", name: BOOT_TOKEN_ENV },
  };

  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #base: string;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(opts: VastOptions) {
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch;
    this.#base = opts.baseUrl ?? VAST_API;
    this.#now = opts.now ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * One API call. Network failures and timeouts throw kind "outcome_unknown", and so does a
   * `shouldStop` that says to stop before the request is sent. An error status is classified
   * before any body read: an error reply's body is never read.
   */
  async #call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, call: VastCall, body?: unknown, shouldStop?: () => boolean): Promise<unknown> {
    const where = `Vast ${method} ${path.split("?")[0]}`;
    // (before anything is sent: a request outside the fixed set is a bug, and fails closed)
    if (!allowedRequest(method, path, body)) throw new ProviderError("vast", "invalid_request", "Vast: a request outside the adapter's fixed set");
    if (shouldStop?.() === true) throw new ProviderError("vast", "outcome_unknown", `${where}: stopped at the caller's deadline`);
    const deadline = Date.now() + this.#timeoutMs;
    const init: Parameters<Fetch>[1] = {
      method,
      headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(this.#timeoutMs),
      // Never follow a redirect: the key header would go to wherever it points.
      redirect: "manual",
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await this.#fetch(this.#base + path, init);
    } catch (e) {
      // Never include the request (it carries the key), nor the exception's text: a fixed name.
      throw new ProviderError("vast", "outcome_unknown", `${where}: no response (${failureName(e)})`);
    }
    if (!isSuccess(res.status)) throw vastError(res.status, res.headers.get("Retry-After"), call);
    // Within the same deadline and at most MAX_REPLY_BYTES. A reply that can't be read whole is
    // like a lost reply to a change (it may have happened) and a failed read.
    const read = await readBody(res, MAX_REPLY_BYTES, deadline);
    const changes = method !== "GET" && call !== "offers";
    if (!read.ok) throw new ProviderError("vast", changes ? "outcome_unknown" : "unknown", `${where}: reply not read (${read.why})`, res.status);
    if (read.text === "") return null;
    try {
      return JSON.parse(read.text);
    } catch {
      throw new ProviderError("vast", changes ? "outcome_unknown" : "unknown", `${where}: response is not JSON`, res.status);
    }
  }

  #observedAt(): string {
    return this.#now().toISOString();
  }

  /** The search body: every hard rule as a filter (and each is checked again on the reply). */
  searchBody(gpuCount: number, diskGb: number, only?: { gpuName: string; machineId: number }): Record<string, unknown> {
    return {
      limit: only === undefined ? 1000 : 10,
      type: "on-demand",
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      datacenter: { eq: true },
      reliability: { gte: MIN_RELIABILITY },
      num_gpus: { eq: gpuCount },
      gpu_name: only === undefined ? { in: Object.keys(VAST_GPUS).map(vastFilterName) } : { eq: vastFilterName(only.gpuName) },
      ...(only === undefined ? {} : { machine_id: { eq: only.machineId } }),
      allocated_storage: diskGb,
      order: [["dph_total", "asc"]],
    };
  }

  async #search(body: Record<string, unknown>, gpuCount: number, shouldStop?: () => boolean) {
    const json = await this.#call("POST", "/api/v0/bundles/", "offers", body, shouldStop);
    // The reference's example shows one object where its schema says an array: only an array is read.
    if (!isObject(json) || !Array.isArray(json["offers"])) throw new ProviderError("vast", "unknown", "Vast offer search reply is malformed");
    return json["offers"].map((o) => usableOffer(o, gpuCount)).filter((o) => o !== null);
  }

  /** Current offers: the cheapest usable one per GPU type and host machine, priced with OFFER_DISK_GB of disk. */
  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (!Number.isInteger(query.gpuCount) || query.gpuCount < 1) throw new RangeError("gpuCount must be a positive integer");
    const found = await this.#search(this.searchBody(query.gpuCount, OFFER_DISK_GB), query.gpuCount);
    const observedAt = this.#observedAt();
    const best = new Map<string, Offer>();
    for (const o of found) {
      const key = `${o.gpuType}\u0000${o.dataCenter}`;
      const cost = usdToMicros(o.usdPerHour);
      const prev = best.get(key);
      if (prev !== undefined && prev.providerCostPerHour <= cost) continue;
      best.set(key, {
        provider: "vast",
        gpuType: o.gpuType,
        gpuCount: query.gpuCount,
        dataCenter: o.dataCenter,
        country: o.country,
        providerCostPerHour: cost,
        // One rentable offer on one machine: whether it lasts is a hint at best.
        stock: "unknown",
        observedAt,
      });
    }
    return [...best.values()];
  }

  /** The create (accept-offer) request body for a spec. */
  createBody(spec: LaunchSpec): Record<string, unknown> {
    if (gpuToVast(spec.gpuType) === null) throw new ProviderError("vast", "invalid_request", "Vast: GPU type not offered");
    if (vastMachineId(spec.dataCenter) === null) throw new ProviderError("vast", "invalid_request", "Vast: not a Vast machine id");
    if (!Number.isSafeInteger(spec.gpuCount) || spec.gpuCount < 1) throw new ProviderError("vast", "invalid_request", "Vast: bad GPU count");
    if (!Number.isSafeInteger(spec.diskGb) || spec.diskGb < 1) throw new ProviderError("vast", "invalid_request", "Vast: bad disk size");
    if (typeof spec.image !== "string" || !IMAGE_NAME.test(spec.image)) throw new ProviderError("vast", "invalid_request", "Vast: bad image name");
    if (spec.launcher.length === 0) throw new ProviderError("vast", "invalid_request", "empty launcher");
    if (!BOOT_TOKEN.test(spec.bootToken)) throw new ProviderError("vast", "invalid_request", "Vast: bad boot token");
    if (!specNameMatches(spec)) throw new ProviderError("vast", "invalid_request", "Vast: the spec's name isn't its machine's");
    return {
      image: spec.image,
      label: spec.name,
      disk: spec.diskGb,
      runtype: "args",
      args: [...spec.launcher],
      env: `-e ${BOOT_TOKEN_ENV}=${spec.bootToken}`,
      target_state: "running",
      cancel_unavail: true,
      vm: false,
    };
  }

  async launch(spec: LaunchSpec, opts: LaunchOptions = {}): Promise<LaunchResult> {
    const body = this.createBody(spec);
    const stop = opts.shouldStop;
    const machine = vastMachineId(spec.dataCenter)!;
    const gpuName = gpuToVast(spec.gpuType)!;
    if (stop?.() === true) throw new ProviderError("vast", "unknown", "stopped at the caller's deadline before launching");
    // This machine's offer as it is now, priced with this launch's disk.
    let offers;
    try {
      offers = await this.#search(this.searchBody(spec.gpuCount, spec.diskGb, { gpuName, machineId: machine }), spec.gpuCount, stop);
    } catch (e) {
      // Nothing was created by a search: an unknown outcome here is a plain failure.
      if (e instanceof ProviderError && e.kind === "outcome_unknown") throw new ProviderError("vast", "unknown", e.message, e.httpStatus);
      throw e;
    }
    const ask = offers.find((o) => o.gpuType === spec.gpuType && o.dataCenter === spec.dataCenter);
    if (ask === undefined) throw new ProviderError("vast", "no_capacity", "Vast: the machine has no usable offer now");
    if (usdToMicros(ask.usdPerHour) > spec.maxProviderCostPerHour) throw new ProviderError("vast", "unplaceable", "Vast: the offer is above the price cap now");
    if (stop?.() === true) throw new ProviderError("vast", "unknown", "stopped at the caller's deadline before launching");

    let id: string;
    try {
      id = createdId(await this.#call("PUT", `/api/v0/asks/${ask.askId}/`, "create", body, stop));
    } catch (e) {
      if (!(e instanceof ProviderError) || (e.kind !== "outcome_unknown" && e.kind !== "transient")) throw e;
      // The instance may exist even though the call failed: look for it by name before anyone retries.
      id = await this.#recover(body["label"] as string, e, stop);
    }
    if (stop?.() === true) {
      throw new ProviderError("vast", "outcome_unknown", `stopped at the caller's deadline after creating instance ${id}`, null, null, id);
    }
    let status: ProviderMachineStatus;
    try {
      status = await this.#read(id);
    } catch {
      throw new ProviderError("vast", "unknown", `Vast instance ${id} could not be read back`, null, null, id);
    }
    return this.#accept(spec, status);
  }

  /** After a create whose outcome is unknown: one list, filtered by our exact label. */
  async #recover(label: string, cause: ProviderError, stop: (() => boolean) | undefined): Promise<string> {
    let found: ProviderMachineStatus[];
    try {
      found = (await this.#list(stop, label)).filter((s) => s.state !== "terminated");
    } catch {
      throw new ProviderError("vast", "outcome_unknown", `${cause.message}; the instance list could not be read`);
    }
    if (found.length === 0) throw cause;
    if (found.length > 1) {
      const ids = found.map((s) => s.providerMachineId);
      throw new ProviderError("vast", "outcome_unknown", `${ids.length} instances carry label ${label}: ${ids.join(", ")}`, null, null, ids[0]!);
    }
    return found[0]!.providerMachineId;
  }

  /**
   * Check a fresh instance against the spec. One that doesn't match is reported, not cleaned up
   * here: the caller revokes its boot token first, then terminates it and confirms it is gone.
   */
  #accept(spec: LaunchSpec, status: ProviderMachineStatus): LaunchResult {
    const drift = specDrift(expectedSpec(spec, this.info, status.providerMachineId), status);
    if (drift.length > 0) {
      const priceOnly = drift.every((d) => d.field === "providerCostPerHour") && status.providerCostPerHour !== null;
      throw new ProviderError(
        "vast",
        priceOnly ? "price_above_cap" : "spec_mismatch",
        `launched instance does not match the spec in: ${drift.map((d) => d.field).join(", ")}`,
        null,
        null,
        status.providerMachineId,
        driftMarkers(drift, status),
      );
    }
    return { providerMachineId: status.providerMachineId, status };
  }

  /** One instance, as Vast reports it; another instance's answer, or none, fails. */
  async #read(id: string): Promise<ProviderMachineStatus> {
    const json = await this.#call("GET", `/api/v0/instances/${id}/`, "instance");
    const inst = isObject(json) ? json["instances"] : undefined;
    // What Vast answers for a destroyed instance isn't documented beyond a 404: anything else that
    // isn't this instance is an error, never "gone".
    if (!isObject(inst)) throw new ProviderError("vast", "unknown", "Vast instance reply has no instance");
    const s = instanceStatus(inst, this.#observedAt());
    if (s.providerMachineId !== id) throw new ProviderError("vast", "unknown", "Vast answered an instance query with another instance");
    return s;
  }

  async status(providerMachineId: string): Promise<ProviderMachineStatus> {
    if (!/^[1-9][0-9]{0,15}$/.test(providerMachineId)) throw new ProviderError("vast", "invalid_request", "not a Vast instance id");
    try {
      return await this.#read(providerMachineId);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "not_found") return goneStatus(providerMachineId, this.#observedAt());
      throw e;
    }
  }

  /** Destroy, never stop: a stopped instance keeps billing its disk. Idempotent: gone is done. */
  async terminate(providerMachineId: string): Promise<void> {
    if (!/^[1-9][0-9]{0,15}$/.test(providerMachineId)) throw new ProviderError("vast", "invalid_request", "not a Vast instance id");
    let json: unknown;
    try {
      json = await this.#call("DELETE", `/api/v0/instances/${providerMachineId}/`, "instance");
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "not_found") return;
      throw e;
    }
    if (!isObject(json) || json["success"] !== true) {
      throw new ProviderError("vast", "outcome_unknown", `Vast destroy of ${providerMachineId} did not say it succeeded`);
    }
  }

  async listMachines(opts: LaunchOptions = {}): Promise<ProviderMachineStatus[]> {
    return this.#list(opts.shouldStop);
  }

  /** Every instance of ours (by name), page by page; with `label`, only instances with that exact label. */
  async #list(shouldStop?: () => boolean, label?: string): Promise<ProviderMachineStatus[]> {
    const out: ProviderMachineStatus[] = [];
    let retained = 0;
    let token: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (label !== undefined) qs.set("select_filters", JSON.stringify({ label: { eq: label } }));
      if (token !== null) qs.set("after_token", token);
      const json = await this.#call("GET", `/api/v1/instances/?${qs}`, "instance", undefined, shouldStop);
      const observedAt = this.#observedAt();
      // A malformed page proves nothing: not that a machine is absent, nor that the list is complete.
      if (!isObject(json) || !Array.isArray(json["instances"])) {
        throw new ProviderError("vast", "unknown", "Vast instance list is malformed");
      }
      // The page size is enforced, not just asked for: a longer page proves the list isn't what we asked.
      if (json["instances"].length > PAGE) throw new ProviderError("vast", "unknown", `Vast instance list page has more than ${PAGE} rows`);
      for (const inst of json["instances"]) {
        const s = instanceStatus(inst, observedAt);
        if (s.machineId === null) continue;
        // A filter Vast ignored must not widen a by-label answer.
        if (label !== undefined && !sameMachineName(s.parsedName, label)) continue;
        retained += retainedChars(s);
        if (retained > MAX_LIST_CHARS) throw new ProviderError("vast", "unknown", "Vast instance list is too large to keep");
        out.push(s);
      }
      // null is the last page; absent or anything else isn't a page boundary we can trust
      const next = json["next_token"];
      if (next === null) return out;
      if (typeof next !== "string" || next === "") throw new ProviderError("vast", "unknown", "Vast instance list has a bad next_token");
      token = next;
    }
    throw new ProviderError("vast", "unknown", `Vast instance list has more than ${MAX_PAGES} pages`);
  }
}

/**
 * The instance id in a create reply: `new_contract` with success true; anything else may have
 * created one. Only these two fields are read. The reply also carries `instance_api_key`, a secret:
 * it is never read, and the reply is never kept, returned or put in an error (SEC ruling).
 */
function createdId(json: unknown): string {
  const id = isObject(json) && json["success"] === true ? intId(json["new_contract"]) : null;
  if (id === null) throw new ProviderError("vast", "outcome_unknown", "Vast create reply has no new_contract");
  return String(id);
}

function goneStatus(providerMachineId: string, observedAt: string): ProviderMachineStatus {
  return {
    provider: "vast",
    providerMachineId,
    machineId: null,
    parsedName: null,
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
