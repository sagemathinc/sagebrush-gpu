// Providers' display names, for every screen that names one.

import type { ProviderId } from "@sbgpu/api";

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = Object.freeze({
  runpod: "RunPod",
  shadeform: "Shadeform",
  hyperstack: "Hyperstack",
  nebius: "Nebius",
  vast: "Vast.ai",
});
