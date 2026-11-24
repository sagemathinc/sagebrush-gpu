#!/usr/bin/env python3
"""Self-test of scripts/mutants.py: it must fail closed. Run: python3 -I scripts/test-mutants.py"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mutants.py")

MODULE = "export const f = (x: number): number => x + 1;\nexport const g = (x: number): number => x * 2;\n"
TEST = (
    'import { test } from "node:test";\n'
    'import assert from "node:assert/strict";\n'
    'import { f, g } from "./m.ts";\n'
    'test("f adds one", () => { assert.equal(f(1), 2); });\n'
    'test("g is called", () => { g(3); });\n'
)
OTHER = 'import { test } from "node:test";\ntest("other", () => {});\n'

failures = []


def make_pkg():
    d = tempfile.mkdtemp(prefix="mutants-selftest-")
    os.makedirs(os.path.join(d, "src", "a"))
    files = {"package.json": '{"type": "module"}\n', "src/a/m.ts": MODULE, "src/a/m.test.ts": TEST, "src/other.test.ts": OTHER}
    for rel, text in files.items():
        with open(os.path.join(d, rel), "w") as f:
            f.write(text)
    return d, files


def run(pkg, mutants, env=None, raw=None):
    path = os.path.join(pkg, "mutants.json")
    with open(path, "w") as f:
        f.write(raw if raw is not None else json.dumps(mutants))
    r = subprocess.run([sys.executable, "-I", RUNNER, pkg], capture_output=True, text=True, env=env, timeout=600)
    return r.returncode, r.stdout + r.stderr


def check(name, mutants, want_rc, want_text, env=None, raw=None, setup=None):
    pkg, files = make_pkg()
    try:
        if setup:
            setup(pkg)
            files = None  # the setup changed files on purpose
        rc, out = run(pkg, mutants, env=env, raw=raw)
        if rc != want_rc or want_text not in out:
            failures.append(f"{name}: exit {rc} (want {want_rc}), want {want_text!r} in:\n{out}")
        if files:
            for rel, text in files.items():
                with open(os.path.join(pkg, rel)) as f:
                    if f.read() != text:
                        failures.append(f"{name}: {rel} not restored")
        print(f"{'ok' if rc == want_rc and want_text in out else 'FAIL':4} {name}")
    finally:
        shutil.rmtree(pkg)


M = "src/a/m.ts"
killed = {"file": M, "old": "x + 1", "new": "x + 2"}

check("a killed mutant passes", [killed], 0, "KILLED")
check("a survivor fails", [killed, {"file": M, "old": "x * 2", "new": "x * 3"}], 1, "SURVIVED")
check("a mutant not found fails", [killed, {"file": M, "old": "nope", "new": "x"}], 1, "NOT-APPLICABLE")
check("a mutant found twice fails", [{"file": M, "old": "(x: number): number", "new": "(x: any): number"}], 1, "occurs 2 times")
check("old == new fails", [{"file": M, "old": "x + 1", "new": "x + 1"}], 1, "NOT-APPLICABLE")
check("a missing file fails", [{"file": "src/nope.ts", "old": "a", "new": "b"}], 1, "NOT-APPLICABLE")
check("a path outside the package fails", [{"file": "../m.ts", "old": "a", "new": "b"}], 1, "NOT-APPLICABLE")
check("a malformed mutant fails", [{"file": M, "old": 1, "new": "b"}], 1, "NOT-APPLICABLE")
check("a load error is invalid, not killed", [{"file": M, "old": "x + 1;", "new": "x +;"}], 1, "INVALID")
check(
    "a mutant changing the test count is invalid",
    [{"file": "src/a/m.test.ts", "old": 'test("g is called", () => { g(3); });\n', "new": ""}],
    1,
    "INVALID",
)
check("a failing baseline stops everything", [killed], 2, "BASELINE FAILED", setup=lambda p: open(os.path.join(p, "src/other.test.ts"), "a").write('test("bad", () => { throw new Error("x"); });\n'))
check("no tests is a bad input", [killed], 2, "BAD INPUT", setup=lambda p: [os.remove(os.path.join(p, f)) for f in ("src/a/m.test.ts", "src/other.test.ts")])
check("an empty list is a bad input", [], 2, "BAD INPUT")
check("a non-list is a bad input", None, 2, "BAD INPUT", raw='{"mutants": []}')
check("broken JSON is a bad input", None, 2, "BAD INPUT", raw="[")

# astra2's case: a package with exactly one test. A load error is one failing "test" named
# by the file, so the count matches the baseline; it must still be INVALID.
def one_test(p):
    os.remove(os.path.join(p, "src/other.test.ts"))
    with open(os.path.join(p, "src/a/m.test.ts"), "w") as f:
        f.write('import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { f } from "./m.ts";\ntest("adds", () => { assert.equal(f(1), 2); });\n')

check("one test: a load error is invalid", [{"file": M, "old": "x + 1;", "new": "x +;"}], 1, "INVALID", setup=one_test)
check("one test: a real kill passes", [killed], 0, "KILLED", setup=one_test)
# astra2's fixture exactly: a one-test file beside a healthy file (baseline 2 tests)
def one_test_beside_healthy(p):
    with open(os.path.join(p, "src/a/m.test.ts"), "w") as f:
        f.write('import {test} from "node:test";\nimport assert from "node:assert/strict";\nimport {f} from "./m.ts";\ntest("adds",()=>assert.equal(f(1),2));\n')

check("one-test file beside a healthy file: a load error is invalid", [{"file": M, "old": "x + 1", "new": "x +"}], 1, "INVALID", setup=one_test_beside_healthy)
# a load error in one file next to real failures in another is still invalid
two_files = lambda p: open(os.path.join(p, "src/other.test.ts"), "w").write('import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { g } from "./a/m.ts";\ntest("g doubles", () => { assert.equal(g(2), 4); });\n')
check("a load error beside a real failure is invalid", [{"file": "src/a/m.test.ts", "old": 'import { f, g } from "./m.ts";', "new": 'import { f, g } from "./m.ts"; x x;'}], 1, "INVALID", setup=two_files)

# node replaced by shims: one that always fails, one that "passes" without running anything
for name, body, want in [("always-failing node", "exit 1", 2), ("silent passing node", "exit 0", 2)]:
    shim = tempfile.mkdtemp(prefix="node-shim-")
    with open(os.path.join(shim, "node"), "w") as f:
        f.write(f"#!/bin/sh\n{body}\n")
    os.chmod(os.path.join(shim, "node"), 0o755)
    env = dict(os.environ, PATH=shim + os.pathsep + os.environ.get("PATH", ""))
    check(name, [killed], want, "BASELINE FAILED", env=env)
    shutil.rmtree(shim)

# A cancelled run (SIGTERM, SIGHUP) must restore the mutated file before exiting.
import signal
import time


def interrupted(name, sig):
    pkg, files = make_pkg()
    try:
        with open(os.path.join(pkg, "src/other.test.ts"), "w") as f:
            f.write('import { test } from "node:test";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 4000)); });\n')
        files["src/other.test.ts"] = open(os.path.join(pkg, "src/other.test.ts")).read()
        with open(os.path.join(pkg, "mutants.json"), "w") as f:
            json.dump([killed], f)
        p = subprocess.Popen([sys.executable, "-I", RUNNER, pkg], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        path = os.path.join(pkg, M)
        deadline = time.time() + 60
        while time.time() < deadline and open(path).read() == MODULE:
            time.sleep(0.05)
        applied = open(path).read() != MODULE
        p.send_signal(sig)
        out, _ = p.communicate(timeout=60)
        ok = applied and p.returncode == 128 + sig and "INTERRUPTED" in out
        for rel, text in files.items():
            with open(os.path.join(pkg, rel)) as f:
                if f.read() != text:
                    ok = False
                    failures.append(f"{name}: {rel} not restored")
        if not ok:
            failures.append(f"{name}: applied {applied}, exit {p.returncode}, output:\n{out}")
        print(f"{'ok' if ok else 'FAIL':4} {name}")
    finally:
        shutil.rmtree(pkg)


interrupted("SIGTERM mid-mutant restores the file", signal.SIGTERM)
interrupted("SIGHUP mid-mutant restores the file", signal.SIGHUP)

if failures:
    print("\n\n".join(failures))
    sys.exit(1)
print("mutants.py self-test: all cases fail closed as expected")
