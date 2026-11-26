// The workspace's saves on the project page: the caller's own and their team's, each newest
// first, with the current one marked. A save can be named (and renamed, or its name removed),
// and restored, which writes a new current save from it and deletes nothing then (later saves follow
// the usual retention: the confirmation says so). The page offers a
// restore only while none of the caller's machines is running (a running machine writes to both
// workspaces), and asks first.

import type { VNode } from "preact";
import { useState } from "preact/hooks";
import type { ListSnapshotsResponse, SnapshotArea } from "@sbgpu/api";
import { canRestore, checkSaveName, restoreBlockedText, restoreConfirmText, saveRows, type SaveRow } from "../saves.ts";
import { html } from "./html.ts";
import type { Store } from "./store.ts";

function SaveName({ store, area, list, row }: { store: Store; area: SnapshotArea; list: ListSnapshotsResponse; row: SaveRow }): VNode {
  const [text, setText] = useState<string | null>(null);
  const busy = store.isBusy(`save-name:${row.id}`);
  const label = row.name ?? "this save";
  if (text == null) {
    return html`<td>
      ${row.name ? html`<span class="save-name">${row.name}</span> ` : null}
      <button class="link" aria-label=${row.name ? `Rename ${label}` : `Name the save from ${row.when}`} disabled=${busy} onClick=${() => setText(row.name ?? "")}>
        ${row.name ? "Rename" : "Name"}
      </button>
      ${row.name
        ? html` <button class="link" aria-label=${`Remove the name ${row.name}`} disabled=${busy} onClick=${() => void store.nameSave(area, row.id, null)}>Remove name</button>`
        : null}
    </td>`;
  }
  const check = checkSaveName(text, list, row.id);
  const save = async () => {
    if (!check.ok) return;
    if (check.name === row.name || (await store.nameSave(area, row.id, check.name))) setText(null);
  };
  return html`<td>
    <input aria-label=${`Name for the save from ${row.when}`} value=${text} disabled=${busy}
      onInput=${(e: Event) => setText((e.target as HTMLInputElement).value)}
      onKeyDown=${(e: KeyboardEvent) => (e.key === "Enter" ? void save() : e.key === "Escape" ? setText(null) : undefined)} />
    <button disabled=${!check.ok || busy} onClick=${save}>Save name</button>
    <button class="secondary" onClick=${() => setText(null)}>Cancel</button>
    ${check.ok || text.trim() === "" ? null : html`<span class="warn small">${check.reason}</span>`}
  </td>`;
}

function SavesCard({ store, area, title, list }: { store: Store; area: SnapshotArea; title: string; list: ListSnapshotsResponse }): VNode {
  const labels = store.labels.value;
  const rows = saveRows(list.items, store.now());
  const restorable = canRestore(store.machines.value);
  const restoring = store.isBusy(`restore:${area}`);
  const restore = (row: SaveRow) => {
    if (window.confirm(restoreConfirmText(row, area, labels, list.keepLast))) void store.restoreSave(area, row.id);
  };
  return html`<section class="card saves" data-area=${area}>
    <h2>${title}</h2>
    <p class="muted small">
      ${`The newest ${list.keepLast} unnamed saves are kept, and every named one (up to ${list.namedMax}). Name a save to keep it.`}
    </p>
    ${rows.length === 0
      ? html`<p class="muted">No saves yet. A machine saves your work while it runs and when it stops.</p>`
      : html`<table class="saves">
          <thead><tr><th scope="col">When</th><th scope="col">How</th><th scope="col">Size</th><th scope="col">Name</th><th scope="col"><span class="visually-hidden">Restore</span></th></tr></thead>
          <tbody>${rows.map(
            (row) => html`<tr key=${row.id} class=${row.current ? "current" : ""}>
              <td><time datetime=${row.createdAt} title=${row.createdAt}>${row.when}</time>${row.current ? html` <span class="badge">Current</span>` : null}</td>
              <td>${row.kind}</td>
              <td class="nowrap">${row.size}</td>
              <${SaveName} store=${store} area=${area} list=${list} row=${row} />
              <td>${row.current || !restorable
                ? null
                : html`<button class="secondary" disabled=${restoring} aria-label=${`Restore the save from ${row.when}`} onClick=${() => restore(row)}>Restore</button>`}</td>
            </tr>`,
          )}</tbody>
        </table>`}
    ${rows.length > 1 && !restorable ? html`<p class="small">${restoreBlockedText(labels)}</p>` : null}
    ${restoring ? html`<p class="small" role="status">Restoring… Your machines can't start until it finishes.</p>` : null}
  </section>`;
}

export function SavesSection({ store }: { store: Store }): VNode | null {
  const { member, team } = store.saves.value;
  const labels = store.labels.value;
  if (member == null && team == null) return null;
  return html`<div class="saves-areas">
    ${member ? html`<${SavesCard} store=${store} area="member" title="Your saves" list=${member} />` : null}
    ${team ? html`<${SavesCard} store=${store} area="team" title=${`Your ${labels.team}'s saves`} list=${team} />` : null}
  </div>`;
}

/** "Save with a name…" on a running machine's card: a name for the save it makes now. */
export function SaveWithName({ store, machineId }: { store: Store; machineId: string }): VNode {
  const [text, setText] = useState<string | null>(null);
  const member = store.saves.value.member;
  const busy = store.isBusy(`save:${machineId}`);
  if (text == null) return html`<button class="secondary" disabled=${busy} onClick=${() => setText("")}>Save with a name…</button>`;
  const check = member ? checkSaveName(text, member, null) : ({ ok: false, reason: "" } as const);
  // (once the save starts, the card swaps this for its progress, so nothing here closes the field)
  const save = () => (check.ok ? void store.saveNamed(machineId, check.name) : undefined);
  return html`<span class="save-with-name">
    <input aria-label="Name for this save" value=${text} disabled=${busy}
      onInput=${(e: Event) => setText((e.target as HTMLInputElement).value)}
      onKeyDown=${(e: KeyboardEvent) => (e.key === "Enter" ? void save() : e.key === "Escape" ? setText(null) : undefined)} />
    <button disabled=${!check.ok || busy} onClick=${save}>Save now</button>
    <button class="secondary" onClick=${() => setText(null)}>Cancel</button>
    ${check.ok || text.trim() === "" || check.reason === "" ? null : html`<span class="warn small">${check.reason}</span>`}
  </span>`;
}

