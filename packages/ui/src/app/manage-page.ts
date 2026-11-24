// The manager's page for a project (assistants see it read-only): totals and Stop all, the
// spend CSVs, the members table with allocation edits (one or in bulk), invites with a
// preview, and every machine in the project.

import type { VNode } from "preact";
import { useState } from "preact/hooks";
import { SPEND_CSV_GROUPINGS, canRemoveMember, type Machine, type SpendCsvGrouping } from "@sbgpu/api";
import { plural } from "../labels.ts";
import { bulkPlan, csvFilename, filterRows, invitePreview, memberRows, sortRows, type MemberRow, type SortKey } from "../manage.ts";
import { formatPriceSplit, formatUsd, parseUsd } from "../money.ts";
import { formatBytes, machineStateLabel } from "../view.ts";
import { Link, useProjectLoad, type Nav } from "./components.ts";
import { html } from "./html.ts";
import type { PollTimers } from "./polling.ts";
import type { Store } from "./store.ts";

/** Hand a CSV to the browser as a file download. */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Summary({ store }: { store: Store }): VNode | null {
  const p = store.project.value;
  if (p == null) return null;
  const running = store.allMachines.value.filter((m) => m.state === "starting" || m.state === "running").length;
  const stopAll = () => {
    if (window.confirm(`Stop all ${running} running ${running === 1 ? "machine" : "machines"}? Each saves its workspace first.`)) void store.stopAll();
  };
  const csv = async (by: SpendCsvGrouping) => {
    const text = await store.spendCsv(by);
    if (text != null) download(csvFilename(p.name, by, new Date(store.now()).toISOString()), text);
  };
  return html`<section class="card">
    <h2>Budget</h2>
    <dl class="figures">
      <div><dt>Budget</dt><dd class="big">${formatUsd(p.budget)}</dd></div>
      <div><dt>Allocated</dt><dd>${formatUsd(p.allocated)}</dd></div>
      <div><dt>Not yet allocated</dt><dd>${formatUsd(p.budget - p.allocated)}</dd></div>
      <div><dt>Spent</dt><dd>${formatUsd(p.spent.total)} <span class="muted small">(provider ${formatUsd(p.spent.providerCost)} + service ${formatUsd(p.spent.margin)})</span></dd></div>
      <div><dt>Running now</dt><dd>${running}</dd></div>
    </dl>
    <div class="actions">
      <button class="danger" disabled=${running === 0 || store.isBusy("stopAll")} onClick=${stopAll}>Stop all machines</button>
      ${SPEND_CSV_GROUPINGS.map(
        (by) => html`<button class="secondary" disabled=${store.isBusy(`csv:${by}`)} onClick=${() => csv(by)}>Spend by ${by} (CSV)</button>`,
      )}
    </div>
  </section>`;
}

const COLUMNS: Array<[SortKey, string]> = [
  ["email", "Email"],
  ["name", "Name"],
  ["team", "Team"],
  ["allocation", "Allocation"],
  ["spent", "Spent"],
  ["remaining", "Remaining"],
  ["running", "Running"],
];

function AllocationCell({ store, row, editable }: { store: Store; row: MemberRow; editable: boolean }): VNode {
  const [text, setText] = useState<string | null>(null);
  if (!editable) return html`<td>${formatUsd(row.allocation)}</td>`;
  const value = text ?? formatUsd(row.allocation).slice(1);
  const parsed = parseUsd(value);
  // Read what's in the field now (not this render's copy), so a quick type-then-leave saves it.
  const save = async (input: HTMLInputElement) => {
    if (text == null && input.value === value) return;
    const amount = parseUsd(input.value);
    if (amount == null) return;
    if (amount === row.allocation || (await store.setAllocation(row.memberId, amount))) setText(null);
  };
  return html`<td class="nowrap">
    $<input class=${`money${parsed == null ? " invalid" : ""}`} aria-label=${`Allocation for ${row.email}`} inputmode="decimal" value=${value}
      onInput=${(e: Event) => setText((e.target as HTMLInputElement).value)}
      onBlur=${(e: Event) => void save(e.target as HTMLInputElement)}
      onKeyDown=${(e: KeyboardEvent) => e.key === "Enter" && void save(e.target as HTMLInputElement)} />
  </td>`;
}

function MembersTable({ store }: { store: Store }): VNode {
  const labels = store.labels.value;
  const canManage = store.canManage.value;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "email", descending: false });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const all = memberRows(store.members.value, store.meters.value, store.allMachines.value, store.teams.value);
  const rows = sortRows(filterRows(all, query), sort.key, sort.descending);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const actor = store.role.value;
  const owners = all.filter((r) => r.role === "owner").length;
  // Offer Remove only where the membership rules allow it (the server checks them too).
  const removable = (r: MemberRow) => actor != null && canRemoveMember(actor, r.role, owners).ok;
  const remove = (row: MemberRow) => {
    if (window.confirm(`Remove ${row.email}? Their running machines are stopped (saving first).`)) void store.removeMember(row.memberId);
  };
  return html`<section class="card">
    <h2>People (${all.length})</h2>
    <input type="search" placeholder="Filter by email, name, ${labels.team}, role" aria-label="Filter" value=${query}
      onInput=${(e: Event) => setQuery((e.target as HTMLInputElement).value)} />
    <table class="members">
      <thead><tr>
        ${canManage ? html`<th scope="col"><span class="visually-hidden">Select</span></th>` : null}
        ${COLUMNS.map(
          ([key, title]) => html`<th scope="col" aria-sort=${sort.key === key ? (sort.descending ? "descending" : "ascending") : "none"}>
            <button class="link" onClick=${() => setSort({ key, descending: sort.key === key ? !sort.descending : false })}>${title}</button>
          </th>`,
        )}
        <th scope="col">Storage</th>
        ${canManage ? html`<th scope="col"><span class="visually-hidden">Actions</span></th>` : null}
      </tr></thead>
      <tbody>
        ${rows.map(
          (r) => html`<tr key=${r.memberId} class=${r.allocation > 0 ? `band-${r.band}` : undefined}>
            ${canManage ? html`<td><input type="checkbox" aria-label=${`Select ${r.email}`} checked=${selected.has(r.memberId)} onChange=${() => toggle(r.memberId)} /></td>` : null}
            <td>${r.email}${r.status === "invited" ? html` <span class="badge">invited</span>` : null}${r.role !== "member" ? html` <span class="badge">${r.role}</span>` : null}</td>
            <td>${r.name ?? ""}</td>
            <td>${r.team ?? ""}</td>
            <${AllocationCell} store=${store} row=${r} editable=${canManage} />
            <td>${formatUsd(r.spent)}</td>
            <td>${formatUsd(r.remaining)}</td>
            <td>${r.running}</td>
            <td>${formatBytes(r.storageBytes)}</td>
            ${canManage
              ? html`<td>${removable(r) ? html`<button class="link danger" disabled=${store.isBusy(`removeMember:${r.memberId}`)} onClick=${() => remove(r)}>Remove</button>` : null}</td>`
              : null}
          </tr>`,
        )}
      </tbody>
    </table>
    ${canManage && selected.size > 0 ? html`<${BulkBar} store=${store} rows=${all} selected=${selected} onDone=${() => setSelected(new Set())} />` : null}
  </section>`;
}

function BulkBar({ store, rows, selected, onDone }: { store: Store; rows: MemberRow[]; selected: ReadonlySet<string>; onDone: () => void }): VNode | null {
  const [mode, setMode] = useState<"set" | "add">("set");
  const [text, setText] = useState("");
  const project = store.project.value;
  if (project == null) return null;
  const amount = parseUsd(text);
  const plan = amount == null ? null : bulkPlan(rows, selected, mode, amount, project);
  const apply = async () => {
    if (plan == null || plan.changes.length === 0) return;
    const done = await store.setAllocations(plan.changes.map((c) => ({ memberId: c.memberId, to: c.to })));
    if (done === plan.changes.length) onDone();
  };
  return html`<div class="bulk" role="group" aria-label="Change the selected allocations">
    <span>${selected.size} selected:</span>
    <select aria-label="How" value=${mode} onChange=${(e: Event) => setMode((e.target as HTMLSelectElement).value as "set" | "add")}>
      <option value="set">set each to</option>
      <option value="add">add to each</option>
    </select>
    <input class=${`money${text !== "" && amount == null ? " invalid" : ""}`} aria-label="Amount in dollars" inputmode="decimal" placeholder="$0.00" value=${text}
      onInput=${(e: Event) => setText((e.target as HTMLInputElement).value)} />
    ${plan
      ? html`<span class="small">${`${plan.changes.length} ${plan.changes.length === 1 ? "change" : "changes"}, ${plan.delta >= 0 ? "+" : "−"}${formatUsd(Math.abs(plan.delta))} allocated; `}${
          plan.headroomAfter >= 0
            ? `${formatUsd(plan.headroomAfter)} of the budget left unallocated`
            : html`<strong class="warn">${formatUsd(-plan.headroomAfter)} over the budget</strong>`
        }</span>`
      : null}
    <button disabled=${plan == null || plan.changes.length === 0 || plan.headroomAfter < 0 || store.isBusy("allocations")} onClick=${apply}>Apply</button>
  </div>`;
}

function InviteForm({ store }: { store: Store }): VNode | null {
  const labels = store.labels.value;
  const [text, setText] = useState("");
  const [allocationText, setAllocationText] = useState("0");
  const project = store.project.value;
  if (project == null) return null;
  const preview = invitePreview(text, store.members.value);
  const allocation = parseUsd(allocationText);
  const needed = allocation == null ? null : allocation * preview.toInvite.length;
  const headroom = project.budget - project.allocated;
  const over = needed != null && needed > headroom;
  // htm drops whitespace that contains a line break, so sentences are built as strings.
  const counts = [`${preview.toInvite.length} to invite`];
  if (preview.already.length > 0) counts.push(`${preview.already.length} already ${plural(labels.member)}`);
  if (preview.duplicates.length > 0) counts.push(`${preview.duplicates.length} repeated`);
  const summary = `${counts.join(", ")}.`;
  const invite = async () => {
    if (allocation == null || preview.toInvite.length === 0 || over) return;
    if ((await store.invite(preview.toInvite, allocation)) > 0) setText("");
  };
  return html`<section class="card">
    <h2>Invite ${plural(labels.member)}</h2>
    <label for="invite-emails">Email addresses (one per line, or separated by commas)</label>
    <textarea id="invite-emails" rows="4" value=${text} onInput=${(e: Event) => setText((e.target as HTMLTextAreaElement).value)}></textarea>
    <label for="invite-allocation">Allocation for each</label>
    <input id="invite-allocation" class=${`money${allocation == null ? " invalid" : ""}`} inputmode="decimal" value=${allocationText}
      onInput=${(e: Event) => setAllocationText((e.target as HTMLInputElement).value)} />
    <p class="small" aria-live="polite">${summary}${
      preview.invalid.length > 0 ? html` <span class="warn">${`Not addresses: ${preview.invalid.join(", ")}.`}</span>` : null
    }${
      needed != null && preview.toInvite.length > 0
        ? over
          ? html` <strong class="warn">${`That's ${formatUsd(needed)}, more than the ${formatUsd(headroom)} not yet allocated.`}</strong>`
          : ` That allocates ${formatUsd(needed)}.`
        : null
    }</p>
    <button disabled=${preview.toInvite.length === 0 || allocation == null || over || store.isBusy("invite")} onClick=${invite}>
      Invite ${preview.toInvite.length || ""}
    </button>
  </section>`;
}

function AllMachines({ store }: { store: Store }): VNode {
  const machines = store.allMachines.value.filter((m) => m.state !== "deleted");
  const email = new Map(store.members.value.map((m) => [m.id, m.email]));
  const stoppable = (m: Machine) => m.state === "starting" || m.state === "running" || m.state === "failed";
  return html`<section class="card">
    <h2>Machines (${machines.length})</h2>
    ${machines.length === 0
      ? html`<p class="muted">No machines yet.</p>`
      : html`<table class="machines">
          <thead><tr><th scope="col">Member</th><th scope="col">GPU</th><th scope="col">State</th><th scope="col">Price</th><th scope="col">Cost so far</th><th scope="col"></th></tr></thead>
          <tbody>${machines.map(
            (m) => html`<tr key=${m.id}>
              <td>${email.get(m.memberId) ?? m.memberId}</td>
              <td>${m.gpuCount}× ${m.gpuType} <span class="muted small">${m.provider}</span></td>
              <td>${machineStateLabel(m)}</td>
              <td class="small">${formatPriceSplit(m.pricePerHour.providerCost, m.pricePerHour.margin)}</td>
              <td>${formatUsd(m.spent.total)}</td>
              <td>${stoppable(m) ? html`<button class="secondary" disabled=${store.isBusy(`stop:${m.id}`)} onClick=${() => store.stop(m.id)}>Stop</button>` : null}</td>
            </tr>`,
          )}</tbody>
        </table>`}
  </section>`;
}

export function ManagePage({ store, projectId, timers, nav }: { store: Store; projectId: string; timers?: PollTimers | undefined; nav: Nav }): VNode {
  useProjectLoad(store, projectId, timers);
  const project = store.project.value;
  if (project == null || store.projectId.value !== projectId) return html`<main><p class="muted">Loading…</p></main>`;
  const labels = store.labels.value;
  if (!store.isStaff.value) {
    return html`<main><h1>${project.name}</h1><p>Only ${plural(labels.manager)} and ${plural(labels.assistant)} can see this page.</p>
      <p><${Link} nav=${nav} to=${{ name: "project", projectId }}>Back to the ${labels.project}<//></p></main>`;
  }
  return html`<main>
    <header class="page">
      <h1>${project.name}: manage</h1>
      ${store.canManage.value ? null : html`<span class="badge">read-only for ${plural(labels.assistant)}</span>`}
      <${Link} nav=${nav} to=${{ name: "project", projectId }}>Your own view<//>
    </header>
    <${Summary} store=${store} />
    <${MembersTable} store=${store} />
    ${store.canManage.value ? html`<${InviteForm} store=${store} />` : null}
    <${AllMachines} store=${store} />
  </main>`;
}
