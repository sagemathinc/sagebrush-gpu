// Container mode's launch (RunPod; the container-launch design r2.1, SEC clear, steps 2-4 and
// 6): the intent, the create, the provider id with the accrual, first running, and the connect
// watchdog. Launch is off in production: nothing in the app calls launchContainer yet (container
// enroll comes next), and it runs only against an adapter the caller gives.
//
// - The intent is one batch before any provider call: the launch row (creating), its pinned rate
//   and the boot token's hash (pending: no provider id, no window). The token itself lives only
//   in memory, for the create.
// - The provider id is one guarded batch: the id on the launch and on its token, and the accrual
//   opened from the pinned rate, starting at the intent (RunPod bills from creation). Each guarded
//   write is followed by a guard that fails the whole batch unless it changed exactly one row.
// - A lost create reply, or a crash after the create, is recovered by the pod's name when the
//   launch's create deadline passes, with the same batch and the same rate.
// - First running is a verified observation (the expected pod, image, entrypoint, env names and
//   settings), timed by control's clock after the read. It only moves earlier, and it opens the
//   token's 120 s window together with the launch's connect deadline.
// - Every termination revokes in the batch that claims the launch, before any provider call:
//   the boot token is used, and a running or saving machine moves to stopping (so its workspace
//   and page tokens die with the state). A starting machine is left for the terminated batch. A pod found with no id recorded is ended only once its accrual is open (or
//   past ACCRUAL_WAIT_MS). The ids a caller holds are written (launch_cleanup) in the claim
//   batch and retried by id until each reads terminated. Only the provider confirming the pods
//   gone marks the launch terminated and closes the accrual.

import type { LaunchSpec, ProviderMachineStatus } from "@sbgpu/providers";
import { ProviderError, machineName, sameMachineName } from "@sbgpu/providers";
import type { Db, Stmt } from "./db.ts";
import { base64url, sha256Hex } from "./http.ts";
import { closeAccrual } from "./ledger.ts";
import { BOOT_TOKEN_TTL_MS, CREATE_DEADLINE_MS, WATCHDOG_BATCH, WATCHDOG_BUDGET_MS, withDeadline, type JobEnv } from "./vm.ts";

/** The calls container mode needs from a provider adapter (the RunPod adapter has them). */
export interface ContainerProvider {
  /** Creates one pod, or finds the one a lost reply created; throws ProviderError otherwise. */
  launch(spec: LaunchSpec): Promise<{ providerMachineId: string }>;
  /** A pod the provider no longer knows reports state "terminated". */
  status(providerMachineId: string): Promise<ProviderMachineStatus>;
  /** Idempotent; throws when the provider can't confirm the request was taken. */
  terminate(providerMachineId: string): Promise<void>;
  /** Every pod of ours (by name), in any state; throws rather than return part of the list. */
  listMachines(): Promise<ProviderMachineStatus[]>;
}

/** What a container must show to be first seen running: the release's image and launcher, and only the token's variable. */
export interface ContainerExpect {
  image: string;
  launcher: readonly string[];
  /** The boot token's variable, the only env name the pod may have. */
  bootEnv: string;
}

/** What the app holds for container mode: the adapter, and what its pods must show. */
export interface ContainerDeps {
  provider: ContainerProvider;
  expect: ContainerExpect;
}

export interface ContainerEnv {
  /** This deployment's installation slug, in every pod's name; null when unset (no launch, no name search). */
  installation: string | null;
  db: Db;
  /** Control's time, read when it's needed (first running is timed after its provider read). */
  clock(): number;
  provider: ContainerProvider | null;
  expect: ContainerExpect;
  randomBytes(n: number): Uint8Array;
  /** Milliseconds since the run began (the watchdog's budget). */
  elapsedMs(): number;
}

/** The connect window: enroll within this of first running, or the pod is ended. */
export const CONNECT_WINDOW_MS = BOOT_TOKEN_TTL_MS;
/** How long the create (with the adapter's own recovery by name) may take. */
export const LAUNCH_CALL_DEADLINE_MS = 60_000;
/**
 * How long after the intent a pod with no id recorded waits for its accrual before it is ended
 * without one (a ledger that refuses it for good): 20 minutes of watchdog retries past the
 * create deadline.
 */
export const ACCRUAL_WAIT_MS = CREATE_DEADLINE_MS + 20 * 60_000;

export type ContainerReason = "create-failed" | "create-deadline" | "connect-deadline" | "provider-facts" | "pod-exited" | "duplicate-name";

/** Fails its batch unless the statement just before it changed exactly one row (D1 runs a batch in order, on one connection, as one transaction). */
const TOOK: Stmt = { sql: `INSERT INTO enroll_guard (ok) SELECT 0 WHERE changes() <> 1`, params: [] };

/** A provider's pod id: 1 to 64 printable ASCII characters (the schema bounds the same bytes). */
const PROVIDER_ID = /^[\x21-\x7e]{1,64}$/;

export interface ContainerIntent {
  machineId: string;
  incarnation: number;
  agentSha256: string;
  credentialKind: "ours" | "org";
  /** The offer's pinned rate: what the launch bills at, whenever its accrual opens. */
  rate: { providerCostPerHour: number; marginBps: number };
  createdMs: number;
  tokenSha256: string;
}

/** The intent: the launch (creating, due at its create deadline), its rate and its pending token, all or nothing. */
export async function recordContainerIntent(db: Db, i: ContainerIntent): Promise<void> {
  await db.batch([
    {
      // (the account: ours is the platform's; an organization's key is that organization's, the
      // machine's at the intent, read in this same statement)
      sql: `INSERT INTO launches (machine_id, incarnation, mode, provider, agent_sha256, credential_kind, account_kind, account_org_id, outcome, next_ms, created_ms)
            VALUES (?, ?, 'container', 'runpod', ?, ?, ?,
              CASE WHEN ? = 'org' THEN (SELECT p.org_id FROM machines m JOIN projects p ON p.id = m.project_id WHERE m.id = ?) END,
              'creating', ?, ?)`,
      params: [
        i.machineId, i.incarnation, i.agentSha256, i.credentialKind, i.credentialKind === "org" ? "org" : "platform",
        i.credentialKind, i.machineId, i.createdMs + CREATE_DEADLINE_MS, i.createdMs,
      ],
    },
    {
      sql: `INSERT INTO launch_rates (machine_id, incarnation, provider_cost_per_hour, margin_bps) VALUES (?, ?, ?, ?)`,
      params: [i.machineId, i.incarnation, i.rate.providerCostPerHour, i.rate.marginBps],
    },
    {
      sql: `INSERT INTO boot_tokens (token_sha256, machine_id, incarnation, mode) VALUES (?, ?, ?, 'container')`,
      params: [i.tokenSha256, i.machineId, i.incarnation],
    },
  ]);
}

/** The accrual of a container launch, from its pinned rate and its intent time; nothing if it has one. */
function openFromRate(machineId: string, incarnation: number, boundId: string | null): Stmt[] {
  return [
    {
      sql: `INSERT INTO machine_accruals (machine_id, incarnation, provider, provider_cost_per_hour, margin_bps, start_ms)
            SELECT l.machine_id, l.incarnation, l.provider, r.provider_cost_per_hour, r.margin_bps, l.created_ms
            FROM launches l JOIN launch_rates r ON r.machine_id = l.machine_id AND r.incarnation = l.incarnation
            WHERE l.machine_id = ? AND l.incarnation = ? AND l.mode = 'container' AND ${boundId === null ? "l.provider_machine_id IS NULL" : "l.provider_machine_id = ?"}
              AND NOT EXISTS (SELECT 1 FROM machine_accruals a WHERE a.machine_id = l.machine_id AND a.incarnation = l.incarnation)`,
      params: boundId === null ? [machineId, incarnation] : [machineId, incarnation, boundId],
    },
    TOOK,
    {
      sql: `UPDATE machines SET billed_through_ms = COALESCE(billed_through_ms, (SELECT (l.created_ms / 60000) * 60000 FROM launches l WHERE l.machine_id = ? AND l.incarnation = ?))
            WHERE id = ?`,
      params: [machineId, incarnation, machineId],
    },
    TOOK,
  ];
}

/**
 * The provider id of a creating container launch, with its accrual, in one guarded batch: the id
 * on the launch (none recorded yet), the same id on its token, and the accrual from the pinned
 * rate. "recorded" for this id, now or already (a replay opens nothing more); "refused" for
 * another id, a launch past creating, or a failed write (the caller abandons the launch with the
 * id it holds).
 */
export async function recordContainerId(db: Db, machineId: string, incarnation: number, providerMachineId: string): Promise<"recorded" | "refused"> {
  if (!PROVIDER_ID.test(providerMachineId)) return "refused";
  try {
    await db.batch([
      {
        sql: `UPDATE launches SET provider_machine_id = ?, watchdog_version = watchdog_version + 1
              WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND outcome = 'creating' AND provider_machine_id IS NULL`,
        params: [providerMachineId, machineId, incarnation],
      },
      TOOK,
      {
        sql: `UPDATE boot_tokens SET provider_machine_id = ? WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND provider_machine_id IS NULL AND used_ms IS NULL`,
        params: [providerMachineId, machineId, incarnation],
      },
      TOOK,
      ...openFromRate(machineId, incarnation, providerMachineId),
    ]);
    return "recorded";
  } catch {
    // (nothing of the batch applied: already recorded with this id is a replay, anything else is refused)
    const r = await db.all<{ ok: number }>(
      `SELECT 1 AS ok FROM launches l WHERE l.machine_id = ? AND l.incarnation = ? AND l.mode = 'container' AND l.outcome = 'creating' AND l.provider_machine_id = ?
         AND EXISTS (SELECT 1 FROM machine_accruals a WHERE a.machine_id = l.machine_id AND a.incarnation = l.incarnation)`,
      [machineId, incarnation, providerMachineId],
    );
    return r.length === 1 ? "recorded" : "refused";
  }
}

/**
 * First running: a verified observation at control time `atMs` (taken after the provider read),
 * in one guarded batch. The launch moves to issued (or stays issued) with first running and its
 * connect deadline, and the token gets its 120 s window. It only moves earlier: a sample no
 * earlier than the recorded one changes nothing ("kept"), and so does a launch that isn't
 * creating or issued with this id, or a revoked token.
 */
export async function recordFirstRunning(db: Db, machineId: string, incarnation: number, providerMachineId: string, atMs: number): Promise<"recorded" | "kept"> {
  if (!Number.isSafeInteger(atMs) || atMs < 0) return "kept";
  try {
    await db.batch([
      {
        sql: `UPDATE launches SET first_running_ms = ?, outcome = 'issued', next_ms = ?, watchdog_version = watchdog_version + 1
              WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND provider_machine_id = ? AND outcome IN ('creating', 'issued')
                AND (first_running_ms IS NULL OR first_running_ms > ?)`,
        params: [atMs, atMs + CONNECT_WINDOW_MS, machineId, incarnation, providerMachineId, atMs],
      },
      TOOK,
      {
        sql: `UPDATE boot_tokens SET issued_ms = ?, expires_ms = ?
              WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND provider_machine_id = ? AND used_ms IS NULL`,
        params: [atMs, atMs + BOOT_TOKEN_TTL_MS, machineId, incarnation, providerMachineId],
      },
      TOOK,
    ]);
    return "recorded";
  } catch {
    return "kept";
  }
}

export interface ContainerRow {
  machine_id: string;
  incarnation: number;
  provider_machine_id: string | null;
  watchdog_version: number;
  outcome: string;
  created_ms: number;
}

export async function containerRow(db: Db, machineId: string, incarnation: number): Promise<ContainerRow | null> {
  const r = await db.all<ContainerRow>(
    `SELECT machine_id, incarnation, provider_machine_id, watchdog_version, outcome, created_ms FROM launches WHERE machine_id = ? AND incarnation = ? AND mode = 'container'`,
    [machineId, incarnation],
  );
  return r[0] ?? null;
}

/**
 * The provider's live pods carrying exactly this launch's name (this installation, this machine,
 * this incarnation). "unavailable" if the whole list can't be read, or the name can't be built.
 */
async function podsNamed(env: ContainerEnv, machineId: string, incarnation: number): Promise<string[] | "unavailable"> {
  const p = env.provider;
  if (!p || env.installation === null) return "unavailable";
  let name: string;
  try {
    name = machineName(env.installation, machineId, incarnation);
  } catch {
    return "unavailable";
  }
  const list = await withDeadline<ProviderMachineStatus[] | "unavailable">(() => p.listMachines(), "unavailable");
  if (list === "unavailable") return "unavailable";
  return list.filter((s) => sameMachineName(s.parsedName, name) && s.state !== "terminated").map((s) => s.providerMachineId);
}

/**
 * Whether a launch with no id recorded has its accrual open, opening it from the pinned rate if
 * not. A write or read that fails is "not open".
 */
async function accrualOpen(db: Db, r: ContainerRow): Promise<boolean> {
  try {
    await db.batch(openFromRate(r.machine_id, r.incarnation, null));
    return true;
  } catch {
    // (refused when it is open already; otherwise the write failed)
    try {
      const a = await db.all<{ ok: number }>(`SELECT 1 AS ok FROM machine_accruals WHERE machine_id = ? AND incarnation = ?`, [r.machine_id, r.incarnation]);
      return a.length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Ends the launch's cleanup ids and confirms each by its own status: an id read terminated (that
 * exact id) is forgotten. A terminate that throws, times out or returns early proves nothing;
 * its row stays for the next attempt. Whether every one was confirmed and forgotten.
 */
async function endCleanup(env: ContainerEnv, p: ContainerProvider, r: ContainerRow, ids: readonly string[]): Promise<boolean> {
  for (const id of ids) await withDeadline(() => p.terminate(id), undefined);
  let all = true;
  for (const id of ids) {
    const s = await withDeadline<ProviderMachineStatus | "unavailable">(() => p.status(id), "unavailable");
    if (s === "unavailable" || s.providerMachineId !== id || s.state !== "terminated") {
      all = false;
      continue;
    }
    try {
      await env.db.run(`DELETE FROM launch_cleanup WHERE machine_id = ? AND incarnation = ? AND provider_machine_id = ?`, [r.machine_id, r.incarnation, id]);
    } catch {
      all = false;
    }
  }
  return all;
}

/**
 * The machine's half of the revocation, for every batch that marks a container launch to
 * terminate: a running or saving machine moves to stopping at that incarnation, only while its
 * container launch there is ending (after the mark, in the same batch). A starting machine is
 * left as it is (the start path's helper fails it when the launch is terminated), and so is a
 * VM's, or a machine that moved on.
 */
export function stopMachineStmt(machineId: string, incarnation: number): Stmt {
  return {
    sql: `UPDATE machines SET state = 'stopping' WHERE id = ? AND incarnation = ? AND state IN ('running', 'saving')
            AND EXISTS (SELECT 1 FROM launches WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND outcome = 'terminate')`,
    params: [machineId, incarnation, machineId, incarnation],
  };
}

/**
 * One termination attempt, if this caller wins the row's claim: in one batch, the claim (a
 * conditional update from the version it read; the launch moves to terminate), the boot token's
 * revocation, and the ids the caller holds (other than the recorded one) as cleanup ids. Only
 * after that commits does it call the provider: terminate every pod of the launch (its id, its
 * cleanup ids from this and earlier attempts, or every pod with its name when it has none), then
 * confirm. With no id recorded, pods are ended only once the accrual is open (or past
 * ACCRUAL_WAIT_MS), except cleanup ids a list read without them. Confirmed gone (each cleanup id
 * by its own status) marks it terminated and closes the accrual. Returns whether the claim was won.
 */
export async function terminateContainerAttempt(env: ContainerEnv, r: ContainerRow, reason: ContainerReason | string, heldIds: readonly string[] = []): Promise<boolean> {
  const now = env.clock();
  const held = [...new Set(heldIds.filter((x) => PROVIDER_ID.test(x) && x !== r.provider_machine_id))];
  try {
    await env.db.batch([
      {
        sql: `UPDATE launches SET watchdog_version = watchdog_version + 1, next_ms = ?,
                outcome = CASE WHEN outcome IN ('creating', 'issued') THEN 'terminate' ELSE outcome END,
                terminate_reason = COALESCE(terminate_reason, ?)
              WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND watchdog_version = ? AND outcome IN ('creating', 'issued', 'terminate')`,
        params: [now, reason, r.machine_id, r.incarnation, r.watchdog_version],
      },
      TOOK,
      {
        sql: `UPDATE boot_tokens SET used_ms = COALESCE(used_ms, ?) WHERE machine_id = ? AND incarnation = ? AND mode = 'container'`,
        params: [now, r.machine_id, r.incarnation],
      },
      stopMachineStmt(r.machine_id, r.incarnation),
      ...held.map((id) => ({
        sql: `INSERT INTO launch_cleanup (machine_id, incarnation, provider_machine_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        params: [r.machine_id, r.incarnation, id],
      })),
    ]);
  } catch {
    return false;
  }
  const p = env.provider;
  if (!p) return true; // (no adapter: the row stays due)
  // the cleanup ids: those held now and any an earlier attempt kept (unread: the row stays due)
  let cleanup: string[];
  try {
    cleanup = (await env.db.all<{ provider_machine_id: string }>(
      `SELECT provider_machine_id FROM launch_cleanup WHERE machine_id = ? AND incarnation = ? ORDER BY provider_machine_id`,
      [r.machine_id, r.incarnation],
    )).map((c) => c.provider_machine_id);
  } catch {
    return true;
  }
  // which pods: the recorded id and the cleanup ids; with none recorded, every pod with the name
  let ids = [...new Set([...(r.provider_machine_id !== null ? [r.provider_machine_id] : []), ...cleanup])];
  const byName = r.provider_machine_id === null;
  // (with no id recorded, every pod with the name; a list that wasn't read proves nothing, but the
  // cleanup ids are still ended, once the accrual is open)
  const named = byName ? await podsNamed(env, r.machine_id, r.incarnation) : [];
  if (named !== "unavailable") ids = [...new Set([...ids, ...named])];
  if (byName && ids.length > 0 && !(await accrualOpen(env.db, r)) && now < r.created_ms + ACCRUAL_WAIT_MS) {
    // pods exist that no id batch recorded: they bill, and none is ended before its accrual is
    // durably open (until ACCRUAL_WAIT_MS). The row stays due (next_ms is the claim's now) and
    // the pods stay up, so the next attempt finds them by name and opens it then. Only a cleanup
    // id that a list read without it is ended now (and confirmed by its id): no list could find
    // it (the provider renamed it), and its row keeps it for the next attempt until it reads
    // terminated.
    if (named !== "unavailable") await endCleanup(env, p, r, cleanup.filter((x) => !named.includes(x)));
    return true;
  }
  for (const id of ids) if (!cleanup.includes(id)) await withDeadline(() => p.terminate(id), undefined);
  const cleaned = await endCleanup(env, p, r, cleanup);
  if (named === "unavailable") return true; // (the row stays due: absence can't be confirmed)
  // confirmed gone: every cleanup id by its own status, and the recorded id by its own status,
  // or, with none recorded, a fresh list showing no pod with the name
  let gone: boolean;
  if (!byName) {
    const s = await withDeadline<ProviderMachineStatus | "unavailable">(() => p.status(r.provider_machine_id!), "unavailable");
    gone = s !== "unavailable" && s.providerMachineId === r.provider_machine_id && s.state === "terminated";
  } else {
    const left = await podsNamed(env, r.machine_id, r.incarnation);
    gone = left !== "unavailable" && left.length === 0;
  }
  if (gone && cleaned) {
    const at = env.clock();
    await env.db.batch([
      {
        sql: `UPDATE launches SET outcome = 'terminated', terminated_ms = ?, next_ms = NULL WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND outcome = 'terminate'`,
        params: [at, r.machine_id, r.incarnation],
      },
      { sql: `UPDATE machines SET state = 'stopped' WHERE id = ? AND incarnation = ? AND state = 'stopping'`, params: [r.machine_id, r.incarnation] },
      ...closeAccrual(r.machine_id, r.incarnation, at),
    ]);
  }
  return true;
}

/**
 * Held pods that could be neither recorded nor confirmed gone (every write failed, and no exact
 * status read them terminated): the only record of them is this error's ids. The caller must keep
 * them and retry or report them. The launch's boot token may not be revoked either.
 */
export class HeldPodsUnknown extends Error {
  readonly machineId: string;
  readonly incarnation: number;
  readonly providerMachineIds: readonly string[];
  constructor(machineId: string, incarnation: number, providerMachineIds: readonly string[]) {
    super(`container launch ${machineId} (incarnation ${incarnation}): ${providerMachineIds.length} held pod(s) neither recorded nor confirmed gone`);
    this.name = "HeldPodsUnknown";
    this.machineId = machineId;
    this.incarnation = incarnation;
    this.providerMachineIds = providerMachineIds;
  }
}

/** How many times abandonContainer tries to claim the launch before it hands its held ids over alone. */
const ABANDON_CLAIM_TRIES = 2;

/**
 * Ends a container launch now (revoking its token first), with the pod ids the caller holds.
 * The held ids must outlive this call. If the claim isn't won (a failed write, or another
 * caller's claim), they are written to launch_cleanup by themselves, so whoever claims the launch
 * later (the watchdog, at the latest at the create deadline) ends them by id. Only if nothing can
 * be written are they ended here, each dropped only once its exact status reads terminated
 * (nothing else could ever find a pod that no list shows by the name). Throws HeldPodsUnknown
 * with the ids it could neither record nor confirm gone.
 */
export async function abandonContainer(env: ContainerEnv, machineId: string, incarnation: number, reason: ContainerReason, heldIds: readonly string[] = []): Promise<void> {
  for (let i = 0; i < ABANDON_CLAIM_TRIES; i++) {
    let r: ContainerRow | null;
    try {
      r = await containerRow(env.db, machineId, incarnation);
    } catch {
      continue;
    }
    if (!r) return;
    if (await terminateContainerAttempt(env, r, reason, heldIds)) return;
  }
  const held = [...new Set(heldIds.filter((x) => PROVIDER_ID.test(x)))];
  if (held.length === 0) return;
  try {
    await env.db.batch(
      held.map((id) => ({
        sql: `INSERT INTO launch_cleanup (machine_id, incarnation, provider_machine_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        params: [machineId, incarnation, id],
      })),
    );
    return;
  } catch {
    // (nothing durable: the last chance to end them, each kept until its own status proves it gone)
  }
  const p = env.provider;
  const left: string[] = [];
  for (const id of held) {
    if (p) await withDeadline(() => p.terminate(id), undefined);
    const s = p ? await withDeadline<ProviderMachineStatus | "unavailable">(() => p.status(id), "unavailable") : "unavailable";
    if (s === "unavailable" || s.providerMachineId !== id || s.state !== "terminated") left.push(id);
  }
  if (left.length > 0) throw new HeldPodsUnknown(machineId, incarnation, left);
}

export interface ContainerLaunch {
  machineId: string;
  incarnation: number;
  agentSha256: string;
  credentialKind: "ours" | "org";
  rate: { providerCostPerHour: number; marginBps: number };
  /** Everything the create needs but the boot token, the name and the incarnation, which are made here. */
  spec: Omit<LaunchSpec, "bootToken" | "name" | "incarnation">;
}

/**
 * The launch up to the provider id: the intent, then the create with the token in the pod's env,
 * then the id batch. "not-started": the intent wasn't written (nothing was created). "created":
 * the id and the accrual are recorded. "unknown": the create's outcome is unknown (the row stays
 * creating; at its create deadline the watchdog finds any pod by its name). "abandoned": the
 * create failed, or its pod was refused; the launch is ended (token revoked first), its pod once
 * its accrual is open (the watchdog retries). Throws HeldPodsUnknown (from abandonContainer) when
 * a pod it holds could be neither recorded nor confirmed gone.
 */
export async function launchContainer(env: ContainerEnv, l: ContainerLaunch): Promise<"not-started" | "created" | "unknown" | "abandoned"> {
  // the pod's name first: one that can't be built (no installation, or an incarnation past the
  // name's bound) is a launch not started, with nothing written
  let name: string;
  try {
    if (env.installation === null) return "not-started";
    name = machineName(env.installation, l.machineId, l.incarnation);
  } catch {
    return "not-started";
  }
  const token = base64url(env.randomBytes(32));
  try {
    await recordContainerIntent(env.db, {
      machineId: l.machineId,
      incarnation: l.incarnation,
      agentSha256: l.agentSha256,
      credentialKind: l.credentialKind,
      rate: l.rate,
      createdMs: env.clock(),
      tokenSha256: await sha256Hex(token),
    });
  } catch {
    return "not-started";
  }
  const p = env.provider;
  if (!p) {
    await abandonContainer(env, l.machineId, l.incarnation, "create-failed");
    return "abandoned";
  }
  type Created = { id: string } | { error: unknown } | "late";
  const created = await withDeadline<Created>(
    () => p.launch({ ...l.spec, incarnation: l.incarnation, name, bootToken: token }).then((x) => ({ id: x.providerMachineId }), (e: unknown) => ({ error: e })),
    "late",
    LAUNCH_CALL_DEADLINE_MS,
  );
  if (created === "late") return "unknown";
  if ("error" in created) {
    const e = created.error;
    // a pod the adapter refused (it didn't match the spec): ours, and billed, so it is ended by its id
    if (e instanceof ProviderError && e.providerMachineId !== null) {
      await abandonContainer(env, l.machineId, l.incarnation, "create-failed", [e.providerMachineId]);
      return "abandoned";
    }
    if (e instanceof ProviderError && e.kind === "outcome_unknown") return "unknown";
    // a definitive failure: no pod; the watchdog confirms that by name before it marks the launch terminated
    await abandonContainer(env, l.machineId, l.incarnation, "create-failed");
    return "abandoned";
  }
  if ((await recordContainerId(env.db, l.machineId, l.incarnation, created.id)) === "recorded") return "created";
  await abandonContainer(env, l.machineId, l.incarnation, "create-failed", [created.id]);
  return "abandoned";
}

/** Same strings in the same order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * One observation of a creating or issued container launch: a fresh provider read, verified
 * (the expected pod; when running, the release's image and launcher, the token's variable as the
 * only env name, no ports and no other settings). Running and verified records first running at
 * control time after the read. A pod that exited, or doesn't match, ends the launch.
 */
export async function observeContainer(env: ContainerEnv, machineId: string, incarnation: number): Promise<"running" | "pending" | "unavailable" | "ended"> {
  const r = await containerRow(env.db, machineId, incarnation);
  const p = env.provider;
  if (!r || !p || r.provider_machine_id === null || (r.outcome !== "creating" && r.outcome !== "issued")) return "unavailable";
  const id = r.provider_machine_id;
  const s = await withDeadline<ProviderMachineStatus | "unavailable">(() => p.status(id), "unavailable");
  if (s === "unavailable") return "unavailable";
  const at = env.clock(); // (control time, after the read)
  if (s.providerMachineId !== id || s.machineId !== machineId) {
    await terminateContainerAttempt(env, r, "provider-facts");
    return "ended";
  }
  if (s.state === "terminated" || s.state === "failed" || s.state === "stopping") {
    await terminateContainerAttempt(env, r, "pod-exited");
    return "ended";
  }
  if (s.state !== "running") return "pending";
  const e = env.expect;
  const ok =
    s.image === e.image &&
    sameList(s.command, e.launcher) &&
    sameList(s.envNames, [e.bootEnv]) &&
    s.exposedPorts.length === 0 &&
    s.unexpectedSettings.length === 0;
  if (!ok) {
    await terminateContainerAttempt(env, r, "provider-facts");
    return "ended";
  }
  await recordFirstRunning(env.db, machineId, incarnation, id, at);
  return "running";
}

/**
 * The container watchdog's search (exported for its query-plan test): due container launches,
 * a range scan of the partial index on next_ms in the index's order, stopping at the batch.
 */
export const CONTAINER_WATCHDOG_SELECT = `SELECT v.machine_id, v.incarnation, v.provider_machine_id, v.watchdog_version, v.outcome, v.created_ms,
       CASE WHEN v.outcome = 'terminate' THEN v.terminate_reason
            WHEN v.outcome = 'creating' THEN 'create-deadline'
            ELSE 'connect-deadline' END AS reason
     FROM launches v
     WHERE v.next_ms IS NOT NULL AND v.next_ms <= ? AND v.mode = 'container'
     ORDER BY v.next_ms, v.watchdog_version, v.machine_id, v.incarnation
     LIMIT ?`;

/**
 * The container watchdog job: launches marked to terminate, creating past their create deadline
 * (never seen running), and issued past their connect deadline (not enrolled within 120 s of
 * first running), which is exactly `next_ms <= now`. A creating launch whose id was never
 * recorded (a lost reply, a crash) first gets it from the provider's list by its name, with the
 * same id batch and its pinned rate, so its accrual opens as it would have; two pods with the
 * name are both ended. At most WATCHDOG_BATCH a run, none claimed past the budget. Returns how
 * many it attempted.
 */
export async function runContainerWatchdog(env: ContainerEnv): Promise<number> {
  const rows = await env.db.all<ContainerRow & { reason: string }>(CONTAINER_WATCHDOG_SELECT, [env.clock(), WATCHDOG_BATCH]);
  let attempted = 0;
  for (const row of rows) {
    if (env.elapsedMs() >= WATCHDOG_BUDGET_MS) break;
    let r: ContainerRow = row;
    let reason = row.reason;
    if (r.outcome === "creating" && r.provider_machine_id === null) {
      const named = await podsNamed(env, r.machine_id, r.incarnation);
      if (named !== "unavailable" && named.length === 1) {
        await recordContainerId(env.db, r.machine_id, r.incarnation, named[0]!);
        r = (await containerRow(env.db, r.machine_id, r.incarnation)) ?? r;
      } else if (named !== "unavailable" && named.length > 1) {
        reason = "duplicate-name";
      }
    }
    if (await terminateContainerAttempt(env, r, reason)) attempted++;
  }
  return attempted;
}

/**
 * The lifetime job's search (exported for its query-plan test): enrolled container launches at or
 * past their hard lifetime, a range scan of the lifetime index in its own order, stopping at the batch.
 */
export const CONTAINER_LIFETIME_SELECT = `SELECT machine_id, incarnation, watchdog_version FROM launches
     WHERE outcome = 'enrolled' AND mode = 'container' AND max_end_ms <= ?
     ORDER BY max_end_ms, machine_id, incarnation
     LIMIT ?`;

/**
 * The hard lifetime (scheduled): each enrolled container launch at or past max_end_ms is marked
 * to terminate (max-session), in one batch with its revocation (the machine leaves running), for
 * the container watchdog to end through the provider. There is no save first: the agent has no
 * save protocol yet, so work not saved by then is lost. Each mark rechecks what was read (enrolled,
 * at its version, still past its lifetime) and fails whole unless it changed exactly that row.
 * At most WATCHDOG_BATCH a run. Returns how many it marked.
 */
export async function runContainerLifetime(env: JobEnv): Promise<number> {
  const rows = await env.db.all<{ machine_id: string; incarnation: number; watchdog_version: number }>(CONTAINER_LIFETIME_SELECT, [env.now, WATCHDOG_BATCH]);
  let marked = 0;
  for (const r of rows) {
    try {
      await env.db.batch([
        {
          sql: `UPDATE launches SET outcome = 'terminate', terminate_reason = 'max-session', next_ms = ?, watchdog_version = watchdog_version + 1
                WHERE machine_id = ? AND incarnation = ? AND mode = 'container' AND outcome = 'enrolled' AND watchdog_version = ? AND max_end_ms <= ?`,
          params: [env.now, r.machine_id, r.incarnation, r.watchdog_version, env.now],
        },
        TOOK,
        stopMachineStmt(r.machine_id, r.incarnation),
      ]);
      marked++;
    } catch {
      // (it changed meanwhile: another mark came first; nothing written)
    }
  }
  return marked;
}
