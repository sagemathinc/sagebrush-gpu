#!/usr/bin/env python3
"""The shared mutation check: apply each mutant of a package, run its tests, judge.

Usage:  python3 -I scripts/mutants.py <package-dir> [<mutants.json>]

<mutants.json> defaults to <package-dir>/mutants.json: a list of
  {"file": "src/x.ts", "old": "...", "new": "...", "note": "optional"}
with file paths relative to the package. Tests are every src/**/*.test.ts of the
package, run with `node --test` from the package directory.

It fails closed. Exit status:
  0  the baseline passes with at least one test, and every mutant is KILLED: the run
     reports the same number of tests as the baseline and at least one fails (or the run
     times out);
  1  any mutant is SURVIVED (all tests pass), NOT-APPLICABLE ('old' not found exactly
     once, or old == new), or INVALID (fewer or more tests than the baseline, a test file
     that failed to load or parse, or no failing named test though node failed: a setup
     error proves nothing about the tests); or a file did not restore byte for byte;
  2  the baseline fails, finds no tests, or the input is unusable.

Each mutant is restored in a finally block and checked byte for byte. SIGTERM and SIGHUP
(a cancelled job, a closed terminal) are turned into an exit through that block, so the
mutant is restored before the runner exits (with 128 + the signal number). One line of
evidence is printed per mutant: the verdict, then the failing tests or the error.
"""

import glob
import hashlib
import json
import os
import re
import signal
import subprocess
import sys

TIMEOUT_S = 120


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def run_tests(pkg, files):
    try:
        r = subprocess.run(
            ["node", "--test", "--test-reporter=tap", *files],
            cwd=pkg,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return {"timeout": True, "rc": None, "out": ""}
    except OSError as e:
        return {"timeout": False, "rc": None, "out": f"cannot run node: {e}"}
    return {"timeout": False, "rc": r.returncode, "out": r.stdout + r.stderr}


def summary(out, key):
    """The last '# key N' summary line of a TAP run, or None."""
    found = re.findall(rf"^# {key} (\d+)\s*$", out, re.M)
    return int(found[-1]) if found else None


def failing(out):
    return [m.group(1).strip() for m in re.finditer(r"^\s*not ok \d+ - (.*)$", out, re.M)]


def classify(result, baseline_tests, test_files, pkg):
    """(verdict, evidence): KILLED, SURVIVED or INVALID.

    A file that fails to load or parse is reported by node as one failing test named by
    the file's path, which can match the baseline count (a package with one test). So any
    failing entry named by a test file is INVALID, and KILLED needs at least one failing
    test with its own name.
    """
    if result["timeout"]:
        return "KILLED", f"timeout after {TIMEOUT_S}s"
    out = result["out"]
    tests, fails = summary(out, "tests"), summary(out, "fail")
    if result["rc"] == 0 and tests == baseline_tests and fails == 0:
        return "SURVIVED", f"{tests} tests, all pass"
    if result["rc"] in (0, None) or tests != baseline_tests or not fails:
        err = re.search(r"(\w*Error\b[^\n]*)", out)
        why = err.group(1)[:160] if err else (out.strip().splitlines() or ["no output"])[-1][:160]
        return "INVALID", f"exit {result['rc']}, tests {tests} (baseline {baseline_tests}), fail {fails}: {why}"
    file_names = set(test_files) | {os.path.join(pkg, f) for f in test_files}
    names = failing(out)
    file_level = [n for n in names if n in file_names or n.endswith(".test.ts")]
    named = [n for n in names if n not in file_level]
    if file_level or not named:
        why = f"file-level failure of {', '.join(file_level[:3])}" if file_level else "no named failing test"
        return "INVALID", f"exit {result['rc']}, tests {tests} (baseline {baseline_tests}): {why}"
    shown = "; ".join(named[:3]) + (f" (+{len(named) - 3} more)" if len(named) > 3 else "")
    return "KILLED", f"{fails} failing: {shown}"


class Interrupted(BaseException):
    def __init__(self, signum):
        super().__init__(signum)
        self.signum = signum


def _raise_interrupted(signum, _frame):
    raise Interrupted(signum)


def main(argv):
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _raise_interrupted)
    try:
        return run(argv)
    except Interrupted as e:
        print(f"INTERRUPTED by signal {e.signum}: the file being mutated was restored")
        return 128 + e.signum


def run(argv):
    if len(argv) not in (2, 3):
        print(__doc__)
        return 2
    pkg = os.path.abspath(argv[1])
    list_path = argv[2] if len(argv) == 3 else os.path.join(pkg, "mutants.json")
    try:
        with open(list_path, encoding="utf-8") as f:
            mutants = json.load(f)
        if not isinstance(mutants, list):
            raise ValueError("the mutant list must be a JSON array")
    except (OSError, ValueError) as e:
        print(f"BAD INPUT: {list_path}: {e}")
        return 2
    test_files = sorted(os.path.relpath(p, pkg) for p in glob.glob(os.path.join(pkg, "src", "**", "*.test.ts"), recursive=True))
    if not test_files or not mutants:
        print(f"BAD INPUT: {len(test_files)} test files, {len(mutants)} mutants")
        return 2

    base = run_tests(pkg, test_files)
    tests, passed, fails = summary(base["out"], "tests"), summary(base["out"], "pass"), summary(base["out"], "fail")
    if base["timeout"] or base["rc"] != 0 or not tests or passed != tests or fails != 0:
        print(f"BASELINE FAILED: exit {base['rc']}, timeout {base['timeout']}, tests {tests}, pass {passed}, fail {fails}")
        print("\n".join(base["out"].splitlines()[-30:]))
        return 2
    print(f"baseline: {tests} tests pass in {len(test_files)} files")

    bad = 0
    counts = {}
    for i, m in enumerate(mutants, 1):
        ok_shape = isinstance(m, dict) and all(isinstance(m.get(k), str) for k in ("file", "old", "new"))
        label = f"#{i} {m.get('file') if isinstance(m, dict) else m!r}"
        if ok_shape:
            label += f": {m['old'][:60]!r} -> {m['new'][:60]!r}"
        path = os.path.normpath(os.path.join(pkg, m["file"])) if ok_shape else ""
        if not ok_shape or not path.startswith(pkg + os.sep) or not os.path.isfile(path):
            verdict, evidence = "NOT-APPLICABLE", "malformed mutant, or its file is missing or outside the package"
        else:
            with open(path, encoding="utf-8", newline="") as f:
                src = f.read()
            before = sha(path)
            n = src.count(m["old"])
            if n != 1 or m["old"] == m["new"]:
                verdict, evidence = "NOT-APPLICABLE", f"'old' occurs {n} times" if n != 1 else "old == new"
            else:
                try:
                    with open(path, "w", encoding="utf-8", newline="") as f:
                        f.write(src.replace(m["old"], m["new"]))
                    verdict, evidence = classify(run_tests(pkg, test_files), tests, test_files, pkg)
                finally:
                    with open(path, "w", encoding="utf-8", newline="") as f:
                        f.write(src)
                if sha(path) != before:
                    print(f"RESTORE FAILED {label}")
                    return 1
        counts[verdict] = counts.get(verdict, 0) + 1
        if verdict != "KILLED":
            bad += 1
        print(f"{verdict:14} {label}\n               {evidence}")

    print(f"{len(mutants)} mutants: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    if bad:
        print(f"FAIL: {bad} mutant(s) not killed by a test")
        return 1
    print("OK: every mutant was killed by a test")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
