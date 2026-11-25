// The Hyperstack adapter, over Hyperstack's public Infrahub API (https://infrahub-api.nexgencloud.com/v1).
// Mock-only: no test or code path here has called Hyperstack.
//
// Hyperstack is a VM provider. VM mode's boot credential design is cleared, but no launch is: this
// adapter's launch() refuses before any request until the create path lands under its own review.
// Offers, status, the machine list, terminate, the per-launch keypair and the readback checks the
// announce gate needs are here, so they can be reviewed first.

import type { webcrypto } from "node:crypto";

import { ProviderError, type ProviderErrorKind } from "../errors.ts";
import { failureName, retryAfterSeconds, type Fetch } from "../http.ts";
import { parseMachineName } from "../machine-name.ts";
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
import { gpuFromHyperstack, hyperstackCountry } from "./catalog.ts";

export const HYPERSTACK_API = "https://infrahub-api.nexgencloud.com/v1";
/** VMs per page of the machine list. */
const PAGE = 100;
const MAX_PAGES = 50;
const TIMEOUT_MS = 30_000;

export interface HyperstackOptions {
  /** From the control plane's secrets. Only ever sent in the `api_key` header. */
  apiKey: string;
  fetch: Fetch;
  baseUrl?: string;
  now?: () => Date;
  timeoutMs?: number;
}

/** A Hyperstack HTTP error as a ProviderError. Response bodies are never read or kept. */
export function hyperstackError(status: number, retryAfter: string | null): ProviderError {
  const kind: ProviderErrorKind =
    status === 400 || status === 405 || status === 422
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
  return new ProviderError("hyperstack", kind, `Hyperstack HTTP ${status} (${kind})`, status, status === 429 ? retryAfterSeconds(retryAfter) : null);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Hyperstack's VM statuses (its "VM States and Billing" table). Anything else is unknown. */
const STATES: Readonly<Record<string, MachineState>> = {
  CREATING: "provisioning",
  BUILD: "provisioning",
  STARTING: "provisioning",
  RESTORING: "provisioning",
  REBOOTING: "provisioning",
  ACTIVE: "running",
  STOPPING: "stopping",
  SHUTOFF: "stopping",
  HIBERNATING: "stopping",
  HIBERNATED: "stopping",
  DELETING: "stopping",
  ERROR: "failed",
  DELETED: "terminated",
};

export const UNREADABLE = "<unreadable>";

/** A VM's command: Hyperstack doesn't echo user_data, so no VM ever matches a launcher by its echo. */
export const VM_COMMAND: readonly string[] = Object.freeze(["<hyperstack-vm>"]);

function count(x: unknown): number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : Number.NaN;
}

const IPV4 = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

/**
 * Blocks no VM address may be in: every block of IANA's IPv4 Special-Purpose Address Registry
 * that isn't globally reachable (all of 192.0.0.0/24, and all of the deprecated 192.88.99.0/24 for
 * its 6a44 relay address), multicast, and the reserved 240.0.0.0/4 with the broadcast address.
 */
const NOT_GLOBAL: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4Number(x: string): number {
  return x.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

/** A globally reachable IPv4 address, in dotted-quad form without leading zeros. */
export function isPublicIpv4(x: unknown): boolean {
  if (typeof x !== "string" || !IPV4.test(x)) return false;
  const n = ipv4Number(x);
  for (const [base, bits] of NOT_GLOBAL) {
    const size = 2 ** (32 - bits);
    if (Math.floor(n / size) === Math.floor(ipv4Number(base) / size)) return false;
  }
  return true;
}

/** Hyperstack settings that differ from the VM-mode launch shape (draft 5). */
function unexpectedSettings(vm: Record<string, unknown>): string[] {
  const out: string[] = [];
  const rules = vm["security_rules"];
  if (!Array.isArray(rules)) out.push(`security_rules:${UNREADABLE}`);
  else if (rules.length > 0) out.push("security_rules");
  if (vm["port_randomization"] !== false) out.push(`port_randomization:${vm["port_randomization"] === true ? "enabled" : UNREADABLE}`);
  const em = vm["enhanced_metrics"];
  const enabled = isObject(em) ? em["enabled"] : undefined;
  if (enabled !== false) out.push(`enhanced_metrics:${enabled === true ? "enabled" : UNREADABLE}`);
  if (!isPublicIpv4(vm["floating_ip"])) out.push(`floating_ip:${vm["floating_ip"] === null || vm["floating_ip"] === undefined ? "none" : UNREADABLE}`);
  return out;
}

/** Inbound security rules as port markers ("tcp:22-22"); none are ever expected. */
function exposedPorts(vm: Record<string, unknown>): string[] {
  const rules = vm["security_rules"];
  if (!Array.isArray(rules)) return [UNREADABLE];
  const out: string[] = [];
  for (const r of rules) {
    if (!isObject(r)) {
      out.push(UNREADABLE);
      continue;
    }
    if (r["direction"] !== "ingress") continue;
    const proto = typeof r["protocol"] === "string" ? r["protocol"] : UNREADABLE;
    const lo = count(r["port_range_min"]);
    const hi = count(r["port_range_max"]);
    out.push(Number.isNaN(lo) || Number.isNaN(hi) ? `${proto}:all` : `${proto}:${lo}-${hi}`);
  }
  return out;
}

/**
 * A Hyperstack VM (InstanceFields) as our ProviderMachineStatus. Only a missing or malformed id
 * throws: every other field that is missing or malformed is kept as an unreadable value, so the
 * drift check fails closed on it.
 */
export function vmStatus(vm: unknown, observedAt: string): ProviderMachineStatus {
  if (!isObject(vm) || !Number.isSafeInteger(vm["id"]) || (vm["id"] as number) <= 0) {
    throw new ProviderError("hyperstack", "unknown", "Hyperstack returned a VM without an id");
  }
  const flavor = isObject(vm["flavor"]) ? vm["flavor"] : {};
  const env = isObject(vm["environment"]) ? vm["environment"] : {};
  const image = isObject(vm["image"]) ? vm["image"] : {};
  const rawStatus = typeof vm["status"] === "string" ? vm["status"] : "";
  const volumes = vm["volume_attachments"];
  return {
    provider: "hyperstack",
    providerMachineId: String(vm["id"]),
    machineId: typeof vm["name"] === "string" ? parseMachineName(vm["name"]) : null,
    state: Object.hasOwn(STATES, rawStatus) ? STATES[rawStatus]! : "unknown",
    rawStatus,
    gpuType: gpuFromHyperstack(flavor["gpu"]),
    gpuCount: count(flavor["gpu_count"]),
    dataCenter: typeof env["region"] === "string" ? env["region"] : null,
    image: typeof image["name"] === "string" ? image["name"] : UNREADABLE,
    diskGb: count(flavor["disk"]),
    volumeGb: volumes === null || volumes === undefined || (Array.isArray(volumes) && volumes.length === 0) ? 0 : Array.isArray(volumes) ? Number.POSITIVE_INFINITY : Number.NaN,
    // A VM gets no provider-side environment: the boot token comes from the announce.
    envNames: [],
    exposedPorts: exposedPorts(vm),
    unexpectedSettings: unexpectedSettings(vm),
    command: [...VM_COMMAND],
    // VM details carry no rate; the price comes from the catalog at launch.
    providerCostPerHour: null,
    observedAt,
  };
}

/** What the announce check needs from a fresh VM, and what it must match. */
export interface VmReadbackExpectation {
  name: string;
  environmentName: string;
  flavorName: string;
  imageName: string;
  keypairName: string;
}

/**
 * Why a VM is not in the exact launch shape the announce may accept (draft 5), as fixed words; []
 * means it is. ACTIVE; a public IPv4, attached; port randomization off; exactly no security rules;
 * Enhanced Monitoring off; no volumes; and the exact name, environment, flavor, image and keypair.
 */
export function vmReadbackProblems(vm: unknown, want: VmReadbackExpectation): string[] {
  if (!isObject(vm)) return ["unreadable"];
  const out: string[] = [];
  const name = (x: unknown) => (isObject(x) ? x["name"] : undefined);
  if (vm["status"] !== "ACTIVE") out.push("status");
  if (!isPublicIpv4(vm["floating_ip"])) out.push("floating_ip");
  if (vm["floating_ip_status"] !== "ATTACHED") out.push("floating_ip_status");
  if (vm["port_randomization"] !== false) out.push("port_randomization");
  if (!Array.isArray(vm["security_rules"]) || vm["security_rules"].length !== 0) out.push("security_rules");
  const em = vm["enhanced_metrics"];
  if (!isObject(em) || em["enabled"] !== false) out.push("enhanced_metrics");
  const volumes = vm["volume_attachments"];
  if (!(volumes === null || volumes === undefined || (Array.isArray(volumes) && volumes.length === 0))) out.push("volumes");
  if (vm["name"] !== want.name) out.push("name");
  if (name(vm["environment"]) !== want.environmentName) out.push("environment");
  if (name(vm["flavor"]) !== want.flavorName) out.push("flavor");
  if (name(vm["image"]) !== want.imageName) out.push("image");
  if (name(vm["keypair"]) !== want.keypairName) out.push("keypair");
  return out;
}

/**
 * What the announce needs to know about a VM right now. "absent": Hyperstack doesn't know it, or
 * it is DELETED. "active": ACTIVE. "other": any other state. `exclusive` is true only for a public
 * IPv4 that is attached, with port randomization off (randomization means a shared, NATed address)
 * and no security rules. Whether Hyperstack's floating IPs are otherwise exclusive (inbound and
 * egress) is support question Q1; until it is answered, no launch is enabled.
 */
export type InstanceFacts = { state: "active" | "absent" | "other"; ipv4: string | null; exclusive: boolean } | "unavailable";

/** A fresh Ed25519 keypair for one launch: the OpenSSH public line to import, and a private key that can't be exported. */
export async function perLaunchKeypair(): Promise<{ publicKey: string; privateKey: webcrypto.CryptoKey }> {
  // extractable: false. The private half can never leave this process; dropping it destroys it.
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"])) as unknown as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const type = new TextEncoder().encode("ssh-ed25519");
  const blob = new Uint8Array(4 + type.length + 4 + raw.length);
  const view = new DataView(blob.buffer);
  view.setUint32(0, type.length);
  blob.set(type, 4);
  view.setUint32(4 + type.length, raw.length);
  blob.set(raw, 8 + type.length);
  return { publicKey: `ssh-ed25519 ${Buffer.from(blob).toString("base64")}`, privateKey: pair.privateKey };
}

export class HyperstackAdapter implements ProviderAdapter {
  // No VM gets a provider-side environment, so "" here matches no variable: the drift check expects
  // [""] and flags every Hyperstack VM, failing closed, until the launch path brings the announce
  // delivery form in place of an environment variable name.
  readonly info: AdapterInfo = { provider: "hyperstack", selfIdentity: null, bootTokenEnv: "" };

  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #base: string;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(opts: HyperstackOptions) {
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch;
    this.#base = opts.baseUrl ?? HYPERSTACK_API;
    this.#now = opts.now ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * One API call. Network failures and timeouts throw kind "outcome_unknown". An error status is
   * classified before any body read: an error reply's body is never read.
   */
  async #call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    const init: Parameters<Fetch>[1] = {
      method,
      headers: { api_key: this.#apiKey, Accept: "application/json" },
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
      throw new ProviderError("hyperstack", "outcome_unknown", `Hyperstack ${method} ${path.split("?")[0]}: no response (${failureName(e)})`);
    }
    if (!(res.status >= 200 && res.status < 300)) throw hyperstackError(res.status, res.headers.get("Retry-After"));
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw new ProviderError("hyperstack", "outcome_unknown", `Hyperstack ${method} ${path.split("?")[0]}: reply cut off (${failureName(e)})`, res.status);
    }
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      // A change (POST, DELETE) succeeded but its reply is unreadable: it may have happened.
      const kind: ProviderErrorKind = method === "GET" ? "unknown" : "outcome_unknown";
      throw new ProviderError("hyperstack", kind, `Hyperstack ${method} ${path.split("?")[0]}: response is not JSON`, res.status);
    }
  }

  #observedAt(): string {
    return this.#now().toISOString();
  }

  /**
   * Offers: flavors with exactly the GPU count asked for, in regions we know the country of,
   * priced from the pricebook (an entry named exactly as the flavor's GPU, per GPU-hour; to confirm
   * against a real read). One offer per GPU type and region (they share one price), preferring one in stock.
   */
  async listOffers(query: OfferQuery): Promise<Offer[]> {
    if (!Number.isSafeInteger(query.gpuCount) || query.gpuCount < 1) throw new RangeError("gpuCount must be a positive integer");
    const flavors = await this.#call("GET", "/core/flavors");
    const book = await this.#call("GET", "/pricebook");
    if (!isObject(flavors) || !Array.isArray(flavors["data"])) {
      throw new ProviderError("hyperstack", "unknown", "Hyperstack flavor list is malformed");
    }
    const entries = Array.isArray(book) ? book : isObject(book) && Array.isArray(book["data"]) ? book["data"] : null;
    if (entries === null) throw new ProviderError("hyperstack", "unknown", "Hyperstack pricebook is malformed");
    const perGpu = new Map<string, number>();
    for (const e of entries) {
      if (!isObject(e) || typeof e["name"] !== "string" || typeof e["value"] !== "number" || !Number.isFinite(e["value"]) || e["value"] < 0) continue;
      // Two entries for one name are ambiguous: neither is used.
      perGpu.set(e["name"], perGpu.has(e["name"]) ? Number.NaN : usdToMicros(e["value"]));
    }
    const observedAt = this.#observedAt();
    const best = new Map<string, Offer>();
    for (const group of flavors["data"]) {
      if (!isObject(group) || !Array.isArray(group["flavors"])) continue;
      for (const f of group["flavors"]) {
        if (!isObject(f) || f["gpu_count"] !== query.gpuCount || typeof f["stock_available"] !== "boolean") continue;
        const gpuType = gpuFromHyperstack(f["gpu"]);
        const region = f["region_name"];
        const country = hyperstackCountry(region);
        const unit = typeof f["gpu"] === "string" ? perGpu.get(f["gpu"]) : undefined;
        if (gpuType === null || country === null || typeof region !== "string" || unit === undefined) continue;
        // A price that rounds to no micros, an ambiguous one (NaN), or one whose total isn't a safe
        // integer is no price.
        const total = unit * query.gpuCount;
        if (unit < 1 || !Number.isSafeInteger(total)) continue;
        const offer: Offer = {
          provider: "hyperstack",
          gpuType,
          gpuCount: query.gpuCount,
          dataCenter: region,
          country,
          providerCostPerHour: total,
          stock: f["stock_available"] ? "unknown" : "none",
          observedAt,
        };
        const key = `${gpuType}\u0000${region}`;
        const prev = best.get(key);
        if (prev === undefined || offer.stock !== "none") {
          best.set(key, offer);
        }
      }
    }
    return [...best.values()];
  }

  /** Refused before any request: the Hyperstack create path lands under its own review. */
  async launch(_spec: LaunchSpec, _opts?: LaunchOptions): Promise<LaunchResult> {
    throw new ProviderError("hyperstack", "invalid_request", "Hyperstack: VM launch is not enabled");
  }

  async status(providerMachineId: string): Promise<ProviderMachineStatus> {
    if (!/^[1-9][0-9]{0,15}$/.test(providerMachineId)) throw new RangeError("a Hyperstack VM id is a positive integer");
    try {
      const json = await this.#call("GET", `/core/virtual-machines/${providerMachineId}`);
      const vm = isObject(json) ? json["instance"] : undefined;
      const s = vmStatus(vm, this.#observedAt());
      if (s.providerMachineId !== providerMachineId) {
        throw new ProviderError("hyperstack", "unknown", "Hyperstack answered a VM query with another VM");
      }
      return s;
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "not_found") return goneStatus(providerMachineId, this.#observedAt());
      throw e;
    }
  }

  /**
   * The announce's provider facts, read now. Never throws for a provider failure: any error, an
   * unreadable reply or another VM's answer is "unavailable", and the caller refuses.
   */
  async instanceFacts(providerMachineId: string): Promise<InstanceFacts> {
    if (!/^[1-9][0-9]{0,15}$/.test(providerMachineId)) throw new RangeError("a Hyperstack VM id is a positive integer");
    let json;
    try {
      json = await this.#call("GET", `/core/virtual-machines/${providerMachineId}`);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "not_found") return { state: "absent", ipv4: null, exclusive: false };
      return "unavailable";
    }
    const vm = isObject(json) ? json["instance"] : undefined;
    if (!isObject(vm) || vm["id"] !== Number(providerMachineId) || typeof vm["status"] !== "string") return "unavailable";
    const status = vm["status"];
    if (status === "DELETED") return { state: "absent", ipv4: null, exclusive: false };
    const ip = vm["floating_ip"];
    const ipv4 = isPublicIpv4(ip) ? (ip as string) : null;
    const exclusive =
      ipv4 !== null &&
      vm["floating_ip_status"] === "ATTACHED" &&
      vm["port_randomization"] === false &&
      Array.isArray(vm["security_rules"]) &&
      vm["security_rules"].length === 0;
    return { state: status === "ACTIVE" ? "active" : "other", ipv4, exclusive };
  }

  /** Idempotent: a VM Hyperstack doesn't know is done; a refusal counts only if the VM is on its way out. */
  async terminate(providerMachineId: string): Promise<void> {
    if (!/^[1-9][0-9]{0,15}$/.test(providerMachineId)) throw new RangeError("a Hyperstack VM id is a positive integer");
    try {
      await this.#call("DELETE", `/core/virtual-machines/${providerMachineId}`);
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.kind === "not_found") return;
      if (e.kind !== "unplaceable") throw e;
      const s = await this.status(providerMachineId);
      if (s.state === "terminated" || s.rawStatus === "DELETING") return;
      throw e;
    }
  }

  /**
   * Every VM of ours Hyperstack lists. Pages by page number; the count must stay the same, every
   * page but the last must be full, no VM may appear twice (foreign ones included), and every row
   * must carry a readable name, or the list fails.
   */
  async listMachines(): Promise<ProviderMachineStatus[]> {
    const out: ProviderMachineStatus[] = [];
    const seen = new Set<string>();
    let total: number | null = null;
    let read = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE) });
      const json = await this.#call("GET", `/core/virtual-machines?${qs}`);
      const observedAt = this.#observedAt();
      if (!isObject(json) || !Array.isArray(json["instances"]) || !Number.isSafeInteger(json["count"]) || (json["count"] as number) < 0) {
        throw new ProviderError("hyperstack", "unknown", "Hyperstack VM list is malformed");
      }
      const t = json["count"] as number;
      if (total !== null && t !== total) throw new ProviderError("hyperstack", "unknown", "Hyperstack VM list changed while it was read");
      total = t;
      const rows = json["instances"];
      if (rows.length !== Math.max(0, Math.min(PAGE, total - read))) {
        throw new ProviderError("hyperstack", "unknown", "Hyperstack VM list page has the wrong length");
      }
      for (const vm of rows) {
        const s = vmStatus(vm, observedAt);
        if (seen.has(s.providerMachineId)) throw new ProviderError("hyperstack", "unknown", "Hyperstack VM list has a VM twice");
        seen.add(s.providerMachineId);
        if (typeof (vm as Record<string, unknown>)["name"] !== "string") {
          throw new ProviderError("hyperstack", "unknown", "Hyperstack VM list has a VM without a name");
        }
        if (s.machineId !== null) out.push(s);
      }
      read += rows.length;
      if (read >= total) return out;
    }
    throw new ProviderError("hyperstack", "unknown", `Hyperstack VM list has more than ${MAX_PAGES} pages`);
  }

  /** Import one launch's public key; returns the keypair's id. */
  async importKeypair(name: string, environmentName: string, publicKey: string): Promise<number> {
    if (!/^sbg-[A-Za-z0-9_-]{1,46}$/.test(name)) throw new RangeError("keypair name must be ours (sbg-…), at most 50 characters");
    if (!/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(publicKey)) throw new RangeError("only an OpenSSH Ed25519 public key");
    const json = await this.#call("POST", "/core/keypairs", { name, environment_name: environmentName, public_key: publicKey });
    const kp = isObject(json) ? json["keypair"] : undefined;
    const id = isObject(kp) ? kp["id"] : undefined;
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || !isObject(kp) || kp["name"] !== name) {
      // Imported or not, we can't name it: the caller must find it by name before going on.
      throw new ProviderError("hyperstack", "outcome_unknown", "Hyperstack keypair import reply has no matching id");
    }
    return id as number;
  }

  /** Idempotent: a keypair Hyperstack doesn't know is gone. */
  async deleteKeypair(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError("a keypair id is a positive integer");
    try {
      await this.#call("DELETE", `/core/keypair/${id}`);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "not_found") return;
      throw e;
    }
  }
}

function goneStatus(providerMachineId: string, observedAt: string): ProviderMachineStatus {
  return {
    provider: "hyperstack",
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
