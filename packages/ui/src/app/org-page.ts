// An organization's page, for anyone with a role in it: how it pays for machines, its
// credit (or, for an organization on its own provider accounts, its budget) not yet given
// to projects, and its projects with their budgets.

import type { VNode } from "preact";
import { useEffect } from "preact/hooks";
import { BILLING_WORDS } from "../billing.ts";
import { formatUsd } from "../money.ts";
import { Link, type Nav } from "./components.ts";
import { html } from "./html.ts";
import type { Store } from "./store.ts";

export { BILLING_WORDS };

export function OrgPage({ store, orgId, nav }: { store: Store; orgId: string; nav: Nav }): VNode {
  const known = store.me.value?.orgs.some((o) => o.orgId === orgId) ?? false;
  useEffect(() => {
    if (known) void store.openOrg(orgId);
  }, [store, orgId, known]);
  if (!known) {
    return html`<main><h1>Not found</h1><p><${Link} nav=${nav} to=${{ name: "home" }}>Your projects<//></p></main>`;
  }
  const org = store.org.value;
  // The first render after a navigation comes before openOrg runs: the store still holds
  // the last organization then, which must not be shown as this one.
  if (org == null || store.orgId.value !== orgId) return html`<main><p class="muted">Loading…</p></main>`;
  const words = BILLING_WORDS[org.billingMode];
  const projects = store.orgProjects.value;
  const cut = store.truncated.value.has("orgProjects");
  return html`<main>
    <h1>${org.name}</h1>
    <section class="card">
      <h2>Billing</h2>
      <p>${words.about}</p>
      <dl class="figures">
        <div><dt>${words.unassigned}</dt><dd class="big">${formatUsd(org.unassignedCredit)}</dd></div>
        <div><dt>${words.total}</dt><dd>${formatUsd(org.totalCredit)}</dd></div>
      </dl>
    </section>
    <section class="card">
      <h2>Projects (${projects.length}${cut ? "+" : ""})</h2>
      ${cut ? html`<p class="warn small">${`Showing the first ${projects.length} projects.`}</p>` : null}
      ${projects.length === 0
        ? html`<p class="muted">No projects yet.</p>`
        : html`<table class="projects">
            <thead><tr><th scope="col">Project</th><th scope="col">Budget</th><th scope="col">Allocated</th><th scope="col">${words.spent}</th></tr></thead>
            <tbody>${projects.map(
              (p) => html`<tr>
                <td><${Link} nav=${nav} to=${{ name: "project", projectId: p.id }}>${p.name}<//></td>
                <td>${formatUsd(p.budget)}</td>
                <td>${formatUsd(p.allocated)}</td>
                <td>${formatUsd(p.spent.total)}</td>
              </tr>`,
            )}</tbody>
          </table>`}
    </section>
  </main>`;
}
