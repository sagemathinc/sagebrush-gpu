# @sbgpu/control

The control plane: Cloudflare Worker + D1 (API, ledger, allocations, watchdog). Lane: control.

- `migrations/`: the D1 schema, applied in order. Money is integer micro-USD; times are
  integer Unix milliseconds (UTC).
- `src/db.ts`: the database interface (reads, and atomic batches), with a D1 adapter.
  Tests use `src/testing/sqlite.ts`, the same SQL on `node:sqlite`.
- `src/ledger.ts`: per-minute accrual (one entry per machine per UTC minute, written
  once the minute has closed, for the seconds of all the machine's placements in it, at
  the rate pinned by the minute's first fragment) and `findHardStops` (unspent against
  a bound computed the way the ledger charges, failing closed).

Mutation check: `python3 -I scripts/mutants.py packages/control`.
