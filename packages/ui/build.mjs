// Build the web UI into dist/web (production: no mock) or dist/web-mock (--mock: the
// whole API runs in the page with demo data, opened with ?mock=1).

import { build } from "esbuild";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";

const mock = process.argv.includes("--mock");
// The machine domain is deploy configuration (each machine's origin is https://m-<id>.<domain>/).
// A production build must be given it; the mock build uses the test default.
const machineDomain = mock ? "machines.invalid" : process.env.MACHINE_DOMAIN ?? "";
if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(machineDomain)) {
  console.error(`build.mjs: set MACHINE_DOMAIN to the machines' domain (e.g. MACHINE_DOMAIN=machines.example.org); got "${machineDomain}"`);
  process.exit(1);
}
const here = new URL(".", import.meta.url).pathname;
const outdir = `${here}dist/${mock ? "web-mock" : "web"}`;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: { app: `${here}src/app/main.ts` },
  bundle: true,
  format: "esm",
  // The terminal (xterm) loads only when opened, as its own chunk.
  splitting: true,
  outdir,
  minify: true,
  sourcemap: true,
  // The production map points at sources without embedding them (the mock's text stays out).
  sourcesContent: mock,
  target: "es2022",
  define: { SBGPU_MOCK: String(mock), SBGPU_MACHINE_DOMAIN: JSON.stringify(machineDomain) },
  logLevel: "warning",
});
for (const file of ["index.html", "styles.css"]) await copyFile(`${here}web/${file}`, `${outdir}/${file}`);
await copyFile(`${here}node_modules/@xterm/xterm/css/xterm.css`, `${outdir}/xterm.css`);
const { size } = await stat(`${outdir}/app.js`);
console.log(`${outdir}: app.js ${size} bytes`);
