// The one way to an organization's provider key in the clear (BYOK design r3, row 2): read
// one row, open it, hand the key to the caller. There is no bulk-decrypt path, and nothing
// here logs, returns in an error, or stores the key.
//
// A key sealed under an old KEK is re-sealed under the current one as it's opened (a guarded
// update on the row's exact organization, provider, id, version and KEK version, so it never
// touches a newer key; it keeps the version and writes no event). A key that doesn't open (its
// KEK removed, or a ciphertext that isn't this row's) is never replaced by anything: the row is
// marked 'error' (which pauses launches on that provider, #78) with a 'check' event, both under
// the same guard, and the caller gets a refusal.

import type { Db } from "./db.ts";
import { stmt } from "./db.ts";
import { credentialKeys, openSealed, sealCredential, type CredentialKeys } from "./credential-seal.ts";

export interface CredentialSecrets {
  /** The deployment's environment name (in every seal's associated data). */
  env: string;
  CREDENTIAL_KEKS?: string;
  CREDENTIAL_FINGERPRINT_KEY?: string;
}

export type OpenedCredential =
  | { ok: true; key: string; credentialId: string; version: number }
  | { ok: false; reason: "unavailable" | "no-credential" | "paused" | "unopenable" };

/** Whether a stored status lets the key be used: unchecked or ok, and nothing else (a pausing status, or one this code doesn't know). */
export function usableCredentialStatus(status: unknown): boolean {
  return status === "ok" || status === "unchecked";
}

interface Row {
  id: string;
  version: number;
  sealed: string;
  nonce: string;
  kek_version: string;
  status: string;
}

/** The parsed secrets, or null: the store is then unavailable (every route answers checkUnavailable; launches, "unavailable"). */
export function storeKeys(s: CredentialSecrets): Promise<CredentialKeys | null> {
  return credentialKeys(s.CREDENTIAL_KEKS, s.CREDENTIAL_FINGERPRINT_KEY);
}

/** `orgId`'s key for `provider`, in the clear, for one provider call. */
export async function openCredential(db: Db, s: CredentialSecrets, orgId: string, provider: string, nowMs: number): Promise<OpenedCredential> {
  const keys = await storeKeys(s);
  if (!keys) return { ok: false, reason: "unavailable" };
  const rows = await db.all<Row>(
    `SELECT id, version, sealed, nonce, kek_version, status FROM provider_credentials WHERE org_id = ? AND provider = ?`,
    [orgId, provider],
  );
  const r = rows[0];
  if (!r) return { ok: false, reason: "no-credential" };
  if (!usableCredentialStatus(r.status)) return { ok: false, reason: "paused" };
  const ctx = { env: s.env, orgId, provider, credentialId: r.id, version: r.version };
  const key = await openSealed(keys, ctx, { sealed: r.sealed, nonce: r.nonce, kekVersion: r.kek_version });
  const exact = [orgId, provider, r.id, r.version, r.kek_version];
  if (key === null) {
    await db.batch([
      stmt(
        `UPDATE provider_credentials SET status = 'error', last_checked_ms = ? WHERE org_id = ? AND provider = ? AND id = ? AND version = ? AND kek_version = ?`,
        nowMs,
        ...exact,
      ),
      stmt(
        `INSERT INTO credential_events (org_id, provider, credential_id, credential_version, kind, fingerprint, status, actor, at_ms)
         SELECT org_id, provider, id, version, 'check', fingerprint, 'error', NULL, ? FROM provider_credentials
         WHERE changes() = 1 AND org_id = ? AND provider = ? AND id = ? AND version = ?`,
        nowMs,
        orgId,
        provider,
        r.id,
        r.version,
      ),
    ]);
    return { ok: false, reason: "unopenable" };
  }
  if (r.kek_version !== keys.current) {
    const n = await sealCredential(keys, ctx, key);
    await db.run(
      `UPDATE provider_credentials SET sealed = ?, nonce = ?, kek_version = ? WHERE org_id = ? AND provider = ? AND id = ? AND version = ? AND kek_version = ?`,
      [n.sealed, n.nonce, n.kekVersion, ...exact],
    );
  }
  return { ok: true, key, credentialId: r.id, version: r.version };
}
