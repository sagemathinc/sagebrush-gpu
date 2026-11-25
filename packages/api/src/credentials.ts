// An organization's own provider keys (billing mode "byok"): what the credential routes
// carry, the one check of a key's shape that the server and the page share, the window
// after a fresh sign-in in which keys may change, and the fixed words of every refusal on
// those routes. The key itself goes one way only, in a PUT's body: no response, error or
// status ever carries it.

import type { ApiErrorBody, ErrorCode } from "./errors.ts";
import type { ProviderId } from "./providers.ts";
import type { IsoTime } from "./time.ts";

/**
 * How long after a fresh sign-in (WorkOS, with the organization's MFA) an owner may change
 * its keys. GET /v1/me's `recentAuthForMs` is never above it.
 */
export const RECENT_AUTH_WINDOW_MS = 300_000;

/**
 * Whether `x` is a usable `recentAuthForMs`: an integer from 0 to RECENT_AUTH_WINDOW_MS.
 * Anything else (null, missing, NaN, infinite, negative, fractional, larger) means the
 * window is closed.
 */
export function isRecentAuthForMs(x: unknown): x is number {
  return Number.isInteger(x) && (x as number) >= 0 && (x as number) <= RECENT_AUTH_WINDOW_MS;
}

/** The most bytes a key may have. */
export const CREDENTIAL_KEY_MAX_BYTES = 4096;

/**
 * Whether `x` has a key's shape: a string of 1 to CREDENTIAL_KEY_MAX_BYTES characters, each
 * printable ASCII other than a space (0x21 to 0x7E), so its characters are its bytes. The
 * server refuses anything else before any other step (badShape), and the page doesn't send it.
 */
export function isCredentialKeyShape(x: unknown): x is string {
  return typeof x === "string" && x.length <= CREDENTIAL_KEY_MAX_BYTES && /^[\x21-\x7e]+$/.test(x); // (+: at least one)
}

/**
 * Where a provider's key stands:
 *   none       no key is set
 *   unchecked  set, and its check hasn't run yet
 *   ok         its last check passed
 *   rejected   the provider refused it at its last check
 *   revoked    the provider says it was revoked
 *   error      its last check couldn't complete
 */
export const CREDENTIAL_STATUSES = Object.freeze(["none", "unchecked", "ok", "rejected", "revoked", "error"] as const);
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export function isCredentialStatus(x: unknown): x is CredentialStatus {
  return (CREDENTIAL_STATUSES as readonly unknown[]).includes(x);
}

/** One provider's key, as the routes show it: never the key, only facts about it. */
export interface ProviderCredential {
  /** One of the providers the server accepts keys for; the server decides which it lists. */
  provider: ProviderId;
  status: CredentialStatus;
  /** A nonsecret fingerprint of the key (a truncated HMAC under a separate secret); null when none is set. */
  fingerprint: string | null;
  /** The email of the owner who set it; null when none is set. */
  setBy: string | null;
  setAt: IsoTime | null;
  lastCheckedAt: IsoTime | null;
  /** The organization's machines on this provider that aren't terminated (for the removal warning). */
  runningMachines: number;
}

/** PUT /v1/orgs/:orgId/credentials/:provider: set or replace the key, checked before the answer. */
export interface PutCredentialRequest {
  key: string;
}

/**
 * Every refusal on the credential routes, each with its code and its fixed words. The server
 * answers only these on those routes, and none of the words contain, or are built from, a
 * submitted value. The page shows its own words for each (and never a server message).
 */
export const CREDENTIAL_REFUSALS = Object.freeze({
  badShape: {
    code: "badRequest",
    message: "A key is 1 to 4096 characters, each a printable ASCII character other than a space.",
  },
  rejected: {
    code: "badRequest",
    message: "The provider refused this key. Nothing was saved.",
  },
  checkUnavailable: {
    code: "unavailable",
    message: "The provider couldn't be reached to check this key. Nothing was saved.",
  },
  notOwner: {
    code: "forbidden",
    message: "Only an owner of this organization can see or change its provider keys.",
  },
  notByok: {
    code: "forbidden",
    message: "This organization uses our provider accounts, so it has no keys of its own.",
  },
  reauthenticate: {
    code: "reauthenticate",
    message: "Confirm it's you again to change provider keys.",
  },
  unknownProvider: {
    code: "notFound",
    message: "Keys for this provider aren't accepted.",
  },
  noKey: {
    code: "notFound",
    message: "No key is set for this provider.",
  },
} as const satisfies Record<string, { code: ErrorCode; message: string }>);
export type CredentialRefusal = keyof typeof CREDENTIAL_REFUSALS;

export function credentialRefusalBody(refusal: CredentialRefusal): ApiErrorBody {
  const { code, message } = CREDENTIAL_REFUSALS[refusal];
  return { error: { code, message } };
}
