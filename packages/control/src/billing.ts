// Whose provider account a provider call uses. The organization's billing mode (stored,
// fixed at creation: migrations/0011) decides: a resold organization uses ours; a byok
// organization uses its own credential (migrations/0016) or nothing, never ours. A new
// launch resolves the organization from the database (machine -> project -> org), never from
// a request; a call about an existing launch resolves the account the launch pinned at its
// intent (account_kind, account_org_id: migrations/0014), never from the machine's current
// owner. An unknown organization or launch, an unset or unknown mode or account, or a byok
// organization without a usable credential (none, or one whose status pauses launches) is a
// refusal. The key itself is opened separately, for the call (credentials.ts).

import { isBillingMode, isProviderId, type ProviderId } from "@sbgpu/api";
import type { Db } from "./db.ts";
import { usableCredentialStatus } from "./credentials.ts";

export type CredentialChoice =
  | { use: "ours"; provider: ProviderId }
  | { use: "org"; provider: ProviderId; orgId: string; credentialId: string; version: number }
  | { use: "none"; reason: "no-such-org" | "no-such-launch" | "unknown-provider" | "no-credential" | "credential-paused" };

interface Held {
  credential_id: string | null;
  credential_version: number | null;
  credential_status: string | null;
}

function orgCredential(orgId: string, provider: ProviderId, c: Held | undefined): CredentialChoice {
  if (!c || c.credential_id === null || c.credential_version === null) return { use: "none", reason: "no-credential" };
  if (!usableCredentialStatus(c.credential_status)) return { use: "none", reason: "credential-paused" };
  return { use: "org", provider, orgId, credentialId: c.credential_id, version: c.credential_version };
}

const HELD = `c.id AS credential_id, c.version AS credential_version, c.status AS credential_status`;

/** The credential for a new provider call on behalf of `orgId`. */
export async function credentialForOrg(db: Db, orgId: string, provider: string): Promise<CredentialChoice> {
  if (!isProviderId(provider)) return { use: "none", reason: "unknown-provider" };
  const r = await db.all<{ billing_mode: unknown } & Held>(
    `SELECT o.billing_mode, ${HELD} FROM orgs o LEFT JOIN provider_credentials c ON c.org_id = o.id AND c.provider = ? WHERE o.id = ?`,
    [provider, orgId],
  );
  const mode = r[0]?.billing_mode;
  if (!isBillingMode(mode)) return { use: "none", reason: "no-such-org" };
  if (mode === "resold") return { use: "ours", provider };
  return orgCredential(orgId, provider, r[0]);
}

/** The credential for a provider call about the launch (`machineId`, `incarnation`): the account it pinned at its intent. */
export async function credentialForLaunch(db: Db, machineId: string, incarnation: number): Promise<CredentialChoice> {
  const r = await db.all<{ provider: unknown; account_kind: unknown; account_org_id: string | null } & Held>(
    `SELECT l.provider, l.account_kind, l.account_org_id, ${HELD} FROM launches l
     LEFT JOIN provider_credentials c ON l.account_kind = 'org' AND c.org_id = l.account_org_id AND c.provider = l.provider
     WHERE l.machine_id = ? AND l.incarnation = ?`,
    [machineId, incarnation],
  );
  const l = r[0];
  if (!l) return { use: "none", reason: "no-such-launch" };
  if (!isProviderId(l.provider)) return { use: "none", reason: "unknown-provider" };
  if (l.account_kind === "platform") return { use: "ours", provider: l.provider };
  if (l.account_kind === "org" && l.account_org_id !== null) return orgCredential(l.account_org_id, l.provider, l);
  return { use: "none", reason: "no-such-launch" };
}
