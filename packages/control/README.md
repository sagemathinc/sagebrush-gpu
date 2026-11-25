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

- `src/worker.ts`: the Worker. fetch serves only the app's origin: `/v1/*` (the API),
  `/api/relay/v1/*` (the machine relay's routes) and the UI's static assets, every response
  with the security headers. scheduled runs `src/jobs.ts`'s list (every minute; each job
  bounded per run). `src/entry.ts` is the deployed entry: the Worker plus the relay's
  Durable Object class.
- `wrangler.json`: the deploy config, a template with placeholders (example.com hosts, a
  zeroed database id). `run_worker_first` keeps every asset behind the Worker, and so behind
  the security headers. The Miniflare tests (`src/worker.test.ts`) read this same file.
  Sign-in mail is refused until a sender is configured.

Mutation check: `python3 -I scripts/mutants.py packages/control`.
