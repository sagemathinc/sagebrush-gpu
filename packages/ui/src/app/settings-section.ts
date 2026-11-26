// A manager's project settings: the name, the project's own words, and the policy. The
// form is filled when the section mounts (once per project: the page shows Loading in
// between), so polling never overwrites what is being typed; Save sends only what changed
// (settings.ts).

import type { VNode } from "preact";
import { useState } from "preact/hooks";
import { LOCALITY_PRESETS, PROVIDER_IDS, type LocalityPreset, type ProviderId } from "@sbgpu/api";
import { GENERIC_LABELS, capitalize, type LabelKey } from "../labels.ts";
import { FIELD_NAMES, GIB_FIELDS, WHOLE_FIELDS, settingsForm, settingsRequest, type SettingsForm } from "../settings.ts";
import { html } from "./html.ts";
import type { Store } from "./store.ts";

export const LOCALITY_NAMES: { readonly [K in LocalityPreset]: string } = {
  any: "Anywhere",
  europe: "Europe (the EU, the rest of the EEA, and the UK)",
  uk: "The UK",
  eu: "The EU",
  us: "The US",
  ca: "Canada",
};

const value = (e: Event) => (e.target as HTMLInputElement).value;

export function SettingsSection({ store }: { store: Store }): VNode | null {
  const project = store.project.value;
  const [base, setBase] = useState(() => (project ? settingsForm(project) : null));
  const [form, setForm] = useState(() => (base ? structuredClone(base) : null));
  const [saved, setSaved] = useState(false);
  if (base == null || form == null) return null;
  const busy = store.isBusy("settings");

  // From the latest form, not this render's: two quick changes must both stick. (While a
  // save is in flight every field is disabled: its answer refills the form, which would
  // silently drop an edit made meanwhile.)
  const edit = (change: (f: SettingsForm) => void) => {
    setForm((current) => {
      const next = structuredClone(current);
      if (next !== null) change(next);
      return next;
    });
    setSaved(false);
  };
  const req = settingsRequest(form, base);
  const unchanged = req.ok && Object.keys(req.value).length === 0;
  const save = async () => {
    if (!req.ok || unchanged) return;
    if (!(await store.updateProject(req.value))) return;
    const fresh = store.project.value;
    if (fresh != null) {
      const filled = settingsForm(fresh);
      setBase(filled);
      setForm(structuredClone(filled));
    }
    setSaved(true);
  };
  const status = !req.ok ? html`<span class="warn">${req.reason}</span>` : saved && unchanged ? "Saved." : unchanged ? "No changes." : null;

  const number = (id: string, label: string, text: string, set: (f: SettingsForm, v: string) => void) =>
    html`<label for=${id}>${label}</label>
      <input disabled=${busy} id=${id} inputmode="decimal" value=${text} onInput=${(e: Event) => edit((f) => set(f, value(e)))} />`;

  return html`<details class="card settings">
    <summary><h2>Settings</h2></summary>
    <label for="settings-name">Name</label>
    <input disabled=${busy} id="settings-name" value=${form.name} onInput=${(e: Event) => edit((f) => (f.name = value(e)))} />

    <fieldset>
      <legend>Words</legend>
      <label><input disabled=${busy} type="checkbox" id="settings-custom-labels" checked=${form.customLabels}
        onChange=${(e: Event) => edit((f) => (f.customLabels = (e.target as HTMLInputElement).checked))} /> Use this project's own words</label>
      ${form.customLabels
        ? (Object.keys(GENERIC_LABELS) as LabelKey[]).map(
            (k) => html`<label for=${`settings-label-${k}`}>${capitalize(GENERIC_LABELS[k])}</label>
              <input disabled=${busy} id=${`settings-label-${k}`} value=${form.labels[k]} onInput=${(e: Event) => edit((f) => (f.labels[k] = value(e)))} />`,
          )
        : html`<p class="muted small">The generic words: project, member, manager, assistant, team.</p>`}
    </fieldset>

    <fieldset>
      <legend>Machines</legend>
      <label for="settings-gpu-types">${FIELD_NAMES.allowedGpuTypes}</label>
      <input disabled=${busy} id="settings-gpu-types" value=${form.allowedGpuTypes} onInput=${(e: Event) => edit((f) => (f.allowedGpuTypes = value(e)))} />
      <p class="muted small">GPU type names, separated by commas. With none, nothing can start.</p>
      <p>${FIELD_NAMES.allowedProviders}</p>
      ${PROVIDER_IDS.map(
        (id: ProviderId) => html`<label><input disabled=${busy} type="checkbox" id=${`settings-provider-${id}`} checked=${form.allowedProviders.includes(id)}
          onChange=${(e: Event) =>
            edit((f) => {
              const on = (e.target as HTMLInputElement).checked;
              f.allowedProviders = PROVIDER_IDS.filter((p) => (p === id ? on : f.allowedProviders.includes(p)));
            })} /> ${id}</label>`,
      )}
      <label for="settings-locality">${FIELD_NAMES.locality}</label>
      <select disabled=${busy} id="settings-locality" value=${form.locality} onChange=${(e: Event) => edit((f) => (f.locality = value(e) as LocalityPreset))}>
        ${LOCALITY_PRESETS.map((l) => html`<option value=${l}>${LOCALITY_NAMES[l]}</option>`)}
      </select>
      <label for="settings-countries">${FIELD_NAMES.allowedCountries}</label>
      <input disabled=${busy} id="settings-countries" value=${form.allowedCountries} onInput=${(e: Event) => edit((f) => (f.allowedCountries = value(e)))} />
      <p class="muted small">Two-letter country codes such as GB, SE. Empty for no further limit.</p>
      ${number("settings-price", `${FIELD_NAMES.maxPricePerHour} ($)`, form.maxPricePerHour, (f, v) => (f.maxPricePerHour = v))}
      ${WHOLE_FIELDS.map((k) => number(`settings-${k}`, FIELD_NAMES[k], form.whole[k], (f, v) => (f.whole[k] = v)))}
      ${number("settings-maxGpusPerTeam", FIELD_NAMES.maxGpusPerTeam, form.maxGpusPerTeam, (f, v) => (f.maxGpusPerTeam = v))}
      <p class="muted small">Counted in GPUs across a team's members. Empty for one per member.</p>
      ${GIB_FIELDS.map((k) => number(`settings-${k}`, FIELD_NAMES[k], form.gib[k], (f, v) => (f.gib[k] = v)))}
      <label for="settings-setup-script">${FIELD_NAMES.setupScript}</label>
      <textarea disabled=${busy} id="settings-setup-script" rows="4" value=${form.setupScript} onInput=${(e: Event) => edit((f) => (f.setupScript = value(e)))}></textarea>
      <p class="muted small">Runs on each new machine, for example pip install peft datasets. Empty for none.</p>
    </fieldset>

    <p class="small" aria-live="polite">${status}</p>
    <div class="actions">
      <button disabled=${!req.ok || unchanged || busy} onClick=${save}>Save changes</button>
      <button class="secondary" disabled=${unchanged || busy} onClick=${() => {
        setForm(structuredClone(base));
        setSaved(false);
      }}>Discard changes</button>
    </div>
  </details>`;
}
