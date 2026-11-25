// The VM gate's words as the shared fixture holds them (see scripts/gen-gate-words.ts).
import { VM_GATE_WORDS } from "@sbgpu/api";

/** The fixture's exact bytes: the words (sorted already: @sbgpu/api's test pins that), a JSON array, then a newline. */
export function gateWordsFixture(): string {
  return JSON.stringify(VM_GATE_WORDS) + "\n";
}
