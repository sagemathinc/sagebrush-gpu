// Generates src/boot/bootstrap-script.ts from src/boot/bootstrap.sh (the launcher's source) and
// src/boot/probe-prologue.sh (the probe-only prologue's):
//   node packages/machine/scripts/gen-bootstrap.ts           (write it)
//   node packages/machine/scripts/gen-bootstrap.ts --check   (exit 1 if it's stale; scripts/check.sh runs this)
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../src/boot/", import.meta.url);
const sh = readFileSync(new URL("bootstrap.sh", dir), "utf8");
const prologue = readFileSync(new URL("probe-prologue.sh", dir), "utf8");
const ts = "// Generated from bootstrap.sh and probe-prologue.sh by scripts/gen-bootstrap.ts; don't edit.\n" +
  `export const BOOTSTRAP_SH = ${JSON.stringify(sh)};\n` +
  `export const PROBE_PROLOGUE_SH = ${JSON.stringify(prologue)};\n`;
const target = new URL("bootstrap-script.ts", dir);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== ts) {
    console.error("packages/machine/src/boot/bootstrap-script.ts is stale: run node packages/machine/scripts/gen-bootstrap.ts");
    process.exit(1);
  }
} else {
  writeFileSync(target, ts);
}
