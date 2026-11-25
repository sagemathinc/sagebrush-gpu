// One error shape for every endpoint: { error: { code, message } }, with a closed set
// of codes. Clients switch on `code`; `message` is for people and may change. One code,
// credentialUnusable, also names the provider, and is the only one that does.

import { isProviderId, type ProviderId } from "./providers.ts";

export const ERROR_STATUS = {
  badRequest: 400,
  unauthenticated: 401,
  forbidden: 403,
  /** The change needs a fresh sign-in (within RECENT_AUTH_WINDOW_MS, see credentials.ts); sign in again with reauth=1. */
  reauthenticate: 403,
  notFound: 404,
  conflict: 409,
  invalidState: 409,
  allocationTooLow: 402,
  budgetExhausted: 402,
  priceCap: 422,
  policy: 422,
  projectEnded: 409,
  projectNotStarted: 409,
  concurrencyCap: 429,
  quotaExceeded: 413,
  rateLimited: 429,
  tokenReused: 401,
  noCapacity: 503,
  /**
   * The organization's own key for a provider is rejected, revoked or failing, so launches
   * there are paused until a check passes again; running machines are untouched. The body
   * names the provider (credentialUnusableBody) and nothing about the key.
   */
  credentialUnusable: 409,
  providerError: 502,
  /** A service we depend on (sign-in's) can't be reached for now; try again. */
  unavailable: 503,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiErrorBody {
  /** `provider` is set exactly when code is "credentialUnusable". */
  error: { code: ErrorCode; message: string; provider?: ProviderId };
}

/** The one message for credentialUnusable: the same for every caller, with no key details. */
export const CREDENTIAL_UNUSABLE_MESSAGE =
  "Launches on this provider are paused for this organization until its key works again.";

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === "string" && Object.hasOwn(ERROR_STATUS, x);
}

export function errorBody(code: ErrorCode, message: string): ApiErrorBody {
  if (code === "credentialUnusable") throw new RangeError("credentialUnusable names its provider: use credentialUnusableBody");
  return { error: { code, message } };
}

export function credentialUnusableBody(provider: ProviderId): ApiErrorBody {
  if (!isProviderId(provider)) throw new RangeError(`not a provider: ${String(provider)}`);
  return { error: { code: "credentialUnusable", message: CREDENTIAL_UNUSABLE_MESSAGE, provider } };
}

export function isApiErrorBody(x: unknown): x is ApiErrorBody {
  if (typeof x !== "object" || x === null) return false;
  const e = (x as { error?: unknown }).error;
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (!isErrorCode(code) || typeof message !== "string") return false;
  if (code === "credentialUnusable") return isProviderId((e as { provider?: unknown }).provider);
  return !Object.hasOwn(e, "provider");
}
