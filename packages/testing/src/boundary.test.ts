// The test-only boundary (boundary.ts): the real tree has no runtime import of this package, and each planted one fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeImportsOfTesting } from "./boundary.ts";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("no runtime source of any package imports the test-only package", () => {
  assert.deepEqual(runtimeImportsOfTesting(PACKAGES), []);
});

test("a planted runtime import of the test-only package fails, in every form; tests and the package itself are exempt", () => {
  const root = mkdtempSync(join(tmpdir(), "sbgpu-boundary-"));
  try {
    const put = (p: string, s: string) => {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), s);
    };
    put("control/src/clean.ts", 'import { x } from "@sbgpu/api";\n');
    put("control/src/ok.test.ts", 'import { assertRelayLifecycleContract } from "@sbgpu/testing/relay-contract";\n');
    put("testing/src/self.ts", 'import "@sbgpu/testing/worker";\n');
    assert.deepEqual(runtimeImportsOfTesting(root), []); // (the control)
    const planted: Array<[string, string]> = [
      ["control/src/a.ts", 'import { assertRelayLifecycleContract } from "@sbgpu/testing/relay-contract";\n'],
      ["machine/src/relay/b.ts", "export * from '@sbgpu/testing';\n"],
      ["machine/src/c.ts", 'const m = await import("@sbgpu/testing/relay-contract");\n'],
      ["providers/src/d.js", 'const m = require("../../testing/src/relay-contract.ts");\n'],
      ["ui/src/deep/e.tsx", 'import "../../../testing/src/worker.ts";\n'],
    ];
    for (const [p, s] of planted) put(p, s);
    assert.deepEqual(runtimeImportsOfTesting(root), planted.map(([p]) => join(root, p)).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
