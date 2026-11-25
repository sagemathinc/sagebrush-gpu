// An organization's page, for anyone with a role in it: how it pays for machines, its
// credit (or, for an organization on its own provider accounts, its budget) not yet given
// to projects, and its projects with their budgets.

import type { VNode } from "preact";
import { useEffect } from "preact/hooks";
import type { BillingMode } from "@sbgpu/api";
import { formatUsd } from "../money.ts";
import { Link, type Nav } from "./components.ts";
import { html } from "./html.ts";
import type { Store } from "./store.ts";

/** The words for each billing mode. Never "no charge" or "no markup": byok has a fee by agreement. */
export const BILLING_WORDS: {
  readonly [M in BillingMode]: { about: string; unassigned: string; total: string; spent: string };
} = {
  resold: {
    about: "Credit is bought from us and assigned to projects as budgets.",
    unassigned: "Credit not yet assigned to projects",
    total: "Credit bought in all",
    spent: "Spent",
  },
  byok: {
    about:
      "Machines run on your organization's own provider accounts, which the providers bill. Our fee is set in your agreement. Project budgets limit what each project may spend.",
    unassigned: "Budget not yet assigned to projects",
    total: "Budget granted in all",
    spent: "Metered use",
  },
};

export function OrgPage({ store, orgId, nav }: { store: Store; orgId: string; nav: Nav }): VNode {
  const known = store.me.value?.orgs.some((o) => o.orgId === orgId) ?? false;
  useEffect(() => {
    if (known) void store.openOrg(orgId);
  }, [store, orgId, known]);
  if (!known) {
    return html`<main><h1>Not found</h1><p><${Link} nav=${nav} to=${{ name: "home" }}>Your projects<//></p></main>`;
  }
  const org = store.org.value;
  // (openOrg clears the organization when it changes, so a stale one is never shown.)
  if (org == null) return html`<main><p class="muted">Loading…</p></main>`;
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
