// The launcher a provider runs first on a new machine (DESIGN.md section 1).  The control plane calls
// renderBootCommand(); provider adapters put its result in place and never build a start command by hand.
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

function check(v: BootValues): void {
  if (!URL_RE.test(v.agentUrl)) throw new Error("agentUrl must be a plain https URL");
  if (!URL_RE.test(v.controlUrl)) throw new Error("controlUrl must be a plain https URL");
  if (!SHA256_RE.test(v.agentSha256)) throw new Error("agentSha256 must be 64 lowercase hex");
  if (v.mode !== "container" && v.mode !== "vm") throw new Error("mode must be container or vm");
}

/** The whole launcher script with its values.  The options are for tests only: `prefix`, a directory standing in
 * for /, and `body`, the script's text read from bootstrap.sh itself (so a mutant of the .sh is what runs). */
export function renderBootScript(v: BootValues, opts: { prefix?: string; body?: string } = {}): string {
  check(v);
  const prefix = opts.prefix ?? "";
  if (prefix !== "" && (!PREFIX_RE.test(prefix) || prefix.split("/").includes(".."))) {
    throw new Error("prefix must be an absolute plain path");
  }
  // Every value matched a pattern without quotes, so single quotes hold it exactly.
  return (
    "#!/bin/sh\n" +
    `SBGPU_AGENT_URL='${v.agentUrl}'\n` +
    `SBGPU_AGENT_SHA256='${v.agentSha256}'\n` +
    `SBGPU_CONTROL_URL='${v.controlUrl}'\n` +
    `SBGPU_MODE='${v.mode}'\n` +
    `SBGPU_PREFIX='${prefix}'\n` +
    (opts.body ?? BOOTSTRAP_SH)
  );
}

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
 * `saltHex`: 32 random bytes as 64 lowercase hex, fresh per run.  `dir` is for tests only (default /opt/sbgpu).
 */
export function renderProbePrologue(saltHex: string, opts: { dir?: string } = {}): string {
  if (!SALT_RE.test(saltHex)) throw new Error("the salt must be 64 lowercase hex");
  const dir = opts.dir ?? "/opt/sbgpu";
  if (!PREFIX_RE.test(dir) || dir.split("/").includes("..")) throw new Error("dir must be an absolute plain path");
  return `SBGPU_PROBE_SALT='${saltHex}'\nSBGPU_PROBE_DIR='${dir}'\n` + PROBE_PROLOGUE_SH;
}
