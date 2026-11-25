// The slice of fetch the adapters use. The Worker passes its global fetch; tests pass a mock,
// so no test ever reaches a provider.

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * Always "manual": a redirect is never followed, so no header (an API key) reaches a second
   * origin. Workers don't implement "error" (it throws), so "manual" is the one mode for every
   * runtime, and callers refuse the 3xx (or a browser's status-0 opaque redirect) as a non-2xx.
   */
  redirect: "manual";
}

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** The body as a stream, for a bounded read (readPrefix). */
  body?: ReadableStream<Uint8Array> | null;
}

/** A 2xx status. Anything else, a redirect or a status 0 included, is a failure. */
export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * At most `maxBytes` of a response body, as text, for classifying an error reply; the rest is
 * never read (the stream is cancelled). Without a stream, or if reading fails, it is "". Nothing
 * past `maxBytes` is copied or kept: one buffer of `maxBytes`, filled from views of each chunk.
 */
export async function readPrefix(res: HttpResponse, maxBytes: number): Promise<string> {
  let reader;
  try {
    // No stream (undefined or null), a locked one, or not a stream at all: no prefix.
    reader = (res.body as ReadableStream<Uint8Array>).getReader();
  } catch {
    return "";
  }
  const buf = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (size < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      // A view, not a copy: only the bytes still needed are copied into buf.
      const take = next.value.subarray(0, maxBytes - size);
      buf.set(take, size);
      size += take.length;
    }
  } catch {
    return "";
  } finally {
    reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(buf.subarray(0, size));
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
  try {
    if (!(e instanceof Error)) return "error";
    // Read the name once: a getter could answer differently on a second read.
    const name: unknown = e.name;
    // Return our own constant, never the value read.
    for (const fixed of FAILURE_NAMES) if (fixed === name) return fixed;
  } catch {
    // A throwing getter (or a proxy that throws on instanceof) names nothing.
  }
  return "error";
}
