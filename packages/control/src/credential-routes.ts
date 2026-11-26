// The credential routes (BYOK design r3, row 5; SEC clear): an organization's provider keys,
// listed, set or replaced, and removed, by its owners, for a byok organization only. Every
// refusal is one of CREDENTIAL_REFUSALS (app.ts maps anything else), and nothing ever carries
// the key: no response, error, alert or stored row but its sealed form (credentials.ts).
//
// Every set, replace and remove is one D1 batch, in this order:
//   1. use the assurance (credential-assurance.ts): one conditional UPDATE on every binding,
//      then the guard, so with no live assurance nothing in the batch applies;
//   2. the scoped compare-and-swap: a set inserts into the absent (org, provider) slot
//      (ON CONFLICT DO NOTHING); a replace or remove names the exact key it read
//      (org_id, provider, id and version);
//   3. the event, if and only if the swap changed exactly one row (changes() = 1).
// No guard follows the swap: a swap that loses commits the used assurance (no replay) and
// nothing else, and the answer is busy. The handler reads statement 2's change count; a
// database error fails the whole batch, answered checkUnavailable, never a success.
//
// Every predicate carries the authority scope: the organization the session was authorized
// for and the validated route provider. An id from another organization or provider matches
// nothing. Events take their fields from that context and the changed row, never from the
// request; a removal's event, from the row read just before it (the same id and version as
// the delete's predicate, and so the same key: the fingerprint is fixed per version).
//
// The provider check (row 3) is injected: a read-only status, never a write. Only an ok check
// saves; any other result still uses the assurance, and keeps the previous key exactly.

import {
  isCredentialExpected,
  isCredentialKeyShape,
  isId,
  isProviderId,
  newId,
  parseCredentialVersionQuery,
  toIso,
  type CredentialExpected,
  type ProviderCredential,
  type ProviderId,
} from "@sbgpu/api";
import type { Ctx, Handlers } from "./app.ts";
import { stmt, type Db, type Stmt } from "./db.ts";
import { json } from "./http.ts";
import { credentialFingerprint, sealCredential } from "./credential-seal.ts";
import { storeKeys } from "./credentials.ts";
import { consumeAssurance, credentialRefusal, liveAssurance, reserveCheck, type AssuranceBinding } from "./credential-assurance.ts";
import { listTotpFactors } from "./workos.ts";

export const PUT_MAX_BODY_BYTES = 8 * 1024;

/** Row 3's provider check of a key, injected: the providers the server accepts keys for, and a read-only status. */
export interface CredentialCheck {
  providers: readonly ProviderId[];
  check(provider: ProviderId, key: string): Promise<"ok" | "rejected" | "revoked" | "error">;
}

const GUARD = /CHECK constraint failed: ok = 1/;

/** The route's provider, if the server accepts keys for it (unknownProvider otherwise). */
function routeProvider(ctx: Ctx): ProviderId {
  const p = ctx.params.provider;
  const accepted = ctx.deps.credentialCheck?.providers ?? [];
  if (!isProviderId(p) || !accepted.includes(p)) throw credentialRefusal("unknownProvider");
  return p;
}

async function requireByok(db: Db, orgId: string): Promise<void> {
  const r = await db.all<{ billing_mode: string }>(`SELECT billing_mode FROM orgs WHERE id = ?`, [orgId]);
  if (r[0]?.billing_mode !== "byok") throw credentialRefusal("notByok");
}

/** The store's keys, or checkUnavailable with an alert (a malformed or missing secret: never a partial or default key). */
async function requireStore(ctx: Ctx) {
  const keys = await storeKeys({ env: ctx.deps.config.appOrigin, CREDENTIAL_KEKS: ctx.deps.config.credentialKeks, CREDENTIAL_FINGERPRINT_KEY: ctx.deps.config.credentialFingerprintKey });
  if (!keys) {
    ctx.deps.alert("credential store unavailable: CREDENTIAL_KEKS or CREDENTIAL_FINGERPRINT_KEY is missing or malformed");
    throw credentialRefusal("checkUnavailable");
  }
  return keys;
}

/**
 * The binding a change's assurance must match, with the user's one TOTP factor as WorkOS lists
 * it now (a reset or removed factor: mfaRequired; WorkOS unreachable: checkUnavailable).
 */
async function bindingNow(ctx: Ctx, orgId: string): Promise<AssuranceBinding> {
  const a = ctx.deps.config.auth;
  if (!a) throw credentialRefusal("checkUnavailable");
  const userId = ctx.userId as string;
  const id = await ctx.deps.db.all<{ sub: string }>(`SELECT sub FROM identities WHERE user_id = ? AND iss = ?`, [userId, a.workos.issuer]);
  const sub = id[0]?.sub;
  if (!sub) throw credentialRefusal("reauthenticate");
  const f = await listTotpFactors(a.workos, sub, ctx.deps.fetch);
  if (!f.ok) throw credentialRefusal("checkUnavailable");
  if (f.totp.length !== 1) throw credentialRefusal("mfaRequired");
  return { sessionHash: ctx.sessionHash as string, userId, orgId, env: a.workos.env, clientId: a.workos.clientId, factorId: f.totp[0]! };
}

interface Row {
  provider: string;
  id: string;
  version: number;
  status: string;
  fingerprint: string;
  set_ms: number;
  last_checked_ms: number | null;
  email: string | null;
}

async function views(db: Db, orgId: string, providers: readonly ProviderId[]): Promise<ProviderCredential[]> {
  const rows = await db.all<Row>(
    `SELECT c.provider, c.id, c.version, c.status, c.fingerprint, c.set_ms, c.last_checked_ms, u.email
     FROM provider_credentials c LEFT JOIN users u ON u.id = c.set_by WHERE c.org_id = ?`,
    [orgId],
  );
  // (the organization's own-account launches that aren't terminated, by the account each pinned at its intent, not by ownership)
  const running = await db.all<{ provider: string; n: number }>(
    `SELECT provider, COUNT(*) AS n FROM launches WHERE account_kind = 'org' AND account_org_id = ? AND outcome <> 'terminated' GROUP BY provider`,
    [orgId],
  );
  return providers.map((provider) => {
    const r = rows.find((x) => x.provider === provider);
    const runningMachines = running.find((x) => x.provider === provider)?.n ?? 0;
    if (!r) return { provider, id: null, version: null, status: "none", fingerprint: null, setBy: null, setAt: null, lastCheckedAt: null, runningMachines };
    return {
      provider,
      id: r.id,
      version: r.version,
      status: r.status as ProviderCredential["status"],
      fingerprint: r.fingerprint,
      setBy: r.email,
      setAt: toIso(r.set_ms),
      lastCheckedAt: r.last_checked_ms === null ? null : toIso(r.last_checked_ms),
      runningMachines,
    };
  });
}

/** Runs a change's batch; true if its swap changed one row. The guard's abort (no live assurance) is reauthenticate. */
async function commit(db: Db, stmts: Stmt[]): Promise<boolean> {
  let r: { changes: number }[];
  try {
    r = await db.batch(stmts);
  } catch (e) {
    if (e instanceof Error && GUARD.test(e.message)) throw credentialRefusal("reauthenticate");
    throw credentialRefusal("checkUnavailable");
  }
  return r[2]?.changes === 1;
}

export const CREDENTIAL_HANDLERS: Handlers = {
  async listCredentials(ctx: Ctx) {
    const orgId = ctx.params.orgId as string;
    await requireByok(ctx.deps.db, orgId);
    await requireStore(ctx);
    return json(200, { items: await views(ctx.deps.db, orgId, ctx.deps.credentialCheck?.providers ?? []) });
  },

  /**
   * In order: the body (at most 8 KiB, before parsing; then the key's shape: badShape; then
   * exactly { key, expected } with a well-formed expected: badExpected); the provider
   * (unknownProvider); an owner (notOwner, by the route's access) of a byok organization
   * (notByok); the store (checkUnavailable); a live assurance (reauthenticate, mfaRequired);
   * one unit of the check quota (tooManyChecks); the provider's check. Then the batch.
   */
  async putCredential(ctx: Ctx) {
    const { deps } = ctx;
    const key = ctx.body.key;
    if (!isCredentialKeyShape(key)) throw credentialRefusal("badShape");
    const names = Object.keys(ctx.body);
    const expected = ctx.body.expected;
    if (names.length !== 2 || !names.includes("expected") || !isCredentialExpected(expected)) throw credentialRefusal("badExpected");
    const provider = routeProvider(ctx);
    const orgId = ctx.params.orgId as string;
    await requireByok(deps.db, orgId);
    const store = await requireStore(ctx);
    const binding = await bindingNow(ctx, orgId);
    if (!(await liveAssurance(deps.db, binding, deps.now()))) throw credentialRefusal("reauthenticate");
    if (!(await reserveCheck(deps.db, orgId, deps.now()))) throw credentialRefusal("tooManyChecks");
    let status: "ok" | "rejected" | "revoked" | "error";
    try {
      status = await deps.credentialCheck!.check(provider, key);
    } catch {
      status = "error";
    }
    if (status !== "ok") {
      // (the assurance is used all the same; no credential or event is written)
      await deps.db.batch(consumeAssurance(binding, deps.now())).catch(() => {});
      throw credentialRefusal(status === "rejected" || status === "revoked" ? "rejected" : "checkUnavailable");
    }
    const e = expected as CredentialExpected | null;
    const id = e ? e.id : newId("credential");
    const version = e ? e.version + 1 : 1;
    const sealed = await sealCredential(store, { env: deps.config.appOrigin, orgId, provider, credentialId: id, version }, key);
    const fingerprint = await credentialFingerprint(store, key);
    const at = deps.now();
    const userId = ctx.userId as string;
    const swap = e
      ? stmt(
          `UPDATE provider_credentials SET version = version + 1, sealed = ?, nonce = ?, kek_version = ?, fingerprint = ?, status = 'ok', last_checked_ms = ?, set_by = ?, set_ms = ?
           WHERE org_id = ? AND provider = ? AND id = ? AND version = ?`,
          sealed.sealed, sealed.nonce, sealed.kekVersion, fingerprint, at, userId, at, orgId, provider, e.id, e.version,
        )
      : stmt(
          `INSERT INTO provider_credentials (id, org_id, provider, version, sealed, nonce, kek_version, fingerprint, status, last_checked_ms, set_by, set_ms)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'ok', ?, ?, ?) ON CONFLICT (org_id, provider) DO NOTHING`,
          id, orgId, provider, sealed.sealed, sealed.nonce, sealed.kekVersion, fingerprint, at, userId, at,
        );
    const event = stmt(
      `INSERT INTO credential_events (org_id, provider, credential_id, credential_version, kind, fingerprint, status, actor, at_ms)
       SELECT org_id, provider, id, version, ?, fingerprint, NULL, ?, ? FROM provider_credentials
       WHERE changes() = 1 AND org_id = ? AND provider = ? AND id = ? AND version = ?`,
      e ? "replace" : "set", userId, at, orgId, provider, id, version,
    );
    if (!(await commit(deps.db, [...consumeAssurance(binding, at), swap, event]))) throw credentialRefusal("busy");
    const v = (await views(deps.db, orgId, [provider]))[0]!;
    return json(200, v);
  },

  /**
   * In order: the query (?id=&version= naming a key: badExpected); the provider; an owner of a
   * byok organization; the store; the key as listed (none: noKey; another: busy, nothing used);
   * a live assurance. Then the batch. Removal never calls the provider: no quota (break-glass).
   */
  async deleteCredential(ctx: Ctx) {
    const { deps } = ctx;
    const id = ctx.query.get("id");
    const version = parseCredentialVersionQuery(ctx.query.get("version"));
    if (!isId("credential", id) || version === null) throw credentialRefusal("badExpected");
    const provider = routeProvider(ctx);
    const orgId = ctx.params.orgId as string;
    await requireByok(deps.db, orgId);
    await requireStore(ctx);
    const cur = await deps.db.all<{ id: string; version: number; fingerprint: string }>(
      `SELECT id, version, fingerprint FROM provider_credentials WHERE org_id = ? AND provider = ?`,
      [orgId, provider],
    );
    const c = cur[0];
    if (!c) throw credentialRefusal("noKey");
    if (c.id !== id || c.version !== version) throw credentialRefusal("busy");
    const binding = await bindingNow(ctx, orgId);
    const at = deps.now();
    if (!(await liveAssurance(deps.db, binding, at))) throw credentialRefusal("reauthenticate");
    const swap = stmt(`DELETE FROM provider_credentials WHERE org_id = ? AND provider = ? AND id = ? AND version = ?`, orgId, provider, c.id, c.version);
    const event = stmt(
      `INSERT INTO credential_events (org_id, provider, credential_id, credential_version, kind, fingerprint, status, actor, at_ms)
       SELECT ?, ?, ?, ?, 'remove', ?, NULL, ?, ? WHERE changes() = 1`,
      orgId, provider, c.id, c.version, c.fingerprint, ctx.userId as string, at,
    );
    if (!(await commit(deps.db, [...consumeAssurance(binding, at), swap, event]))) throw credentialRefusal("busy");
    return json(200, { removed: true });
  },
};

/**
 * The scheduled check's record (later, with the pause): a status, only on the exact key it
 * checked (org, provider, id and version read before its provider call), with a check event
 * in the same batch. An older check never marks a newer key. True if it recorded.
 */
export async function recordCheck(db: Db, k: { orgId: string; provider: string; id: string; version: number }, status: "ok" | "rejected" | "revoked" | "error", nowMs: number): Promise<boolean> {
  const r = await db.batch([
    stmt(`UPDATE provider_credentials SET status = ?, last_checked_ms = ? WHERE org_id = ? AND provider = ? AND id = ? AND version = ?`, status, nowMs, k.orgId, k.provider, k.id, k.version),
    stmt(
      `INSERT INTO credential_events (org_id, provider, credential_id, credential_version, kind, fingerprint, status, actor, at_ms)
       SELECT org_id, provider, id, version, 'check', fingerprint, ?, NULL, ? FROM provider_credentials
       WHERE changes() = 1 AND org_id = ? AND provider = ? AND id = ? AND version = ?`,
      status, nowMs, k.orgId, k.provider, k.id, k.version,
    ),
  ]);
  return r[0]?.changes === 1;
}
