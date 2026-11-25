// The deployed control Worker's entry (wrangler.json's "main"): the Worker from worker.ts,
// and the machine relay's Durable Object class, bound as MACHINE_RELAY. (Bundled for the
// Workers runtime only; Node's tests load worker.ts, and the Miniflare tests this file.)
export { MachineRelay } from "@sbgpu/machine/relay/object";
export { default } from "./worker.ts";
