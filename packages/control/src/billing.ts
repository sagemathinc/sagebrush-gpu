// Whose provider account a provider call uses. The organization's billing mode (stored,
// fixed at creation: migrations/0011) decides: a resold organization uses ours; a byok
// organization uses its own credential or nothing, never ours. Every call resolves the
// organization from the database (machine -> project -> org), never from a request. An
// unknown organization, an unset or unknown mode, or a byok organization without a usable
// credential is a refusal. (The credential store comes later: until then byok refuses.)

import { isBillingMode, isProviderId, type ProviderId } from "@sbgpu/api";
import type { Db } from "./db.ts";

export type CredentialChoice =
  | { use: "ours"; provider: ProviderId }
  | { use: "none"; reason: "no-such-org" | "unknown-provider" | "byok-unavailable" };

function choose(mode: unknown, provider: string): CredentialChoice {
  if (!isProviderId(provider)) return { use: "none", reason: "unknown-provider" };
  if (!isBillingMode(mode)) return { use: "none", reason: "no-such-org" };
  if (mode === "resold") return { use: "ours", provider };
  return { use: "none", reason: "byok-unavailable" };
}

/** The credential for a provider call on behalf of `orgId`. */
export async function credentialForOrg(db: Db, orgId: string, provider: string): Promise<CredentialChoice> {
  const r = await db.all<{ billing_mode: unknown }>(`SELECT billing_mode FROM orgs WHERE id = ?`, [orgId]);
  return choose(r[0]?.billing_mode, provider);
}

/** The credential for a provider call about `machineId`, through its project's organization. */
export async function credentialForMachine(db: Db, machineId: string, provider: string): Promise<CredentialChoice> {
  const r = await db.all<{ billing_mode: unknown }>(
    `SELECT o.billing_mode FROM machines m JOIN projects p ON p.id = m.project_id JOIN orgs o ON o.id = p.org_id WHERE m.id = ?`,
    [machineId],
  );
  return choose(r[0]?.billing_mode, provider);
}
