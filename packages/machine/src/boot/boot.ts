// The launcher a provider runs first on a new machine (DESIGN.md section 1).  The control plane calls
// renderBootCommand(); provider adapters put its result in place and never build a start command by hand.
import { isId } from "@sbgpu/api";
import { BOOTSTRAP_SH, PROBE_PROLOGUE_SH } from "./bootstrap-script.ts";

export type BootMode = "container" | "vm";

export interface BootValues {
  /** https URL of the agent tarball. */
  agentUrl: string;
  /** The tarball's sha256, 64 lowercase hex: the release the control plane pinned for this launch. */
  agentSha256: string;
  /** https URL of the control plane. */
  controlUrl: string;
  mode: BootMode;
  /** VM mode only (and required there): the machine's id and the launch's nonce (22 base64url), public values the
   * launcher announces itself with (DESIGN.md section 1.6).  Never in container mode. */
  machineId?: string;
  nonce?: string;
}

/** The only variable a launch puts in the machine's environment; its value is the one-time boot token. */
export const BOOT_TOKEN_ENV = "SBGPU_BOOT_TOKEN";

/** Names the launcher copies into the agent's environment when present (bootstrap.sh, section 1.4); every other
 * name in the provider's environment is dropped.  boot.test.ts checks that the script has the same list. */
export const ENV_COPY_ALLOWLIST: readonly string[] = Object.freeze([
  "LD_LIBRARY_PATH",
  "CUDA_HOME",
  "CUDA_VERSION",
  "NVIDIA_VISIBLE_DEVICES",
  "NVIDIA_DRIVER_CAPABILITIES",
  "NVIDIA_REQUIRE_CUDA",
  "NV_CUDA_LIB_VERSION",
  "PYTORCH_VERSION",
  "TZ",
]);

/** Names the launcher always sets in the agent's environment. */
export const ENV_FIXED: readonly string[] = Object.freeze(["PATH", "HOME", "LANG", "SBGPU_PREFIX"]);

// An https URL with nothing a shell or JSON would treat specially: host, optional port, and a plain path.
const URL_RE = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~\/-]{0,1024})?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PREFIX_RE = /^\/[A-Za-z0-9._\/-]{1,512}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

function check(v: BootValues): void {
  if (!URL_RE.test(v.agentUrl)) throw new Error("agentUrl must be a plain https URL");
  if (!URL_RE.test(v.controlUrl)) throw new Error("controlUrl must be a plain https URL");
  if (!SHA256_RE.test(v.agentSha256)) throw new Error("agentSha256 must be 64 lowercase hex");
  if (v.mode !== "container" && v.mode !== "vm") throw new Error("mode must be container or vm");
  if (v.mode === "vm") {
    if (typeof v.machineId !== "string" || !isId("machine", v.machineId)) throw new Error("vm mode needs the machine's id");
    if (typeof v.nonce !== "string" || !NONCE_RE.test(v.nonce)) throw new Error("vm mode needs a nonce of 22 base64url");
  } else if (v.machineId !== undefined || v.nonce !== undefined) {
    throw new Error("a machine id and nonce are for vm mode only");
  }
}

/**
 * VM mode's first two lines, ahead of the values, so they run before the nonce is even assigned (the launcher's design,
 * H1 and H3): a 077 umask and no core files, each read back, or the boot stops with `limits`.
 */
export const VM_HEADER =
  `umask 077 && [ "$(umask)" = 0077 ] || { echo 'SBGPU-BOOT {"v":1,"ok":false,"step":"limits","fail":["limits"]}' >&2; exit 2; }\n` +
  `ulimit -c 0 && [ "$(ulimit -c)" = 0 ] || { echo 'SBGPU-BOOT {"v":1,"ok":false,"step":"limits","fail":["limits"]}' >&2; exit 2; }\n`;

/** The whole launcher script with its values.  The options are for tests only: `prefix`, a directory standing in
 * for /, and `body`, the script's text read from bootstrap.sh itself (so a mutant of the .sh is what runs).  VM mode's
 * body is still bootstrap.sh, which refuses it: vm-launcher.sh (VM_LAUNCHER_SH) is reached only by tests, as `body`,
 * until VM mode is reviewed as a whole. */
export function renderBootScript(v: BootValues, opts: { prefix?: string; body?: string } = {}): string {
  check(v);
  const prefix = opts.prefix ?? "";
  if (prefix !== "" && (!PREFIX_RE.test(prefix) || prefix.split("/").includes(".."))) {
    throw new Error("prefix must be an absolute plain path");
  }
  // Every value matched a pattern without quotes, so single quotes hold it exactly.
  return (
    "#!/bin/sh\n" +
    (v.mode === "vm" ? VM_HEADER : "") +
    `SBGPU_AGENT_URL='${v.agentUrl}'\n` +
    `SBGPU_AGENT_SHA256='${v.agentSha256}'\n` +
    `SBGPU_CONTROL_URL='${v.controlUrl}'\n` +
    `SBGPU_MODE='${v.mode}'\n` +
    (v.mode === "vm" ? `SBGPU_MACHINE_ID='${v.machineId}'\nSBGPU_NONCE='${v.nonce}'\n` : "") +
    `SBGPU_PREFIX='${prefix}'\n` +
    (opts.body ?? BOOTSTRAP_SH)
  );
}

/**
 * The boot script's identity in the VM announce (control's contract, r3): the sha256, 64 lowercase hex, of the UTF-8
 * bytes of renderBootScript's output exactly as returned (the final newline included), which is what the provider
 * delivers as user data.  WebCrypto, so the control Worker and Node compute it the same way.
 */
export async function bootScriptSha256(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The shared test vector for bootScriptSha256: control's announce, the provider adapter and the launcher each test
 * that hashing renderBootScript(values) gives `sha256`.  It changes whenever the launcher's bytes do (boot.test.ts
 * pins it), so a change to the script is a deliberate change to this vector.
 */
export const BOOT_SCRIPT_VECTOR = Object.freeze({
  values: Object.freeze({
    agentUrl: "https://cdn.example.com/agent/sbgpu-agent.tar.gz",
    agentSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    controlUrl: "https://api.example.com",
    mode: "vm",
    machineId: "mch_0123456789abcdefghjk",
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  } as const),
  sha256: "6ca41a78c5cb14c0fc58536b742f1446f652d6a545ca081c2ec32efa8523e7e5",
});

/** What a provider adapter launches with: the container's entrypoint (the launcher runs as PID 1), or a VM's
 * cloud-init user data.  The boot token goes in the environment as BOOT_TOKEN_ENV, separately. */
export function renderBootCommand(v: BootValues): { argv: string[] } | { userData: string } {
  const script = renderBootScript(v);
  return v.mode === "container" ? { argv: ["/bin/sh", "-c", script] } : { userData: script };
}

const SALT_RE = /^[0-9a-f]{64}$/;

/**
 * PROBE ONLY (DESIGN.md section 1.5): the prologue the key-eradication probe's driver runs before the unchanged
 * launcher, as `["/bin/sh", "-c", renderProbePrologue(salt) + renderBootScript(values)]`.  It captures, from the
 * provider's injected RUNPOD_API_KEY, only a salted digest, the byte length, a coarse class set and a short prefix (or
 * none), into a 0600 file the probe agent reads; then it falls through into the launcher.  Never used in production.
 * Before it touches the key, it stops if anything listens on TCP port 22.
 * `saltHex`: 32 random bytes as 64 lowercase hex, fresh per run.  `dir` and `netDir` are for tests only (defaults
 * /opt/sbgpu and /proc/net).
 */
export function renderProbePrologue(saltHex: string, opts: { dir?: string; netDir?: string } = {}): string {
  if (!SALT_RE.test(saltHex)) throw new Error("the salt must be 64 lowercase hex");
  const dir = opts.dir ?? "/opt/sbgpu";
  const net = opts.netDir ?? "/proc/net";
  for (const [what, p] of [["dir", dir], ["netDir", net]] as const) {
    if (!PREFIX_RE.test(p) || p.split("/").includes("..")) throw new Error(`${what} must be an absolute plain path`);
  }
  return `SBGPU_PROBE_SALT='${saltHex}'\nSBGPU_PROBE_DIR='${dir}'\nSBGPU_PROBE_NET='${net}'\n` + PROBE_PROLOGUE_SH;
}
