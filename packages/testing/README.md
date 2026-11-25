# @sbgpu/testing

Test helpers shared by the packages.

- `@sbgpu/testing/worker`: `startWorker({ entry, durableObjects, bindings, d1Databases, migrations })` bundles a Worker entry with esbuild and starts it in Miniflare (local, no network), applying each D1 binding's migration directories in name order; `splitSql` splits a migration into the statements D1 runs one at a time.
- `@sbgpu/testing/relay-contract`: `assertRelayLifecycleContract(make)`, the conformance check for control's machine lifecycle around `revokeMachine` (packages/machine/DESIGN.md, section 4).

This package is test-only: no runtime source of any package (a non-test file under a package's `src/`) may import it. `src/boundary.test.ts` enforces this over the whole tree, with planted imports as its control.
