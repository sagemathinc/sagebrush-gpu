# sagebrush-gpu (working name)

A prepaid GPU sub-budget service. An organization buys credit and divides it among
projects, teams and members; members start GPU machines on whichever provider has
capacity, under hard spending limits. The API comes first: the web UI and Sagebrush
are both clients of it.

## Layout

| Package | What |
|---|---|
| `packages/api` (`@sbgpu/api`) | The API contract: types for every object and endpoint, money helpers. Every other package imports it. |
| `packages/control` | Control plane: Cloudflare Worker + D1 (API, ledger, allocations, watchdog). |
| `packages/providers` | Provider interface, adapters and placement. |
| `packages/machine` | Boot script, agent, storage gateway Worker, `ws-sync`. |
| `packages/ui` | Manager and member UI. |

## Develop

```sh
pnpm install
bash scripts/check.sh   # typecheck + all tests (the CI line)
```

Code is TypeScript run directly by Node (type stripping), so it uses erasable syntax
only: no `enum`, no `namespace`, no parameter properties. Tests are `*.test.ts` files
next to the code, run with `node --test`.

## Conventions

- **Money** is an integer number of micro-dollars (`Micros`, 1e-6 USD). Never floats.
  Every price carries the provider's part and our margin separately.
- **Times** on the wire are ISO-8601 UTC strings (`2027-02-01T09:00:00.000Z`).
- **Ids** are prefixed strings (`org_…`, `prj_…`, `mch_…`).
- **Errors** are `{ "error": { "code": ..., "message": ... } }` with a closed set of codes.

## Mutation checks

One shared runner, `scripts/mutants.py`, fails closed (see its header). Each package
keeps its list in `packages/<pkg>/mutants.json`: `[{"file": "src/...", "old": "...",
"new": "...", "note": "optional"}]`, paths relative to the package; tests are the
package's `src/**/*.test.ts`. Run `python3 -I scripts/mutants.py packages/<pkg>`.
