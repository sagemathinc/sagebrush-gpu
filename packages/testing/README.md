# @sbgpu/testing

Test helpers shared by the packages.

- `@sbgpu/testing/worker`: `startWorker({ entry, durableObjects, bindings, d1Databases, migrations })` bundles a Worker entry with esbuild and starts it in Miniflare (local, no network), applying each D1 binding's migration directories in name order; `splitSql` splits a migration into the statements D1 runs one at a time.
