# The machine side: design (r1)

*Draft r1, Nov 24 2026. Lane: machine (@sagebrush-gpu3). For review by SEC (boot, tokens, relay, gateway), LIMITS (quotas, reserve) and TESTS.*

This covers everything that runs on, or talks directly to, a member's GPU machine:

1. the **boot script** (the provider's start command or cloud-init), which installs and starts
2. the **agent** (Python 3, stdlib only), which enrolls with the control plane, dials out to
3. the **relay** (a Cloudflare Worker with a Durable Object per machine), which carries the browser terminal and Jupyter, and
4. the **storage gateway** (a Worker in front of R2) with its client **`ws-sync`**, which restore and save the workspace.

Control-plane endpoints and their types live in `@sbgpu/api` (lane: control). This note proposes their shapes for the machine; the contract is the source of truth once it lands.

## 0. Principles

- **The member has root on the machine.** Anything on the machine is the member's to read and copy: the agent, its tokens, the setup script's output. So nothing on the machine is worth more than "this member's own areas, for minutes, while this machine runs". No provider keys, no R2 keys, no long-lived secrets.
- **Dial out only.** The machine opens no inbound ports. The agent connects out to the relay and the control plane over HTTPS/WSS.
- **No images of our own.** The boot script needs only `sh`, `curl` (or `wget`), `sha256sum` (or `shasum`), `tar` and `python3`, which every provider's CUDA/PyTorch image has. Nightly, each provider's current image is test-launched (later; costs money, needs approval).
- **Fail closed.** A bad hash, a refused enroll or a revoked token stops the agent. It never falls back to something less checked.

## 1. Boot

### 1.1 The launcher

The control plane renders it with `renderBootCommand()` from this package; providers never build it by hand. It's one POSIX `sh` script, `boot/bootstrap.sh`, with four values set at its top:

```sh
SBGPU_AGENT_URL='https://<cdn>/agent/agent-<version>.tar.gz'
SBGPU_AGENT_SHA256='<64 hex>'
SBGPU_CONTROL_URL='https://<api>'
SBGPU_MODE='container'            # or 'vm'
```

The **boot token** is the only value in the provider's environment for the machine (`SBGPU_BOOT_TOKEN`), never in the script text.

- **Container providers (RunPod):** the launcher is the container's entrypoint, so it runs as **PID 1** and is the first code in the container: `entrypoint: ["/bin/sh", "-c", "<script>"]`, no `cmd`, `ports: []`, SSH and the provider's Jupyter off, no template, and the environment is the boot token alone. The image's own entrypoint (RunPod's `/start.sh`: nginx, sshd, Jupyter, and a dump of the whole environment into `/etc/rp_environment`) **never runs**. Jupyter comes from our agent, through the relay.
- **VM providers (cloud-init: Hyperstack, Nebius):** `user_data` is the same script with `SBGPU_MODE='vm'`, and it installs a systemd unit for the agent. (Whether a VM provider injects anything like RunPod's key is checked per provider, before it's admitted.)

### 1.2 What the launcher does

Everything runs in the foreground: the launcher starts no background process, so nothing that inherited the original environment survives it.

1. Read `SBGPU_BOOT_TOKEN` into a shell variable. Check that it matches `^[A-Za-z0-9_-]{43}$`.
2. Download the agent tarball to `/run/sbgpu/` (`curl -fsS --proto =https --max-filesize 16 MiB`, with `python3 -I` urllib as the fallback when curl is missing). There are 3 tries, each with a time limit.
3. Compute its sha256 (`sha256sum`, else `python3 -I` hashlib) and compare it in full with `SBGPU_AGENT_SHA256`. A mismatch, an empty or oversized file, or a missing tool means exit 2 with nothing unpacked or run.
4. Unpack into `/opt/sbgpu/agent/<sha256>/`, refusing links, special files, and absolute or `..` member names.
5. Write `/run/sbgpu/boot.json` (mode 0600, directory 0700): the control URL, the mode and the boot token. The agent reads it and deletes it before it enrolls.
6. `exec env -i <allowlist> python3 -I -S /opt/sbgpu/agent/<sha256>/sbgpu-agent`: the agent **replaces** the launcher as PID 1, with an environment rebuilt from an allowlist (1.4), not the original minus some names.

**Integrity: the hash is pinned per launch, with no signature check on the machine (proposal; SEC rules on it).** The control plane puts the exact sha256 of the current release into every launch's command, which travels over the provider's API. A pinned hash fixes the bytes completely, so an on-machine signature would add nothing as long as the launcher never fetches an unpinned "latest". The signing key lives only in release CI, which signs the release manifest (version, URL, sha256); the control plane checks that signature before it pins a hash. If SEC wants an on-machine Ed25519 check as well, it can be added with `openssl pkeyutl -verify` (usually present, not guaranteed) or a small pure-Python verifier.

### 1.3 PID 1 (container mode)

The agent is PID 1, so it reaps orphans (`waitpid(-1, WNOHANG)` on SIGCHLD) and handles SIGTERM (a provider stop: a final save within the grace period, then exit). The PID 1 process keeps very little state: the terminal sessions, the sync and Jupyter run in child processes, so a crash in one of them doesn't end the container. If PID 1 itself exits, the container ends.

**No re-enroll in container mode.** A container restart runs the launcher again with the provider's original environment, and the boot token has already been used. So a restarted container can't enroll. The control plane sees the missed heartbeats and terminates the pod, and the member's work is safe up to the last periodic save. (VM mode, where systemd restarts the agent, could use a re-enroll secret. That's an open question.)

### 1.4 Credential eradication (the RunPod condition; SEC ruling, Nov 24)

RunPod injects a pod-scoped `RUNPOD_API_KEY` into the container's initial environment, and that key can change or delete the pod. SEC admits RunPod only if that key is gone before any member access, and only after a paid adversarial probe proves it (1.5). The machine side does three things:

1. **Replace the environment, don't edit it.** The launcher's `exec env -i` starts the agent with only:
   - fixed values: `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `HOME=/root`, `LANG=C.UTF-8`, and `SBGPU_PREFIX` (empty on a real machine; a test directory standing in for `/` in tests);
   - copied from the original environment only if present, and only if the name matches one of these exactly: `LD_LIBRARY_PATH`, `CUDA_HOME`, `CUDA_VERSION`, `NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES`, `NVIDIA_REQUIRE_CUDA`, `NV_CUDA_LIB_VERSION`, `PYTORCH_VERSION`, `TZ`.
   Every other name is dropped, `RUNPOD_*` included, and so is the boot token. The list is a constant in the launcher and in the agent, and a test checks that they are the same. A copied value must not contain the key's value either: the launcher compares each copied value with `$RUNPOD_API_KEY` (in memory, never written or logged) and exits if any matches or contains it.
2. **Check before any access.** Before it enrolls or opens anything, the agent checks:
   - `/proc/1/environ` (itself) has exactly the allowlisted names;
   - no other process exists in the container (every `/proc/<pid>` other than 1 is refused, since the launcher started nothing in the background);
   - none of a fixed set of files exists or contains a `RUNPOD_API_KEY=` line: `/etc/rp_environment`, `/etc/environment`, `/root/.bashrc`, `/root/.profile`, `/etc/profile.d/*`.
   (It can't look for the key's value, which it never sees. Searching the files for the value is the probe's job, below.)
3. **Abort on any doubt.** A failed check means `POST /v1/agent/abort {bootToken, reason}`, which uses up the boot token and makes the control plane terminate the pod through the provider API, then exit 3. There's no relay, terminal, Jupyter or setup script before the check passes and enroll succeeds. Enroll also reports `eradication: {checks: [...], ok: true}`, and the control plane refuses an enroll without it in container mode.

The setup script, terminals and Jupyter inherit the agent's allowlisted environment (plus `HOME`, `USER` and `TERM` for the member's shell).

### 1.5 The probe (a release gate; spending on it needs approval)

Two parts. A **probe agent** (lane: machine) is a separate pinned tarball that the *unchanged* production launcher fetches, verifies and execs in place of the agent. The launcher can't tell the difference, so the probe tests exactly the production launcher. A **driver** (lane: providers) launches a pod exactly as in production (`renderBootCommand` with the probe tarball's URL and sha256, the launcher as the entrypoint, no ports, SSH or provider Jupyter, and the env carrying only a well-formed random boot token that nothing exchanges). The driver reads the results from the container log, drives the restart paths, and terminates. The driver never uses the provider's exec API: exec starts processes with the container's configured environment, which would plant the key and is itself a path around the launcher (for SEC's write-up).

The probe never sees, hashes or reports the key's value (the Nov 16 ruling). It prints one line per check, `SBGPU-PROBE {"v":1,"boot":n,"check":"pid1|environ|files|metadata|history|done","pass":bool,"paths":[...],"detail":"..."}`, with at most 20 paths of at most 256 bytes and `detail` from a fixed vocabulary. It prints nothing else to stdout. The driver fails closed on a missing `done`, a malformed line, any `pass:false`, or any key-shaped string anywhere in the container or system log. The checks, each with its own time limit:

1. **pid1:** the probe is PID 1 (exec keeps the launcher's PID) and `/proc/1/cmdline` is python3 running it, with no other process.
2. **Every process's environment:** `/proc/*/environ`, `/proc/*/task/*/environ`.
3. **Files:** a search over the whole filesystem except `/proc` and `/sys` (every mount in `/proc/mounts`, including `/etc`, `/root`, `/tmp`, `/var/log` and `/run`) for the variable's name and for strings shaped like the provider's documented key formats. Any hit fails, reported by path only. The probe never sees, hashes or reports the key's value (the Nov 16 ruling); a shape match is enough to fail.
4. **Metadata:** every link-local and provider address reachable from the pod (`169.254.169.254`, `169.254.170.2`, the provider's documented helper endpoints, and the env-advertised URLs before cleaning), checking that none returns the key or a replacement credential.
5. **Restart paths** (the driver): restart, and stop then start; every check runs again at each boot. The boot count is kept in `/opt/sbgpu/probe-boots` and cross-checked against the driver's count of `pid1` lines.
6. **history:** shell histories and the files from step 3 under `/root` and `/home`. The driver checks the logs themselves.

It passes only if every step passes. Then it's a release gate for every change to RunPod images or templates, or to our launcher. Its cost: a few pod-hours on the cheapest RunPod GPU, a few dollars, once approved.

## 2. Tokens

Every token carries a `kind` claim and is refused anywhere else. Signed tokens use Ed25519 by the control plane, so the relay and gateway Workers hold only the public key. Opaque tokens are stored hashed (SHA-256) in D1.

| kind | issued by, to | lifetime | bound to | used for |
|---|---|---|---|---|
| `boot` (opaque, 32 random bytes) | control → provider env | single use; TTL 2 min from the provider first reporting the machine running (see below) | one authorized launch, the exact provider machine id | `POST /v1/agent/enroll` (or `abort`) once |
| `agent` (signed) | enroll / heartbeat → agent | 1 h, refreshed by heartbeat | `mch`, `inc` | heartbeat, save-status, workspace-token, the relay's peer leg |
| `workspace` (signed) | control → agent | 15 min, refreshed | `mch`, `inc`, `mbr`, `prj`, `team`, areas | the storage gateway |
| `page` (opaque) | control → browser | 60 s, single use | `mbr`, `mch` | one relay page connection |
| `jupyter` (opaque code) | control → browser link | 60 s, single use | `mbr`, `mch` | swapped for a cookie on the machine's Jupyter origin |

- **The boot token's TTL (SEC ruling of Nov 16: at most 2 minutes, first exchange wins).** Image pulls and VM boots can take several minutes before any of our code runs (a VM provider took about 5.5 minutes to be usable in a spike), so 2 minutes from the launch request would fail slow starts. Proposal for SEC: the 2 minutes start when the provider first reports the machine running, which for a container is when our launcher starts. The watchdog's 2-minute "billed but not enrolled" stop starts from the same moment. VM mode, where cloud-init runs well after the VM reports running, needs its own figure: proposal 6 minutes from running, for SEC.
- The token is in pod metadata that the provider's API shows, so it's readable by anyone with the account key, and by the pod's own `RUNPOD_API_KEY` until eradication. Single use, first exchange wins, the exact pod-id binding and the short TTL are what protect it. The self-identity cross-check (`RUNPOD_POD_ID`, read by the launcher before the exec, sent at enroll) only catches mistakes: user code could fake it, but no user code runs before enroll.
- **Incarnation:** each enroll for a machine increments `inc`. The relay and the gateway refuse a token from an older incarnation.
- **Stop kills everything:** once the control plane marks a machine stopped, its agent, workspace and page tokens are refused (the Workers check the machine's state in D1, or a revocation list in KV, at each connection and each write).
- **Workspace token claims:** `{kind, mch, inc, mbr, prj, team|null, areas: [{area, mode: "rw"|"ro"}], quotaBytes, finalSaveOnly, exp}`. The gateway derives every R2 key from these claims; the client never names a prefix.

## 3. The agent

Python 3 (3.8+), stdlib only, a single package unpacked by the bootstrap. Each component is a module with its own tests (`python3 -m unittest`, run by `scripts/check.sh`). A JSON fixture test checks the agent's request and response bytes against the `@sbgpu/api` types.

### 3.1 Life cycle

```
launcher (PID 1) -> exec agent (clean env) -> eradication checks -> enroll -> restore workspace -> setup script -> ready -> (running: heartbeats, relay, periodic save)
      -> stop command | idle | max session | allocation stop -> final save -> report done -> (provider terminates)
```

- **Enroll:** `POST /v1/agent/enroll {bootToken, agentVersion, provider, providerMachineId|null, gpu: {name, count, memoryMiB}|null, hostname}` returns `{agentToken, agentTokenExpiresAt, incarnation, reenrollSecret, relayUrl, heartbeatSeconds, idle: {minutes, gpuUtilThresholdPct}, maxSessionEndsAt, setupScript|null, workspace: {restore}, agentVersion}`. A 401/403 means exit 3. Enroll also carries `providerMachineId` (read by the launcher before its exec) and the eradication report (1.4).
- **Heartbeat** every `heartbeatSeconds` (default 30): `{incarnation, uptimeS, activity: {lastTerminalInputAt, lastJupyterActivityAt, gpuUtilPct, gpuMemUsedMiB}, idleSince|null, save: SaveStatus, dirtyBytes}`, answered by `{agentToken?, commands: [{id, op: "save"|"stop"|"revoke"}]}`. Commands also arrive over the relay leg for speed; the heartbeat is the reliable path. Each command is handled once (by id) and answered through `POST /v1/agent/save-status {commandId, ...}`.
- **Setup script:** runs once per machine (marker file), after the restore, as the member's user, with output into `~/.sbgpu/setup.log`, visible in the terminal. It has a time limit (default 20 min). A failure is reported, but it doesn't stop the machine.
- **The member's user:** the agent runs as root (needed for the PTY users and for stopping processes). Terminals run as root on container images that only have root; otherwise as a `member` user. The member has root anyway on the providers we use.

### 3.2 Idle detection

A machine is idle when, for `idle.minutes` (project policy, default 30):
- no terminal input on any session, and
- no Jupyter kernel activity (via Jupyter's `/api/status` `last_activity` and `/api/kernels` execution states, polled locally), and
- GPU utilisation below `gpuUtilThresholdPct` (default 5%) on every sample (`nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits`, every 30 s).

A training run with no terminal attached keeps the GPU busy, so the machine isn't idle. An idle machine is saved, then stopped. At 5 minutes before an idle stop, the agent writes a warning to every attached terminal, and any input cancels it. Sustained 100% GPU with no session for hours is reported in the heartbeat (`activity`), and the watchdog decides (abuse flag).

### 3.3 Stop (save before stop)

1. The control plane sets the machine to `saving-before-stop`, issues a workspace token with `finalSaveOnly`, and sends `stop`.
2. The agent stops the periodic sync, sends SIGTERM to the processes in the member's terminals (to flush files), waits up to 10 s, then runs the final save, reporting progress through save-status.
3. On `done`, the control plane terminates the machine through the provider. On failure, or no report by the deadline (sized by the ledger from `dirtyBytes`, see 5.6), it terminates anyway with `stopReason: "final-save-incomplete"`, and the last periodic snapshot stays the latest.

`SaveStatus`: `{state: "idle"|"saving"|"failed", lastSavedAt|null, progress: {bytesDone, bytesTotal}|null, error|null, snapshotId|null}`.

## 4. The relay

Adapted from Sagebrush's relay (a Durable Object per remote: one peer leg and its page legs, generation-prefixed text frames, per-receiver windows proved by receipts, a caps table). The copy is our own code and is noted as such in its file header; there's no dependency on that repository. What changes:

- **Naming:** one Durable Object per machine (`mch_…`).
- **Peer auth:** the agent's leg authenticates with its `agent` token (current incarnation; the machine running). A newer leg of the same machine replaces the older one (4009).
- **Page auth:** a page sends `{"t":"hello","token":"<page token>"}` as its first message (never in the URL). The Worker swaps the single-use token, checks member and machine, and only then joins the leg. Before the hello, at most 1 KiB and 10 s.
- **Channels:** `terminal` (below), `jupyter` (4.2) and `control` (the peer only: commands pushed from the control plane).
- **Text only** (binary closes 1003), as in the original. PTY bytes travel base64.
- **Close codes:** 4001 the machine's agent went away (the page shows "reconnecting" and retries with a fresh page token, backing off 1, 2, 4 … 30 s), 4009 replaced, 4403 revoked or machine stopped (no retry), 1009 message too big, 1013 receiver not reading.

### 4.1 Terminal protocol (agreed with ui, Nov 24)

Ported from Sagebrush's runner terminal, minus its DPoP layer (the relay authenticates the page here).

```
page -> agent   {"t":"open","rows":r,"cols":c}                 a new session
                {"t":"open","session":id,"rows":r,"cols":c}    reattach
                {"t":"in","b":"<base64>"}    {"t":"resize","rows":r,"cols":c}
                {"t":"ack","upto":n}         {"t":"kill","session":id}
agent -> page   {"t":"opened","session":id}
                {"t":"replay"}  {"t":"out","b":"<base64>"}...  {"t":"live"}
                {"t":"out","b":"<base64>"}   {"t":"inack","upto":n}
                {"t":"exit","code":n|null,"signal":s|null}   {"t":"error","error":e}
```

- **Credit:** the page acks the decoded output bytes it has written (`upto`, cumulative). The agent sends at most 1 MiB beyond the last ack; the rest goes only to the ring.
- **Sessions:** at most 4 running per machine; each has a 1 MiB scrollback ring. A reattach replays a terminal reset plus the ring from a line boundary, then `live`. A detached session lives until the machine stops (or 24 h with no output and no attach).
- **Limits:** an `in` frame carries at most 16 KiB decoded; an output frame at most 48 KiB decoded; rows and cols are 1..1000; any other message to the agent is at most 8 KiB.
- **Stopping a session:** the process-tree rule from the original: SIGHUP, SIGTERM, then SIGKILL after 2 s, recounting the PTY's session until it is empty.

### 4.2 Jupyter

Jupyter runs on the machine on loopback only, with a random token known to the agent. The browser reaches it on **its own origin per machine** (`https://m-<mch>.<machine-domain>/`), in a new tab, never on the UI's origin, so a notebook's output can't call the API with the member's session. The UI asks `POST /v1/machines/{id}/jupyter-link` for a URL carrying a 60 s single-use code; the relay swaps it for an HttpOnly, Secure, SameSite=Lax cookie scoped to that host, then proxies HTTP requests and WebSockets over the agent's leg (channel `jupyter`: request and response heads, bodies chunked, base64, under the channel's caps). This proxying is new code, built after the terminal. Until it exists, the fallback is the provider's own Jupyter proxy, where one exists.

## 5. Workspaces: the storage gateway and `ws-sync`

### 5.1 Layout in R2 (content-addressed)

```
a/<area>/blobs/<sha256>            a chunk of a file, at most 32 MiB
a/<area>/snaps/<snapshotId>.json   a manifest: {parent, createdAt, name|null, files: [{path, mode, size, mtime, chunks: [sha256...]}]}
a/<area>/HEAD                      the latest snapshot id (written only by the gateway, compare-and-swap)
```

`<area>` is derived by the gateway from the token's claims: `prj/<prj>/m/<mbr>`, `prj/<prj>/t/<team>`, `prj/<prj>/ro` (read-only project data).

Why chunks: each chunk is a request under the Worker's body limit, so there's **no multipart upload at all**. An interrupted save resumes chunk by chunk, an unchanged chunk of a big checkpoint is never sent twice, and snapshots cost only their manifest. The gateway checks each chunk's sha256 while streaming it (Workers' `DigestStream`) before it is visible.

### 5.2 Gateway API (all under the workspace token, `Authorization: Bearer`)

| request | does |
|---|---|
| `GET /v1/ws/areas` | the token's areas, modes, quota and usage |
| `GET /v1/ws/{area}/head` | the latest snapshot id and manifest |
| `POST /v1/ws/{area}/missing {hashes: [...]}` | which chunks aren't stored yet (at most 1,000 per call) |
| `PUT /v1/ws/{area}/blobs/{sha256}` | upload one chunk (checked: hash, size, quota, the day's bytes) |
| `GET /v1/ws/{area}/blobs/{sha256}` | download one chunk (streamed) |
| `POST /v1/ws/{area}/snaps {parent, manifest, name?}` | commit a snapshot: every chunk must exist; `parent` must equal HEAD (else 409, and the client merges or retries) |
| `GET /v1/ws/{area}/snaps` | the kept snapshots (for rollback) |

`{area}` in a URL is only an index into the token's own `areas` list (`0`, `1`, …), never a path.

### 5.3 Restore at boot

Fetch HEAD's manifest for each area, then download the chunks in parallel (8 at a time) into `~/work` (member area), `~/team` (team area) and `/opt/sbgpu/cache/ro` (read-only data, linked as `~/data`). Chunks already in the local cache (same machine, a restart) aren't fetched again. Restore writes to temporary names and renames each file into place.

### 5.4 Save

`ws-sync save` walks the tree (skipping `.sbgpu-ignore` patterns, default: `__pycache__`, `.ipynb_checkpoints`, `*.tmp`), rehashes only files whose (size, mtime, inode) changed since the last save, asks `missing`, uploads those chunks, then commits the manifest. Periodic saves run every 5 minutes (when anything changed), plus **Save now** (UI or the `save` command) and the final save. Only one save runs at a time; a request during a save queues one more.

### 5.5 Limits (LIMITS review)

All in the gateway, from the token and the project policy in D1:

- **Quota** per area (default 50 GB): the unique stored bytes of the chunks referenced by kept snapshots, plus pending uploads. A chunk that would exceed it is refused (413, `quota`).
- **Per day:** written bytes per member (default 20 GB) and requests per minute (default 600).
- **Per request:** a chunk is at most 32 MiB; a manifest at most 8 MiB and 100,000 files.
- **Kept snapshots:** the last 10, plus named ones (at most 5). Unreferenced chunks are deleted by a scheduled job.
- **After the project ends, or with the allocation spent:** writes are refused, except under a `finalSaveOnly` token within its reserve (`dirtyBytes` at the stop, plus 10%).
- Bytes in and out are recorded per member for the ledger (GB-month storage accrual is the control plane's).

### 5.6 The final-save reserve

The ledger keeps enough allocation to finish a save before the hard stop. The agent reports `dirtyBytes` (bytes changed since the last save) in each heartbeat. This package exports `finalSaveReserveSeconds(dirtyBytes)`, using a conservative throughput (assume 20 MB/s) plus a fixed 60 s, which the ledger turns into money at the machine's rate.

## 6. Team git (later)

A repository per team, served behind the same gateway and token scheme, cloned at boot into `~/team/repo`. Where it's hosted is an open question in the plan. It comes after the pilot's critical path.

## 7. Threats (for SEC)

| threat | answer |
|---|---|
| A tampered agent (CDN or transit) | the hash pinned per launch; HTTPS only; installed only after a full match |
| A copied boot token | single use, 2 min from running, bound to the launch and the provider machine id; a reuse attempt flags the machine |
| RunPod's pod API key, readable by root | the launcher is PID 1 and execs the agent with an allowlisted environment; the agent checks before any access, and aborts on doubt (1.4); the probe (1.5) gates admission |
| A copied agent or workspace token (the member has root) | worth only this member's own areas and machine, for at most 1 h / 15 min; dead at stop or re-enroll; quotas apply |
| A member's notebook attacking the UI | Jupyter on a separate origin per machine; cookie host-scoped |
| A stranger attaching to a terminal | page tokens are single use, 60 s, bound to member and machine |
| Free file hosting on R2 | no R2 keys anywhere on machines; quotas, day caps, writes stop at project end |
| A forgotten machine | idle stop, maximum session length, hard stop by the ledger, the watchdog |
| Path tricks in the gateway | the area comes from claims; blob names must be 64 lowercase hex; manifest paths are checked (relative, no `..`, no NUL, at most 4 KiB) before restore writes anything |

## 8. Build order

1. This note; the bootstrap and its tests; the agent skeleton (enroll, heartbeat) against a mock control plane.
2. The terminal (porting the runner's terminal) and the relay (porting the relay Durable Object), tested locally end to end with a fake page.
3. The gateway Worker and `ws-sync` (restore, save, save before stop), tested with an in-memory R2.
4. Idle detection, the setup script and the commands.
5. Jupyter proxying.
6. Team git.

## 9. Open questions

1. SEC: is a hash pinned per launch enough, or do you also want Ed25519 checked on the machine (section 1.2)?
2. SEC: the boot token's 2 minutes counted from the provider's first "running" report, and 6 minutes for VM mode (section 2).
3. Control: re-enroll in VM mode after an agent crash, or always stop the machine (section 1.3)?
4. Providers: whether each VM provider injects any credential into the machine (metadata, cloud-init, environment) before it's admitted.
