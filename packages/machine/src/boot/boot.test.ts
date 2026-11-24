// The launcher, run for real: /bin/sh against a local https server, with a prefix directory standing in for /.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { BOOT_TOKEN_ENV, ENV_COPY_ALLOWLIST, ENV_FIXED, renderBootCommand, renderBootScript } from "./boot.ts";

const TOKEN = "A".repeat(20) + "b-_" + "9".repeat(20); // 43 base64url characters
const KEY = "rpa_TESTKEY0123456789"; // stands in for RunPod's injected key

// The fake agent: records its environment, argv and what the launcher left for it, then exits 0.
const FAKE_AGENT = `
import json, os, stat, sys
p = os.environ.get("SBGPU_PREFIX", "")
run = p + "/run/sbgpu"
st = lambda f: oct(stat.S_IMODE(os.stat(f).st_mode))
out = {"env": dict(os.environ), "boot": json.load(open(run + "/boot.json")), "bootMode": st(run + "/boot.json"),
       "runMode": st(run), "tgzLeft": os.path.exists(run + "/agent.tar.gz"), "flags": [sys.flags.isolated, sys.flags.no_site]}
open(p + "/out.json", "w").write(json.dumps(out))
`;

let root: string;
let server: Server;
let plain: ReturnType<typeof createHttpServer>;
let port: number;
let ca: string;
const files = new Map<string, Buffer>(); // path -> body
const redirects = new Map<string, string>(); // path -> Location
const hits = new Map<string, number>();

function tarball(name: string, build: (dir: string) => void): Buffer {
  const dir = mkdtempSync(join(root, `src-${name}-`));
  build(dir);
  const out = join(root, `${name}.tgz`);
  execFileSync("tar", ["-czf", out, "-C", dir, "."]);
  return readFileSync(out);
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

before(async () => {
  root = mkdtempSync(join(tmpdir(), "sbgpu-boot-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")],
    { stdio: "ignore" });
  ca = join(root, "cert.pem");
  server = createServer({ key: readFileSync(join(root, "key.pem")), cert: readFileSync(ca) }, (req, res) => {
    const path = req.url ?? "";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const loc = redirects.get(path);
    if (loc !== undefined) {
      res.writeHead(302, { location: loc }).end();
      return;
    }
    const body = files.get(path);
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;

  const good = tarball("good", (d) => {
    mkdirSync(join(d, "sbgpu-agent"));
    writeFileSync(join(d, "sbgpu-agent", "__main__.py"), FAKE_AGENT);
  });
  files.set("/good.tgz", good);
  files.set("/truncated.tgz", good.subarray(0, good.length >> 1));
  files.set("/big.tgz", Buffer.alloc(16 * 1024 * 1024 + 1));
  files.set("/symlink.tgz", tarball("symlink", (d) => {
    mkdirSync(join(d, "sbgpu-agent"));
    writeFileSync(join(d, "sbgpu-agent", "__main__.py"), FAKE_AGENT);
    symlinkSync("/etc/passwd", join(d, "sbgpu-agent", "link"));
  }));
  // A member named with "..": built by Python's tarfile, since tar won't make one.
  const dotdot = join(root, "dotdot.tgz");
  execFileSync("python3", ["-I", "-c", `
import io, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as t:
    for name, data in (("sbgpu-agent/__main__.py", b"print(1)"), ("sbgpu-agent/../../escape", b"x")):
        info = tarfile.TarInfo(name); info.size = len(data); t.addfile(info, io.BytesIO(data))
`, dotdot]);
  files.set("/dotdot.tgz", readFileSync(dotdot));
  files.set("/empty.tgz", Buffer.alloc(0));
  // A plain http server with the same good tarball, so a followed redirect to it would succeed.
  plain = createHttpServer((_req, res) => {
    const body = files.get("/good.tgz")!;
    res.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  redirects.set("/redirect-http.tgz", `http://localhost:${(plain.address() as AddressInfo).port}/good.tgz`);
  redirects.set("/redirect-https.tgz", `https://localhost:${port}/good.tgz`);
});

after(() => {
  server.close();
  plain.close();
  rmSync(root, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  stderr: string;
  prefix: string;
  out: { env: Record<string, string>; boot: Record<string, string>; bootMode: string; runMode: string; tgzLeft: boolean; flags: number[] } | null;
}

// The launcher's text as it is in bootstrap.sh (bootstrap-script.ts is generated from it; check.sh checks that).
const SH = readFileSync(new URL("bootstrap.sh", import.meta.url), "utf8");
let runs = 0;
let defaultBin: string | undefined;
const PYTHON = execFileSync("python3", ["-I", "-c", "import sys; print(sys.executable)"]).toString().trim();
async function launch(opts: {
  path: string;
  sha?: string;
  env?: Record<string, string>;
  binPath?: string;
  edit?: (script: string) => string;
}): Promise<Run> {
  const prefix = join(root, `p${++runs}`);
  mkdirSync(prefix);
  const body = files.get(opts.path);
  let script = renderBootScript({
    agentUrl: `https://localhost:${port}${opts.path}`,
    agentSha256: opts.sha ?? sha(body ?? files.get("/good.tgz")!),
    controlUrl: "https://control.example.com",
    mode: "container",
  }, { prefix, body: SH });
  if (opts.edit) script = opts.edit(script);
  const env: Record<string, string> = {
    PATH: opts.binPath ?? (defaultBin ??= binWithout()),
    CURL_CA_BUNDLE: ca,
    SSL_CERT_FILE: ca,
    [BOOT_TOKEN_ENV]: TOKEN,
    ...opts.env,
  };
  const child = spawn("/bin/sh", ["-c", script], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  const outPath = join(prefix, "out.json");
  return { code, stderr, prefix, out: existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null };
}

/** A PATH directory with these commands only (symlinks to the real ones). */
function binWithout(...missing: string[]): string {
  const bin = mkdtempSync(join(root, "bin-"));
  for (const c of ["sh", "rm", "mkdir", "chmod", "wc", "sleep", "sha256sum", "tar", "gzip", "cat", "env", "python3", "curl"]) {
    if (missing.includes(c)) continue;
    // (python3 itself, not a wrapper script that might add to the environment)
    const real = c === "python3" ? PYTHON : execFileSync("sh", ["-c", `command -v ${c}`]).toString().trim();
    symlinkSync(real, join(bin, c));
  }
  return bin;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

function assertRefused(r: Run, message: RegExp): void {
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, message);
  assert.equal(r.out, null, "the agent must not run");
}

const PROVIDER_ENV = {
  RUNPOD_API_KEY: KEY,
  RUNPOD_POD_ID: "pod-abc123",
  PUBLIC_KEY: "ssh-ed25519 AAAA",
  JUPYTER_PASSWORD: "pw",
  CUDA_VERSION: "12.4.1",
  NVIDIA_VISIBLE_DEVICES: "all",
};

test("a good launch: the agent runs isolated, with only the allowlisted environment", async () => {
  const r = await launch({ path: "/good.tgz", env: PROVIDER_ENV });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.out);
  assert.deepEqual(Object.keys(r.out.env).sort(), ["CUDA_VERSION", "HOME", "LANG", "NVIDIA_VISIBLE_DEVICES", "PATH", "SBGPU_PREFIX"]);
  assert.equal(r.out.env.CUDA_VERSION, "12.4.1");
  assert.equal(r.out.env.HOME, "/root");
  for (const v of Object.values(r.out.env)) assert.ok(!v.includes(KEY) && !v.includes(TOKEN));
  assert.deepEqual(r.out.boot, {
    controlUrl: "https://control.example.com", mode: "container", bootToken: TOKEN, providerMachineId: "pod-abc123",
    agentSha256: sha(files.get("/good.tgz")!),
  });
  assert.equal(r.out.bootMode, "0o600");
  assert.equal(r.out.runMode, "0o700");
  assert.equal(r.out.tgzLeft, false);
  assert.deepEqual(r.out.flags, [1, 1]);
  // Nothing of the key anywhere the launcher wrote.
  for (const f of filesUnder(r.prefix)) assert.ok(!readFileSync(f).includes(KEY), f);
});

test("without curl, python3 downloads; without sha256sum, python3 hashes", async () => {
  const noCurl = await launch({ path: "/good.tgz", binPath: binWithout("curl") });
  assert.equal(noCurl.code, 0, noCurl.stderr);
  assert.ok(noCurl.out);
  const noSum = await launch({ path: "/good.tgz", binPath: binWithout("sha256sum") });
  assert.equal(noSum.code, 0, noSum.stderr);
  assert.ok(noSum.out);
  const neither = await launch({ path: "/good.tgz", binPath: binWithout("curl", "sha256sum"), sha: "0".repeat(64) });
  assertRefused(neither, /sha256 doesn't match/);
});

test("a hash that differs in its last character is refused, and nothing is unpacked", async () => {
  const good = sha(files.get("/good.tgz")!);
  const last = good.endsWith("0") ? "1" : "0";
  const r = await launch({ path: "/good.tgz", sha: good.slice(0, 63) + last });
  assertRefused(r, /sha256 doesn't match/);
  assert.equal(existsSync(join(r.prefix, "opt")), false);
});

test("an empty download is refused, even with its hash pinned", async () => {
  assertRefused(await launch({ path: "/empty.tgz" }), /bad download size/);
});

test("a truncated download fails the hash", async () => {
  const r = await launch({ path: "/truncated.tgz", sha: sha(files.get("/good.tgz")!) });
  assertRefused(r, /sha256 doesn't match/);
});

test("a download over 16 MiB is refused, by curl and by the python fallback", { timeout: 60_000 }, async () => {
  const big = files.get("/big.tgz")!;
  assertRefused(await launch({ path: "/big.tgz", sha: sha(big) }), /can't download/);
  assertRefused(await launch({ path: "/big.tgz", sha: sha(big), binPath: binWithout("curl") }), /can't download/);
});

test("redirects: to https followed, to http refused (curl and python)", { timeout: 60_000 }, async () => {
  const goodSha = sha(files.get("/good.tgz")!);
  const ok = await launch({ path: "/redirect-https.tgz", sha: goodSha });
  assert.equal(ok.code, 0, ok.stderr);
  assertRefused(await launch({ path: "/redirect-http.tgz", sha: goodSha }), /can't download/);
  assertRefused(await launch({ path: "/redirect-http.tgz", sha: goodSha, binPath: binWithout("curl") }), /can't download/);
});

test("the script's own checks: http URLs, a bad pin and a bad mode are refused before any request", async () => {
  const before = hits.get("/good.tgz") ?? 0;
  const http = await launch({ path: "/good.tgz", edit: (s) => s.replace("SBGPU_AGENT_URL='https://", "SBGPU_AGENT_URL='http://") });
  assertRefused(http, /agent URL must be https/);
  const ctl = await launch({ path: "/good.tgz", edit: (s) => s.replace("SBGPU_CONTROL_URL='https://", "SBGPU_CONTROL_URL='http://") });
  assertRefused(ctl, /control URL must be https/);
  const upper = await launch({ path: "/good.tgz", edit: (s) => s.replace(/SBGPU_AGENT_SHA256='([0-9a-f])/, (_m, c: string) => `SBGPU_AGENT_SHA256='${c === "a" ? "B" : "A"}`) });
  assertRefused(upper, /bad pinned sha256/);
  const short = await launch({ path: "/good.tgz", edit: (s) => s.replace(/SBGPU_AGENT_SHA256='[0-9a-f]/, "SBGPU_AGENT_SHA256='") });
  assertRefused(short, /bad pinned sha256/);
  const vm = await launch({ path: "/good.tgz", edit: (s) => s.replace("SBGPU_MODE='container'", "SBGPU_MODE='vm'") });
  assertRefused(vm, /vm mode is not built yet/);
  const other = await launch({ path: "/good.tgz", edit: (s) => s.replace("SBGPU_MODE='container'", "SBGPU_MODE='pod'") });
  assertRefused(other, /bad mode/);
  assert.equal(hits.get("/good.tgz") ?? 0, before);
});

test("boot tokens of the wrong length or alphabet are refused", async () => {
  for (const bad of [TOKEN.slice(1), TOKEN + "A", TOKEN.slice(1) + "$", TOKEN.slice(1) + '"', TOKEN.slice(1) + "="]) {
    assertRefused(await launch({ path: "/good.tgz", env: { [BOOT_TOKEN_ENV]: bad } }), /bad boot token/);
  }
  const unset = await launch({ path: "/good.tgz", edit: (s) => s.replace("#!/bin/sh\n", `#!/bin/sh\nunset ${BOOT_TOKEN_ENV}\n`) });
  assertRefused(unset, /bad boot token/);
});

test("a provider machine id with unexpected characters is dropped, not passed on", async () => {
  for (const id of ['pod"x', "pod/x", "p".repeat(65)]) {
    const r = await launch({ path: "/good.tgz", env: { RUNPOD_POD_ID: id } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out?.boot.providerMachineId, "");
  }
});

test("an allowlisted variable holding the provider key stops the launch", async () => {
  const r = await launch({ path: "/good.tgz", env: { RUNPOD_API_KEY: KEY, LD_LIBRARY_PATH: `/usr/lib:${KEY}:/x` } });
  assertRefused(r, /holds the provider key/);
  // ... while an unset key changes nothing.
  const ok = await launch({ path: "/good.tgz", env: { LD_LIBRARY_PATH: "/usr/lib" } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.out?.env.LD_LIBRARY_PATH, "/usr/lib");
});

test("tarballs with a link or a '..' name are refused before unpacking", async () => {
  const link = await launch({ path: "/symlink.tgz" });
  assertRefused(link, /link or special file/);
  assert.equal(existsSync(join(link.prefix, "opt")), false);
  const dotdot = await launch({ path: "/dotdot.tgz" });
  assertRefused(dotdot, /unsafe name/);
  assert.equal(existsSync(join(dotdot.prefix, "escape")), false);
});

test("renderBootCommand: argv for containers, user data for VMs; values are checked", () => {
  const v = { agentUrl: "https://cdn.example.com/agent/agent-1.tar.gz", agentSha256: "a".repeat(64), controlUrl: "https://api.example.com", mode: "container" as const };
  const c = renderBootCommand(v);
  assert.ok("argv" in c);
  assert.deepEqual(c.argv.slice(0, 2), ["/bin/sh", "-c"]);
  assert.ok(c.argv[2]!.includes("SBGPU_AGENT_SHA256='" + "a".repeat(64) + "'\n"));
  assert.ok(!c.argv[2]!.includes(BOOT_TOKEN_ENV + "="), "the token never goes in the script");
  const vm = renderBootCommand({ ...v, mode: "vm" });
  assert.ok("userData" in vm && vm.userData.startsWith("#!/bin/sh\n"));
  for (const bad of [
    { agentUrl: "http://cdn.example.com/a.tgz" },
    { agentUrl: "https://cdn.example.com/a'.tgz" },
    { agentUrl: "https://cdn.example.com/$(id)" },
    { controlUrl: "https://api.example.com/?x=1" },
    { agentSha256: "A".repeat(64) },
    { agentSha256: "a".repeat(63) },
    { agentSha256: "a".repeat(65) },
    { mode: "pod" },
  ]) {
    assert.throws(() => renderBootCommand({ ...v, ...bad } as typeof v), JSON.stringify(bad));
  }
  assert.throws(() => renderBootScript(v, { prefix: "/tmp/../etc" }));
  assert.throws(() => renderBootScript(v, { prefix: "relative" }));
});

test("bootstrap.sh and boot.ts list the same environment", () => {
  const loop = /for name in ([A-Z_ \\\n]+); do/.exec(SH);
  assert.ok(loop);
  assert.deepEqual(loop[1]!.split(/[\s\\]+/).filter(Boolean), [...ENV_COPY_ALLOWLIST]);
  for (const name of ENV_FIXED) assert.ok(SH.includes(`"${name}=`), name);
});

test("bootstrap.sh passes shellcheck", { skip: !existsSync("/usr/bin/shellcheck") && "no shellcheck" }, () => {
  execFileSync("shellcheck", ["-s", "sh", new URL("bootstrap.sh", import.meta.url).pathname]);
});
