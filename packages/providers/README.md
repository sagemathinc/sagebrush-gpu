# @sbgpu/providers

The provider interface, its adapters, placement and the drift check. Lane: providers.

Everything here runs in a Cloudflare Worker: the only I/O is an injected `fetch`, so tests never
reach a provider. Provider API keys come from the control plane's secrets and are only ever sent
in an `Authorization` header. Error messages never include a request, and never include the
provider's response text either (it can echo request values such as the boot token): only the
HTTP status and our error kind.

## The interface (`types.ts`)

`ProviderAdapter`, one per provider:

| Method | Does |
|---|---|
| `listOffers({gpuCount})` | Current `Offer`s: one per GPU type we map and data center, with the provider's list price (no margin) and its stock label. |
| `launch(spec)` | Launch one machine; returns the provider id and its first status. |
| `status(id)` | A `ProviderMachineStatus`. A machine the provider no longer knows is `terminated`. |
| `terminate(id)` | Idempotent. There is no provider "stop": a stop is always a terminate (workspaces live in R2), and a restart is a new launch plus a restore. |
| `listMachines()` | Every machine of ours the provider knows, for the watchdog and for orphan recovery. A partial list is an error, never a result. |

`info` says which environment variable carries the boot token and how a machine learns its own
provider id (`selfIdentity`, a cross-check at enrollment only: user code can read and fake it).

Quotes are not an adapter method: an `Offer` is the provider's price, and the control plane adds
the margin (`priceSplit` in `@sbgpu/api`).

**Names.** A machine's provider-side name is `sbg-<machineId>` (`machine-name.ts`). Anything that
doesn't parse as one of our machine ids isn't ours.

## Launch spec

`LaunchSpec` has no free-form environment. The provider-side environment is provider metadata
(the provider's API returns it), so it carries exactly one value: the one-time boot token. The
launcher argv comes from `@sbgpu/machine` and becomes the container's entrypoint, so our code is
PID 1 and runs before any access.

On RunPod the create body is fixed (`RunPodAdapter.createBody`): Secure Cloud, one data center,
`entrypoint` = the launcher, `cmd: []`, `ports: []`, `startSsh: false`, `startJupyter: false`,
`mounts: {}`, no template, `env` = `{SBGPU_BOOT_TOKEN}` only. RunPod's own `/start.sh` (nginx,
sshd, Jupyter) never runs.

**After every launch** the adapter checks the returned pod against the spec (the drift check
below, except a data center the scheduler hasn't reported yet). A pod that doesn't match is
reported with its id: `price_above_cap` when only the rate is too high, `spec_mismatch` for
anything else. Placement then cleans it up (below).

**Parsing fails closed.** Only a pod without an id is an error. Every other field RunPod sends
malformed or not at all is kept as an unreadable value (`<unreadable>`, `NaN`) that never equals
an expected one, so the drift check reports it: missing or non-string `ports`, `env`, `entrypoint`
or `cmd` entries, missing or malformed `mounts` (an unknown mount kind, a non-array network or
global list, a non-integer or zero size: any persistent mount is a volume), a missing `cmd`, a
non-integer disk or GPU count, a missing image. Provider settings outside our launch shape are
listed in `unexpectedSettings` (expected empty): on RunPod, a cloud other than `SECURE`, any
non-null SSH endpoint (`ssh.proxy`, `ssh.direct`, or an unknown kind; `proxy` and `direct` must
both be reported, as null), a non-null `template`,
and global networking not explicitly disabled; a missing or malformed value is listed as
unreadable. A list or
catalog response that doesn't match RunPod's schema (`pods` array, `pagination.hasNextPage`
boolean, a cursor whenever there is a next page) is an error: it proves neither that a machine is
absent nor that the list is complete.

## Errors (`errors.ts`)

Every adapter error is a `ProviderError` with a `kind`, and `launchErrorAction(kind)` says what a
launch loop does next:

| Action | Kinds |
|---|---|
| next offer | `no_capacity`, `unplaceable`, `forbidden`, `price_above_cap` (after cleanup) |
| retry the same offer, with backoff | `rate_limited` (honours `Retry-After`), `transient` |
| stop | `spec_mismatch` (after cleanup), `invalid_request`, `insufficient_funds`, `auth`, `not_found`, `outcome_unknown`, `unknown` |

An error with `providerMachineId` set means the call left a machine behind that the caller must
clean up.

`outcome_unknown` means the request may have reached the provider (no response, a timeout): a
machine may exist. On a launch, the adapter first lists our machines by name; if it finds exactly
one, that is the launch's result. If the listing fails or is malformed, the result is
`outcome_unknown` and nothing launches elsewhere, so a lost response can't make two machines. A
5xx followed by a valid listing with no such machine stays `transient` and is retried under the
same name, with a fresh boot token (the old one is revoked first, so a late-appearing machine
can't enroll); the watchdog treats two machines with one machine id as an alarm.

RunPod (v2 REST API): 400 is either capacity or a rule violation and has no machine-readable
code, so a 400 whose detail says capacity is `no_capacity`, any other 400 is `unplaceable`; 401
`auth`, 402 `insufficient_funds`, 403 `forbidden`, 404 `not_found`, 409/413/422
`invalid_request`, 429 `rate_limited`, 5xx `transient`. This follows RunPod's own retry table.

## Placement (`placement.ts`)

- `placementPolicy(projectPolicy, marginBps)`: the project policy as placement reads it. The
  policy's price cap is the total with margin; the provider cap is the largest provider cost whose
  `priceSplit` total fits (`providerCapForTotal`: a BigInt binary search, exact for every safe
  integer cap and every valid margin; other inputs are refused).
- `rankOffers(offers, policy, request)`: the requested GPU type (if the policy allows it) and
  count, allowed providers, allowed countries, provider cost at most the cap, and stock other than
  `none`; cheapest first, then the better stock label, then provider and data center, so the same
  inputs always give the same order. Stock labels only order offers of equal price: a "low" or
  even "high" offer can still refuse a launch.
- `launchWithFallback(...)`: tries the ranked offers in order, following `launchErrorAction`, at
  most `maxAttempts` launch calls in all (default 6) and `maxRetriesPerOffer` retries per offer
  (default 2), backing off 1 s, 2 s, 4 s ... (at most 30 s) or as `Retry-After` says. The bounds
  are integers in [1, 20] and [0, 20], checked before any effect.
- Every launch call gets its own spec, so its own boot token. **After every failed call, its boot
  token is revoked first** (`revokeBootToken`, supplied by the control plane). If the call left a
  machine behind, placement then terminates it and polls until the provider reports it gone
  (`confirmPolls`, default 10, `confirmIntervalMs`, default 3 s). Only a status for exactly that
  machine id at that adapter's provider counts (the RunPod adapter also refuses an answer about
  another pod). If the revocation, the termination or the confirmation fails, the search stops
  with `outcome_unknown`: no next offer, no second launch. `terminateAndConfirm` is exported for
  the watchdog and validates its own bounds.

**Locality** (`locality.ts`): presets are country sets. `europe` is the EU, the rest of the EEA
(Iceland, Liechtenstein, Norway) and the UK; `eu` the 27 EU states; `uk`, `us`, `ca` one country
each; `any` everything. The project's `allowedCountries` narrows a preset further. A data center
whose country we can't determine is never offered (RunPod: `US-DE-1` is Delaware, not Germany, so
countries come from an explicit rule per id prefix, not from the id's letters).

## Drift (`drift.ts`)

`expectedSpec(spec, info, id)` is the immutable expected specification recorded at launch;
`specDrift(expected, observed)` lists every difference: provider, ids, GPU type and count, data
center, image, disk, any volume, env names (as a set), exposed ports, the command, and a rate that
is unknown or above the cap. Unknown values count as drift. The watchdog polls status and
terminates on any drift, revoking the machine's tokens first. This is a secondary control: it
does not contain a provider credential readable inside the machine (see below).

## Reconciliation (`reconcile.ts`)

Providers bill per machine in time buckets; the ledger charges per machine per minute.
`reconcile(billing, ledger, bindings, opts)` sums both per (machine, bucket) and gives each pair a
status:

| Status | Meaning |
|---|---|
| `ok` | The difference is within tolerance: the larger of `toleranceMicros` and $\lfloor \text{ledger} \cdot \text{bps} / 10000 \rfloor$, computed exactly (BigInt) for every safe amount. |
| `over` | The provider billed more than the ledger charged (we under-charged, or a machine ran unmetered). |
| `under` | The provider billed less than the ledger charged. |
| `unknown_machine` | The provider billed a machine we have no binding for: it ran outside our control. |
| `pending` | The bucket isn't closed yet (`closedBefore`); nothing is concluded. |

Only compute entries count, at their provider cost (`amount.providerCost`). `bindings` map
provider machines to ours; one machine may have had several provider machines (restarts), and a
provider machine bound to two of ours is an error. Every input it can't reconcile (a malformed
or nonexistent time such as 2026-02-30, a record that isn't exactly one bucket, an unsafe sum, bad
tolerances) is an error, never `ok`. It's pure: the control plane fetches the bill and the ledger
rows and decides what to do.

Choosing `toleranceMicros`: under the ledger's pinned-rate rule, a compute entry carries the
provider and rate of its minute's first fragment. In the minute a restart re-places a machine on
another provider, the other provider's seconds are charged under the first provider's entry. That
shows up as the first provider `under` and the second `over` by at most one minute at the higher
rate, per restart. So set `toleranceMicros` to at least one minute at the highest allowed rate,
times the restarts a machine may have in one bucket.

`BillingSource.billing({start, end, bucket})` fetches the bill. On RunPod it reads
`GET /v2/billing/pods` for whole hour or day buckets (at most 1000), and fails unless the
response is complete: the echoed window and bucket size are exactly the ones asked for, it's not
filtered to one pod, every record is one bucket inside the window, there is at most one record per
pod and bucket (as RunPod documents), the record and distinct-pod counts match, and the records add
up to the reported totals (to a micro per record), with every partial sum a safe integer. RunPod's billing records
arrive late (in hourly buckets), so a reconcile should only conclude on buckets well in the past;
the live signal for a running machine is its rate (`cost` on the pod).

## RunPod status

SEC (Nov 24): RunPod stays blocked for real use, because RunPod injects a pod-scoped API key that
code in the pod can read and use to change its own pod. The one conditional path is pre-access
eradication: our launcher as PID 1, an allowlisted replacement environment, and a paid adversarial
probe showing root can't recover the key or a replacement, on every restart path. The launch shape
above is built for that path. Until the probe passes, the adapter is for development and tests.

To confirm in the probe (all fail closed today, through the drift check at launch): that
`mounts: {}` gives a pod with no volume; that `ports: []` is accepted; that the pod's `env` as
returned lists only what we set; how RunPod reports `entrypoint`/`cmd` back; and that a pod
launched with `startSsh: false` reports `ssh: {proxy: null, direct: null}`.

## The eradication probe (`src/probes/`)

The provider side of SEC's release gate for RunPod (the in-pod side is the probe agent in
`packages/machine`). **It costs money and needs William's approval for each run.** The first
approved run (Nov 24 2026) created no pod: RunPod refused the launch (RTX A4000 in EU-SE-1,
which the catalog didn't list), and the spend rate settled at 0. The second (A40 in EU-SE-1)
created a pod that the launch's drift check rejected (`spec_mismatch`); it was terminated within
seconds and confirmed gone, with the spend rate back at 0. `launchError.drift` now says where.

- `eradication.ts`, the driver:
  - **Launch:** one pod, exactly as production does (`RunPodAdapter`), with one probe-only
    addition. The launcher argv is `/bin/sh -c` with `@sbgpu/machine`'s probe prologue
    (`renderProbePrologue(salt)`) followed by the unchanged production launcher script for the
    pinned probe agent (`renderBootScript`). The prologue captures only a salted digest, the byte
    length and a coarse shape of RunPod's injected key into a 0600 file, for the probe agent's
    search by value. The driver builds this argv itself from three closed values (the agent's
    https URL, its pinned sha256, the control URL) and a fresh 32-byte salt per run, and refuses a
    plan whose launcher differs in any byte. The salt goes only into the pod's entrypoint: it is
    masked from all output and never reported. The report records the URL, the pin and the sha256
    of the complete argv. The boot token is random; nothing exchanges it.
  - **Results:** read from the container log (`SBGPU-PROBE {v, boot, check, pass, paths,
    detail}` lines). `judgeStage` passes a stage only if it holds exactly one run of pid1, environ,
    files, metadata, history and done, in that order, all passing and in one boot. Every raw log
    line, probe lines included, is scanned before parsing, and every decoded field of an accepted
    probe line again after it (JSON escapes such as `\u0052` hide from a raw scan): the key's name
    or a key-shaped string anywhere fails the stage, and the probe agent searches by the captured
    value itself (`found-value`), whatever its format.
  - **Capture:** each stage's passing pid1 reports the key's shape (e.g. `v44-rpa-dlsu`) and the
    salted digest. The driver compares shape and digest across the three stages internally; the
    report carries only `observedShape` and the boolean `captureConsistent`, never a digest. An
    inconsistent or malformed capture is never a pass.
  - **Restart paths:** three stages: first boot, after a restart, and after a stop followed by a
    start (RunPod's v2 API has no separate reset).
  - **Budget:** a reserve of 387 s is kept at every step: one provider call in flight (every call
    times out in 30 s) plus the whole cleanup (a terminate and 10 status reads with 3 s between
    them). Before every status read, log read, action and sleep, the elapsed time plus the step
    plus the reserve must fit the lifetime cap and, at the highest rate seen, the spend cap; and
    the budget is checked again after each status read. Stop-state polling and every restart,
    stop and start are guarded the same way, with the drift check, so nothing starts again past
    the budget. The plan itself is refused if its stages and the reserve don't fit the lifetime,
    or the reserve doesn't fit the spend cap at the rate cap.
  - **Launch:** the launch itself, recovery after a lost response included (a listing of up to
    50 pages), is bounded the same way: the adapter checks `LaunchOptions.shouldStop` before
    every request and stops when the budget can no longer hold one more call and the cleanup.
    A launch whose outcome stays unknown (a lost response, a listing that failed, was malformed
    or didn't finish, two pods with one name, a create response without an id) may have left a
    pod: the report says `terminatedConfirmed: false` and an `exposure` with the machine name and
    no provider id, never "nothing exists". A failed launch is reported as `launchError`: the
    ProviderError's kind and HTTP status (our own fixed words, never the provider's text), or
    `driver-error` for anything else. For a pod rejected at launch (`spec_mismatch`,
    `price_above_cap`) it also carries `drift`: drift.ts's `driftMarkers`, the drifted fields' names
    and, for unexpected settings, words from a fixed vocabulary (anything else reads `other`), so it
    says where a pod differed and never what RunPod reported. The report checks that again on its
    own: of the first 32 entries it keeps only markers `driftMarkers` can produce (`isDriftMarker`:
    exact field names, the exact setting vocabulary, at most three words after `unexpectedSettings`).
  - **Snapshot:** the plan is copied before it is checked, and only the copy is used, so changing
    the caller's plan while the driver runs (e.g. during the launcher digest) changes nothing.
  - **Cleanup:** always terminate and confirm. Outcome `pass` only if all three stages pass, nothing
    aborted and the pod is confirmed gone; `fail` if the probe found something; otherwise
    `aborted` (inconclusive). The report says whether the estimate stayed within the cap
    (`withinCap`); if termination couldn't be confirmed, it reports the `exposure` (the pod and
    its rate) instead of claiming a ceiling: a remote termination can't be guaranteed locally.
  - **No exec API:** it never uses RunPod's exec API. Exec'd processes get the container's
    configured environment, key included, which would plant the key in `/proc` and spoil the probe.
    The exec API and the web terminal are provider-side paths into the pod that bypass the launcher.
    They need the account key, not anything inside the pod, so they're outside the probe; SEC's
    write-up should name them.
- `cli.ts`, the command line: `--agent-url`, `--agent-sha256` and `--control-url` (required; no
  `--launcher`). A **dry run by default**: it prints the plan, the launcher's sha256 and the exact
  create body, with the token and the salt masked. `--execute` needs `--approval "<who and
  where>"`, `--key-file /run/secrets/cocalc/runpod` (the only path accepted) and a spend cap of at
  most $10 (default $3). The key is read inside the process, checked (one line, no whitespace, at
  most 512 bytes) and used only in Authorization headers. The pod's rate cap is the spend cap
  spread over the lifetime, so a pricier placement is refused at launch. After the pod is
  confirmed gone, the CLI reads the account's `currentSpendPerHr` (GraphQL `myself`) up to 6 times,
  30 s apart; `spendSettled` is true only on a successful read of exactly 0, and the exit code is 0
  only for a pass that settled.

## Shadeform (`src/shadeform/`, mock-only)

Over Shadeform's public REST API (`https://api.shadeform.ai/v1`, key in the `X-API-KEY` header).
It is built from Shadeform's API reference and tested only against mocks: nothing here has called
Shadeform.

- **launch() always refuses** (`invalid_request`, "VM mode is not supported") before any request.
  Every Shadeform launch is a VM: either a startup script, or a container on a VM with
  `--network=host`, the account's SSH key and no container status in the API. VM mode is refused
  (machine DESIGN.md section 2). Any future VM design goes to SEC as its own note first. Because
  launch refuses, Shadeform must not be in any project's `allowedProviders`.
- **Offers** come from `GET /v1/instances/types?num_gpus=N&shade_cloud=true`:
  - on-demand availability only; the price is the type's `hourly_price` in whole cents, as micros;
  - one offer per GPU type and place, the cheapest, preferring one that can launch at a tie;
  - stock is `none` when Shadeform says the place can't launch now, and `unknown` otherwise (Shadeform gives no level).
- **Places.** A data center is `<cloud>/<region>`. Region names belong to each underlying cloud and
  Shadeform doesn't document them, so a place is offered only once `SHADEFORM_REGIONS` gives its
  country, each entry checked against a real catalog read. Today that's only the documented
  `hyperstack/canada-1`.
- **GPUs.** `A100_80G` and `H100` cover both PCIe and SXM; they map only with an interconnect in
  the table (`pcie`, `sxm4`/`sxm5`, to be confirmed against a real catalog). Anything else is never
  offered.
- **Status.** An instance maps to our status as follows:
  - the image is the VM's `os` and the disk its type's `storage_in_gb`;
  - environment names come from both `envs` lists;
  - ports from `port_forwards` and the container's `port_mappings`;
  - an SSH key, Shade Cloud off, non-on-demand terms and a template, cluster or commitment are unexpected settings;
  - the command is a fixed marker, so no Shadeform machine ever matches a launch spec.

  `deleting` is `stopping` (billing has stopped, but the machine isn't gone); only `deleted` or a 404 is `terminated`.
- **List and terminate.**
  - The list is read by offset, 100 per page, at most 50 pages. It fails if the total changes, a page has the wrong length, any instance id appears twice (foreign rows included), or any row's name isn't a string: such a list may be missing one of ours.
  - Terminate is `POST .../delete`, idempotent on 404. A 409 counts as done only if a fresh status shows the instance deleting or gone.
- **Errors** keep no provider text (bodies can echo request values), and name a fetch failure only by a fixed word (`failureName`). An unreadable reply to a POST is `outcome_unknown`.

## Not yet

- Hyperstack/Nebius, after the Dec 12 provider decision.

## Tests

`bash scripts/check.sh` runs typecheck and every test. `mutants.json` lists this package's mutants
(flipped comparisons, dropped checks, wrong mappings, relaxed parsing), for the repo's shared
fail-closed mutant runner, `scripts/mutants.py`. Each entry is `{file, old, new}` with `file`
relative to this package.

Fixtures (`src/runpod/fixtures/`) are recorded RunPod responses and RunPod's documented examples,
with no credentials or account identifiers; their README says where each comes from.
