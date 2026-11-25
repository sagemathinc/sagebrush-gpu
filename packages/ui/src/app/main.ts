// The browser entry point. The production build sets SBGPU_MOCK to false, so the mock
// backend and its demo data are dropped from the bundle; the demo build (?mock=1) runs
// the whole API in the page against a fake clock.

import { render } from "preact";
import { signal } from "@preact/signals";
import { createClient, type FetchFn } from "../client.ts";
import { Store } from "./store.ts";
import { App, html, type DemoAccount, type Nav } from "./components.ts";

declare const SBGPU_MOCK: boolean;

async function boot(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  let fetchFn: FetchFn | undefined;
  let now: () => number = Date.now;
  let demoAccounts: DemoAccount[] | undefined;
  let search = "";
  let devTerminal: { url: string; token: string } | undefined;

  if (SBGPU_MOCK && params.get("mock") === "1") {
    const { seedDemo } = await import("../mock/seed.ts");
    const { mockFetch } = await import("../mock/fetch.ts");
    const demo = seedDemo();
    fetchFn = mockFetch(demo.backend);
    now = () => demo.backend.now();
    const account = (label: string, email: string): DemoAccount => ({ label, email, token: `mock:${email}` });
    demoAccounts = [
      account("A member", demo.emails.member),
      account("A member low on allocation", demo.emails.lowMember),
      account("A manager", demo.emails.manager),
      account("An assistant", demo.emails.assistant),
      account("The owner", demo.emails.owner),
    ];
    // Fake seconds per real second; the default makes a boot take 9 s and a minute 6 s.
    const speed = Math.max(1, Math.min(600, Number(params.get("speed") ?? "10") || 10));
    setInterval(() => demo.backend.advance(1000 * speed), 1000);
    search = `?mock=1${params.has("speed") ? `&speed=${speed}` : ""}`;
    // A local mock terminal (packages/machine's mock-terminal) for every machine: ?relay=ws://127.0.0.1:8790/api/relay/v1/page
    const relay = params.get("relay");
    if (relay != null) {
      devTerminal = { url: relay, token: "dev" };
      search += `&relay=${encodeURIComponent(relay)}`;
    }
  }

  const store = new Store(createClient(fetchFn ? { fetch: fetchFn } : {}), now, devTerminal ? { devTerminal } : {});

  // A sign-in link lands with ?token=...: use it once, then drop it from the address bar.
  const token = params.get("token");
  if (token != null) {
    params.delete("token");
    history.replaceState(null, "", location.pathname + (params.size > 0 ? `?${params}` : ""));
    if (!(await store.verifySignIn(token))) await store.loadMe();
  } else {
    await store.loadMe();
  }

  const path = signal(location.pathname);
  const go = (to: string) => {
    history.pushState(null, "", to);
    path.value = new URL(to, location.href).pathname;
    window.scrollTo(0, 0);
  };
  addEventListener("popstate", () => {
    path.value = location.pathname;
  });
  const Root = () => {
    const nav: Nav = { path: path.value, search, go };
    return html`<${App} store=${store} nav=${nav} demoAccounts=${demoAccounts} />`;
  };
  render(html`<${Root} />`, root);
}

const root = document.getElementById("app");
if (root) void boot(root);
