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

/** How reading a whole reply body ended. */
export type BodyRead = { ok: true; text: string } | { ok: false; why: "too_large" | "unreadable" | "timeout" };

/**
 * A whole reply body, at most `maxBytes`, by `deadline` (a Date.now() time), as strict UTF-8.
 * A chunk that would take the body past `maxBytes` is never kept or copied: the read stops and
 * the stream is cancelled. So does a body still open at the deadline (a stalled stream), one that
 * can't be read, or one that isn't UTF-8. text() is never called.
 */
export async function readBody(res: HttpResponse, maxBytes: number, deadline: number): Promise<BodyRead> {
  let reader;
  try {
    reader = (res.body as ReadableStream<Uint8Array>).getReader();
  } catch {
    return { ok: false, why: "unreadable" };
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((ok) => {
    timer = setTimeout(() => ok("late"), Math.max(0, deadline - Date.now()));
  });
  try {
    for (;;) {
      // Checked before every read too: a chunk that is always ready can't outrun the deadline.
      if (Date.now() >= deadline) return { ok: false, why: "timeout" };
      const next = await Promise.race([reader.read(), late]);
      if (next === "late") return { ok: false, why: "timeout" };
      if (next.done) break;
      // Checked before the chunk is kept: nothing past maxBytes is ever held or copied.
      if (next.value.length > maxBytes - size) return { ok: false, why: "too_large" };
      parts.push(next.value);
      size += next.value.length;
    }
  } catch {
    return { ok: false, why: "unreadable" };
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(all) };
  } catch {
    return { ok: false, why: "unreadable" };
  }
}
