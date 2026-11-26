// Test support (not a test file): a seeded mock whose requests can be held or failed.

import { createClient } from "../client.ts";
import { mockFetch } from "../mock/fetch.ts";
import { seedDemo } from "../mock/seed.ts";
import type { MockBackend } from "../mock/backend.ts";
import { Store, type Prefs, type StoreOptions } from "./store.ts";

/** Signs `store` in as `email`, as a WorkOS round trip would; the account must be admitted. */
export async function signInAs(store: Store, backend: MockBackend, email: string): Promise<void> {
  if (!backend.signInAs(email)) throw new Error(`the mock refused ${email}`);
  await store.sessionStarted();
}

/** Preferences kept in memory only (each test its own). */
export function memoryPrefs(): Prefs {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

/**
 * A store whose requests can be held: hold(pattern) makes matching requests wait until
 * release() is called (hold(pattern, true): only the next matching one). The server
 * answers when the request is sent; only the answer's arrival is held, so a held answer
 * can be stale. Every request is logged as "METHOD path".
 *
 * The provider keys' own request path (credentialFetch) goes to the same mock, held and
 * logged the same way, and is logged as "KEYS METHOD path". Its held answer is dropped with
 * an AbortError when its signal aborts, unless abortWins is false (then the answer still
 * arrives, as when it wins the race with the abort). clientBodies records every body the
 * shared client sends; the keys' path never shows up there. The reauth window runs on a
 * monotonic clock (mono, advanceMono) and its own fake timers (keyTimers).
 */
export async function controllable(email?: string, options: StoreOptions = {}, seed: Parameters<typeof seedDemo>[0] = {}) {
  const demo = seedDemo(seed);
  const other = demo.backend.addProject(demo.orgId, {
    name: "Second project",
    budget: 100_000_000,
    startsAt: "2027-01-01T00:00:00.000Z",
    endsAt: "2027-12-01T00:00:00.000Z",
    policy: { allowedGpuTypes: ["A6000"], allowedProviders: ["runpod"] },
  });
  const ada = [...demo.backend.users.values()].find((u) => u.email === demo.emails.member)!;
  demo.backend.addMember(other.id, { email: ada.email, userId: ada.id, allocation: 5_000_000 });
  const inner = mockFetch(demo.backend);
  const log: string[] = [];
  let held: { pattern: RegExp; once: boolean; gate: Promise<void> } | null = null;
  let openGate: (() => void) | null = null;
  let failNext: Error | null = null;
  let override: { pattern: RegExp; make: () => Response } | null = null;
  /** Independent one-shot holds (gate()): each holds the next matching request until its own release. */
  const gates: Array<{ pattern: RegExp; gate: Promise<void> }> = [];
  const clientBodies: string[] = [];
  const signals: AbortSignal[] = [];
  let abortWins = true;
  const fetchFn = (url: string, init: RequestInit) => {
    if (typeof init.body === "string") clientBodies.push(init.body);
    return send(url, init, `${init.method} ${url}`);
  };
  const credentialFetch = (url: string, init: RequestInit) => {
    if (init.signal) signals.push(init.signal);
    const answer = send(url, init, `KEYS ${init.method} ${url}`);
    const signal = init.signal;
    if (!signal || !abortWins) return answer;
    // As fetch does: an abort drops the answer still to come.
    return new Promise<Response>((resolve, reject) => {
      const aborted = () => reject(new DOMException("aborted", "AbortError"));
      if (signal.aborted) return aborted();
      signal.addEventListener("abort", aborted, { once: true });
      answer.then(resolve, reject);
    });
  };
  const send = async (url: string, init: RequestInit, entry: string) => {
    log.push(entry);
    if (failNext) {
      const err = failNext;
      failNext = null;
      throw err;
    }
    const key = `${init.method} ${url}`;
    const replaced = override && override.pattern.test(key) ? override : null;
    if (replaced) override = null;
    const answer = replaced ? null : inner(url, init); // computed now, as a server would
    if (held && held.pattern.test(key)) {
      const gate = held.gate;
      if (held.once) held = null;
      await gate;
    }
    const one = gates.findIndex((g) => g.pattern.test(key));
    if (one >= 0) {
      const [g] = gates.splice(one, 1);
      await g!.gate;
    }
    return replaced ? replaced.make() : (answer as Promise<Response>);
  };
  let mono = 1_000_000;
  const keyTimers = new FakeTimers();
  const store = new Store(createClient({ fetch: fetchFn }), () => demo.backend.now(), {
    credentialFetch,
    monotonic: () => mono,
    timers: keyTimers,
    prefs: memoryPrefs(),
    ...options,
  });
  await signInAs(store, demo.backend, email ?? demo.emails.member);
  return {
    demo,
    store,
    log,
    otherId: other.id,
    clientBodies,
    /** The signals the keys' path was given, in order. */
    signals,
    keyTimers,
    mono: () => mono,
    advanceMono(ms: number) {
      mono += ms;
    },
    /** Whether a held keys answer still arrives after its abort (false: it wins the race). */
    set abortWins(v: boolean) {
      abortWins = v;
    },
    hold(pattern: RegExp, once = false) {
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      held = { pattern, once, gate };
    },
    release() {
      openGate?.();
      openGate = null;
      held = null;
    },
    /** Hold the next request matching `pattern` (independently of hold()); call the result to let it answer. */
    gate(pattern: RegExp): () => void {
      let open: () => void = () => {};
      gates.push({ pattern, gate: new Promise<void>((resolve) => (open = resolve)) });
      return () => open();
    },
    failOnce(err: Error) {
      failNext = err;
    },
    /** The next request matching `pattern` gets make()'s answer (or its throw) instead. */
    respondOnce(pattern: RegExp, make: () => Response) {
      override = { pattern, make };
    },
  };
}


/** Timers the test drives: nothing runs until run(). */
export class FakeTimers {
  #next = 1;
  readonly pending = new Map<number, { fn: () => unknown; ms: number }>();
  readonly cleared: number[] = [];

  readonly setTimeout = (fn: () => unknown, ms: number): unknown => {
    const id = this.#next++;
    this.pending.set(id, { fn, ms });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.cleared.push(handle as number);
    this.pending.delete(handle as number);
  };

  /** The delays of the pending timers. */
  delays(): number[] {
    return [...this.pending.values()].map((t) => t.ms);
  }

  /** Run the oldest pending timer and wait for what it started. */
  async run(): Promise<void> {
    const first = this.pending.entries().next();
    if (first.done) throw new Error("no timer pending");
    const [id, t] = first.value;
    this.pending.delete(id);
    await t.fn();
  }
}
