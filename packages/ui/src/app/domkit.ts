// Test support (not a test file): a happy-dom window for mounting the real App, with
// Preact's effects run promptly.

import { Window } from "happy-dom";
import { options, render } from "preact";
import { App, html, type Nav } from "./components.ts";
import type { FakeTimers } from "./testkit.ts";
import type { Store } from "./store.ts";

export function installDom(): Window {
  const win = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, { window: win, document: win.document });
  // Preact runs effects after the next frame; without requestAnimationFrame that waits up
  // to 100 ms. Run them on the next tick instead.
  (options as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame = (cb) => void setTimeout(cb, 0);
  return win;
}

/** Let promises and Preact's deferred renders settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Pages mounted and not yet unmounted: a test file's afterEach unmounts them (unmountAll). */
const mounted = new Set<() => void>();

/** Unmount whatever a test left mounted (also when it failed half-way). */
export function unmountAll(): void {
  for (const unmount of [...mounted]) unmount();
}

export function mountApp(win: Window, store: Store, path: string, timers: FakeTimers) {
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  const nav = (p: string): Nav => ({ path: p, search: "", go: () => {} });
  const show = (p: string) => render(html`<${App} store=${store} nav=${nav(p)} timers=${timers} />`, root as unknown as Element);
  show(path);
  function unmount() {
    if (!mounted.delete(unmount)) return;
    render(null, root as unknown as Element);
    root.remove();
  }
  mounted.add(unmount);
  const q = <T = HTMLElement>(sel: string) => root.querySelector(sel) as unknown as T | null;
  const qa = <T = HTMLElement>(sel: string) => [...root.querySelectorAll(sel)] as unknown as T[];
  return {
    root,
    q,
    qa,
    /** The visible text: text within an element joins as written; elements are set apart by spaces. */
    text: () => {
      type N = { nodeType: number; textContent: string | null; childNodes: ArrayLike<unknown> };
      const walk = (n: N): string =>
        Array.from(n.childNodes)
          .map((c) => ((c as N).nodeType === 3 ? ((c as N).textContent ?? "") : ` ${walk(c as N)} `))
          .join("");
      return walk(root as unknown as N).replace(/\s+/g, " ").trim();
    },
    show,
    unmount,
    button: (label: string | RegExp) =>
      qa<HTMLButtonElement>("button").find((b) => (typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""))) ?? null,
    /** Type into an input or textarea as a person would (value, then an input event). */
    type(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
      if (el == null) throw new Error("no such field");
      el.value = value;
      el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    },
    blur(el: HTMLElement | null) {
      el?.dispatchEvent(new win.Event("blur") as unknown as Event);
    },
    change(el: HTMLElement | null) {
      el?.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    },
  };
}
