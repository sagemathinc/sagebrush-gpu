// The test-only boundary: no runtime source of any package imports this package (it holds node:assert checks and
// Miniflare helpers that must never reach a Worker or the UI).  Runtime source is every .ts/.tsx/.js/.mjs file under a
// package's src/ that isn't a test (*.test.*); this package's own files are exempt.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = /\.(ts|tsx|js|mjs)$/;
const TEST = /\.test\.(ts|tsx|js|mjs)$/;
// (any mention of the package name or of a path into it in an import, export-from, require or dynamic import)
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`](?:@sbgpu\/testing(?:\/[^"'`]*)?|[^"'`]*\/testing\/src\/[^"'`]*)["'`]/;

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") yield* files(p);
    } else if (e.isFile() && SOURCE.test(e.name) && !TEST.test(e.name)) {
      yield p;
    }
  }
}

/** Every runtime source file under packagesDir/<package>/src that imports the test-only package (sorted). */
export function runtimeImportsOfTesting(packagesDir: string): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory() || pkg.name === "testing") continue;
    let src: Generator<string>;
    try {
      readdirSync(join(packagesDir, pkg.name, "src"));
      src = files(join(packagesDir, pkg.name, "src"));
    } catch {
      continue; // (a package without src/)
    }
    for (const f of src) if (IMPORT.test(readFileSync(f, "utf8"))) out.push(f);
  }
  return out.sort();
}
