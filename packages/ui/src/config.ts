// Trusted deployment configuration, fixed at build time: build.mjs injects it with esbuild
// `define` from the deploy config. Tests and the mock build use the defaults below.

declare const SBGPU_MACHINE_DOMAIN: string | undefined;

/** The test and mock default: a reserved name (RFC 6761) that never resolves. */
export const TEST_MACHINE_DOMAIN = "machines.invalid";

/**
 * The domain under which every machine has its own origin, https://m-<machine id>.<domain>/
 * (the machine relay serves Jupyter there). The UI opens machine links only on that exact host.
 */
export const MACHINE_DOMAIN: string = typeof SBGPU_MACHINE_DOMAIN === "string" ? SBGPU_MACHINE_DOMAIN : TEST_MACHINE_DOMAIN;
