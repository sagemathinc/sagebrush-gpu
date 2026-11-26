// The VM announce's body as the shared fixture holds it (see scripts/gen-announce-fixture.ts).
import type { AgentAnnounceRequest } from "@sbgpu/api";
import { BOOT_SCRIPT_VECTOR } from "./boot/boot.ts";

/** One announce, typed as control's AgentAnnounceRequest, in the key order the launcher sends. */
export const ANNOUNCE_FIXTURE_VALUES: AgentAnnounceRequest = Object.freeze({
  machineId: BOOT_SCRIPT_VECTOR.values.machineId,
  nonce: BOOT_SCRIPT_VECTOR.values.nonce,
  bootScriptSha256: "0123456789abcdef".repeat(4),
});

/** The fixture's exact bytes: the launcher's body for those values (compact JSON), then a newline. */
export function announceFixture(): string {
  return JSON.stringify(ANNOUNCE_FIXTURE_VALUES) + "\n";
}
