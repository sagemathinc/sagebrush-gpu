// Test support (not a test file): a seeded mock whose requests can be held or failed.

import { createClient } from "../client.ts";
import { mockFetch } from "../mock/fetch.ts";
import { seedDemo } from "../mock/seed.ts";
import type { MockBackend } from "../mock/backend.ts";
import { Store, type StoreOptions } from "./store.ts";

/** Signs `store` in as `email`, as a WorkOS round trip would; the account must be admitted. */
export async function signInAs(store: Store, backend: MockBackend, email: string): Promise<void> {
  if (!backend.signInAs(email)) throw new Error(`the mock refused ${email}`);
  await store.sessionStarted();
}

/**
 * A store whose requests can be held: hold(pattern) makes matching requests wait until
 * release() is called (hold(pattern, true): only the next matching one). The server
 * answers when the request is sent; only the answer's arrival is held, so a held answer
 * can be stale. Every request is logged as "METHOD path".
 */
export async function controllable(email?: string, options: StoreOptions = {}) {
  const demo = seedDemo();
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
  const fetchFn = async (url: string, init: RequestInit) => {
    log.push(`${init.method} ${url}`);
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
    return replaced ? replaced.make() : (answer as Promise<Response>);
  };
  const store = new Store(createClient({ fetch: fetchFn }), () => demo.backend.now(), options);
  await signInAs(store, demo.backend, email ?? demo.emails.member);
  return {
    demo,
    store,
    log,
    otherId: other.id,
    hold(pattern: RegExp, once = false) {
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      held = { pattern, once, gate };
    },
    release() {
      openGate?.();
      openGate = null;
      held = null;
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
