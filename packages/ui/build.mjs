// Build the web UI into dist/web (production: no mock) or dist/web-mock (--mock: the
// whole API runs in the page with demo data, opened with ?mock=1).

import { build } from "esbuild";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";

const mock = process.argv.includes("--mock");
const here = new URL(".", import.meta.url).pathname;
const outdir = `${here}dist/${mock ? "web-mock" : "web"}`;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: { app: `${here}src/app/main.ts` },
  bundle: true,
  format: "esm",
  splitting: mock,
  outdir,
  minify: true,
  sourcemap: true,
  target: "es2022",
  define: { SBGPU_MOCK: String(mock) },
  logLevel: "warning",
});
for (const file of ["index.html", "styles.css"]) await copyFile(`${here}web/${file}`, `${outdir}/${file}`);
const { size } = await stat(`${outdir}/app.js`);
console.log(`${outdir}: app.js ${size} bytes`);
