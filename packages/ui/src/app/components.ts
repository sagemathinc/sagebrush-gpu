// The screens, written with htm (tagged templates) so they run in Node without a JSX
// build step. Decisions live in view.ts and store.ts; these only lay them out.

import type { ComponentChildren, VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import { SavesSection, SaveWithName } from "./saves-section.ts";
import { tourSteps } from "../tour.ts";
import { html } from "./html.ts";
import type { BillingMode, Machine, PriceListItem, ProjectLabels, Quote, SignInOutcome, SpendMeter } from "@sbgpu/api";
import { capitalize, GENERIC_LABELS, withArticle } from "../labels.ts";
import { BILLING_WORDS } from "../billing.ts";
import { formatPriceSplit, formatUsd, priceText } from "../money.ts";
import { ago, hoursOnAllocation, machineActions, machineStateLabel, meterView, pauseView, refusalText, savePercent, startFailureText, stopReasonText, storageWarning } from "../view.ts";
import type { Store } from "./store.ts";
import { parseRoute, routePath, type Route } from "./router.ts";
import { startPolling, type PollTimers } from "./polling.ts";
import { ManagePage } from "./manage-page.ts";
import { OrgPage } from "./org-page.ts";
import { TerminalPanel } from "./terminal-panel.ts";
import { signInHref } from "./signin.ts";

export { html };

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
  /** Signs in as this account in the mock (the whole WorkOS round trip). */
  signIn: () => Promise<void>;
}

export function Link({ nav, to, children }: { nav: Nav; to: Route; children: ComponentChildren }): VNode {
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

const SIGN_IN_NOTICES: { readonly [K in SignInOutcome | "signedOut"]: string } = {
  refused: "This Sagebrush account hasn't been invited to a project here. Ask whoever runs your project to invite the email address you use with Sagebrush.",
  error: "Signing in didn't work.",
  expired: "Signing in took too long or was interrupted.",
  unavailable: "Signing in isn't possible at the moment.",
  signedOut: "Signed out of sagebrush-gpu.",
};

export function SignIn({ store, nav, demoAccounts }: { store: Store; nav: Nav; demoAccounts?: DemoAccount[] | undefined }): VNode {
  const notice = store.signInNotice.value;
  const retry = notice === "error" || notice === "expired" || notice === "unavailable";
  const demo = demoAccounts && demoAccounts.length > 0 ? demoAccounts : null;
  // The demo has no WorkOS: the button signs in as its first account.
  const onClick = demo
    ? (e: Event) => {
        e.preventDefault();
        void demo[0]?.signIn();
      }
    : undefined;
  return html`<main class="narrow">
    <h1>Sign in</h1>
    ${notice ? html`<p class=${notice === "signedOut" ? "notice" : "notice warn"} role="status">${SIGN_IN_NOTICES[notice]}</p>` : null}
    <p><a class="button" href=${signInHref(nav.path)} onClick=${onClick}>${retry ? "Try again" : "Sign in with your Sagebrush account"}</a></p>
    ${demo
      ? html`<section class="demo">
          <h2>Demo accounts (mock data)</h2>
          <ul>
            ${demo.map(
              (a) => html`<li><button class="secondary" onClick=${() => a.signIn()}>${a.label}</button> <span class="muted">${a.email}</span></li>`,
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
    ${me.orgs.length > 0
      ? html`<h2>Your organizations</h2>
          <ul class="cards">
            ${me.orgs.map(
              (o) => html`<li class="card">
                <${Link} nav=${nav} to=${{ name: "org", orgId: o.orgId }}>${o.name}<//>
                <span class="badge">${o.role}</span>
              </li>`,
            )}
          </ul>`
      : null}
  </main>`;
}

// ---------------------------------------------------------------- spend meter

export function MeterCard({
  title,
  meter,
  now,
  mode = "resold",
  labels = GENERIC_LABELS,
}: {
  title: string;
  meter: SpendMeter;
  now: number;
  mode?: BillingMode;
  labels?: ProjectLabels;
}): VNode {
  const v = meterView(meter, mode);
  const storageNote = storageWarning(v.storageLevel, labels);
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
    ${storageNote ? html`<p class=${`warn storage-${v.storageLevel}`} role="status">${storageNote}</p>` : null}
    <p class="muted small">Updated ${ago(meter.asOf, now)}.${v.reserved ? " While a machine runs, enough is held back for its final save." : ""}</p>
  </section>`;
}

// ---------------------------------------------------------------- starting a machine

export function GpuRow({ store, item, quote, labels }: { store: Store; item: PriceListItem; quote: Quote | undefined; labels: ProjectLabels }): VNode {
  const price = quote?.offers[0]?.pricePerHour ?? item.pricePerHour;
  const key = `start:${item.gpuType}`;
  const canStart = quote?.canStart === true;
  const refused = store.startRefusal.value?.gpuType === item.gpuType ? store.startRefusal.value.text : null;
  const hours = quote && price ? hoursOnAllocation(quote.remaining, price.total, store.billingMode.value) : null;
  return html`<tr>
    <th scope="row">${item.gpuCount}× ${item.gpuType} <span class="muted">${item.gpuMemoryGb} GB</span></th>
    <td>${price
      ? html`<strong>${priceText(price.providerCost, price.margin, store.billingMode.value).total}</strong><br /><span class="small muted">${priceText(price.providerCost, price.margin, store.billingMode.value).parts}</span>`
      : html`<span class="muted">not available</span>`}</td>
    <td class="small">${
      refused
        ? html`<span class="warn" role="status">${refused}</span>`
        : quote && !quote.canStart && quote.reason
          ? refusalText(quote.reason, labels, quote.reasonProvider)
          : [hours, item.stock === "low" ? "Few left" : null].filter((x) => x != null).join(" · ")
    }</td>
    <td><button disabled=${!canStart || store.isBusy(key)} onClick=${() => store.start(item.gpuType)}>
      ${store.isBusy(key) ? "Starting…" : "Start"}
    </button></td>
  </tr>`;
}

/**
 * Paused providers, above the start panel. Everyone sees which provider is paused and since
 * when; managers and above also see why (the server sends the reason only to them, and this
 * shows it only to them too), and an owner of the organization a link to its keys.
 */
export function PauseBanner({ store, nav }: { store: Store; nav?: Nav | undefined }): VNode | null {
  const pauses = store.paused.value;
  if (pauses.length === 0) return null;
  const now = store.now();
  const showReason = store.canManage.value;
  const orgId = store.project.value?.orgId;
  const owner = orgId != null && store.me.value?.orgs.some((o) => o.orgId === orgId && o.role === "owner") === true;
  return html`<section class="banner paused" role="status" aria-label="Paused providers">
    ${pauses.map((p) => {
      const v = pauseView(p, showReason, now);
      return html`<p>
        <strong>${v.headline}</strong> <span class="small muted">${v.since}</span>
        ${v.reason ? html`<br /><span class="small">${v.reason}</span>` : null}
      </p>`;
    })}
    ${showReason && owner && nav && orgId
      ? html`<p class="small"><${Link} nav=${nav} to=${{ name: "org", orgId }}>Replace the key on the organization's page<//></p>`
      : showReason
        ? html`<p class="small">An owner of the organization can replace the key.</p>`
        : null}
  </section>`;
}

/** The first-run walkthrough: four steps, ticked from what has happened; skippable any time. */
export function TourCard({ store }: { store: Store }): VNode {
  const steps = tourSteps({ machines: store.machines.value, memberSaves: store.saves.value.member, jupyterOpened: store.jupyterOpened.value });
  const finished = steps.every((s) => s.done);
  const next = steps.find((s) => !s.done);
  return html`<section class="card tour" aria-label="Getting started">
    <h2>Getting started</h2>
    ${finished ? html`<p>You're all set: you've started a machine, used Jupyter, saved your work and stopped it.</p>` : null}
    <ol>
      ${steps.map(
        (s) => html`<li key=${s.id} class=${s.done ? "done" : s === next ? "next" : ""}>
          <strong>${s.title}</strong>${s.done ? html` <span class="badge">Done</span>` : null}
          ${s === next ? html`<br /><span class="small">${s.hint}</span>` : null}
        </li>`,
      )}
    </ol>
    <button class="secondary" onClick=${() => store.hideTour()}>${finished ? "Hide" : "Skip"}</button>
  </section>`;
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
  const [terminalOpen, setTerminalOpen] = useState(false);
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
    <p class="small muted">${m.provider} · ${m.dataCenter} · ${formatPriceSplit(m.pricePerHour.providerCost, m.pricePerHour.margin, store.billingMode.value)}</p>
    <p>${BILLING_WORDS[store.billingMode.value].costSoFar}: ${formatUsd(m.spent.total)}${m.startedAt && m.state === "running" ? html` · started ${ago(m.startedAt, now)}` : null}</p>
    ${pct != null
      ? html`<p><label>Saving workspace: ${pct}% <progress max="100" value=${pct}>${pct}%</progress></label></p>`
      : m.save.lastSavedAt
        ? html`<p class="small muted">Last saved ${ago(m.save.lastSavedAt, now)}.</p>`
        : null}
    ${m.stopReason && (m.state === "stopped" || m.state === "saving" || m.state === "stopping")
      ? html`<p class="small">${stopReasonText(m.stopReason, labels)}</p>`
      : null}
    ${m.finalSaveIncomplete ? html`<p class="warn small">The final save didn't finish; work after the last save was lost.</p>` : null}
    ${m.startFailure ? html`<p class="warn small">${startFailureText(m, store.billingMode.value)}</p>` : null}
    ${m.error ? html`<p class="warn small">${m.error}</p>` : null}
    <div class="actions">
      ${actions.openTerminal && !terminalOpen ? html`<button onClick=${() => setTerminalOpen(true)}>Open terminal</button>` : null}
      ${actions.openJupyter ? html`<button onClick=${openJupyter} disabled=${busy("jupyter")}>Open Jupyter</button>` : null}
      ${actions.save ? html`<button class="secondary" onClick=${() => store.save(m.id)} disabled=${busy("save")}>Save now</button>` : null}
      ${actions.save ? html`<${SaveWithName} store=${store} machineId=${m.id} />` : null}
      ${actions.stop ? html`<button class="secondary" onClick=${() => store.stop(m.id)} disabled=${busy("stop")}>Stop</button>` : null}
      ${actions.restart ? html`<button onClick=${() => store.restart(m.id)} disabled=${busy("restart")}>Start again</button>` : null}
      ${actions.delete ? html`<button class="danger" onClick=${remove} disabled=${busy("delete")}>Delete</button>` : null}
    </div>
    ${terminalOpen && actions.openTerminal ? html`<${TerminalPanel} store=${store} machineId=${m.id} onClose=${() => setTerminalOpen(false)} />` : null}
  </li>`;
}

export function MachineList({ store }: { store: Store }): VNode {
  const machines = store.machines.value;
  const labels = store.labels.value;
  const now = store.now();
  const cut = store.truncated.value.has("machines");
  return html`<section>
    <h2>Your machines${cut ? ` (${machines.length}+)` : ""}</h2>
    ${cut ? html`<p class="warn small">${`Showing your first ${machines.length} machines; you have more than one page load reads.`}</p>` : null}
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

/** Load a project on mount (and when it changes), then poll it until unmount. */
export function useProjectLoad(store: Store, projectId: string, timers: PollTimers | undefined): void {
  useEffect(() => {
    let stop: (() => void) | null = null;
    let unmounted = false;
    void store.openProject(projectId).then(() => {
      if (unmounted) return;
      stop = startPolling(store, {
        ...(timers ? { timers } : {}),
        visible: () => typeof document === "undefined" || document.visibilityState === "visible",
      });
    });
    return () => {
      unmounted = true;
      stop?.();
    };
  }, [projectId]);
}

export function ProjectPage({ store, projectId, timers, nav }: { store: Store; projectId: string; timers?: PollTimers | undefined; nav?: Nav | undefined }): VNode {
  useProjectLoad(store, projectId, timers);

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
      ${nav && store.isStaff.value ? html`<${Link} nav=${nav} to=${{ name: "manage", projectId }}>Manage this ${labels.project}<//>` : null}
    </header>
    <div class="grid">
      ${mine ? html`<${MeterCard} title="Your allocation" meter=${mine} now=${now} mode=${store.billingMode.value} labels=${labels} />` : null}
      ${team ? html`<${MeterCard} title=${`Your ${labels.team}'s allocation`} meter=${team} now=${now} mode=${store.billingMode.value} labels=${labels} />` : null}
    </div>
    <${PauseBanner} store=${store} nav=${nav} />
    ${store.role.value === "member" && !store.tourHidden.value ? html`<${TourCard} store=${store} />` : null}
    <${StartPanel} store=${store} />
    <${MachineList} store=${store} />
    <${SavesSection} store=${store} />
  </main>`;
}

// ---------------------------------------------------------------- the app

export function App({
  store,
  nav,
  demoAccounts,
  timers,
}: {
  store: Store;
  nav: Nav;
  demoAccounts?: DemoAccount[] | undefined;
  /** For tests: the polling loop's timers. */
  timers?: PollTimers | undefined;
}): VNode {
  const me = store.me.value;
  let page: VNode;
  if (!store.meLoaded.value) page = html`<main><p class="muted">Loading…</p></main>`;
  else if (me == null) page = html`<${SignIn} store=${store} nav=${nav} demoAccounts=${demoAccounts} />`;
  else {
    const route = parseRoute(nav.path);
    page =
      route.name === "home"
        ? html`<${Home} store=${store} nav=${nav} />`
        : route.name === "project"
          ? html`<${ProjectPage} store=${store} projectId=${route.projectId} timers=${timers} nav=${nav} />`
          : route.name === "manage"
            ? html`<${ManagePage} store=${store} projectId=${route.projectId} timers=${timers} nav=${nav} />`
          : route.name === "org"
            ? html`<${OrgPage} store=${store} orgId=${route.orgId} nav=${nav} />`
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
