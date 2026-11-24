// A static server for the built UI, for local development: serves dist/web (or dist/web-mock
// with --mock) and answers index.html for app paths. Usage: node serve.mjs [--mock] [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const mock = process.argv.includes("--mock");
const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 5180);
const root = new URL(`./dist/${mock ? "web-mock" : "web"}/`, import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = extname(path) in TYPES ? root + path.slice(1) : root + "index.html";
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}/`));
