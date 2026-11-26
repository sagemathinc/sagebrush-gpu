// The agent's heartbeat (design r2, SEC clear). An authenticated agent (agent-auth.ts) reports
// every 30 s; control keeps the latest report per machine incarnation and, when the agent's
// token has 15 minutes or less left, answers with a fresh one (same machine and incarnation,
// the capped lifetime, signed by the proved-ready signer; none, plus an alert, when it isn't
// ready). Requests may cross: a report replaces the stored one (and sets the save estimate)
// only when it's newer, and the launch's heartbeat due time only moves later, so an older
// request committing last never undoes a newer one. The heartbeat watchdog ends an enrolled
// machine, VM or container, whose heartbeats stopped: past its due time (silent for more than
// 120 s), it marks the launch to terminate (heartbeat-lost), in one guarded batch that rechecks
// everything it read, so a heartbeat that lands first leaves the launch alone; a container's
// machine leaves running (for stopping) in the same batch. The mode's own watchdog then ends it
// through the provider (a container's revokes its boot token first).

import { finalSaveReserveSeconds, isId, signToken, toIso, type AgentClaims, type AgentHeartbeatResponse } from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import { stopMachineStmt } from "./container.ts";
import type { Stmt } from "./db.ts";
import { HttpError, base64url, json } from "./http.ts";
import type { JobEnv } from "./vm.ts";

export const HEARTBEAT_MAX_BODY_BYTES = 4096;
/** A refresh when the presented token has this long or less left (seconds). */
export const REFRESH_WITHIN_S = 900;
const AGENT_TOKEN_TTL_S = 3600;
/** A machine silent for more than this is lost (3 missed 30 s heartbeats, plus slack). */
export const HEARTBEAT_LOST_MS = 120_000;
export const HEARTBEAT_WATCHDOG_BATCH = 20;
const SKEW_MS = 30_000;
const MAX_UPTIME_S = 10_000_000;
const MAX_SAVE_ERROR_BYTES = 200;
const SAFE = 9007199254740991;
/** SaveStatus["state"]. */
const SAVE_STATES = ["idle", "saving", "failed"] as const;

const BAD = () => new HttpError("badRequest", "not a heartbeat");

function exactKeys(x: unknown, keys: string): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).sort().join(",") === keys;
}
function int(x: unknown, lo: number, hi: number): x is number {
  return Number.isSafeInteger(x) && (x as number) >= lo && (x as number) <= hi;
}

interface Report {
  uptimeS: number;
  lastTerminalInputMs: number | null;
  lastJupyterActivityMs: number | null;
  gpuUtilPct: number | null;
  gpuMemUsedMiB: number | null;
  idleSinceMs: number | null;
  saveState: string;
  saveLastMs: number | null;
  bytesDone: number | null;
  bytesTotal: number | null;
  saveError: string | null;
  snapshotId: string | null;
  dirtyBytes: number;
}

/** The request in its exact shape, its times between `floorMs` and now (plus skew), else a 400. */
function parseReport(b: Record<string, unknown>, inc: number, floorMs: number, nowMs: number): Report {
  if (!exactKeys(b, "activity,idleSince,incarnation,save,uptimeS") || b.incarnation !== inc || !int(b.uptimeS, 0, MAX_UPTIME_S)) throw BAD();
  const time = (x: unknown): number | null => {
    if (x === null) return null;
    if (typeof x !== "string" || x.length > 40) throw BAD();
    const ms = Date.parse(x);
    if (!Number.isSafeInteger(ms) || toIso(ms) !== x || ms < floorMs || ms > nowMs + SKEW_MS) throw BAD();
    return ms;
  };
  const a = b.activity;
  if (!exactKeys(a, "gpuMemUsedMiB,gpuUtilPct,lastJupyterActivityAt,lastTerminalInputAt")) throw BAD();
  if (a.gpuUtilPct !== null && !int(a.gpuUtilPct, 0, 100)) throw BAD();
  if (a.gpuMemUsedMiB !== null && !int(a.gpuMemUsedMiB, 0, 4 * 1024 * 1024)) throw BAD();
  const s = b.save;
  if (!exactKeys(s, "dirtyBytes,error,lastSavedAt,progress,snapshotId,state")) throw BAD();
  if (typeof s.state !== "string" || !(SAVE_STATES as readonly string[]).includes(s.state) || !int(s.dirtyBytes, 0, SAFE)) throw BAD();
  let bytesDone: number | null = null;
  let bytesTotal: number | null = null;
  if (s.progress !== null) {
    const p = s.progress;
    if (!exactKeys(p, "bytesDone,bytesTotal") || !int(p.bytesTotal, 0, SAFE) || !int(p.bytesDone, 0, p.bytesTotal as number)) throw BAD();
    bytesDone = p.bytesDone;
    bytesTotal = p.bytesTotal as number;
  }
  if (s.error !== null && (typeof s.error !== "string" || s.error.length === 0 || s.error.includes("\0") || new TextEncoder().encode(s.error).length > MAX_SAVE_ERROR_BYTES)) throw BAD();
  if (s.snapshotId !== null && !isId("snapshot", s.snapshotId)) throw BAD();
  return {
    uptimeS: b.uptimeS,
    lastTerminalInputMs: time(a.lastTerminalInputAt),
    lastJupyterActivityMs: time(a.lastJupyterActivityAt),
    gpuUtilPct: a.gpuUtilPct as number | null,
    gpuMemUsedMiB: a.gpuMemUsedMiB as number | null,
    idleSinceMs: time(b.idleSince),
    saveState: s.state,
    saveLastMs: time(s.lastSavedAt),
    bytesDone,
    bytesTotal,
    saveError: s.error as string | null,
    snapshotId: s.snapshotId as string | null,
    dirtyBytes: s.dirtyBytes,
  };
}

/**
 * When a machine incarnation enrolled, or nothing if it never did. A VM's enroll wrote its gate
 * report; a container's used its boot token and set the launch's hard lifetime (max_end_ms is
 * set only by enroll), so the token's use is the enroll time.
 */
async function enrolledAt(ctx: Ctx, mch: string, inc: number): Promise<{ at_ms: number } | undefined> {
  const db = ctx.deps.db;
  const vm = (await db.all<{ at_ms: number }>(`SELECT at_ms FROM gate_reports WHERE machine_id = ? AND incarnation = ?`, [mch, inc]))[0];
  if (vm) return vm;
  return (
    await db.all<{ at_ms: number }>(
      `SELECT b.used_ms AS at_ms FROM launches v JOIN boot_tokens b ON b.machine_id = v.machine_id AND b.incarnation = v.incarnation AND b.mode = 'container'
         WHERE v.machine_id = ? AND v.incarnation = ? AND v.mode = 'container' AND v.max_end_ms IS NOT NULL AND b.used_ms IS NOT NULL`,
      [mch, inc],
    )
  )[0];
}

export const HEARTBEAT_HANDLERS: Handlers = {
  async agentHeartbeat(ctx: Ctx) {
    const { deps } = ctx;
    const c = ctx.agent as AgentClaims;
    const now = deps.now();
    // (the enroll time bounds the report's times from below)
    const enrolled = await enrolledAt(ctx, c.mch, c.inc);
    if (!enrolled) throw new HttpError("unauthenticated", "refused");
    const r = parseReport(ctx.body, c.inc, enrolled.at_ms, now);
    // (in order: the report, only over an older one; the save estimate, only when that report
    // was written: changes() is the statement just before; the due time, only later)
    const stmts: Stmt[] = [
      {
        sql: `INSERT INTO machine_heartbeats (machine_id, incarnation, last_ms, uptime_s, last_terminal_input_ms, last_jupyter_activity_ms, gpu_util_pct, gpu_mem_used_mib,
                idle_since_ms, save_state, save_last_ms, save_bytes_done, save_bytes_total, save_error, save_snapshot_id, dirty_bytes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (machine_id, incarnation) DO UPDATE SET last_ms = excluded.last_ms, uptime_s = excluded.uptime_s,
                last_terminal_input_ms = excluded.last_terminal_input_ms, last_jupyter_activity_ms = excluded.last_jupyter_activity_ms,
                gpu_util_pct = excluded.gpu_util_pct, gpu_mem_used_mib = excluded.gpu_mem_used_mib, idle_since_ms = excluded.idle_since_ms,
                save_state = excluded.save_state, save_last_ms = excluded.save_last_ms, save_bytes_done = excluded.save_bytes_done,
                save_bytes_total = excluded.save_bytes_total, save_error = excluded.save_error, save_snapshot_id = excluded.save_snapshot_id,
                dirty_bytes = excluded.dirty_bytes
              WHERE excluded.last_ms > machine_heartbeats.last_ms`,
        params: [c.mch, c.inc, now, r.uptimeS, r.lastTerminalInputMs, r.lastJupyterActivityMs, r.gpuUtilPct, r.gpuMemUsedMiB, r.idleSinceMs,
          r.saveState, r.saveLastMs, r.bytesDone, r.bytesTotal, r.saveError, r.snapshotId, r.dirtyBytes],
      },
      {
        sql: `UPDATE machines SET save_estimate_seconds = ? WHERE id = ? AND incarnation = ? AND changes() = 1`,
        params: [finalSaveReserveSeconds(r.dirtyBytes), c.mch, c.inc],
      },
      {
        sql: `UPDATE launches SET heartbeat_due_ms = ? WHERE machine_id = ? AND incarnation = ? AND outcome = 'enrolled' AND heartbeat_due_ms < ?`,
        params: [now + HEARTBEAT_LOST_MS, c.mch, c.inc, now + HEARTBEAT_LOST_MS],
      },
    ];
    await deps.db.batch(stmts);
    const out: AgentHeartbeatResponse = { commands: [] };
    // the refresh: exactly when 15 minutes or less are left; never without a ready signer
    const nowS = Math.floor(now / 1000);
    if (c.exp - nowS <= REFRESH_WITHIN_S) {
      const signer = await deps.agentSigner();
      if (!signer) {
        deps.alert("heartbeat: the agent signer isn't ready; no refresh");
      } else {
        const claims: AgentClaims = { v: 1, kind: "agent", jti: base64url(deps.randomBytes(16)), iat: nowS, exp: nowS + AGENT_TOKEN_TTL_S, mch: c.mch, inc: c.inc };
        out.agentToken = await signToken(claims, signer.privateKey, signer.kid);
        out.agentTokenExpiresAt = toIso(claims.exp * 1000);
      }
    }
    return json(200, out);
  },
};

// ---------------------------------------------------------------- the heartbeat watchdog

interface Candidate {
  machine_id: string;
  incarnation: number;
  watchdog_version: number;
  due_ms: number;
  running: number;
}

/**
 * Enrolled launches past their heartbeat due time (silent for more than HEARTBEAT_LOST_MS:
 * since their last heartbeat or, with none yet, their enroll), oldest first, under one bound:
 * a range scan of the due index, each row's machine looked up by its key, so the work examined
 * is the bound, never the fleet. (Exported for its query-plan test.)
 */
export const HEARTBEAT_WATCHDOG_SELECT = `SELECT v.machine_id, v.incarnation, v.watchdog_version, v.heartbeat_due_ms AS due_ms,
       EXISTS (SELECT 1 FROM machines m WHERE m.id = v.machine_id AND m.incarnation = v.incarnation AND m.state = 'running') AS running
     FROM launches v
     WHERE v.outcome = 'enrolled' AND v.heartbeat_due_ms < ?
     ORDER BY v.heartbeat_due_ms, v.machine_id, v.incarnation
     LIMIT ?`;

const TOOK = { sql: `INSERT INTO enroll_guard (ok) SELECT 0 WHERE changes() <> 1`, params: [] };

/**
 * The heartbeat watchdog job: marks each lost machine's launch to terminate (heartbeat-lost);
 * its mode's watchdog then ends it through the provider. Each mark is one batch whose update rechecks
 * what was read (the launch enrolled at its version and due time, the machine running at its
 * incarnation) and fails whole unless it changed exactly that row. A launch whose machine
 * isn't running (saving, stopping, or another incarnation) isn't marked: its due time moves
 * 120 s on, so it leaves the batch's places to others. Returns how many it marked.
 */
export async function runHeartbeatWatchdog(env: JobEnv): Promise<number> {
  const rows = await env.db.all<Candidate>(HEARTBEAT_WATCHDOG_SELECT, [env.now, HEARTBEAT_WATCHDOG_BATCH]);
  let marked = 0;
  for (const r of rows) {
    const running = `EXISTS (SELECT 1 FROM machines WHERE id = ? AND incarnation = ? AND state = 'running')`;
    const same = `machine_id = ? AND incarnation = ? AND outcome = 'enrolled' AND heartbeat_due_ms = ?`;
    if (!r.running) {
      // (deferred; a heartbeat or the machine running again since the read leaves it as it is)
      await env.db.batch([
        {
          sql: `UPDATE launches SET heartbeat_due_ms = ? WHERE ${same} AND NOT ${running}`,
          params: [env.now + HEARTBEAT_LOST_MS, r.machine_id, r.incarnation, r.due_ms, r.machine_id, r.incarnation],
        },
      ]);
      continue;
    }
    try {
      await env.db.batch([
        {
          sql: `UPDATE launches SET outcome = 'terminate', terminate_reason = 'heartbeat-lost', next_ms = ?, watchdog_version = watchdog_version + 1
                WHERE ${same} AND watchdog_version = ? AND ${running}`,
          params: [env.now, r.machine_id, r.incarnation, r.due_ms, r.watchdog_version, r.machine_id, r.incarnation],
        },
        TOOK,
        stopMachineStmt(r.machine_id, r.incarnation), // (a container's machine leaves running; a VM's is left)
      ]);
      marked++;
    } catch {
      // (it changed meanwhile: a heartbeat, a stop or another mark came first; nothing written)
    }
  }
  return marked;
}
