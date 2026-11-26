// Launches paused for a provider (the organization's own key is rejected, revoked or failing),
// on the project page: who sees what, the quote and start text naming the provider, and the
// banner following the pause as it begins and ends.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import type { CredentialStatus, ProviderId } from "@sbgpu/api";
import { installDom, mountApp, settle, unmountAll } from "./domkit.ts";
import { controllable, FakeTimers } from "./testkit.ts";

let win: Window;
before(() => {
  win = installDom();
});
afterEach(() => unmountAll());
after(async () => {
  await win.happyDOM.close();
});

/** The seeded project, its organization on its own keys, with `paused` providers' keys in a pausing status. */
async function pausedWorld(email: string | undefined, paused: Array<[ProviderId, CredentialStatus]>) {
  return pausedWorldWith(await controllable(email, {}, { billingMode: "byok" }), paused);
}

async function pausedWorldWith(t: Awaited<ReturnType<typeof controllable>>, paused: Array<[ProviderId, CredentialStatus]>) {
  const b = t.demo.backend;
  for (const provider of ["runpod", "hyperstack"] as const) {
    b.credentials.set(`${t.demo.orgId}|${provider}`, { fingerprint: "0badf00d", setBy: t.demo.emails.owner, setAt: b.now(), lastCheckedAt: b.now(), status: "ok" });
  }
  b.advance(5 * 60_000);
  for (const [provider, status] of paused) b.setKeyStatus(t.demo.orgId, provider, status);
  b.advance(3 * 60_000);
  const timers = new FakeTimers();
  const page = mountApp(win, t.store, `/p/${t.demo.projectId}`, timers);
  await settle();
  return { t, b, page, timers };
}

const HEADLINE = "Launches on RunPod are paused for this organization. Machines already running keep running.";
const REASON = /The organization's RunPod key was revoked at the provider; last checked 3 min ago\./;

test("a member sees that launches on the provider are paused, and since when, but not why", async () => {
  const { t, page } = await pausedWorld(undefined, [["runpod", "revoked"]]);
  const banner = page.q("[aria-label='Paused providers']");
  assert.ok(banner, "the banner shows");
  assert.match(page.text(), new RegExp(HEADLINE.replace(/\./g, "\\.")));
  assert.match(page.text(), /Paused 3 min ago\./);
  assert.doesNotMatch(page.text(), /revoked|refused|key was|last checked/i);
  assert.equal(page.text().includes("Replace the key"), false);
  assert.equal(page.text().includes("An owner of the organization"), false);
  // The server left the reason out for a member, so the store never had it.
  assert.deepEqual(t.store.paused.value.map((p) => Object.keys(p).sort()), [["provider", "since"]]);
});

test("member redaction holds even if a reason reaches the page: the screen shows it to manager and above only", async () => {
  const { t, page } = await pausedWorld(undefined, [["runpod", "revoked"]]);
  // As if a server sent the reason to a member: the page still leaves it out.
  t.store.paused.value = [{ provider: "runpod", since: t.store.paused.value[0]!.since, detail: { status: "revoked", lastCheckedAt: t.store.paused.value[0]!.since } }];
  await settle();
  assert.match(page.text(), /Launches on RunPod are paused/);
  assert.doesNotMatch(page.text(), /revoked|last checked/i);
});

test("a manager sees why, and that an owner can replace the key", async () => {
  const { t, page } = await pausedWorld(controllableEmail("manager"), [["runpod", "revoked"]]);
  assert.match(page.text(), REASON);
  assert.match(page.text(), /An owner of the organization can replace the key\./);
  assert.equal(page.text().includes("Replace the key on the organization's page"), false);
  assert.equal(t.store.paused.value[0]?.detail?.status, "revoked");
});

test("an owner of the organization sees why, with a link to replace the key on the organization's page", async () => {
  const { t, page } = await pausedWorld(controllableEmail("owner"), [["runpod", "error"]]);
  assert.match(page.text(), /The organization's RunPod key couldn't be checked; last checked 3 min ago\./);
  const link = page.qa<HTMLAnchorElement>("a").find((a) => a.textContent === "Replace the key on the organization's page");
  assert.ok(link, "the link shows");
  assert.equal(link!.getAttribute("href"), `/o/${t.demo.orgId}`);
});

test("an assistant sees only that launches are paused", async () => {
  const { page } = await pausedWorld(controllableEmail("assistant"), [["runpod", "rejected"]]);
  assert.match(page.text(), /Launches on RunPod are paused/);
  assert.doesNotMatch(page.text(), /refused by the provider|last checked/i);
  assert.equal(page.text().includes("An owner of the organization"), false);
});

test("a manager who only views the organization gets no owner's link", async () => {
  const t0 = await controllable(controllableEmail("manager"), {}, { billingMode: "byok" });
  const mgr = [...t0.demo.backend.users.values()].find((u) => u.email === controllableEmail("manager"))!;
  t0.demo.backend.setOrgRole(t0.demo.orgId, mgr.id, "viewer");
  await t0.store.sessionStarted(); // (reloads who the user is: now a viewer of the organization)
  assert.deepEqual(t0.store.me.value?.orgs.map((o) => [o.orgId, o.role]), [[t0.demo.orgId, "viewer"]]);
  const { page } = await pausedWorldWith(t0, [["runpod", "revoked"]]);
  assert.match(page.text(), /An owner of the organization can replace the key\./);
  assert.equal(page.text().includes("Replace the key on the organization's page"), false);
});

test("the quote names the paused provider; a type still offered elsewhere starts there", async () => {
  const { page } = await pausedWorld(undefined, [["runpod", "revoked"]]);
  const row = (gpu: string) => page.qa("tr").find((r) => r.textContent?.includes(gpu)) ?? null;
  // A100-80GB is offered on RunPod only: refused, naming RunPod.
  assert.match(row("A100-80GB")?.textContent ?? "", /Launches on RunPod are paused: the organization's key for it isn't working\./);
  // L4 is offered on Hyperstack too: it can still start, at Hyperstack's price.
  assert.equal(row("L4")?.querySelector("button")?.disabled, false);
  assert.doesNotMatch(row("L4")?.textContent ?? "", /paused/);
});

test("a start refused because the provider was paused meanwhile names the provider", async () => {
  const { t, b, page } = await pausedWorld(undefined, []);
  assert.equal(page.q("[aria-label='Paused providers']"), null, "no banner yet");
  // Both of L4's providers are paused after the page quoted it.
  b.setKeyStatus(t.demo.orgId, "runpod", "revoked");
  b.setKeyStatus(t.demo.orgId, "hyperstack", "rejected");
  const start = page.qa<HTMLButtonElement>("tr").find((r) => r.textContent?.includes("L4"))?.querySelector("button");
  start!.click();
  await settle();
  assert.equal(t.store.error.value, "Launches on RunPod are paused for this organization until its key works again.");
  assert.match(page.q("[role='alert']")?.textContent ?? "", /Launches on RunPod are paused for this organization until its key works again\./);
  assert.ok(t.log.some((l) => /^POST .*\/machines$/.test(l)), "the start was sent");
});

test("the banner follows the pause: it shows when a pause begins and goes when it ends, at the next poll", async () => {
  const { t, b, page, timers } = await pausedWorld(undefined, []);
  assert.equal(page.q("[aria-label='Paused providers']"), null);
  b.setKeyStatus(t.demo.orgId, "hyperstack", "revoked");
  await timers.run();
  await settle();
  assert.match(page.text(), /Launches on Hyperstack are paused/);
  b.setKeyStatus(t.demo.orgId, "hyperstack", "ok");
  await timers.run();
  await settle();
  assert.equal(page.q("[aria-label='Paused providers']"), null);
});

test("two paused providers: one line each, in provider order", async () => {
  const { page } = await pausedWorld(undefined, [["hyperstack", "error"], ["runpod", "revoked"]]);
  const lines = page.qa("[aria-label='Paused providers'] strong").map((s) => s.textContent);
  assert.deepEqual(lines, [HEADLINE, "Launches on Hyperstack are paused for this organization. Machines already running keep running."]);
});

test("a project switch and a sign-out clear the paused providers at once", async () => {
  const { t } = await pausedWorld(undefined, [["runpod", "revoked"]]);
  assert.equal(t.store.paused.value.length, 1);
  const switching = t.store.openProject(t.otherId);
  assert.deepEqual(t.store.paused.value, [], "cleared before the other project loads");
  await switching;
  await t.store.openProject(t.demo.projectId);
  assert.equal(t.store.paused.value.length, 1);
  await t.store.signOut();
  assert.deepEqual(t.store.paused.value, []);
});

function controllableEmail(role: "owner" | "manager" | "assistant"): string {
  return { owner: "owner@example.org", manager: "manager@example.org", assistant: "assistant@example.org" }[role];
}
