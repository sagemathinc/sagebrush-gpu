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

const NO_BYTES = new Uint8Array(0);

/** How reading a whole reply body ended. */
export type BodyRead = { ok: true; text: string } | { ok: false; why: "too_large" | "unreadable" | "timeout" };

/**
 * A whole reply body, at most `maxBytes`, by `deadline` (a Date.now() time), as strict UTF-8.
 * The bytes are copied into one buffer of our own, grown up to `maxBytes`: no chunk (nor the
 * larger buffer a small chunk may view) is kept, empty chunks cost nothing, and a chunk that would
 * take the body past `maxBytes` is never copied. The read stops, and the stream is cancelled, at
 * that chunk, at the deadline (checked before each read and again on each answer, so a late
 * chunk or a late end is refused too), when the stream fails, and for a body that isn't UTF-8.
 * text() is never called.
 */
export async function readBody(res: HttpResponse, maxBytes: number, deadline: number): Promise<BodyRead> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = (res.body as ReadableStream<Uint8Array>).getReader();
  } catch {
    return { ok: false, why: "unreadable" };
  }
  const timeout: BodyRead = { ok: false, why: "timeout" };
  // The reads, start to end. Its own deadline checks (before each read, and on each answer) refuse
  // a late answer; the single race below ends a read that never answers.
  const pump = async (): Promise<BodyRead> => {
    let buf: Uint8Array | null = null;
    let size = 0;
    for (;;) {
      if (Date.now() >= deadline) return timeout;
      const next = await reader.read();
      if (Date.now() >= deadline) return timeout;
      if (next.done) break;
      const n = next.value.length;
      // Checked before any copy: nothing past maxBytes is ever copied.
      if (n > maxBytes - size) return { ok: false, why: "too_large" };
      if (n === 0) continue;
      const have: number = buf === null ? 0 : buf.length;
      if (size + n > have) {
        const grown: Uint8Array = new Uint8Array(Math.min(maxBytes, Math.max(size + n, 2 * have, 64 * 1024)));
        if (buf !== null) grown.set(buf.subarray(0, size));
        buf = grown;
      }
      (buf as Uint8Array).set(next.value, size);
      size += n;
    }
    try {
      return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(buf === null ? NO_BYTES : buf.subarray(0, size)) };
    } catch {
      return { ok: false, why: "unreadable" };
    }
  };
  // One race for the whole read, so waiting costs one timer and one reaction, however many chunks.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<BodyRead>((ok) => {
    timer = setTimeout(() => ok(timeout), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([pump().catch((): BodyRead => ({ ok: false, why: "unreadable" })), late]);
  } finally {
    clearTimeout(timer);
    // Ends the stream, and with it a pump still waiting on a read.
    reader.cancel().catch(() => {});
  }
}
