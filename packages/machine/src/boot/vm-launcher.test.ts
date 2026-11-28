// VM mode's launcher (vm-launcher.sh), run for real: /bin/sh against a local https server (the agent tarball, and
// control's announce), with a prefix directory standing in for /.  The agent's tarball holds its real vmboot.py; its
// neutralise and gate, its clock and the agent itself are stubs that log what they were given (argv, environment,
// stdin) under the prefix.  The clock stub answers each caller (the announce child, each remaining-time check, the
// gate.json writer) from a table, so a test can put a suspend across D between any two of them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { BOOT_SCRIPT_VECTOR, renderBootScript, VM_HEADER } from "./boot.ts";
import { VM_LAUNCHER_SH } from "./bootstrap-script.ts";

const TOKEN = "T".repeat(20) + "o-_" + "k".repeat(20); // 43 base64url characters
const NONCE = "N".repeat(10) + "-_" + "n".repeat(10); // 22
const MACHINE = BOOT_SCRIPT_VECTOR.values.machineId;
const C = 5_000_000; // CLOCK_BOOTTIME ms, as the stub clock reports it by default
const D = C + 80_000;
const PASS = 'SBGPU-GATE {"v":1,"pass":true,"fail":[]}';
const OK_LINE = 'SBGPU-BOOT {"v":1,"ok":true}\n';
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const line = (step: string, word: string) => `SBGPU-BOOT {"v":1,"ok":false,"step":"${step}","fail":["${word}"]}\n`;

const STUB = `
import json, os
PREFIX = os.path.abspath(__file__).split("/var/lib/sbgpu/agent/")[0]
def log(who, stdin=""):
    import sys
    with open(PREFIX + "/calls.log", "a") as f:
        f.write(json.dumps({"who": who, "argv": sys.argv, "env": dict(os.environ), "stdin": stdin}) + "\\n")
def conf(name, default):
    p = PREFIX + "/" + name
    return json.load(open(p)) if os.path.exists(p) else default
def calls(who):
    p = PREFIX + "/calls.log"
    return sum(1 for l in open(p) if json.loads(l)["who"] == who) if os.path.exists(p) else 0
`;
const NEUTRALISE = `
from sbgpu_agent._stub import conf, log
def main(argv):
    log("neutralise")
    c = conf("neutralise.json", {"line": 'SBGPU-NEUTRALISE {"v":1,"ok":true,"fail":[]}', "rc": 0})
    print(c["line"])
    return c["rc"]
`;
const VMGATE = `
import sys, time
from sbgpu_agent._stub import calls, conf, log
def main(argv):
    data = sys.stdin.read()
    n = calls("vmgate") + 1
    log("vmgate", data)
    c = conf("gate%d.json" % n, {})
    time.sleep(c.get("sleep", 0))
    print(c.get("line", ${JSON.stringify(PASS)}))
    return c.get("rc", 0)
`;
const CLOCK = `
import json, os, sys
PREFIX = os.path.abspath(__file__).split("/var/lib/sbgpu/agent/")[0]
def boottime_ms():
    who = sys.argv[1] if len(sys.argv) > 1 else ""
    if who == "remaining" and len(sys.argv) > 3:
        who += ":" + sys.argv[3]
    clock = json.load(open(PREFIX + "/clock.json"))
    return clock.get(who, clock["default"])
`;
// The fake agent: records what the launcher left it (the token only as its digest), removes both files as the real one
// does, and exits 0.
const FAKE_AGENT = `
import hashlib, json, os, stat, sys
p = os.environ.get("SBGPU_PREFIX", "")
d = p + "/run/sbgpu"
mode = lambda f: oct(stat.S_IMODE(os.stat(f).st_mode))
boot = json.load(open(d + "/boot.json"))
out = {"argv": sys.argv[1:], "env": dict(os.environ), "flags": [sys.flags.isolated, sys.flags.no_site],
       "boot": {k: v for k, v in boot.items() if k != "bootToken"}, "bootKeys": sorted(boot),
       "tokenSha": hashlib.sha256(boot["bootToken"].encode()).hexdigest(), "gate": open(d + "/gate.json").read(),
       "modes": [mode(d), mode(d + "/boot.json"), mode(d + "/gate.json")], "files": sorted(os.listdir(d))}
os.unlink(d + "/boot.json")
os.unlink(d + "/gate.json")
open(p + "/agent.json", "w").write(json.dumps(out))
`;

let root: string;
let server: Server;
let port: number;
let ca: string;
const files = new Map<string, Buffer>();
let hits = 0;
let current = ""; // the prefix of the run in progress (the announce handler logs into it)
let reply: () => { status: number; body: string } = issue;
const announces: { prefix: string; body: string }[] = [];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function issue(lifeMs = 120_000) {
  return { status: 200, body: JSON.stringify({ bootToken: TOKEN, expiresAt: iso(Date.now() + lifeMs) }) };
}

function tarball(name: string, edit?: (dir: string) => void): Buffer {
  const dir = mkdtempSync(join(root, `src-${name}-`));
  const agent = join(dir, "sbgpu-agent");
  const pkg = join(agent, "sbgpu_agent");
  mkdirSync(pkg, { recursive: true });
  const real = new URL("../../agent/sbgpu-agent/sbgpu_agent/", import.meta.url);
  cpSync(new URL("vmboot.py", real), join(pkg, "vmboot.py"));
  writeFileSync(join(pkg, "__init__.py"), "");
  writeFileSync(join(pkg, "_stub.py"), STUB);
  writeFileSync(join(pkg, "neutralise.py"), NEUTRALISE);
  writeFileSync(join(pkg, "vmgate.py"), VMGATE);
  writeFileSync(join(pkg, "boottime.py"), CLOCK);
  writeFileSync(join(agent, "__main__.py"), FAKE_AGENT);
  writeFileSync(join(agent, "image-allowlist.json"), "{}");
  edit?.(dir);
  const out = join(root, `${name}.tgz`);
  execFileSync("tar", ["-czf", out, "-C", dir, "."]);
  return readFileSync(out);
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "sbgpu-vmboot-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")],
    { stdio: "ignore" });
  ca = join(root, "cert.pem");
  server = createServer({ key: readFileSync(join(root, "key.pem")), cert: readFileSync(ca) }, (req, res) => {
    const path = req.url ?? "";
    if (path === "/v1/agent/announce" && req.method === "POST") {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        announces.push({ prefix: current, body });
        writeFileSync(join(current, "calls.log"), JSON.stringify({ who: "announce", argv: [], env: {}, stdin: "" }) + "\n", { flag: "a" });
        const r = reply();
        res.writeHead(r.status, { "content-type": "application/json", ...(r.status === 302 ? { location: "https://localhost/" } : {}) }).end(r.body);
      });
      return;
    }
    hits++;
    const body = files.get(path);
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  files.set("/agent.tgz", tarball("agent"));
  files.set("/no-vmboot.tgz", tarball("no-vmboot", (d) => rmSync(join(d, "sbgpu-agent/sbgpu_agent/vmboot.py"))));
  // (an announce child that hangs after making /run/sbgpu, as a held fsync would: only the hard bound ends it)
  files.set("/hang.tgz", tarball("hang", (d) => {
    const p = join(d, "sbgpu-agent/sbgpu_agent/vmboot.py");
    writeFileSync(p, readFileSync(p, "utf8").replace("def announce(prefix,", `def announce(prefix, *a):
    import time
    d, st = make_dir(prefix)
    os.write(os.open("boot.json", os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=d), ("T" * int("20") + "o-_" + "k" * int("20")).encode())  # (built at run time: no literal in the .pyc)
    print("dir %d %d" % (st.st_dev, st.st_ino), flush=True)
    time.sleep(600)


def unused(prefix,`));
  }));
  // (a gate-file writer that hangs: only its hard bound ends it)
  files.set("/hang-gatefile.tgz", tarball("hang-gatefile", (d) => {
    const p = join(d, "sbgpu-agent/sbgpu_agent/vmboot.py");
    writeFileSync(p, readFileSync(p, "utf8").replace("def gatefile(prefix, deadline, dev, ino, stdin):", `def gatefile(prefix, deadline, dev, ino, stdin):
    import time
    time.sleep(600)


def unused_gatefile(prefix, deadline, dev, ino, stdin):`));
  }));
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

interface Call { who: string; argv: string[]; env: Record<string, string>; stdin: string }
interface Run {
  code: number | null;
  stderr: string;
  prefix: string;
  script: Buffer; // the bytes run, as delivered
  calls: Call[];
  agent: { argv: string[]; env: Record<string, string>; flags: number[]; boot: Record<string, unknown>; bootKeys: string[]; tokenSha: string; gate: string; modes: string[]; files: string[] } | null;
  announces: string[];
}

const SCRIPT_PATH = "var/lib/cloud/instance/scripts/part-001";
const USER_DATA = "var/lib/cloud/instance/user-data.txt";
let runs = 0;
let bin: string | undefined;
const PYTHON = execFileSync("python3", ["-I", "-c", "import sys; print(sys.executable)"]).toString().trim();

/** A PATH directory of links to the real commands (python3 itself, not a wrapper script that adds to the environment). */
function binDir(): string {
  if (bin) return bin;
  bin = mkdtempSync(join(root, "bin-"));
  for (const c of ["sh", "rm", "mkdir", "wc", "sleep", "tar", "gzip", "cat", "env", "python3", "curl", "timeout", "sed"]) {
    const real = c === "python3" ? PYTHON : execFileSync("sh", ["-c", `command -v ${c}`]).toString().trim();
    symlinkSync(real, join(bin, c));
  }
  return bin;
}

let oldBin: string | undefined;
/**
 * binDir, but with an older GNU timeout's way of ending a child (coreutils 9.1, Debian 12's): with
 * -s KILL it signals its own process group, itself included, so it dies by SIGKILL (137) and a shell
 * waiting on it may report "Killed" on its stderr. Newer versions exit 124 quietly.
 */
function oldTimeoutBin(): string {
  if (oldBin) return oldBin;
  oldBin = mkdtempSync(join(root, "bin-old-"));
  for (const c of readdirSync(binDir())) if (c !== "timeout") symlinkSync(readlinkSync(join(binDir(), c)), join(oldBin, c));
  writeFileSync(join(oldBin, "timeout"), `#!${PYTHON} -I
import os, signal, subprocess, sys
a = sys.argv[1:]
if a[:2] != ["-s", "KILL"]:
    sys.exit(125)
os.setpgid(0, 0)
p = subprocess.Popen(a[3:])
try:
    sys.exit(p.wait(timeout=float(a[2])))
except subprocess.TimeoutExpired:
    os.killpg(0, signal.SIGKILL)
`, { mode: 0o755 });
  return oldBin;
}

function newPrefix(): string {
  const prefix = join(root, `p${++runs}`);
  for (const d of ["run", "var/lib/cloud/instance/scripts", "proc/self"]) mkdirSync(join(prefix, d), { recursive: true });
  const dev = statSync(join(prefix, "run")).dev;
  // (st_dev as major:minor, the way the kernel encodes it)
  const major = Number((BigInt(dev) >> 8n) & 0xfffn) | Number((BigInt(dev) >> 32n) & ~0xfffn);
  const minor = Number(BigInt(dev) & 0xffn) | Number((BigInt(dev) >> 12n) & ~0xffn);
  writeFileSync(join(prefix, "proc/self/mountinfo"), `22 1 8:1 / / rw - ext4 /dev/sda1 rw\n25 22 ${major}:${minor} / /run rw,nosuid - tmpfs tmpfs rw\n`);
  return prefix;
}

async function launch(opts: {
  path?: string;
  sha?: string;
  edit?: (script: string) => string;
  clock?: Record<string, number>;
  setup?: (prefix: string) => void;
  prefix?: string;
  scriptMode?: number;
  append?: string;
  via?: "file" | "link" | "dash-c";
  /** The PATH directory: binDir() unless given (oldTimeoutBin() for an older timeout). */
  bin?: string;
} = {}): Promise<Run> {
  const prefix = opts.prefix ?? newPrefix();
  current = prefix;
  rmSync(join(prefix, "agent.json"), { force: true });
  const tgz = files.get(opts.path ?? "/agent.tgz")!;
  let script = renderBootScript({
    agentUrl: `https://localhost:${port}${opts.path ?? "/agent.tgz"}`,
    agentSha256: opts.sha ?? sha(tgz),
    controlUrl: `https://localhost:${port}`,
    mode: "vm",
    machineId: MACHINE,
    nonce: NONCE,
  }, { prefix, body: VM_LAUNCHER_SH });
  if (opts.edit) script = opts.edit(script);
  if (opts.append) script += opts.append;
  const scriptPath = join(prefix, SCRIPT_PATH);
  if (!opts.prefix) {
    writeFileSync(scriptPath, script, { mode: 0o700 });
    chmodSync(scriptPath, opts.scriptMode ?? 0o700);
    writeFileSync(join(prefix, USER_DATA), script, { mode: 0o600 });
    writeFileSync(join(prefix, "clock.json"), JSON.stringify({ default: C, ...opts.clock }));
    opts.setup?.(prefix);
  }
  let argv = ["/bin/sh", scriptPath];
  if (opts.via === "link") {
    symlinkSync(scriptPath, join(prefix, "link.sh"));
    argv = ["/bin/sh", join(prefix, "link.sh")];
  } else if (opts.via === "dash-c") {
    argv = ["/bin/sh", "-c", script];
  }
  const env = { PATH: opts.bin ?? binDir(), CURL_CA_BUNDLE: ca, SSL_CERT_FILE: ca };
  const before = announces.length;
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "ignore", "pipe"], cwd: prefix });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  const log = join(prefix, "calls.log");
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
  const agentPath = join(prefix, "agent.json");
  return {
    code, stderr, prefix, script: readFileSync(scriptPath), calls,
    agent: existsSync(agentPath) ? JSON.parse(readFileSync(agentPath, "utf8")) : null,
    announces: announces.slice(before).map((a) => a.body),
  };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

/** The files under the prefix holding `secret`, as paths relative to it. */
function holding(r: Run, secret: string): string[] {
  return filesUnder(r.prefix).filter((f) => readFileSync(f).includes(secret)).map((f) => f.slice(r.prefix.length + 1)).sort();
}

/** H4/H6: neither secret in any file the launcher created, any report line, any call log, argv or environment; the
 * delivered copies still hold the spent nonce; the token in no file at all. */
function assertSecretsKept(r: Run): void {
  assert.deepEqual(holding(r, NONCE), [USER_DATA, SCRIPT_PATH].sort(), "the nonce: in the delivered copies only");
  assert.deepEqual(holding(r, TOKEN), [], "the token: in no file");
  for (const s of [NONCE, TOKEN]) {
    assert.ok(!r.stderr.includes(s));
    for (const c of r.calls) {
      assert.ok(!c.argv.some((a) => a.includes(s)), `${c.who} argv`);
      assert.ok(!Object.entries(c.env).some(([k, v]) => k.includes(s) || v.includes(s)), `${c.who} env`);
      assert.ok(!c.stdin.includes(s), `${c.who} stdin`);
    }
    if (r.agent) assert.ok(!JSON.stringify(r.agent).includes(s));
  }
}

function who(r: Run): string[] {
  return r.calls.map((c) => c.who);
}

function assertStopped(r: Run, step: string, word: string, code = 2): void {
  assert.equal(r.stderr, line(step, word), `${step}: ${r.stderr}`);
  assert.equal(r.code, code, step);
  assert.equal(r.agent, null, "the agent must not run");
}

test("a good boot: every step in order, one announce, both files for the agent, and the agent run isolated", async () => {
  const r = await launch();
  assert.equal(r.stderr, OK_LINE);
  assert.equal(r.code, 0);
  assert.deepEqual(who(r), ["neutralise", "vmgate", "announce", "vmgate"]);
  // the announce: once, exactly the fixture's shape, with this script's own hash
  assert.equal(r.announces.length, 1);
  assert.equal(r.announces[0], JSON.stringify({ machineId: MACHINE, nonce: NONCE, bootScriptSha256: sha(r.script) }));
  // the gate: the nonce's digest first, then both
  const nonceKnown = { sha256: sha(NONCE), bytes: 22 };
  assert.deepEqual(JSON.parse(r.calls[1]!.stdin), { known: [nonceKnown] });
  assert.deepEqual(JSON.parse(r.calls[3]!.stdin), { known: [nonceKnown, { sha256: sha(TOKEN), bytes: 43 }] });
  for (const c of [r.calls[0]!, r.calls[1]!, r.calls[3]!]) {
    assert.equal(c.argv.at(-1), join(r.prefix, "var/lib/sbgpu/agent/sbgpu-agent/image-allowlist.json"));
  }
  // the agent
  const a = r.agent!;
  assert.deepEqual(a.argv, ["vm"]);
  assert.deepEqual(Object.keys(a.env).sort(), ["HOME", "LANG", "PATH", "SBGPU_PREFIX"]);
  assert.equal(a.env.SBGPU_PREFIX, r.prefix);
  assert.deepEqual(a.flags, [1, 1]);
  assert.deepEqual(a.bootKeys, ["agentSha256", "bootToken", "controlUrl", "enrollByBoottimeMs", "mode"]);
  assert.deepEqual(a.boot, { controlUrl: `https://localhost:${port}`, mode: "vm", agentSha256: sha(files.get("/agent.tgz")!), enrollByBoottimeMs: D });
  assert.equal(a.tokenSha, sha(TOKEN));
  assert.equal(a.gate, '{"v":1,"pass":true,"fail":[]}');
  assert.deepEqual(a.modes, ["0o700", "0o600", "0o600"]);
  assert.deepEqual(a.files, ["boot.json", "gate.json"]);
  assert.ok(existsSync(join(r.prefix, "var/lib/sbgpu/boot-ran")));
  assert.ok(!existsSync(join(r.prefix, "var/lib/sbgpu/agent.tar.gz")));
  assertSecretsKept(r);
});

test("once: a second run stops at rerun (exit 4) before any request; an ambiguous marker directory is once", async () => {
  const first = await launch();
  assert.equal(first.code, 0, first.stderr);
  const [h, n] = [hits, announces.length];
  const again = await launch({ prefix: first.prefix });
  assertStopped(again, "once", "rerun", 4);
  assert.deepEqual([hits, announces.length], [h, n]);
  for (const setup of [
    (p: string) => symlinkSync(join(p, "run"), join(p, "var/lib/sbgpu")),
    (p: string) => mkdirSync(join(p, "var/lib/sbgpu"), { mode: 0o755 }),
    (p: string) => writeFileSync(join(p, "var/lib/sbgpu"), ""),
  ]) {
    const r = await launch({ setup });
    assertStopped(r, "once", "once");
    assert.deepEqual([hits, announces.length], [h, n]);
  }
});

test("limits (H1, H3): a umask or core limit that doesn't read back stops the boot first, before any value line", async () => {
  for (const edit of [
    (s: string) => s.replace("umask 077 &&", "umask 022 &&"),
    (s: string) => s.replace('[ "$(umask)" = 0077 ]', '[ "$(umask)" = 0070 ]'),
    (s: string) => s.replace("ulimit -c 0 &&", "false &&"),
    (s: string) => s.replace('[ "$(ulimit -c)" = 0 ]', '[ "$(ulimit -c)" = 1 ]'),
  ]) {
    // (a value line that would show it ran: it makes a file)
    const r = await launch({ edit: (s) => edit(s).replace("SBGPU_AGENT_URL=", `: >"${"$"}0.ran"; SBGPU_AGENT_URL=`) });
    assertStopped(r, "limits", "limits");
    assert.ok(!existsSync(join(r.prefix, SCRIPT_PATH + ".ran")));
    assert.ok(!existsSync(join(r.prefix, "var/lib/sbgpu")));
  }
});

test("values: each in its exact shape, checked before anything is fetched", async () => {
  const h = hits;
  for (const [from, to] of [
    [`SBGPU_NONCE='${NONCE}'`, `SBGPU_NONCE='${NONCE.slice(1)}'`],
    [`SBGPU_NONCE='${NONCE}'`, `SBGPU_NONCE='${NONCE.slice(1)}+'`],
    [`SBGPU_NONCE='${NONCE}'`, `SBGPU_NONCE='${NONCE}A'`],
    [`SBGPU_MACHINE_ID='${MACHINE}'`, `SBGPU_MACHINE_ID='prj_${MACHINE.slice(4)}'`],
    [`SBGPU_MACHINE_ID='${MACHINE}'`, `SBGPU_MACHINE_ID='${MACHINE.slice(0, -1)}i'`],
    [`SBGPU_MACHINE_ID='${MACHINE}'`, `SBGPU_MACHINE_ID='${MACHINE}0'`],
    ["SBGPU_CONTROL_URL='https://", "SBGPU_CONTROL_URL='http://"],
    ["SBGPU_AGENT_URL='https://", "SBGPU_AGENT_URL='http://"],
    ["SBGPU_AGENT_SHA256='", "SBGPU_AGENT_SHA256='A"],
    ["SBGPU_MODE='vm'", "SBGPU_MODE='container'"],
  ]) {
    const r = await launch({ edit: (s) => s.replace(from!, to!) });
    assertStopped(r, "values", "values");
  }
  assert.equal(hits, h);
});

test("self (Q3): $0 is hashed as delivered; a link, -c, a writable or oversized script stops the boot", async () => {
  const copy = await launch({ append: "# a wrapper's extra line\n" });
  assert.equal(copy.code, 0, copy.stderr);
  assert.equal(JSON.parse(copy.announces[0]!).bootScriptSha256, sha(copy.script));
  assert.notEqual(sha(copy.script), sha(copy.script.subarray(0, copy.script.length - 25)));
  const n = announces.length;
  for (const [opts, why] of [
    [{ via: "link" as const }, "a link"],
    [{ via: "dash-c" as const }, "sh -c"],
    [{ scriptMode: 0o720 }, "group-writable"],
    [{ scriptMode: 0o702 }, "other-writable"],
    [{ append: "#" + "x".repeat(65_536) + "\n" }, "over 64 KiB"],
  ] as const) {
    const r = await launch(opts);
    assertStopped(r, "self", "self");
    assert.equal(announces.length, n, why);
  }
});

test("agent: a bad pin, a tarball without vmboot, or an agent directory already there stops the boot", async () => {
  const n = announces.length;
  assertStopped(await launch({ sha: "0".repeat(64) }), "agent", "agent");
  assertStopped(await launch({ path: "/no-vmboot.tgz" }), "agent", "agent");
  const there = await launch({ setup: (p) => { mkdirSync(join(p, "var/lib/sbgpu/agent"), { recursive: true, mode: 0o700 }); chmodSync(join(p, "var/lib/sbgpu"), 0o700); writeFileSync(join(p, "var/lib/sbgpu/agent/keep"), "x"); } });
  assertStopped(there, "agent", "agent");
  assert.equal(readFileSync(join(there.prefix, "var/lib/sbgpu/agent/keep"), "utf8"), "x");
  assert.equal(announces.length, n);
});

test("neutralise: its own word becomes the boot's; anything else is unreadable; nothing after it runs", async () => {
  for (const [conf, word] of [
    [{ line: 'SBGPU-NEUTRALISE {"v":1,"ok":false,"fail":["keys"]}', rc: 1 }, "neutralise:keys"],
    [{ line: 'SBGPU-NEUTRALISE {"v":1,"ok":false,"fail":["sudo"]}', rc: 0 }, "neutralise:sudo"],
    [{ line: 'SBGPU-NEUTRALISE {"v":1,"ok":false,"fail":["bogus"]}', rc: 1 }, "neutralise:unreadable"],
    [{ line: "garbage", rc: 1 }, "neutralise:unreadable"],
    [{ line: 'SBGPU-NEUTRALISE {"v":1,"ok":true,"fail":[]}', rc: 1 }, "neutralise:unreadable"],
  ] as const) {
    const r = await launch({ setup: (p) => writeFileSync(join(p, "neutralise.json"), JSON.stringify(conf)) });
    assertStopped(r, "neutralise", word);
    assert.deepEqual(who(r), ["neutralise"]);
  }
});

test("gate 1: a failing gate stops the boot before the announce", async () => {
  for (const conf of [{ line: 'SBGPU-GATE {"v":1,"pass":false,"fail":["imds"]}', rc: 1 }, { line: PASS, rc: 1 }, { line: "x", rc: 0 }]) {
    const r = await launch({ setup: (p) => writeFileSync(join(p, "gate1.json"), JSON.stringify(conf)) });
    assertStopped(r, "gate1", "gate1");
    assert.deepEqual(who(r), ["neutralise", "vmgate"]);
  }
});

test("announce: anything but a fresh 200 exits 3 after exactly one POST, with nothing written", async () => {
  for (const r0 of [
    () => ({ status: 403, body: '{"error":{"code":"forbidden"}}' }),
    () => ({ status: 302, body: "" }),
    () => issue(60_000),
    () => ({ status: 200, body: JSON.stringify({ bootToken: TOKEN.slice(1), expiresAt: iso(Date.now() + 120_000) }) }),
  ]) {
    reply = r0;
    const r = await launch();
    reply = issue;
    assertStopped(r, "announce", "announce", 3);
    assert.equal(r.announces.length, 1);
    assert.deepEqual(who(r), ["neutralise", "vmgate", "announce"]);
    assert.deepEqual(readdirSync(join(r.prefix, "run")), []);
    assertSecretsKept(r);
  }
});

test("the announce child is killed at 45 s, whatever it is doing, and what it wrote is removed; an older timeout too", { timeout: 180_000 }, async () => {
  for (const bin of [binDir(), oldTimeoutBin()]) {
    const started = Date.now();
    const r = await launch({ path: "/hang.tgz", bin });
    assert.ok(Date.now() - started >= 44_000 && Date.now() - started < 80_000);
    // (one line of fixed words on stderr, whichever timeout: no "Killed" from the shell)
    assertStopped(r, "announce", "announce", 3);
    assert.deepEqual(readdirSync(join(r.prefix, "run/sbgpu")), []);
    assertSecretsKept(r);
  }
});

test("bootfile (H2): /run/sbgpu already there stops the boot, and nothing there is touched", async () => {
  const r = await launch({ setup: (p) => { mkdirSync(join(p, "run/sbgpu"), { mode: 0o700 }); writeFileSync(join(p, "run/sbgpu/keep"), "x"); } });
  assertStopped(r, "bootfile", "bootfile");
  assert.deepEqual(readdirSync(join(r.prefix, "run/sbgpu")), ["keep"]);
  assertSecretsKept(r);
  const elsewhere = mkdtempSync(join(root, "elsewhere-"));
  writeFileSync(join(elsewhere, "keep"), "x");
  const link = await launch({ setup: (p) => symlinkSync(elsewhere, join(p, "run/sbgpu")) });
  assertStopped(link, "bootfile", "bootfile");
  assert.ok(lstatSync(join(link.prefix, "run/sbgpu")).isSymbolicLink());
  assert.deepEqual(readdirSync(elsewhere), ["keep"]);
  assertSecretsKept(link);
});

test("gate 2: a failing or overrunning gate stops the boot, and boot.json is removed", { timeout: 60_000 }, async () => {
  for (const [conf, clock, bin] of [
    [{ line: 'SBGPU-GATE {"v":1,"pass":false,"fail":["known-value"]}', rc: 1 }, {}, "new"],
    [{ line: PASS, rc: 1 }, {}, "new"],
    [{ sleep: 5 }, { "remaining:30": D - 32_000 }, "new"], // (2 s to run in: killed)
    [{ sleep: 5 }, { "remaining:30": D - 32_000 }, "old"], // (the same, with an older timeout: no "Killed" either)
  ] as const) {
    const r = await launch({ clock, bin: bin === "old" ? oldTimeoutBin() : binDir(), setup: (p) => writeFileSync(join(p, "gate2.json"), JSON.stringify(conf)) });
    assertStopped(r, "gate2", "gate2");
    assert.deepEqual(readdirSync(join(r.prefix, "run/sbgpu")), []);
    assertSecretsKept(r);
  }
});

test("gate 2's file writer is killed at its bound, and the boot stops with one line, whichever timeout", { timeout: 60_000 }, async () => {
  for (const bin of [binDir(), oldTimeoutBin()]) {
    const started = Date.now();
    const r = await launch({ path: "/hang-gatefile.tgz", bin, clock: { "remaining:25": D - 27_000 } }); // (2 s to run in: killed)
    assert.ok(Date.now() - started < 30_000);
    assertStopped(r, "gate2", "gate2");
    assert.deepEqual(readdirSync(join(r.prefix, "run/sbgpu")), []);
    assert.equal(r.agent, null);
    assertSecretsKept(r);
  }
});

test("suspend across D (H7): held before gate 2 starts, gate 2 never runs; its twin, short of D, boots", async () => {
  const r = await launch({ clock: { "remaining:30": D + 1_000 } });
  assertStopped(r, "gate2", "gate2");
  assert.deepEqual(who(r), ["neutralise", "vmgate", "announce"]);
  assert.deepEqual(readdirSync(join(r.prefix, "run/sbgpu")), []);
  assertSecretsKept(r);
  const twin = await launch({ clock: { "remaining:30": D - 45_000, "remaining:25": D - 45_000, gatefile: D - 45_000 } });
  assert.equal(twin.stderr, OK_LINE);
  assert.equal(twin.announces.length, 1);
  assert.ok(twin.agent);
});

test("suspend across D (H7): held during gate 2, its result is never written and the agent never runs; the twin boots", async () => {
  const r = await launch({ clock: { "remaining:25": D + 1_000, gatefile: D + 1_000 } });
  assertStopped(r, "gate2", "gate2");
  assert.deepEqual(who(r), ["neutralise", "vmgate", "announce", "vmgate"]);
  assert.deepEqual(readdirSync(join(r.prefix, "run/sbgpu")), []);
  // (the writer alone, with the remaining-time check passing: still refused at D)
  const writer = await launch({ clock: { gatefile: D } });
  assertStopped(writer, "gate2", "gate2");
  assert.deepEqual(readdirSync(join(writer.prefix, "run/sbgpu")), []);
  const twin = await launch({ clock: { "remaining:25": D - 45_000, gatefile: D - 45_000 } });
  assert.equal(twin.stderr, OK_LINE);
  assert.ok(twin.agent);
});

test("vm-launcher.sh is what VM_LAUNCHER_SH holds, and the rendered VM script begins with the two protections", () => {
  assert.equal(VM_LAUNCHER_SH, readFileSync(new URL("vm-launcher.sh", import.meta.url), "utf8"));
  const s = renderBootScript(BOOT_SCRIPT_VECTOR.values, { body: VM_LAUNCHER_SH });
  assert.ok(s.startsWith("#!/bin/sh\n" + VM_HEADER + "SBGPU_AGENT_URL='"));
});

test("vm-launcher.sh passes shellcheck", { skip: !existsSync("/usr/bin/shellcheck") && "no shellcheck" }, () => {
  execFileSync("shellcheck", ["-s", "sh", new URL("vm-launcher.sh", import.meta.url).pathname]);
});
