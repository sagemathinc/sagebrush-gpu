// The probe agent (probe/sbgpu-agent, Python) and the tarball builder (scripts/build-tarball.py): the probe's unit
// tests, and tarballs that build byte for byte the same each time and have the shape the launcher accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MACHINE = fileURLToPath(new URL("../", import.meta.url));
const PROBE_DIR = join(MACHINE, "probe/sbgpu-agent");
const AGENT_DIR = join(MACHINE, "agent/sbgpu-agent");
const BUILD = join(MACHINE, "scripts/build-tarball.py");

test("the probe's Python unit tests pass", () => {
  execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests"], {
    cwd: PROBE_DIR,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
});

function build(src: string, dir: string, name: string): { bytes: Buffer; printed: string } {
  const out = join(dir, name);
  const printed = execFileSync("python3", ["-I", BUILD, src, out], { encoding: "utf8" });
  return { bytes: readFileSync(out), printed };
}

test("tarballs are reproducible, print their sha256, and hold sbgpu-agent/ with regular files only", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbgpu-tarball-"));
  try {
    for (const [src, label] of [[PROBE_DIR, "probe"], [AGENT_DIR, "agent"]] as const) {
      const a = build(src, dir, `${label}-a.tar.gz`);
      const b = build(src, dir, `${label}-b.tar.gz`);
      assert.ok(a.bytes.equals(b.bytes), `${label}: two builds differ`);
      const sha = createHash("sha256").update(a.bytes).digest("hex");
      assert.ok(a.printed.startsWith(`${sha}  `), a.printed);
      const listing = execFileSync("tar", ["-tvzf", join(dir, `${label}-a.tar.gz`)], { encoding: "utf8" }).trim().split("\n");
      const names = execFileSync("tar", ["-tzf", join(dir, `${label}-a.tar.gz`)], { encoding: "utf8" }).trim().split("\n");
      assert.ok(listing.every((l) => l.startsWith("-") || l.startsWith("d")), `${label}: ${listing.join("\n")}`);
      assert.ok(names.every((n) => n === "sbgpu-agent" || n === "sbgpu-agent/" || n.startsWith("sbgpu-agent/")), names.join(","));
      assert.ok(names.includes("sbgpu-agent/__main__.py"), label);
      assert.ok(!names.some((n) => n.includes("/tests") || n.includes("__pycache__") || n.endsWith(".pyc")), names.join(","));
      // (owner 0/0 and mtime 0 in every entry)
      assert.ok(listing.every((l) => /\s0\/0\s/.test(l) && /\s1970-01-01\s/.test(l)), listing.join("\n"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the builder refuses a source without __main__.py", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbgpu-tarball-"));
  try {
    assert.throws(() => execFileSync("python3", ["-I", BUILD, dir, join(dir, "x.tar.gz")], { stdio: "pipe" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
