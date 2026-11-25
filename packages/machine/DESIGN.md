# The machine side: design (r2)

*Draft r2, Nov 24 2026 (after SEC, LIMITS and TESTS review of r1). Lane: machine. For review by SEC (boot, tokens, relay, gateway), LIMITS (quotas, reserve) and TESTS.*

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
- **VM providers (cloud-init: Hyperstack, Nebius):** `user_data` would be the same script with `SBGPU_MODE='vm'`, installing a systemd unit for the agent. **VM mode is refused for now** (the launcher exits on it; SEC, Nov 24): see section 2. (Whether a VM provider injects anything like RunPod's key is checked per provider, before it's admitted.)

### 1.2 What the launcher does

Everything runs in the foreground: the launcher starts no background process, so nothing that inherited the original environment survives it.

1. Read `SBGPU_BOOT_TOKEN` into a shell variable. Check that it matches `^[A-Za-z0-9_-]{43}$`.
2. Download the agent tarball to `/run/sbgpu/` (`curl -fsS --proto =https --max-filesize 16 MiB`, with `python3 -I` urllib as the fallback when curl is missing). There are 3 tries, each with a time limit.
3. Compute its sha256 (`sha256sum`, else `python3 -I` hashlib) and compare it in full with `SBGPU_AGENT_SHA256`. A mismatch, an empty or oversized file, or a missing tool means exit 2 with nothing unpacked or run.
4. Unpack into `/opt/sbgpu/agent/<sha256>/`, refusing links, special files, and absolute or `..` member names.
5. Write `/run/sbgpu/boot.json` (mode 0600, directory 0700): the control URL, the mode and the boot token. The agent reads it and deletes it before it enrolls.
6. `exec env -i <allowlist> python3 -I -S /opt/sbgpu/agent/<sha256>/sbgpu-agent`: the agent **replaces** the launcher as PID 1, with an environment rebuilt from an allowlist (1.4), not the original minus some names.

**Integrity: the hash is pinned per launch, with no signature check on the machine (SEC, Nov 24: approved on three conditions).** The control plane puts the exact sha256 of the current release into every launch's command, which travels over the provider's API. A pinned hash fixes the bytes completely, and a key sent in the same launch command would add no independent root of trust. The conditions:
1. Release CI signs the release manifest `{version, immutable URL, sha256}`; the signing key lives only in release CI.
2. The control plane verifies that signature before it pins a hash for any launch.
3. Enroll compares the agent's reported `agentSha256` with the hash recorded for that launch, and refuses a mismatch.

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

The probe never sees, hashes or reports the key's value (the Nov 16 ruling). It prints one line per check, `SBGPU-PROBE {"v":1,"boot":n,"check":"listen22-start|pid1|environ|files|metadata|history|listen22-end|done","pass":bool,"paths":[...],"detail":"..."}`, with at most 20 paths of at most 256 bytes and `detail` from a fixed vocabulary. It prints nothing else to stdout. The driver fails closed on a missing `done`, a malformed line, any `pass:false`, or any key-shaped string anywhere in the container or system log. The checks, each with its own time limit:

0. **listen22-start** (first) and **listen22-end** (just before `done`): nothing listens on TCP port 22. `/proc/net/tcp` and `tcp6` are read, and any row in LISTEN (`0A`) on local port `0016`, on any address, fails with `listener`. Tables that are missing, over 4 MiB or don't parse fail with `unreadable`. Only those fixed words (or `no-listener`) are reported, with no paths. The probe-only prologue makes the same check before it touches the key and stops with exit 3 (SEC ruling, Nov 25).
1. **pid1:** the probe is PID 1 (exec keeps the launcher's PID) and `/proc/1/cmdline` is python3 running it, with no other process.
2. **Every process's environment:** `/proc/*/environ`, `/proc/*/task/*/environ`.
3. **Files:** a search over the whole filesystem except `/proc` and `/sys` (every mount in `/proc/mounts`, including `/etc`, `/root`, `/tmp`, `/var/log` and `/run`) for the variable's name and for strings shaped like the provider's documented key formats. Any hit fails, reported by path only. The probe never sees, hashes or reports the key's value (the Nov 16 ruling); a shape match is enough to fail.
4. **Metadata:** a fixed, reviewed list of link-local and provider endpoints (`169.254.169.254`, `169.254.170.2`, and the provider's documented helper endpoints), built into the probe tarball. The probe can't recover endpoints that were advertised only in the original environment, since the launcher's exec discards it; the original environment is never preserved or passed on. It checks that none of these endpoints returns the key or a replacement credential.
5. **Restart paths** (the driver): restart, and stop then start; every check runs again at each boot. The boot count is kept in `/opt/sbgpu/probe-boots` and cross-checked against the driver's count of `pid1` lines.
6. **history:** shell histories and the files from step 3 under `/root` and `/home`. The driver checks the logs themselves.

The probe agent is `packages/machine/probe/sbgpu-agent` (stdlib Python, no control plane), built into its pinned tarball by `scripts/build-tarball.py`, which gives the same bytes and so the same sha256 every time. Its file scan skips `/proc`, `/sys`, `/dev` and virtual mounts, follows no links, reads every regular file (a file it can't read fails the check), and stops at 10 minutes with `timeout`. The variable's name and the key shapes are assembled at run time from pieces, so the probe's own files can't match its own scan. After `done` it stays PID 1 (reaping orphans) until SIGTERM, so the driver decides when the container stops.

**Searching by the key's value (the probe-only prologue; SEC ruling, Nov 24).** Without a documented format for the injected key, the probe also searches for its exact value. The probe agent can't see it (the launcher's `exec` removed it), so the driver runs a **probe-only prologue** (`src/boot/probe-prologue.sh`, `renderProbePrologue(salt)`) as PID 1 *before* the unchanged launcher: `["/bin/sh", "-c", renderProbePrologue(salt) + renderBootScript(...)]`. The launcher's bytes are the exact suffix. Production never runs it.
- The prologue reads `RUNPOD_API_KEY` only into a quoted shell variable and, through `printf` (a shell builtin, so never in argv), into python3's stdin. It writes `/opt/sbgpu/probe-capture` (mode 0600, created through a temporary file and `link()`, so atomic and never replacing, at a fixed path that isn't a link, in a directory that is a real directory, not a link, owned by the prologue's user and writable by no one else; every name is opened relative to it) with only derived data:
  - `sha256("sbgpu-probe-capture-v1" NUL salt NUL key)` (32 random salt bytes, fresh per run);
  - the key's byte length;
  - a coarse class set (digit, hyphen, lower, other, underscore, upper); "other" is every remaining byte (punctuation, whitespace, control characters, DEL, high and UTF-8 bytes), and the probe matches all of them;
  - a prefix only when 1-8 ASCII alphanumerics end in `_` with at least 16 bytes after it (otherwise none).
- No key, a key under 16 bytes, any capture error, or after a restart a capture different from the stored one: it exits (2 or 3) before the launcher. Its messages never carry the value.
- The probe agent reads the capture, checks it strictly, and hashes every window of the key's exact length within runs of its classes. That covers embedded and overlapping occurrences; with a prefix, only windows starting with it. Any match is `found-value`, in every check, and a check's detail never goes down (`found-value` over `found-name` over `found-shape` over `unreadable`) (environment, files and their names and link targets, metadata, histories). The capture file itself is scanned like any other file. Reported paths are sanitized in order: the exact value, then assignments, key shapes and the name. `pid1` reports the observed shape (`v<bytes>-<prefix|none>-<classes>`) in `detail` and the salted digest in `paths`, so the driver can compare stages (never the salt).

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

- **The boot token's TTL: at most 120 s, first exchange wins** (SEC rulings of Nov 16 and Nov 24). For containers, the 120 s start when the provider first reports the machine running, which is when our launcher starts; image pulls before that don't count. The watchdog's "billed but not enrolled" stop starts from the same moment.
- **VM mode stays refused** until a design keeps the boot credential's exchange window within 2 minutes. In a VM, cloud-init runs well after the provider reports the VM running, and an instance id is a claim checked against a known string, not attestation: anyone who reads the metadata knows what to claim in the first-exchange race. Acceptable designs: provider-verifiable instance identity; a fresh credential injected when cloud-init is ready; or another design that keeps the 2-minute cap.
  - **The design is now cleared** (SEC, Nov 25): an IP-bound first announce, with the boot token in that request's TLS response (120 s, single use). The launcher is still unreachable in VM mode until every part below, and the announce, have landed and been reviewed together.
  - **The VM gate** (`sbgpu_agent/vmgate.py`) runs before the announce, with the nonce's digest, and again before enroll, with the boot token's digest too. It only checks:
    - ssh, sshd and the ssh socket resolve, through systemd's unit search path and aliases, to a mask or to nothing (any other linked unit file counts as present);
    - no sshd, sshd-session or sshd-auth runs;
    - every `authorized_keys`/`authorized_keys2` is absent or an empty regular file, reached without following links and without crossing into a mount the image allowlist doesn't pin (each directory on the way and each key file itself: a mount point there, or a device change, fails unless that exact path is pinned); `/etc/passwd` rows are strict;
    - no socket of any kind on local port 22, and nothing listens or is bound off loopback (TCP or UDP, IPv4 or IPv6);
    - loopback listeners only from the image allowlist's exact `{process, protocol, address, port}`;
    - every process runs an allowlisted executable;
    - no environment or command line holds a credential shape (a closed list) or a known value (matched by digest);
    - no provider agent: no hyperstack-agent unit, user, process or install directory;
    - nothing answers on 169.254.169.254, and no config drive (both fail closed until the provider's contents are reviewed).
  - **How the gate reads and reports:** every read is bounded and read to EOF, and the whole scan has a work budget (processes, directory entries, fds, bytes hashed; running out fails the gate). Every directory is enumerated one entry at a time against a cap (`/proc`, each process's fds, each unit directory, `/dev/disk/by-label`), never listed whole first. Unreadable, malformed or vanishing data fails the gate unless the process exited, and the listing repeats until stable. It prints `SBGPU-GATE {"v":1,"pass":…,"fail":[fixed words]}`. The image allowlist is data, reviewed per image.
  - **Still to come before VM mode is reachable:**
    - the files, logs, cloud-init, systemd-credential and keyring checks;
    - the launcher's lockdown, announce and tmpfs boot file;
    - the agent's bounded poweroff;
    - the VM probe stages.
  - **VM user data** carries public values only, plus the machine's id and the launch's nonce (`SBGPU_MACHINE_ID`, `SBGPU_NONCE`; `renderBootScript` requires both in VM mode and refuses them in container mode). The announce names the script by `bootScriptSha256`: the sha256 of its exact UTF-8 bytes, final newline included. `BOOT_SCRIPT_VECTOR` is the shared test vector: control, the provider adapter and the launcher all test against it, and it changes whenever the launcher's bytes do.
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

- **Enroll:** `POST /v1/agent/enroll {bootToken, agentVersion, agentSha256, providerMachineId|null, mode, eradication, gpu: {name, count, memoryMiB}|null, hostname}` (`AgentEnrollRequest` in `@sbgpu/api`) returns `{machineId, agentToken, agentTokenExpiresAt, incarnation, relayUrl, heartbeatSeconds, idle: {minutes, gpuUtilThresholdPct}, maxSessionEndsAt, setupScript|null, workspace: {restore}}`. The request carries no provider: control takes the provider only from the boot token's launch record, and `providerMachineId` is a cross-check against that record, not identity. The eradication report is section 1.4's. A 401/403 means exit 3.
- **Heartbeat** every `heartbeatSeconds` (default 30): `{incarnation, uptimeS, activity: {lastTerminalInputAt, lastJupyterActivityAt, gpuUtilPct, gpuMemUsedMiB}, idleSince|null, save: SaveStatus, dirtyBytes}`, answered by `{agentToken?, commands: [{id, op: "save"|"stop"|"revoke"}]}`. Commands also arrive over the relay leg for speed; the heartbeat is the reliable path. Each command is handled once (by id) and answered through `POST /v1/agent/save-status {commandId, ...}`.
- **Setup script:** runs once per machine (marker file), after the restore, as the member's user, with output into `~/.sbgpu/setup.log`, visible in the terminal. It has a time limit (default 20 min). A failure is reported, but it doesn't stop the machine.
- **The member's user:** the agent runs as root (needed for the PTY users and for stopping processes). Terminals run as root on container images that only have root; otherwise as a `member` user. The member has root anyway on the providers we use.

- **The relay leg** (`sbgpu_agent/relayclient.py`, ported from Sagebrush's runner client): one outbound WebSocket to `relayUrl` (wss only, ws only to a loopback host for tests). The first message is the hello with the current agent token; nothing else is accepted from the relay before its `ready`. Controls are parsed strictly; receipts are acked at once; a ping goes every 15 s, and two unanswered drop the leg. Terminal pages go to the terminals (each page message a strict JSON object, at most 65,536 bytes; the leg itself refuses anything over that plus the prefix, before decoding). A drop is dialled again with a fresh token, backing off 1, 2, 4 … 60 s (60 s after a 429 or 4429). The relay's `revoked` or a 4403 is fatal.
- **The machine's stop** (`main.serve`): heartbeats run in a thread and the relay leg on the event loop. Whichever ends first, by a stop command, a revoke command, a refused heartbeat, the relay revoking or refusing, SIGTERM or an error, ends the other. The terminals are stopped (the tree rule over their sessions). Then, in container mode, `proctree.stop_everything` ends every other process in the container (4.1). The exit code is 0 for a stop and 3 for a revoke, a refusal or an error.

### 3.2 Idle detection

A machine is idle when, for `idle.minutes` (project policy, default 30):
- no terminal input on any session, and
- no Jupyter kernel activity (via Jupyter's `/api/status` `last_activity` and `/api/kernels` execution states, polled locally), and
- no process busy on the CPU (any process in the container above 10% of one core over the sample), whether or not it's in a terminal session, and
- GPU utilisation below `gpuUtilThresholdPct` (default 5%) on every sample (`nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits`, every 30 s).

A training run with no terminal attached keeps the GPU busy, so the machine isn't idle. An idle machine is saved, then stopped. At 5 minutes before an idle stop, the agent writes a warning to every attached terminal, and any input cancels it. Sustained 100% GPU with no session for hours is reported in the heartbeat (`activity`), and the watchdog decides (abuse flag).

### 3.3 Stop (save before stop)

1. The control plane sets the machine to `saving-before-stop`, issues a workspace token with `finalSaveOnly`, and sends `stop`.
2. The agent stops the periodic sync, sends SIGTERM to the processes in the member's terminals (to flush files), waits up to 10 s, then runs the final save, reporting progress through save-status.
3. On `done`, the control plane terminates the machine through the provider. On failure, or no report by the deadline (sized by the ledger from `dirtyBytes`, see 5.6), it terminates anyway with `stopReason: "final-save-incomplete"`, and the last periodic snapshot stays the latest.

`SaveStatus`: `{state: "idle"|"saving"|"failed", lastSavedAt|null, progress: {bytesDone, bytesTotal}|null, error|null, snapshotId|null}`.

## 4. The relay

The relay is part of the control Worker: the Worker's routes (`src/relay/routes.ts`) hand each connection to the machine's Durable Object, `MachineRelay` (`src/relay/relay.ts`), one per machine. It is adapted from Sagebrush's relay, our own code, noted as such in its header, with no dependency on that repository. From the original it keeps: one peer leg (the agent) and its page legs, generation-prefixed text frames, the strict control grammar, per-receiver windows proved by receipts, per-leg rates, dead-leg alarms, and peer replacement. What's different here is authentication (SEC ruling, Nov 24), the per-machine bounds (LIMITS ruling, Nov 24), and no byte leases.

**Routes.** `wss://<api>/api/relay/v1/peer?machine=<mch>` for the agent, and `wss://<api>/api/relay/v1/page?machine=<mch>&chan=terminal` for a page. Exactly these parameters are accepted, so no token ever rides in a URL. The Worker passes the object nothing but the upgrade and the machine id.

**Authentication, in the object, by each leg's first message:** `{"t":"hello","token":"<compact JWS>"}`, exactly those keys in that order, at most 4,608 bytes, within 10 s. Nothing is forwarded to or from a leg before it authenticates, and a token never appears in a log, a URL or a close reason.
- **The agent:** an `agent` token for this machine. The object keeps the accepted incarnation and, separately, `revokedThrough`, both durable. A token at or below `revokedThrough`, or below the accepted incarnation, is refused (4403). A higher one advances the accepted incarnation and closes every leg of a lower one. A newer agent leg of the same incarnation replaces the older (4009), and the pages paired with the older end (4001) and reconnect with fresh tokens. The relay answers `{"relay":"ready","inc":n}`.
- **A page:** a `page` token for this machine and its accepted incarnation, on an allowlisted channel (`terminal`). Its `jti` is consumed by one atomic insert into the object's used set, before anything is paired. It stays consumed whatever happens next (the agent missing, the socket closing), and across restarts. A storage failure refuses the page (1011). Used entries are pruned only after their own expiry. The agent is told `page-open {conn, chan, gen, mbr}`, and the page `{"relay":"ready","gen":n}`. **The page sends nothing before its `ready`.**
- **Revoke** (control, at a stop or a restart): `revokedThrough` is raised and written durably *before* the acknowledgement; then every leg at or below it is closed (4403, the agent told `{"relay":"revoked"}` first). Control treats only an acknowledgement as done: anything else leaves the stop pending and retried, and control mints no page token meanwhile (`revokeMachine` in routes.ts; control's side).

**On the wire after the hello:** the agent's messages are controls (`close {gen}`, `ack {r}`, `ping`) or application messages prefixed `"<gen>\n"`. A page's messages are controls (`ack {r}`, `ping`) or application payloads, which the relay prefixes with the page's generation. The relay sends receipts `{"relay":"receipt","r":…,"upto":n}` behind what it forwards; `upto` counts every byte charged to that receiver before the receipt, earlier receipts included. **Every receiver acks each receipt** (`{"relay":"ack","r":…}`) and **pings every 15 s** (`{"relay":"ping"}`, answered `pong`).

**The caps** (`src/relay/caps.ts`, one table), all enforced per machine:

| what | cap | over it |
|---|---|---|
| page legs | 4 per channel (`terminal`), 4 in all; a fifth replaces the oldest | 4009 to the oldest |
| unauthenticated legs at once | 4 | upgrade refused 429 |
| upgrade attempts | 30 a minute, burst 30, a stored bucket (a reconnect or restart doesn't refill it) | upgrade refused 429 |
| hello | 4,608 bytes, within 10 s, one message | 1008; 4403 at the deadline |
| a message | 65,536 bytes each way on `terminal`; controls 256 bytes | 1009 / 1008 |
| a receiver's unacknowledged bytes | 1 MiB per page, 8 MiB for the agent; 16 receipts out | sender closed 1013, nothing queued |
| messages per leg | 120/s, burst 200 | 4008 |
| **bytes through the machine** | **4 MiB/s, burst 16 MiB, every frame to every receiver (data, controls, receipts and the revoke notice, each with 256 bytes of overhead)**. One bucket; credit leaves it in reservations (250 ms of the rate, or what one frame needs) that are stored before any of it is spent, so a restart can lose credit but never regain it. A receipt is admitted together with the frame that makes it due. | sender closed 4429 (a revoke notice without room isn't sent; the close still is) |
| a dead leg | no ping for 40 s | 1001 (page), 4001 (agent) |
| page tokens in the used set | 10,000 unexpired | hello refused 4429 |

The relay forwards at once or closes: there is no queue behind a slow leg. Jupyter (4.2) will use the same accounting.

**Close codes:** 1001 dead page, 1003 binary, 1008 malformed, 1009 too big, 1011 storage failure at a hello, 1013 receiver not reading, 4000 closed by the agent, 4001 the agent is gone (the page shows "reconnecting" and retries with a fresh page token, backing off 1, 2, 4 … 30 s), 4008 message rate, 4009 replaced, 4403 refused or revoked (no retry with the same token), 4429 the machine's byte rate or token set.

**The lifecycle contract** (SEC ruling, Nov 24; control's machine lifecycle must keep it):
- **(a)** A stop completes only once `revokeMachine(env, mch, inc)` has returned true, meaning the machine's object wrote `revokedThrough >= inc` durably before answering. false, a throw or no answer leave the stop pending; the cron retries it, one attempt at a time. The `inc` is the machine's current incarnation (or higher): an ack for a lower one revokes nothing current, though `revokeMachine` would return true.
- **(b)** No page token is minted for a machine while a revoke for it is in flight, has failed or isn't acknowledged yet, nor once the machine is stopped.

The lifecycle's tests run `assertRelayLifecycleContract(make)` (`@sbgpu/testing/relay-contract`, in the test-only package, so no runtime package exports it). `make` receives a scripted stand-in for `revokeMachine`, injected wherever the lifecycle calls it. It returns the machine (`mch`, `inc`), `stop()` (one attempt per call: `"stopped"` or `"stopping"`) and `mintPageToken()` (a token, or null when refused). The scenarios:
- minting works before any stop (the control);
- a revoke answering false, or throwing, leaves the stop pending and minting refused, and a retry that's acknowledged completes it;
- a revoke in flight refuses minting and doesn't complete the stop until it answers;
- every revoke names the machine and its current incarnation;
- a stopped machine mints nothing;
- a `stop()` that never answers fails the check rather than hanging it.

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

The agent's implementation is `sbgpu_agent/terminal.py` and `terminal_output.py`; their docstrings are the reference. In short:

- **Output credit:** the page acks the decoded output bytes it has written (`upto`, cumulative). The agent stops reading the PTY at 256 KiB unacknowledged and resumes once acks bring that down to 64 KiB; meanwhile the program blocks in `write()`. An ack that goes back, or names more than was sent, closes the page (1008).
- **Input credit:** `in` frames of at most 16 KiB decoded, at most 64 KiB received but not yet written to the PTY; `inack upto` counts the bytes written. Past the credit, the page is closed (1008). Input is written in 1 KiB pieces, so Ctrl-C reaches the program while its output is paused.
- **Sessions:** at most 4 running per machine (`error: "sessions"`, with `limit`); each has a 1 MiB scrollback ring; ids are 22 base64url characters. A reattach replays a terminal reset plus the ring from a line boundary, then `live`. Another page reattaching takes the session over: the old page gets `error: "elsewhere"` and a close 4009. A detached session lives until the machine stops (or 24 h with no output and no attach).
- **Exit:** a shell that exits is never restarted. The PTY's last output reaches the page first; `exit` is always the last output message. The session's scrollback is kept 10 minutes (the last 8 ended sessions at most): a reattach then replays it and sends `exit` again right after `live`; later it gets `error: "unknown_session"` (and a page still attached when it's dropped gets `error: "expired"`). Ended sessions don't count toward the 4 running ones.
- **Errors and closes:** a message before an open gets `error: "not_open"`. A malformed message closes the page: 1002 (not a terminal message, a malformed resize, a kill for another session), 1008 (a malformed or second open, a bad ack, a malformed or oversized `in`, input past its credit), 1009 (any message over 64 KiB; the relay leg enforces it).
- **Limits:** output frames of at most 49,137 decoded bytes (65,534 serialized), coalesced at most 24 times a second (stepping down to 8 and 4 for large windows); output read at most 1 MiB/s per session; rows and cols 1..1000.
- **Stopping a session:** the process-tree rule: SIGHUP, SIGTERM, then SIGKILL after 2 s, recounting the PTY's session every 50 ms until it is empty, so a job that makes a new group late is still caught. The PTY is then drained (at most one ring's worth) and closed; at 30 s it's closed regardless.
- **What a terminal stop covers:** the terminal's original POSIX session only: its shell, its jobs, and every process group still in that session. This applies to `kill`, the 24 h detached-idle stop and the terminals' `stop_all`. A process the member moves out of the session (`setsid`, a daemon) is their own process on their own machine (they have root), and no terminal stop reaches it (product ruling, Nov 24). Such a process still counts as activity for idle detection (3.2).
- **What the machine's stop covers:** every process in the container. At a stop, a revoke or the agent's end, the agent (PID 1 in container mode) sends SIGTERM to every other process (`kill(-1)`, which spares only PID 1), waits up to 2 s, then SIGKILLs. It repeats the census until /proc shows no other process, for at most 10 s (`proctree.stop_everything`). The provider's termination of the machine (at a stop, the budget's hard stop, or from the watchdog) remains the outer boundary.

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

The ledger holds back part of the allocation for a final save before the hard stop. The amount is an **estimate**, not a guarantee that the save will finish:

- `finalSaveReserveSeconds(dirtyBytes)` (in `@sbgpu/api`) assumes an upload rate of 20 MB/s plus a fixed 60 s, capped at one hour. `dirtyBytes` is the agent's report in each heartbeat: the bytes changed since the last save.
- The budget takes the larger of this and the project policy's floor (`budget.reserveSeconds`). The ledger then charges it through the contract's per-minute, pinned-rate rules, not as a separate hourly ceiling.
- A slower network, many small files, or an agent that under-reports can make the save outlast the reserve. At the deadline the machine stops regardless (3.3): the previous snapshot stays the latest, and the stop is marked incomplete. Under-reporting can therefore lose the final changes.
- Over-reporting only reserves more, which can shorten running time on the same allocation. That includes a team allocation shared with others, not just the reporting member's machine.

## 6. Team git (later)

A repository per team, served behind the same gateway and token scheme, cloned at boot into `~/team/repo`. Where it's hosted is an open question in the plan. It comes after the pilot's critical path.

## 7. Threats (for SEC)

| threat | answer |
|---|---|
| A tampered agent (CDN or transit) | the hash pinned per launch from a CI-signed manifest that control verifies; enroll compares the agent's hash with the launch record; HTTPS only; installed only after a full match |
| A copied boot token | single use, at most 120 s from first running (containers), bound to the launch and the provider machine id (a cross-check, not attestation); a reuse attempt flags the machine; VM mode refused until it can meet the same window |
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
2. VM mode: which provider offers verifiable instance identity, or a way to inject a fresh credential when cloud-init is ready, so the boot credential stays within 2 minutes (section 2). Until then VM mode is refused.
3. Control: in VM mode, once it exists, re-enroll after an agent crash, or always stop the machine (section 1.3)?
4. Providers: whether each VM provider injects any credential into the machine (metadata, cloud-init, environment) before it's admitted.
