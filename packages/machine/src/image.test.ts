// The machine image (image/Dockerfile and its lock files): every byte pinned, checked on the text.  The build itself
// and the smoke test inside it run in CI (.github/workflows/image.yml).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../image/${f}`, import.meta.url), "utf8");
const DOCKERFILE = read("Dockerfile");
/** The Dockerfile's instructions, continuation lines joined, comments dropped. */
const instructions = DOCKERFILE.replace(/\\\n/g, " ").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));

/** name -> {version, hashes} of a `uv pip compile --generate-hashes` lock file. */
function lock(text: string): Map<string, { version: string; hashes: number }> {
  const out = new Map<string, { version: string; hashes: number }>();
  for (const block of text.replace(/\\\n/g, " ").split("\n")) {
    const line = block.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9._-]+)==(\S+)((?:\s+--hash=sha256:[0-9a-f]{64})*)\s*$/.exec(line);
    assert.ok(m, `not a hash-pinned requirement: ${line.slice(0, 80)}`);
    out.set(m[1]!.toLowerCase(), { version: m[2]!, hashes: (m[3]!.match(/--hash=/g) ?? []).length });
  }
  return out;
}

test("the base image is pinned by digest, and apt reads one fixed snapshot", () => {
  const from = instructions.filter((l) => l.startsWith("FROM "));
  assert.equal(from.length, 1);
  assert.match(from[0]!, /^FROM [a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
  assert.match(DOCKERFILE, /^ARG APT_SNAPSHOT=\d{8}T\d{6}Z$/m);
  const apt = instructions.filter((l) => /apt-get (update|install)/.test(l));
  assert.ok(apt.length > 0);
  for (const l of apt) {
    for (const call of l.split("&&").filter((c) => /apt-get (update|install)/.test(c))) {
      assert.match(call, /--snapshot "\$APT_SNAPSHOT"/, call.trim());
    }
  }
});

test("every Python install is hash-checked, from a lock file, with nothing fetched by a pipe to a shell", () => {
  const installs = instructions.join("\n").split("&&").filter((c) => /\b(pip|uv pip) install\b/.test(c));
  assert.equal(installs.length, 2);
  for (const c of installs) {
    assert.match(c, /--require-hashes/, c.trim());
    assert.match(c, /--no-deps/, c.trim()); // (the lock file lists every dependency itself)
    assert.match(c, /-r \/opt\/sbgpu\/lock\/(tools|env)\.txt/, c.trim());
  }
  assert.doesNotMatch(DOCKERFILE, /\|\s*(sh|bash)\b/);
  assert.doesNotMatch(DOCKERFILE, /^\s*(ENTRYPOINT|CMD)\b/m); // (the launch supplies the launcher as the entrypoint)
});

test("the lock files are hash-pinned and carry exactly the .in pins", () => {
  for (const [inFile, txt] of [["env.in", "env.txt"], ["tools.in", "tools.txt"]] as const) {
    const locked = lock(read(txt));
    for (const [, entry] of locked) assert.ok(entry.hashes >= 1);
    const pins = read(inFile).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    assert.ok(pins.length > 0);
    for (const pin of pins) {
      const m = /^([A-Za-z0-9._-]+)==(\S+)$/.exec(pin);
      assert.ok(m, `${inFile}: not an exact pin: ${pin}`);
      assert.equal(locked.get(m[1]!.toLowerCase())?.version, m[2], `${txt} has ${pin}`);
    }
  }
  const env = lock(read("env.txt"));
  assert.match(env.get("torch")!.version, /\+cu126$/); // (CUDA 12.6 wheels: drivers back to 525, the 16 GB cards in the plan)
  assert.ok(env.has("sagebrush"));
  assert.ok(lock(read("tools.txt")).has("uv"));
});

test("the smoke test checks each pin against the lock files and the launcher's tools", () => {
  const smoke = read("smoke.sh");
  for (const tool of ["sh", "python3", "curl", "tar", "gzip", "sha256sum", "wc", "timeout", "env", "sed", "uv", "sagebrush"]) {
    assert.match(smoke, new RegExp(`for tool in [^;]*\\b${tool}\\b`), tool);
  }
  assert.match(smoke, /= \/usr\/bin\/python3 \]/);
  assert.match(smoke, /want torch env\.txt/);
  assert.match(smoke, /want sagebrush env\.txt/);
  assert.match(smoke, /want uv tools\.txt/);
});
