// An organization's provider keys, on its page: for its owners, under byok only. The key
// field is uncontrolled. At submit, the page reads the key, checks its shape, builds the one
// request body, empties the field and hands the body over, all before anything is awaited.
// The key is never in state, the URL, storage or an error; every outcome shows fixed words.

import type { VNode } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ROUTES, isCredentialKeyShape, type ProviderCredential, type ProviderId } from "@sbgpu/api";
import { html } from "./html.ts";
import { KEY_STATUS_WORDS, type ProviderKeys } from "./provider-keys.ts";

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = Object.freeze({
  runpod: "RunPod",
  shadeform: "Shadeform",
  hyperstack: "Hyperstack",
  nebius: "Nebius",
  vast: "Vast.ai",
});

/** The sign-in that opens the window: a fresh authentication, then back to this organization. */
export function reauthHref(orgId: string): string {
  return `${ROUTES.startSignIn.path}?reauth=1&return=${encodeURIComponent(`/o/${encodeURIComponent(orgId)}`)}`;
}

function KeyRow({ keys, orgId, row }: { keys: ProviderKeys; orgId: string; row: ProviderCredential }): VNode {
  const field = useRef<HTMLInputElement | null>(null);
  // Whenever the field goes (the window closes, the row or the page goes), it's emptied first:
  // a removed element keeps its value otherwise.
  const bind = useCallback((el: HTMLInputElement | null) => {
    if (el == null && field.current) field.current.value = "";
    field.current = el;
  }, []);
  const [confirming, setConfirming] = useState(false);
  const open = keys.windowOpen.value;
  const pending = keys.pending.value.has(row.provider);
  const name = PROVIDER_NAMES[row.provider];

  const save = () => {
    const input = field.current;
    if (input == null) return;
    // (in this order, before anything is awaited: read, check, build the body, empty the field,
    // hand the body over; put() sends nothing while this row has a request in flight)
    const value = input.value;
    if (!isCredentialKeyShape(value)) {
      input.value = "";
      keys.refuseLocally(row.provider, "badShape");
      return;
    }
    const body = JSON.stringify({ key: value });
    input.value = "";
    void keys.put(row.provider, body).then(() => {
      if (field.current) field.current.value = "";
    });
  };
  const remove = () => {
    setConfirming(false);
    void keys.remove(row.provider);
  };

  const status = KEY_STATUS_WORDS[row.status];
  const notice = keys.notices.value[row.provider];
  const set = row.status !== "none";
  return html`<li class="key-row" data-provider=${row.provider}>
    <h3>${name}</h3>
    <p>
      <span class=${`status status-${row.status}`}>${status}</span>
      ${set ? html` · fingerprint <code>${row.fingerprint}</code>` : null}
      ${set && row.setBy != null ? html` · set by ${row.setBy}${row.setAt != null ? ` on ${row.setAt.slice(0, 10)}` : ""}` : null}
      ${row.lastCheckedAt != null ? html` · last checked ${row.lastCheckedAt.slice(0, 16).replace("T", " ")} UTC` : null}
    </p>
    ${row.status === "revoked" || row.status === "error" || row.status === "rejected"
      ? html`<p class="warn">${`New machines can't start on ${name}. Machines still running there can't be stopped by us now: stop or terminate them in ${name}'s console (their names start with "sbg-"). ${name} keeps billing your account until you do.`}</p>`
      : null}
    ${open
      ? html`<div class="key-change">
          <input
            ref=${bind}
            type="password"
            name=${`provider-key-${row.provider}`}
            autocomplete="off"
            spellcheck="false"
            autocapitalize="off"
            aria-label=${`${set ? "New key" : "Key"} for ${name}`}
            disabled=${pending}
            onKeyDown=${(e: KeyboardEvent) => e.key === "Enter" && save()}
          />
          <button disabled=${pending} onClick=${save}>${set ? "Replace key" : "Save key"}</button>
          ${set ? html`<button class="secondary" disabled=${pending || confirming} onClick=${() => setConfirming(true)}>Remove</button>` : null}
          <p class="muted small">Use a dedicated key you can revoke at any time, with no more access than starting, listing and stopping machines.</p>
        </div>`
      : html`<p><a href=${reauthHref(orgId)}>Confirm it's you to change keys</a></p>`}
    ${confirming && open
      ? html`<div class="confirm" role="alertdialog" aria-label=${`Remove the ${name} key?`}>
          <p>${`Remove the ${name} key? New machines can't start on ${name} from then on.`}</p>
          ${row.runningMachines > 0
            ? html`<p class="warn">${`${row.runningMachines} ${row.runningMachines === 1 ? "machine is" : "machines are"} still running on ${name}. Stop ${row.runningMachines === 1 ? "it" : "them"} first, from ${row.runningMachines === 1 ? "its project's" : "their projects'"} pages, while the key still works. If you remove the key anyway, we will no longer be able to stop ${row.runningMachines === 1 ? "it" : "them"}: ${name} keeps billing your account until you terminate ${row.runningMachines === 1 ? "it" : "them"} in its console (look for names that start with "sbg-").`}</p>`
            : null}
          <button class="danger" disabled=${pending} onClick=${remove}>${row.runningMachines > 0 ? "Remove anyway" : "Remove key"}</button>
          <button class="secondary" onClick=${() => setConfirming(false)}>${row.runningMachines > 0 ? "Keep it and stop them first" : "Keep it"}</button>
        </div>`
      : null}
    ${notice ? html`<p class="notice small" role="status">${notice}</p>` : null}
  </li>`;
}

export function KeysSection({ keys, orgId }: { keys: ProviderKeys; orgId: string }): VNode {
  useEffect(() => {
    void keys.open(orgId);
    return () => keys.leave();
  }, [keys, orgId]);
  const rows = keys.orgId.value === orgId ? keys.rows.value : null;
  const listNotice = keys.notices.value.list;
  return html`<section class="card keys">
    <h2>Provider keys</h2>
    <p>
      Your organization's machines run on its own provider accounts, with these keys. We store them encrypted and use them only on our servers, to
      start and stop machines. A key is never shown again, never sent to a machine, and never kept in this page.
    </p>
    ${listNotice ? html`<p class="warn small" role="status">${listNotice}</p>` : null}
    ${rows == null
      ? listNotice
        ? null
        : html`<p class="muted">Loading…</p>`
      : rows.length === 0
        ? html`<p class="muted">No provider takes keys here yet.</p>`
        : html`<ul class="keys">${rows.map((r) => html`<${KeyRow} key=${r.provider} keys=${keys} orgId=${orgId} row=${r} />`)}</ul>`}
  </section>`;
}
