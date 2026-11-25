// The slice of fetch the adapters use. The Worker passes its global fetch; tests pass a mock,
// so no test ever reaches a provider.

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type Fetch = (url: string, init: HttpRequest) => Promise<HttpResponse>;

/** Retry-After in seconds (the delta form; an HTTP date gives null). */
export function retryAfterSeconds(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,6}$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** The exception names fetch and AbortSignal.timeout throw; any other name reads as "error". */
const FAILURE_NAMES = new Set(["AbortError", "TimeoutError", "TypeError"]);

/**
 * A fetch failure's name for an error message: one of a fixed few, never the exception's own
 * text, since a custom fetch (or anything below it) could put request values in its name.
 */
export function failureName(e: unknown): string {
  return e instanceof Error && FAILURE_NAMES.has(e.name) ? e.name : "error";
}
