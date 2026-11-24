// The screens, written with htm (tagged templates) so they run in Node without a JSX
// build step. Decisions live in view.ts and store.ts; these only lay them out.

import type { ComponentChildren, VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import { html as htmPreact } from "htm/preact";
import type { Machine, PriceListItem, ProjectLabels, Quote, SpendMeter } from "@sbgpu/api";
import { capitalize, withArticle } from "../labels.ts";
import { formatPriceSplit, formatUsd, priceText } from "../money.ts";
import { ago, machineActions, machineStateLabel, meterView, refusalText, savePercent, stopReasonText } from "../view.ts";
import type { Store } from "./store.ts";
import { parseRoute, routePath, type Route } from "./router.ts";

export const html = htmPreact as (strings: TemplateStringsArray, ...values: unknown[]) => VNode;

export interface Nav {
  /** The current path, e.g. "/p/prj_...". */
  path: string;
  /** Kept on every link, so ?mock=1 survives navigation. */
  search: string;
  go: (path: string) => void;
}

export interface DemoAccount {
  label: string;
  email: string;
  /** The mock's sign-in token for this account. */
  token: string;
}

function Link({ nav, to, children }: { nav: Nav; to: Route; children: ComponentChildren }): VNode {
  const href = routePath(to) + nav.search;
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    nav.go(href);
  };
  return html`<a href=${href} onClick=${onClick}>${children}</a>`;
}

function ErrorBanner({ store }: { store: Store }): VNode | null {
  const message = store.error.value;
  if (message == null) return null;
  return html`<div class="banner error" role="alert">
    <span>${message}</span>
    <button class="link" onClick=${() => (store.error.value = null)}>Dismiss</button>
  </div>`;
}

// ---------------------------------------------------------------- sign-in

export function SignIn({ store, demoAccounts }: { store: Store; demoAccounts?: DemoAccount[] | undefined }): VNode {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const busy = store.isBusy("signin");
  const submit = async (e: Event) => {
    e.preventDefault();
    if (await store.requestSignInLink(email.trim())) setSent(true);
  };
  return html`<main class="narrow">
    <h1>Sign in</h1>
    ${sent
      ? html`<p>Check your email for a sign-in link. It works once, for a few minutes.</p>`
      : html`<form onSubmit=${submit}>
          <label for="email">Email</label>
          <input id="email" type="email" required autocomplete="email" value=${email}
            onInput=${(e: Event) => setEmail((e.target as HTMLInputElement).value)} />
          <button type="submit" disabled=${busy}>Email me a sign-in link</button>
        </form>`}
    ${demoAccounts && demoAccounts.length > 0
      ? html`<section class="demo">
          <h2>Demo accounts (mock data)</h2>
          <ul>
            ${demoAccounts.map(
              (a) => html`<li><button class="secondary" disabled=${busy}
                onClick=${() => store.verifySignIn(a.token)}>${a.label}</button> <span class="muted">${a.email}</span></li>`,
            )}
          </ul>
        </section>`
      : null}
  </main>`;
}

// ---------------------------------------------------------------- home

export function Home({ store, nav }: { store: Store; nav: Nav }): VNode {
  const me = store.me.value;
  if (me == null) return html`<main />`;
  return html`<main>
    <h1>Your projects</h1>
    ${me.projects.length === 0
      ? html`<p>You aren't in any projects yet. When someone invites you, the project appears here.</p>`
      : html`<ul class="cards">
          ${me.projects.map(
            (p) => html`<li class="card">
              <${Link} nav=${nav} to=${{ name: "project", projectId: p.projectId }}>${p.name}<//>
              <span class="badge">${p.role}</span>
            </li>`,
          )}
        </ul>`}
  </main>`;
}

// ---------------------------------------------------------------- spend meter

export function MeterCard({ title, meter, now }: { title: string; meter: SpendMeter; now: number }): VNode {
  const v = meterView(meter);
  return html`<section class=${`card meter band-${v.band}`} aria-label=${title}>
    <h2>${title}</h2>
    <div class="bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${v.usedPercent}
      aria-label=${`${v.usedPercent}% used`}>
      <div class="used" style=${`width: ${v.usedPercent}%`}></div>
    </div>
    <dl class="figures">
      <div><dt>Remaining</dt><dd class="big">${v.remaining}</dd></div>
      <div><dt>Used</dt><dd>${v.used} of ${v.allocation}</dd></div>
      ${v.reserved ? html`<div><dt>Held for the final save</dt><dd>${v.reserved}</dd></div>` : null}
      <div><dt>Storage</dt><dd>${v.storage}</dd></div>
    </dl>
    ${v.rate ? html`<p class="rate">Now: ${v.rate}. ${v.timeLeft ? capitalize(v.timeLeft) + "." : ""}</p>` : null}
    ${v.band === "empty"
      ? html`<p class="warn">This allocation is used up. Ask a manager for more.</p>`
      : v.band === "critical" || v.band === "low"
        ? html`<p class="warn">Running low.</p>`
        : null}
    <p class="muted small">Updated ${ago(meter.asOf, now)}.${v.reserved ? " While a machine runs, enough is held back for its final save." : ""}</p>
  </section>`;
}

// ---------------------------------------------------------------- starting a machine

export function GpuRow({ store, item, quote, labels }: { store: Store; item: PriceListItem; quote: Quote | undefined; labels: ProjectLabels }): VNode {
  const price = quote?.offers[0]?.pricePerHour ?? item.pricePerHour;
  const key = `start:${item.gpuType}`;
  const canStart = quote?.canStart === true;
  return html`<tr>
    <th scope="row">${item.gpuCount}× ${item.gpuType} <span class="muted">${item.gpuMemoryGb} GB</span></th>
    <td>${price
      ? html`<strong>${priceText(price.providerCost, price.margin).total}</strong><br /><span class="small muted">${priceText(price.providerCost, price.margin).parts}</span>`
      : html`<span class="muted">not available</span>`}</td>
    <td class="small">${quote && !quote.canStart && quote.reason ? refusalText(quote.reason, labels) : item.stock === "low" ? "Few left" : ""}</td>
    <td><button disabled=${!canStart || store.isBusy(key)} onClick=${() => store.start(item.gpuType)}>
      ${store.isBusy(key) ? "Starting…" : "Start"}
    </button></td>
  </tr>`;
}

export function StartPanel({ store }: { store: Store }): VNode {
  const items = store.gpuTypes.value;
  const labels = store.labels.value;
  return html`<section class="card">
    <h2>Start a machine</h2>
    ${items.length === 0
      ? html`<p>No GPU types are allowed in this ${labels.project} yet.</p>`
      : html`<table class="gpus">
          <thead><tr><th scope="col">GPU</th><th scope="col">Price per hour</th><th scope="col"></th><th scope="col"></th></tr></thead>
          <tbody>${items.map((item) => html`<${GpuRow} store=${store} item=${item} quote=${store.quotes.value[item.gpuType]} labels=${labels} />`)}</tbody>
        </table>`}
    <p class="muted small">Your workspace is restored on every new machine and saved back when it stops.</p>
  </section>`;
}

// ---------------------------------------------------------------- machines

export function MachineCard({ store, machine: m, labels, now }: { store: Store; machine: Machine; labels: ProjectLabels; now: number }): VNode {
  const actions = machineActions(m);
  const pct = savePercent(m);
  const busy = (kind: string) => store.isBusy(`${kind}:${m.id}`);
  const openJupyter = async () => {
    const url = await store.jupyterLink(m.id);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };
  const remove = () => {
    if (window.confirm("Delete this machine? Your saved workspace is kept.")) void store.remove(m.id);
  };
  return html`<li class=${`card machine state-${m.state}`}>
    <header>
      <strong>${m.gpuCount}× ${m.gpuType}</strong>
      <span class="badge">${machineStateLabel(m)}</span>
    </header>
    <p class="small muted">${m.provider} · ${m.dataCenter} · ${formatPriceSplit(m.pricePerHour.providerCost, m.pricePerHour.margin)}</p>
    <p>Cost so far: ${formatUsd(m.spent.total)}${m.startedAt && m.state === "running" ? html` · started ${ago(m.startedAt, now)}` : null}</p>
    ${pct != null
      ? html`<p><label>Saving workspace: ${pct}% <progress max="100" value=${pct}>${pct}%</progress></label></p>`
      : m.save.lastSavedAt
        ? html`<p class="small muted">Last saved ${ago(m.save.lastSavedAt, now)}.</p>`
        : null}
    ${m.stopReason && (m.state === "stopped" || m.state === "saving" || m.state === "stopping")
      ? html`<p class="small">${stopReasonText(m.stopReason, labels)}</p>`
      : null}
    ${m.finalSaveIncomplete ? html`<p class="warn small">The final save didn't finish; work after the last save was lost.</p>` : null}
    ${m.error ? html`<p class="warn small">${m.error}</p>` : null}
    <div class="actions">
      ${actions.openJupyter ? html`<button onClick=${openJupyter} disabled=${busy("jupyter")}>Open Jupyter</button>` : null}
      ${actions.save ? html`<button class="secondary" onClick=${() => store.save(m.id)} disabled=${busy("save")}>Save now</button>` : null}
      ${actions.stop ? html`<button class="secondary" onClick=${() => store.stop(m.id)} disabled=${busy("stop")}>Stop</button>` : null}
      ${actions.restart ? html`<button onClick=${() => store.restart(m.id)} disabled=${busy("restart")}>Start again</button>` : null}
      ${actions.delete ? html`<button class="danger" onClick=${remove} disabled=${busy("delete")}>Delete</button>` : null}
    </div>
  </li>`;
}

export function MachineList({ store }: { store: Store }): VNode {
  const machines = store.machines.value;
  const labels = store.labels.value;
  const now = store.now();
  return html`<section>
    <h2>Your machines</h2>
    ${machines.length === 0
      ? html`<p class="muted">None yet. Start one above.</p>`
      : html`<ul class="cards">${machines.map((m) => html`<${MachineCard} key=${m.id} store=${store} machine=${m} labels=${labels} now=${now} />`)}</ul>`}
  </section>`;
}

// ---------------------------------------------------------------- project page

/** The display word for a project role; owners are shown as managers. */
export function roleWord(role: string | null, labels: ProjectLabels): string {
  return role === "member" ? labels.member : role === "assistant" ? labels.assistant : labels.manager;
}

export function ProjectPage({ store, projectId }: { store: Store; projectId: string }): VNode {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || document.visibilityState === "visible") await store.refresh();
      timer = setTimeout(loop, store.pollDelayMs());
    };
    void store.openProject(projectId).then(() => {
      timer = setTimeout(loop, store.pollDelayMs());
    });
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [projectId]);

  const project = store.project.value;
  if (project == null || store.projectId.value !== projectId) return html`<main><p class="muted">Loading…</p></main>`;
  const labels = store.labels.value;
  const now = store.now();
  const mine = store.myMeter.value;
  const team = store.teamMeter.value;
  return html`<main>
    <header class="page">
      <h1>${project.name}</h1>
      <span class="badge">${capitalize(labels.project)} · you are ${withArticle(roleWord(store.role.value, labels))}</span>
    </header>
    <div class="grid">
      ${mine ? html`<${MeterCard} title="Your allocation" meter=${mine} now=${now} />` : null}
      ${team ? html`<${MeterCard} title=${`Your ${labels.team}'s allocation`} meter=${team} now=${now} />` : null}
    </div>
    <${StartPanel} store=${store} />
    <${MachineList} store=${store} />
  </main>`;
}

// ---------------------------------------------------------------- the app

export function App({ store, nav, demoAccounts }: { store: Store; nav: Nav; demoAccounts?: DemoAccount[] | undefined }): VNode {
  const me = store.me.value;
  let page: VNode;
  if (!store.meLoaded.value) page = html`<main><p class="muted">Loading…</p></main>`;
  else if (me == null) page = html`<${SignIn} store=${store} demoAccounts=${demoAccounts} />`;
  else {
    const route = parseRoute(nav.path);
    page =
      route.name === "home"
        ? html`<${Home} store=${store} nav=${nav} />`
        : route.name === "project"
          ? html`<${ProjectPage} store=${store} projectId=${route.projectId} />`
          : html`<main><h1>Not found</h1><p><${Link} nav=${nav} to=${{ name: "home" }}>Your projects<//></p></main>`;
  }
  return html`<div class="app">
    <nav class="top">
      <${Link} nav=${nav} to=${{ name: "home" }}>sagebrush-gpu<//>
      ${me ? html`<span class="who">${me.user.email} <button class="link" onClick=${() => store.signOut()}>Sign out</button></span>` : null}
    </nav>
    <${ErrorBanner} store=${store} />
    ${page}
  </div>`;
}
