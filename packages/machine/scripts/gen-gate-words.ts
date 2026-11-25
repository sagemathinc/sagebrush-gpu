// Generates fixtures/vm-gate-words.json from @sbgpu/api's VM_GATE_WORDS: the sorted words as a
// JSON array, one line. The VM gate's own test (agent/sbgpu-agent/tests) and
// src/gate-words.test.ts both pin to it, so a change on either side alone fails its test.
//   node packages/machine/scripts/gen-gate-words.ts   (write it)
import { writeFileSync } from "node:fs";
import { gateWordsFixture } from "../src/gate-words.ts";

writeFileSync(new URL("../fixtures/vm-gate-words.json", import.meta.url), gateWordsFixture());
