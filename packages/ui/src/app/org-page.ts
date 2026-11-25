// An organization's page, for anyone with a role in it: how it pays for machines, its
// credit (or, for an organization on its own provider accounts, its budget) not yet given
// to projects, and its projects with their budgets; and for its owners, under byok, its
// provider keys (keys-section.ts).

import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Organization, Project } from "@sbgpu/api";
import { BILLING_WORDS } from "../billing.ts";
import { checkMove, exactUsd, moveBounds } from "../budget-move.ts";
import { formatUsd } from "../money.ts";
import { Link, type Nav } from "./components.ts";
import { KeysSection } from "./keys-section.ts";
import { html } from "./html.ts";
import type { Store } from "./store.ts";

export { BILLING_WORDS };

/** An org owner's control on a project's row: move budget in from the organization, or back. */
function MoveCell({ store, org, project }: { store: Store; org: Organization; project: Project }): VNode {
  const [text, setText] = useState("");
  const bounds = moveBounds(org, project);
  const busy = store.isBusy(`move:${project.id}`);
  const add = checkMove(text, "add", bounds);
  const back = checkMove(text, "return", bounds);
  const go = async (check: typeof add) => {
    if (!check.ok) return;
    if (await store.moveProjectBudget(project.id, check.amount)) setText("");
  };
  const reasons = text.trim() === "" ? [] : [...new Set([add, back].flatMap((c) => (c.ok ? [] : [c.reason])))];
  return html`<td class="move">
    $<input class="money" aria-label=${`Amount to move for ${project.name}`} inputmode="decimal" value=${text} disabled=${busy}
      onInput=${(e: Event) => setText((e.target as HTMLInputElement).value)} />
    <button disabled=${!add.ok || busy} onClick=${() => go(add)}>Add to budget</button>
    <button class="secondary" disabled=${!back.ok || busy} onClick=${() => go(back)}>Return to the organization</button>
    <p class="muted small">${`Up to ${exactUsd(bounds.maxAdd)} can be added; up to ${exactUsd(bounds.maxReturn)} can be returned.`}</p>
    ${reasons.map((r) => html`<p class="warn small">${r}</p>`)}
  </td>`;
}

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
  // Only an owner of the organization moves money (the server checks it too).
  const owner = store.me.value?.orgs.some((o) => o.orgId === orgId && o.role === "owner") ?? false;
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
    ${owner && org.billingMode === "byok" ? html`<${KeysSection} keys=${store.keys} orgId=${orgId} />` : null}
    <section class="card">
      <h2>Projects (${projects.length}${cut ? "+" : ""})</h2>
      ${cut ? html`<p class="warn small">${`Showing the first ${projects.length} projects.`}</p>` : null}
      ${projects.length === 0
        ? html`<p class="muted">No projects yet.</p>`
        : html`<table class="projects">
            <thead><tr><th scope="col">Project</th><th scope="col">Budget</th><th scope="col">Allocated</th><th scope="col">${words.spent}</th>${owner ? html`<th scope="col">Move budget</th>` : null}</tr></thead>
            <tbody>${projects.map(
              (p) => html`<tr>
                <td><${Link} nav=${nav} to=${{ name: "project", projectId: p.id }}>${p.name}<//></td>
                <td>${formatUsd(p.budget)}</td>
                <td>${formatUsd(p.allocated)}</td>
                <td>${formatUsd(p.spent.total)}</td>
                ${owner ? html`<${MoveCell} key=${p.id} store=${store} org=${org} project=${p} />` : null}
              </tr>`,
            )}</tbody>
          </table>`}
    </section>
  </main>`;
}
