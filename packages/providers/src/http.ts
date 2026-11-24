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
