// Generates fixtures/vm-announce.json: one VM announce body, exactly as the launcher sends it (compact JSON,
// machineId, nonce, bootScriptSha256), one line.  The launcher's own test (agent/sbgpu-agent/tests/test_vmboot.py)
// and src/announce-fixture.test.ts both pin to it, so a change on either side alone fails its test.
//   node packages/machine/scripts/gen-announce-fixture.ts   (write it)
import { writeFileSync } from "node:fs";
import { announceFixture } from "../src/announce-fixture.ts";

writeFileSync(new URL("../fixtures/vm-announce.json", import.meta.url), announceFixture());
