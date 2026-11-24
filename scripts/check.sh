#!/usr/bin/env bash
# The full local check, and the CI line once the repo has CI: typecheck, then every test.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec tsc -b
node --test --test-reporter=dot "packages/*/src/**/*.test.ts"
