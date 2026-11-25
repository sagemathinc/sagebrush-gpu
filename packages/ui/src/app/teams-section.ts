// The project's teams on the manager's page: each team's people, allocation, spend and
// what remains. Managers create, rename and delete teams and set their allocations;
// assistants see the table only.

import type { VNode } from "preact";
import { useState } from "preact/hooks";
import { capitalize, plural } from "../labels.ts";
import { checkTeamName, teamRows, type TeamRow } from "../manage.ts";
import { formatUsd, parseUsd } from "../money.ts";
import { html } from "./html.ts";
import type { Store } from "./store.ts";

function TeamAllocation({ store, row, editable }: { store: Store; row: TeamRow; editable: boolean }): VNode {
  const [text, setText] = useState<string | null>(null);
  if (!editable) return html`<td>${formatUsd(row.allocation)}</td>`;
  const value = text ?? formatUsd(row.allocation).slice(1);
  const parsed = parseUsd(value);
  // Read what's in the field now (not this render's copy), so a quick type-then-leave saves it.
  const save = async (input: HTMLInputElement) => {
    if (text == null && input.value === value) return;
    const amount = parseUsd(input.value);
    if (amount == null) return;
    if (amount === row.allocation || (await store.setTeamAllocation(row.teamId, amount))) setText(null);
  };
  return html`<td class="nowrap">
    $<input class=${`money${parsed == null ? " invalid" : ""}`} aria-label=${`Allocation for ${row.name}`} inputmode="decimal" value=${value}
      disabled=${store.isBusy(`team:${row.teamId}`)}
      onInput=${(e: Event) => setText((e.target as HTMLInputElement).value)}
      onBlur=${(e: Event) => void save(e.target as HTMLInputElement)}
      onKeyDown=${(e: KeyboardEvent) => e.key === "Enter" && void save(e.target as HTMLInputElement)} />
  </td>`;
}

function TeamName({ store, row, editable }: { store: Store; row: TeamRow; editable: boolean }): VNode {
  const [text, setText] = useState<string | null>(null);
  if (!editable || text == null) {
    return html`<td>${row.name}${editable
      ? html` <button class="link" aria-label=${`Rename ${row.name}`} onClick=${() => setText(row.name)}>Rename</button>`
      : null}</td>`;
  }
  const check = checkTeamName(text, store.teams.value, row.teamId);
  const save = async () => {
    if (!check.ok) return;
    if (check.name === row.name || (await store.renameTeam(row.teamId, check.name))) setText(null);
  };
  return html`<td>
    <input aria-label=${`New name for ${row.name}`} value=${text} disabled=${store.isBusy(`team:${row.teamId}`)}
      onInput=${(e: Event) => setText((e.target as HTMLInputElement).value)}
      onKeyDown=${(e: KeyboardEvent) => (e.key === "Enter" ? void save() : e.key === "Escape" ? setText(null) : undefined)} />
    <button disabled=${!check.ok || store.isBusy(`team:${row.teamId}`)} onClick=${save}>Save</button>
    <button class="secondary" onClick=${() => setText(null)}>Cancel</button>
    ${check.ok ? null : html`<span class="warn small">${check.reason}</span>`}
  </td>`;
}

function NewTeam({ store }: { store: Store }): VNode | null {
  const labels = store.labels.value;
  const [name, setName] = useState("");
  const [allocationText, setAllocationText] = useState("0");
  const project = store.project.value;
  if (project == null) return null;
  const check = checkTeamName(name, store.teams.value);
  const allocation = parseUsd(allocationText);
  const headroom = project.budget - project.allocated;
  const over = allocation != null && allocation > headroom;
  const busy = store.isBusy("team:create");
  const create = async () => {
    if (!check.ok || allocation == null || over) return;
    if (await store.createTeam(check.name, allocation)) {
      setName("");
      setAllocationText("0");
    }
  };
  return html`<div class="new-team">
    <h3>New ${labels.team}</h3>
    <label for="new-team-name">Name</label>
    <input id="new-team-name" value=${name} disabled=${busy} onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)} />
    <label for="new-team-allocation">Allocation</label>
    <input id="new-team-allocation" class=${`money${allocation == null ? " invalid" : ""}`} inputmode="decimal" value=${allocationText} disabled=${busy}
      onInput=${(e: Event) => setAllocationText((e.target as HTMLInputElement).value)} />
    <p class="small" aria-live="polite">${
      name.trim() !== "" && !check.ok
        ? html`<span class="warn">${check.reason}</span>`
        : over
          ? html`<strong class="warn">${`That's more than the ${formatUsd(headroom)} not yet allocated.`}</strong>`
          : null
    }</p>
    <button disabled=${!check.ok || allocation == null || over || busy} onClick=${create}>Create ${labels.team}</button>
  </div>`;
}

export function TeamsSection({ store }: { store: Store }): VNode {
  const labels = store.labels.value;
  const manage = store.canManage.value;
  const rows = teamRows(store.teams.value, store.meters.value, store.allMachines.value);
  const remove = (row: TeamRow) => {
    const people = row.memberCount === 1 ? `1 ${labels.member} leaves` : `${row.memberCount} ${plural(labels.member)} leave`;
    // The delete doesn't stop them; with nothing left on the allocation, the meter does.
    const machines = row.running === 0 ? "" : ` Its ${row.running} running ${row.running === 1 ? "machine" : "machines"} will be stopped.`;
    const message = `Delete ${row.name}? Its ${people} the ${labels.team}, and its ${formatUsd(row.allocation)} allocation returns to the ${labels.project}.${machines}`;
    if (window.confirm(message)) void store.deleteTeam(row.teamId);
  };
  return html`<section class="card">
    <h2>${capitalize(plural(labels.team))} (${rows.length})</h2>
    ${rows.length === 0
      ? html`<p class="muted">${`No ${plural(labels.team)} yet.`}</p>`
      : html`<table class="teams">
          <thead><tr>
            <th scope="col">Name</th><th scope="col">${capitalize(plural(labels.member))}</th><th scope="col">Allocation</th>
            <th scope="col">Spent</th><th scope="col">Remaining</th>${manage ? html`<th scope="col"><span class="visually-hidden">Actions</span></th>` : null}
          </tr></thead>
          <tbody>${rows.map(
            (row) => html`<tr key=${row.teamId} class=${`band-${row.band}`}>
              <${TeamName} store=${store} row=${row} editable=${manage} />
              <td>${row.memberCount}</td>
              <${TeamAllocation} store=${store} row=${row} editable=${manage} />
              <td>${formatUsd(row.spent)}</td>
              <td>${formatUsd(row.remaining)}</td>
              ${manage
                ? html`<td><button class="link danger" disabled=${store.isBusy(`team:${row.teamId}`)} onClick=${() => remove(row)}>Delete</button></td>`
                : null}
            </tr>`,
          )}</tbody>
        </table>`}
    ${manage ? html`<${NewTeam} store=${store} />` : null}
  </section>`;
}
