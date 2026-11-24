// One error shape for every endpoint: { error: { code, message } }, with a closed set
// of codes. Clients switch on `code`; `message` is for people and may change.

export const ERROR_STATUS = {
  badRequest: 400,
  unauthenticated: 401,
  forbidden: 403,
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
  providerError: 502,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === "string" && Object.hasOwn(ERROR_STATUS, x);
}

export function errorBody(code: ErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function isApiErrorBody(x: unknown): x is ApiErrorBody {
  if (typeof x !== "object" || x === null) return false;
  const e = (x as { error?: unknown }).error;
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return isErrorCode(code) && typeof message === "string";
}
