#!/usr/bin/env bash
# The full local check, and the CI line: typecheck, every test, and the mutant runner's
# self-test. Mutation campaigns (python3 -I scripts/mutants.py packages/<pkg>) are run
# per change, by the author and TESTS.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec tsc -b
node packages/machine/scripts/gen-bootstrap.ts --check
node --test --test-reporter=dot "packages/*/src/**/*.test.ts"
python3 -I scripts/test-mutants.py
