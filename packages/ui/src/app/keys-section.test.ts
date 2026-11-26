// An organization's provider keys on its page, in a DOM (happy-dom), against the mock: the
// rows the design's review asked for first (the field empty while a request is held, the
// window counted from the request's start, malformed windows, stale completions, the race
// with an abort, and the request path apart from the shared client's), then the rest.

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Window } from "happy-dom";
import { CREDENTIAL_REFUSALS, ERROR_STATUS, RECENT_AUTH_WINDOW_MS, type CredentialRefusal } from "@sbgpu/api";
import { mockFingerprint } from "../mock/backend.ts";
import { seedDemo } from "../mock/seed.ts";
import { installDom, mountApp, settle, unmountAll } from "./domkit.ts";
import { reauthHref } from "./keys-section.ts";
import { KEY_REFUSAL_WORDS, KEY_REMOVED_WORDS, KEY_SAVED_WORDS, KEY_STATUS_WORDS } from "./provider-keys.ts";
import { controllable, FakeTimers } from "./testkit.ts";

let win: Window;
before(() => {
  win = installDom();
});
afterEach(() => unmountAll());
after(async () => {
  await win.happyDOM.close();
});

const EMAILS = seedDemo().emails;
/** A distinctive key: found anywhere it shouldn't be, it's this. */
const KEY = "sk_live_ZQX9!kq~unique";

/** Two byok organizations the seed's owner owns (the manager views the first), the owner signed in, the first one's page open. */
async function keysPage(email = EMAILS.owner) {
  const t = await controllable(email);
  const b = t.demo.backend;
  const user = (e: string) => [...b.users.values()].find((u) => u.email === e)!;
  const orgA = b.addOrg("Own keys org", 0, 1_000_000_000, "byok");
  const orgB = b.addOrg("Second keys org", 0, 1_000_000_000, "byok");
  for (const org of [orgA, orgB]) b.setOrgRole(org.id, user(EMAILS.owner).id, "owner");
  b.setOrgRole(orgA.id, user(EMAILS.manager).id, "viewer");
  await t.store.loadMe();
  const page = mountApp(win, t.store, `/o/${orgA.id}`, new FakeTimers());
  await settle();
  const row = (provider: string) => page.q(`li.key-row[data-provider="${provider}"]`);
  const input = (provider: string) => row(provider)?.querySelector("input") as unknown as HTMLInputElement | null;
  const button = (provider: string, label: string) =>
    ([...(row(provider)?.querySelectorAll("button") ?? [])] as unknown as HTMLButtonElement[]).find((x) => x.textContent === label) ?? null;
  /** Type a key and press the row's save (or replace) button; the click's handler runs to its end before this returns. */
  const submit = (provider: string, key = KEY) => {
    page.type(input(provider), key);
    (button(provider, "Save key") ?? button(provider, "Replace key"))!.click();
  };
  const keysLog = () => t.log.filter((l) => l.startsWith("KEYS "));
  const puts = () => keysLog().filter((l) => l.startsWith("KEYS PUT"));
  /** Everything the page holds outside the DOM, as text. */
  const state = () =>
    JSON.stringify({
      rows: t.store.keys.rows.value,
      notices: t.store.keys.notices.value,
      pending: [...t.store.keys.pending.value],
      me: t.store.me.value,
      error: t.store.error.value,
      org: t.store.org.value,
      href: win.location.href,
      history: win.history.state,
      local: Object.entries(win.localStorage),
      session: Object.entries(win.sessionStorage),
    });
  /** The key is nowhere: not in the page's text or markup, any field, the store, the URL, storage or the shared client. */
  const noKey = (what: string) => {
    assert.doesNotMatch(page.text(), /sk_live/, `${what}: text`);
    assert.doesNotMatch((page.root as unknown as HTMLElement).innerHTML, /sk_live/, `${what}: markup`);
    for (const el of page.qa<HTMLInputElement>("input")) assert.equal(el.value.includes("sk_live"), false, `${what}: a field`);
    assert.doesNotMatch(state(), /sk_live/, `${what}: state`);
    assert.equal(t.clientBodies.some((x) => x.includes("sk_live")), false, `${what}: the shared client`);
  };
  return { t, b, orgA, orgB, page, row, input, button, submit, keysLog, puts, state, noKey, user };
}

const refusalResponse = (r: CredentialRefusal) => () =>
  Response.json({ error: { code: CREDENTIAL_REFUSALS[r].code, message: CREDENTIAL_REFUSALS[r].message } }, { status: ERROR_STATUS[CREDENTIAL_REFUSALS[r].code] });

// ---------------------------------------------------------------- H1: held fetch

test("held PUT: the field is already empty when the request goes, the key is nowhere, and a second save starts nothing", async () => {
  const k = await keysPage();
  const field = k.input("shadeform")!;
  assert.deepEqual(
    ["type", "autocomplete", "spellcheck", "autocapitalize"].map((a) => field.getAttribute(a)),
    ["password", "off", "false", "off"],
  );
  assert.doesNotMatch(field.getAttribute("name") ?? "", /password/);
  assert.equal(field.closest("form"), null, "not in a form");
  const release = k.t.gate(/PUT .*\/credentials\/shadeform$/);
  k.submit("shadeform");
  // Synchronously after the click: the request has started and the field is already empty.
  assert.deepEqual(k.puts(), [`KEYS PUT /v1/orgs/${k.orgA.id}/credentials/shadeform`]);
  assert.equal(k.input("shadeform")!.value, "");
  await settle();
  assert.equal(k.t.store.keys.pending.value.has("shadeform"), true, "still held");
  assert.equal(k.input("shadeform")!.value, "");
  assert.equal(k.input("shadeform")!.disabled, true);
  assert.equal(k.button("shadeform", "Save key")!.disabled, true);
  k.noKey("while held");
  // A second save, from the page or the store, starts no request.
  k.page.type(k.input("shadeform"), KEY + "2");
  k.button("shadeform", "Save key")!.click();
  assert.equal(await k.t.store.keys.put("shadeform", JSON.stringify({ key: KEY })), false);
  await settle();
  assert.equal(k.puts().length, 1);
  release();
  await settle();
  assert.match(k.row("shadeform")!.textContent!, new RegExp(`${KEY_STATUS_WORDS.ok} · fingerprint ${mockFingerprint(KEY)} · set by ${EMAILS.owner}`));
  assert.match(k.row("shadeform")!.textContent!, new RegExp(KEY_SAVED_WORDS));
  assert.equal(k.input("shadeform")!.value, "");
  k.noKey("after");
});

test("the request path is the keys' own: the shared client never sees a credentials request or a key", async () => {
  const k = await keysPage();
  k.submit("shadeform");
  await settle();
  assert.equal(k.b.credentials.get(`${k.orgA.id}|shadeform`)?.fingerprint, mockFingerprint(KEY), "the key reached the server");
  assert.equal(k.t.log.some((l) => /credentials/.test(l) && !l.startsWith("KEYS ")), false);
  assert.equal(k.t.clientBodies.some((x) => x.includes("sk_live") || x.includes('"key"')), false);
  assert.ok(k.t.signals.length >= 2 && k.t.signals.every((s) => s instanceof AbortSignal), "every keys request has its abort");
  assert.deepEqual(k.keysLog(), [`KEYS GET /v1/orgs/${k.orgA.id}/credentials`, `KEYS PUT /v1/orgs/${k.orgA.id}/credentials/shadeform`]);
});

// ---------------------------------------------------------------- H2: the window

test("the window counts from just before /me was sent: a slow answer doesn't stretch it", async () => {
  const k = await keysPage();
  const release = k.t.gate(/GET \/v1\/me\?orgId=/);
  const sentAt = k.t.mono();
  const loading = k.t.store.keys.refreshWindow();
  k.t.advanceMono(2_000); // the answer takes two seconds to arrive
  release();
  await loading;
  await settle();
  assert.equal(k.t.store.keys.windowOpen.value, true);
  // One timer, to the server's end counted from the request's start: 298 s from now, not 300.
  assert.deepEqual(k.t.keyTimers.delays(), [RECENT_AUTH_WINDOW_MS - 2_000]);
  k.page.type(k.input("shadeform"), "typed, not saved");
  const field = k.input("shadeform")!;
  k.t.advanceMono(sentAt + RECENT_AUTH_WINDOW_MS - 1 - k.t.mono());
  await k.t.keyTimers.run(); // (early: it waits the last millisecond)
  assert.equal(k.t.store.keys.windowOpen.value, true);
  assert.deepEqual(k.t.keyTimers.delays(), [1]);
  k.t.advanceMono(1);
  await k.t.keyTimers.run();
  await settle();
  assert.equal(k.t.store.keys.windowOpen.value, false);
  assert.equal(k.input("shadeform"), null, "the field is gone");
  assert.equal(field.value, "", "and was emptied as it went");
  const link = k.row("shadeform")!.querySelector("a") as unknown as HTMLAnchorElement;
  assert.equal(link.textContent, "Confirm it's you to change keys");
  assert.equal(link.getAttribute("href"), reauthHref(k.orgA.id));
  assert.equal(reauthHref(k.orgA.id), `/v1/auth/start?reauth=1&return=%2Fo%2F${k.orgA.id}`);
  assert.deepEqual(k.t.keyTimers.delays(), []);
});

test("the window is the shown organization's: read with its orgId, closed on leaving, and a late answer for one left changes nothing", async () => {
  const k = await keysPage();
  await settle();
  assert.ok(k.t.log.includes(`GET /v1/me?orgId=${k.orgA.id}`), "read for the organization shown");
  assert.equal(k.t.log.includes("GET /v1/me?orgId=" + k.orgB.id), false);
  assert.equal(k.t.store.keys.windowOpen.value, true);
  k.t.store.keys.leave();
  assert.equal(k.t.store.keys.windowOpen.value, false, "leaving closes it");
  // A read for A still in flight when the page moves to an organization they don't own: its answer is dropped.
  const notOwned = k.b.addOrg("Viewer only", 0, 1_000_000, "byok");
  k.b.setOrgRole(notOwned.id, [...k.b.users.values()].find((u) => u.email === EMAILS.owner)!.id, "viewer");
  await k.t.store.keys.open(k.orgA.id);
  assert.equal(k.t.store.keys.windowOpen.value, true);
  const release = k.t.gate(new RegExp(`GET /v1/me\\?orgId=${k.orgA.id}`));
  const late = k.t.store.keys.refreshWindow();
  await k.t.store.keys.open(notOwned.id);
  assert.equal(k.t.store.keys.windowOpen.value, false, "the viewer's organization has no window");
  release();
  await late;
  assert.equal(k.t.store.keys.windowOpen.value, false, "A's late answer doesn't open it for another organization");
  // An older read for the same organization, answered after a newer one, changes nothing either.
  await k.t.store.keys.open(k.orgA.id);
  const stale = k.t.gate(new RegExp(`GET /v1/me\\?orgId=${k.orgA.id}`));
  const older = k.t.store.keys.refreshWindow(); // (its answer, computed now, says the window is open)
  k.b.advance(RECENT_AUTH_WINDOW_MS); // the server's window then ends
  await k.t.store.keys.open(k.orgA.id); // left and opened again: this read says closed
  assert.equal(k.t.store.keys.windowOpen.value, false);
  stale();
  await older;
  assert.equal(k.t.store.keys.windowOpen.value, false, "the older answer doesn't reopen it");
  k.b.signInAs(EMAILS.owner); // (a fresh sign-in opens the server's window again)
  // A failed read closes it.
  await k.t.store.keys.open(k.orgA.id);
  assert.equal(k.t.store.keys.windowOpen.value, true);
  k.t.respondOnce(/GET \/v1\/me\?orgId=/, () => Response.json({ error: { code: "internal", message: "x" } }, { status: 500 }));
  await k.t.store.keys.refreshWindow();
  assert.equal(k.t.store.keys.windowOpen.value, false);
});

test("a recentAuthForMs that isn't an integer from 0 to five minutes means the window is closed", async () => {
  const k = await keysPage();
  const me = JSON.stringify(k.b.request("GET", "/v1/me", { orgId: k.orgA.id }, undefined).body);
  assert.equal(k.t.store.keys.windowOpen.value, true);
  for (const raw of ["null", "-1", "1.5", "300001", '"300000"', "1e999", "-1e999", "[]", "{}"]) {
    // Open it again (a good answer), then the bad one.
    await k.t.store.loadMe();
    assert.equal(k.t.store.keys.windowOpen.value, true, raw);
    k.t.respondOnce(/GET \/v1\/me\?orgId=/, () => new Response(me.replace(/"recentAuthForMs":\d+/, `"recentAuthForMs":${raw}`), { headers: { "content-type": "application/json" } }));
    await k.t.store.loadMe();
    await settle();
    assert.equal(k.t.store.keys.windowOpen.value, false, raw);
    assert.equal(k.input("shadeform"), null, raw);
  }
  await k.t.store.loadMe();
  k.t.respondOnce(/GET \/v1\/me\?orgId=/, () => Response.json({ ...JSON.parse(me), recentAuthForMs: undefined }));
  await k.t.store.loadMe();
  assert.equal(k.t.store.keys.windowOpen.value, false, "missing");
  // A /me that fails closes it too.
  await k.t.store.loadMe();
  k.t.failOnce(new TypeError("offline"));
  await k.t.store.loadMe();
  assert.equal(k.t.store.keys.windowOpen.value, false, "a failed /me");
  for (const v of [Number.NaN, Infinity, 0]) {
    k.t.store.keys.setWindow(k.t.mono(), v);
    assert.equal(k.t.store.keys.windowOpen.value, false, String(v)); // (0: nothing left)
  }
  k.t.store.keys.setWindow(k.t.mono(), 1);
  assert.equal(k.t.store.keys.windowOpen.value, true, "a millisecond left is open");
  assert.deepEqual(k.t.keyTimers.delays(), [1]);
});

test("a reauthenticate answer closes the window, and the page asks to confirm it's you", async () => {
  const k = await keysPage();
  k.t.respondOnce(/PUT .*\/credentials\/vast$/, refusalResponse("reauthenticate"));
  k.submit("vast");
  await settle();
  assert.equal(k.t.store.keys.windowOpen.value, false);
  assert.equal(k.input("vast"), null);
  assert.match(k.row("vast")!.textContent!, /Confirm it's you to change keys/);
  assert.match(k.row("vast")!.textContent!, new RegExp(KEY_REFUSAL_WORDS.reauthenticate));
  k.noKey("reauthenticate");
  // With the window closed, the store sends nothing either.
  const n = k.keysLog().length;
  assert.equal(await k.t.store.keys.put("vast", "{}"), false);
  assert.equal(await k.t.store.keys.remove("vast"), false);
  assert.equal(k.keysLog().length, n);
});

// ---------------------------------------------------------------- H3: stale completions and aborts

for (const outcome of ["success", "refusal"] as const) {
  test(`a held ${outcome} that answers after a switch to another organization changes nothing there`, async () => {
    const k = await keysPage();
    if (outcome === "refusal") k.b.keyCheck = () => "rejected";
    const release = k.t.gate(/PUT .*\/credentials\/hyperstack$/);
    k.submit("hyperstack");
    await settle();
    const signal = k.t.signals.at(-1)!;
    k.page.show(`/o/${k.orgB.id}`);
    await settle();
    assert.equal(signal.aborted, true, "the switch aborted it");
    const before = k.state();
    release();
    await settle();
    assert.equal(k.state(), before, "nothing changed");
    assert.equal(k.t.store.keys.orgId.value, k.orgB.id);
    assert.doesNotMatch(k.page.text(), new RegExp(`${KEY_SAVED_WORDS}|${KEY_REFUSAL_WORDS.rejected}`));
    assert.deepEqual(k.t.store.keys.rows.value!.map((r) => r.status), ["none", "none", "none"]);
    k.noKey("after the switch");
    // The server may have made the change: the first organization, opened again, is read again.
    const reads = k.keysLog().filter((l) => l === `KEYS GET /v1/orgs/${k.orgA.id}/credentials`).length;
    k.page.show(`/o/${k.orgA.id}`);
    await settle();
    assert.equal(k.keysLog().filter((l) => l === `KEYS GET /v1/orgs/${k.orgA.id}/credentials`).length, reads + 1);
    const status = outcome === "success" ? KEY_STATUS_WORDS.ok : KEY_STATUS_WORDS.none;
    assert.match(k.row("hyperstack")!.textContent!, new RegExp(`^Hyperstack ?${status}`));
    assert.doesNotMatch(k.page.text(), new RegExp(`${KEY_SAVED_WORDS}|${KEY_REFUSAL_WORDS.rejected}`), "no old words either");
  });
}

for (const how of ["switching back", "remounting"] as const) {
  test(`a held answer from before ${how} to the same organization is ignored there`, async () => {
    const k = await keysPage();
    k.t.abortWins = false;
    const release = k.t.gate(/PUT .*\/credentials\/shadeform$/);
    k.submit("shadeform");
    await settle();
    let page = k.page;
    if (how === "switching back") {
      page.show(`/o/${k.orgB.id}`);
      await settle();
      page.show(`/o/${k.orgA.id}`);
    } else {
      page.unmount();
      page = mountApp(win, k.t.store, `/o/${k.orgA.id}`, new FakeTimers());
    }
    await settle();
    assert.equal(k.t.store.keys.orgId.value, k.orgA.id);
    release();
    await settle();
    // (the server did save it, and the fresh read says so; the old answer adds nothing)
    assert.deepEqual(k.t.store.keys.notices.value, {});
    assert.deepEqual([...k.t.store.keys.pending.value], []);
    assert.doesNotMatch(page.text(), new RegExp(KEY_SAVED_WORDS));
  });
}

test("the race with the abort: an answer that arrives anyway is still ignored", async () => {
  const k = await keysPage();
  k.t.abortWins = false;
  const release = k.t.gate(/PUT .*\/credentials\/shadeform$/);
  k.submit("shadeform");
  await settle();
  // The switch and the answer, in the same moment.
  k.page.show(`/o/${k.orgB.id}`);
  release();
  await settle();
  assert.equal(k.t.store.keys.orgId.value, k.orgB.id);
  assert.deepEqual(k.t.store.keys.rows.value!.map((r) => [r.status, r.fingerprint]), [["none", null], ["none", null], ["none", null]]);
  assert.deepEqual(k.t.store.keys.notices.value, {});
  assert.deepEqual([...k.t.store.keys.pending.value], []);
  k.noKey("race");
});

test("unmount aborts too: a held answer afterwards changes nothing, and the list read for the old organization is dropped", async () => {
  const k = await keysPage();
  k.t.abortWins = false;
  const release = k.t.gate(/PUT .*\/credentials\/vast$/);
  k.submit("vast");
  await settle();
  k.page.unmount();
  assert.equal(k.t.signals.at(-1)!.aborted, true);
  release();
  await settle();
  assert.deepEqual([k.t.store.keys.orgId.value, k.t.store.keys.rows.value, k.t.store.keys.notices.value], [null, null, {}]);
  // A list read held across a switch is dropped as well.
  k.b.credentials.set(`${k.orgA.id}|vast`, { fingerprint: "aaaaaaaa", setBy: EMAILS.owner, setAt: k.b.now(), lastCheckedAt: k.b.now(), status: "ok" });
  const page = mountApp(win, k.t.store, `/o/${k.orgA.id}`, new FakeTimers());
  const releaseList = k.t.gate(/GET .*\/credentials$/);
  await settle();
  page.show(`/o/${k.orgB.id}`);
  releaseList(); // (A's list, if it were held; B's read isn't held)
  await settle();
  assert.equal(k.t.store.keys.orgId.value, k.orgB.id);
  assert.deepEqual(k.t.store.keys.rows.value!.map((r) => r.fingerprint), [null, null, null], "B's own list, not A's");
});

test("an answer naming another provider is not this request's: no row changes, and the page says it didn't understand", async () => {
  const k = await keysPage();
  const crossed = { provider: "vast", status: "ok", fingerprint: "c0ffee00", setBy: EMAILS.owner, setAt: "2027-02-01T09:00:00.000Z", lastCheckedAt: "2027-02-01T09:00:00.000Z", runningMachines: 0 };
  const rows = JSON.stringify(k.t.store.keys.rows.value);
  k.t.respondOnce(/PUT .*\/credentials\/shadeform$/, () => Response.json(crossed));
  k.submit("shadeform");
  await settle();
  assert.equal(JSON.stringify(k.t.store.keys.rows.value), rows, "no row changed");
  assert.deepEqual(k.t.store.keys.notices.value, { shadeform: KEY_REFUSAL_WORDS.badResponse });
  assert.doesNotMatch(k.page.text(), new RegExp(`${KEY_SAVED_WORDS}|c0ffee00`));
  assert.match(k.row("vast")!.textContent!, new RegExp(`^Vast\\.ai ?${KEY_STATUS_WORDS.none}`));
  assert.equal(k.t.store.keys.windowOpen.value, true);
  k.noKey("crossed");
});

for (const outcome of ["held", "success", "refusal", "network"] as const) {
  test(`removal empties a key typed into the row, before the request goes and when it ends (${outcome})`, async () => {
    const k = await keysPage();
    k.submit("vast");
    await settle();
    const field = k.input("vast")!;
    k.page.type(field, "sk_live_unsaved_replacement");
    k.button("vast", "Remove")!.click();
    await settle();
    assert.equal(field.value, "sk_live_unsaved_replacement", "(only a removal empties it)");
    const release = outcome === "held" ? k.t.gate(/DELETE .*\/credentials\/vast\?id=crd_[0-9a-z]{20}&version=\d+$/) : null;
    if (outcome === "refusal") k.t.respondOnce(/DELETE .*\/credentials\/vast\?id=crd_[0-9a-z]{20}&version=\d+$/, refusalResponse("busy"));
    if (outcome === "network") k.t.failOnce(new TypeError("offline"));
    k.button("vast", "Remove key")!.click();
    // Synchronously: the request has gone, and the field is already empty.
    assert.equal(k.keysLog().filter((l) => l.startsWith("KEYS DELETE")).length, 1);
    assert.equal(field.value, "");
    await settle();
    if (release) {
      assert.equal(k.t.store.keys.pending.value.has("vast"), true);
      k.noKey("held DELETE");
      // Anything put in the field meanwhile is emptied when the request ends.
      k.page.type(field, "sk_live_typed_while_held");
      release();
      await settle();
    }
    assert.equal(field.value, "");
    k.noKey(outcome);
    const words = { held: KEY_REMOVED_WORDS, success: KEY_REMOVED_WORDS, refusal: KEY_REFUSAL_WORDS.busy, network: KEY_REFUSAL_WORDS.network }[outcome];
    assert.match(k.row("vast")!.textContent!, new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("a list read that started before a save ended doesn't undo the save: it's discarded and read again", async () => {
  const k = await keysPage();
  const reads = () => k.keysLog().filter((l) => l.startsWith("KEYS GET")).length;
  // A save with no answer reads the list again; that read is held, its snapshot already made.
  const releaseList = k.t.gate(/GET .*\/credentials$/);
  k.t.failOnce(new TypeError("offline"));
  k.submit("shadeform");
  await settle();
  assert.equal(reads(), 2);
  // Meanwhile Vast.ai is saved.
  k.submit("vast");
  await settle();
  assert.match(k.row("vast")!.textContent!, new RegExp(`^Vast\\.ai ?${KEY_STATUS_WORDS.ok}`));
  const releaseReread = k.t.gate(/GET .*\/credentials$/); // (the read again, held: the page in between)
  releaseList();
  await settle();
  assert.equal(reads(), 3, "the old snapshot is read again");
  assert.match(k.row("vast")!.textContent!, new RegExp(`^Vast\\.ai ?${KEY_STATUS_WORDS.ok}`), "the old snapshot was discarded, not shown");
  releaseReread();
  await settle();
  assert.match(k.row("vast")!.textContent!, new RegExp(`^Vast\\.ai ?${KEY_STATUS_WORDS.ok}`));
  assert.equal(k.t.store.keys.rows.value!.find((r) => r.provider === "vast")!.fingerprint, mockFingerprint(KEY));
});

test("a removal while an older list read is held: the removal's re-read isn't lost, and the old snapshot doesn't bring the key back", async () => {
  const k = await keysPage();
  k.submit("vast");
  await settle();
  const reads = () => k.keysLog().filter((l) => l.startsWith("KEYS GET")).length;
  const releaseList = k.t.gate(/GET .*\/credentials$/);
  k.t.failOnce(new TypeError("offline"));
  k.submit("shadeform");
  await settle();
  const before = reads();
  k.button("vast", "Remove")!.click();
  await settle();
  k.button("vast", "Remove key")!.click();
  await settle();
  assert.equal(k.b.credentials.has(`${k.orgA.id}|vast`), false, "removed on the server");
  releaseList();
  await settle();
  assert.equal(reads(), before + 1, "read again once the old read ended");
  assert.match(k.row("vast")!.textContent!, new RegExp(`^Vast\\.ai ?${KEY_STATUS_WORDS.none}`));
  assert.equal(k.t.store.keys.rows.value!.find((r) => r.provider === "vast")!.fingerprint, null);
});

// ---------------------------------------------------------------- outcomes and words

test("every refusal shows the page's own words, never the server's; the field is empty after each, and nothing is retried", async () => {
  const k = await keysPage();
  const refusals: CredentialRefusal[] = ["rejected", "checkUnavailable", "busy", "tooManyChecks", "badShape", "unknownProvider", "notOwner", "notByok"];
  for (const r of refusals) {
    k.t.respondOnce(/PUT .*\/credentials\/shadeform$/, refusalResponse(r));
    const n = k.puts().length;
    k.submit("shadeform");
    await settle();
    assert.equal(k.puts().length, n + 1, `${r}: sent once`);
    assert.match(k.row("shadeform")!.textContent!, new RegExp(KEY_REFUSAL_WORDS[r].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), r);
    assert.equal(k.input("shadeform")!.value, "", r);
    k.noKey(r);
  }
  // A server that echoes the key: its words are never shown.
  k.t.respondOnce(/PUT .*\/credentials\/shadeform$/, () => Response.json({ error: { code: "badRequest", message: `bad key ${KEY}` } }, { status: 400 }));
  k.submit("shadeform");
  await settle();
  assert.match(k.row("shadeform")!.textContent!, /The server's answer wasn't one this page understands/);
  k.noKey("echo");
  // No answer at all: said once, not retried, and the list read again (the change may have been made).
  const reads = k.keysLog().filter((l) => l.startsWith("KEYS GET")).length;
  k.t.failOnce(new TypeError(`fetch failed for ${KEY}`));
  const n = k.puts().length;
  k.submit("shadeform");
  await settle();
  assert.equal(k.puts().length, n + 1);
  assert.match(k.row("shadeform")!.textContent!, /The server didn't answer/);
  assert.equal(k.keysLog().filter((l) => l.startsWith("KEYS GET")).length, reads + 1);
  k.noKey("network");
  assert.equal(k.b.credentials.size, 0);
  // Another organization's rows start with no words from this one.
  k.page.show(`/o/${k.orgB.id}`);
  await settle();
  assert.deepEqual(k.t.store.keys.notices.value, {});
  assert.doesNotMatch(k.page.text(), /The server didn't answer/);
});

test("signedOut ends the session", async () => {
  const k = await keysPage();
  k.t.respondOnce(/PUT .*\/credentials\/shadeform$/, refusalResponse("signedOut"));
  k.submit("shadeform");
  await settle();
  assert.equal(k.t.store.me.value, null);
  assert.equal(k.t.store.keys.windowOpen.value, false);
  assert.equal(k.t.store.keys.orgId.value, null);
});

test("a key that isn't one is refused on the page, and nothing is sent", async () => {
  const k = await keysPage();
  for (const bad of ["", "a b", "kéy", "x".repeat(4097), " sk_live_lead"]) {
    k.submit("shadeform", bad);
    await settle();
    assert.equal(k.input("shadeform")!.value, "", JSON.stringify(bad.slice(0, 10)));
    assert.match(k.row("shadeform")!.textContent!, /That isn't a key/);
  }
  assert.deepEqual(k.puts(), []);
  k.submit("shadeform", "x".repeat(4096));
  await settle();
  assert.equal(k.puts().length, 1, "the longest key is sent");
});

// ---------------------------------------------------------------- who sees it, the list, removal

test("only an owner of a byok organization sees the section; others make no request for it", async () => {
  const k = await keysPage();
  assert.match(k.page.text(), /Provider keys/);
  assert.deepEqual(
    k.t.store.keys.rows.value!.map((r) => r.provider),
    ["shadeform", "hyperstack", "vast"],
    "RunPod isn't offered (it's behind the mock's test flag)",
  );
  for (const p of ["shadeform", "hyperstack", "vast"]) assert.match(k.row(p)!.textContent!, new RegExp(`${KEY_STATUS_WORDS.none}`));
  k.page.unmount();
  // The seed's own organization is resold: its owner sees no keys.
  const before = k.keysLog().length;
  const resold = mountApp(win, k.t.store, `/o/${k.t.demo.orgId}`, new FakeTimers());
  await settle();
  assert.doesNotMatch(resold.text(), /Provider keys/);
  resold.unmount();
  assert.equal(k.keysLog().length, before);
  // A viewer of the byok organization sees none either.
  const v = await keysPage(EMAILS.manager);
  assert.match(v.page.text(), /Own keys org/);
  assert.doesNotMatch(v.page.text(), /Provider keys/);
  assert.deepEqual(v.keysLog(), []);
  // With the flag, the server lists RunPod, and so does the page.
  const r = await keysPage();
  r.b.runpodKeys = true;
  r.page.show(`/o/${r.orgB.id}`);
  await settle();
  assert.ok(r.row("runpod"), "RunPod listed");
});

test("each status in words, with the fingerprint, who set it, and a warning when the provider no longer takes it", async () => {
  const k = await keysPage();
  const at = Date.parse("2027-01-15T10:30:00.000Z");
  for (const [provider, status] of [["shadeform", "revoked"], ["hyperstack", "error"], ["vast", "unchecked"]] as const) {
    k.b.credentials.set(`${k.orgB.id}|${provider}`, { fingerprint: "0badf00d", setBy: EMAILS.owner, setAt: at, lastCheckedAt: at, status });
  }
  k.page.show(`/o/${k.orgB.id}`);
  await settle();
  assert.match(k.row("shadeform")!.textContent!, /Revoked at the provider · fingerprint 0badf00d · set by owner@example\.org on 2027-01-15 · last checked 2027-01-15 10:30 UTC/);
  assert.match(k.row("shadeform")!.textContent!, /New machines can't start on Shadeform\. Machines still running there can't be stopped by us now/);
  assert.match(k.row("hyperstack")!.textContent!, /Couldn't be checked/);
  assert.match(k.row("hyperstack")!.textContent!, /Hyperstack keeps billing your account/);
  assert.match(k.row("vast")!.textContent!, /Set, not checked yet/);
  assert.doesNotMatch(k.row("vast")!.textContent!, /keeps billing/);
});

test("removal: a confirmation first, which says what happens to machines still running; nothing is sent until it's confirmed", async () => {
  const k = await keysPage();
  k.submit("vast");
  await settle();
  k.button("vast", "Remove")!.click();
  await settle();
  assert.match(k.row("vast")!.textContent!, /Remove the Vast\.ai key\? New machines can't start on Vast\.ai from then on\./);
  assert.equal(k.button("vast", "Remove")!.disabled, true);
  k.button("vast", "Keep it")!.click();
  await settle();
  assert.equal(k.keysLog().some((l) => l.startsWith("KEYS DELETE")), false);
  k.button("vast", "Remove")!.click();
  await settle();
  // The removal names the key as listed: its id and version.
  const listed = k.t.store.keys.rows.value!.find((r) => r.provider === "vast")!;
  assert.match(listed.id ?? "", /^crd_/);
  k.button("vast", "Remove key")!.click();
  await settle();
  assert.deepEqual(k.keysLog().filter((l) => l.startsWith("KEYS DELETE")), [`KEYS DELETE /v1/orgs/${k.orgA.id}/credentials/vast?id=${listed.id}&version=${listed.version}`]);
  assert.match(k.row("vast")!.textContent!, new RegExp(`^Vast\\.ai ?${KEY_STATUS_WORDS.none}`));
  assert.match(k.page.text(), new RegExp(KEY_REMOVED_WORDS));
  assert.equal(k.b.credentials.size, 0);

  // With machines still running on the provider.
  k.b.offers = k.b.offers.filter((o) => o.provider !== "runpod");
  const project = k.b.addProject(k.orgA.id, {
    name: "Own keys lab",
    budget: 500_000_000,
    startsAt: "2027-01-01T00:00:00.000Z",
    endsAt: "2027-12-01T00:00:00.000Z",
    policy: { allowedGpuTypes: ["L4"], allowedProviders: ["hyperstack"] },
  });
  const me = k.b.currentUserId;
  const startOne = async (email: string) => {
    const u = k.user(email);
    k.b.addMember(project.id, { email: u.email, userId: u.id, allocation: 25_000_000 });
    k.b.currentUserId = u.id;
    assert.equal(k.b.request("POST", `/v1/projects/${project.id}/machines`, {}, { gpuType: "L4" }).status, 200);
    k.b.currentUserId = me;
    k.page.show(`/o/${k.orgB.id}`);
    await settle();
    k.page.show(`/o/${k.orgA.id}`); // (read again, with the machines)
    await settle();
  };
  k.submit("hyperstack");
  await settle();
  await startOne(EMAILS.member);
  k.button("hyperstack", "Remove")!.click();
  await settle();
  assert.match(
    k.row("hyperstack")!.textContent!,
    /1 machine is still running on Hyperstack\. Stop it first, from its project's pages, while the key still works\. If you remove the key anyway, we will no longer be able to stop it: Hyperstack keeps billing your account until you terminate it in its console/,
  );
  assert.ok(k.button("hyperstack", "Remove anyway"));
  k.button("hyperstack", "Keep it and stop them first")!.click();
  await settle();
  await startOne(EMAILS.teamMember);
  k.button("hyperstack", "Remove")!.click();
  await settle();
  assert.match(
    k.row("hyperstack")!.textContent!,
    /2 machines are still running on Hyperstack\. Stop them first, from their projects' pages, while the key still works\. If you remove the key anyway, we will no longer be able to stop them: Hyperstack keeps billing your account until you terminate them in its console/,
  );
  k.button("hyperstack", "Keep it and stop them first")!.click();
  await settle();
  assert.equal(k.keysLog().filter((l) => l.startsWith("KEYS DELETE")).length, 1);
  k.button("hyperstack", "Remove")!.click();
  await settle();
  k.button("hyperstack", "Remove anyway")!.click();
  await settle();
  assert.equal(k.keysLog().filter((l) => l.startsWith("KEYS DELETE")).length, 2);
  assert.equal(k.b.credentials.size, 0);
});

test("a replace and a removal name the key as listed: changed meanwhile by another owner, they're busy and change nothing", async () => {
  const k = await keysPage();
  k.submit("vast");
  await settle();
  // The page replaces the key it lists (id and version), so a replace goes through.
  k.submit("vast", "sk_live_second_key");
  await settle();
  const listed = k.t.store.keys.rows.value!.find((r) => r.provider === "vast")!;
  assert.equal(listed.version, 2);
  // Another owner replaces it now; this page still lists version 2.
  const rec = k.b.credentials.get(`${k.orgA.id}|vast`)!;
  rec.version = 3;
  k.submit("vast", "sk_live_third_key");
  await settle();
  assert.match(k.row("vast")!.textContent!, new RegExp(KEY_REFUSAL_WORDS.busy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(k.b.credentials.get(`${k.orgA.id}|vast`)!.version, 3, "the stale replace changed nothing");
  k.button("vast", "Remove")!.click();
  await settle();
  k.button("vast", "Remove key")!.click();
  await settle();
  assert.equal(k.b.credentials.size, 1, "the stale removal removed nothing");
  k.noKey("stale changes");
});

test("removing a provider's key when none is listed sends nothing", async () => {
  const k = await keysPage();
  assert.equal(await k.t.store.keys.remove("hyperstack"), false);
  assert.equal(k.keysLog().some((l) => l.startsWith("KEYS DELETE")), false);
  assert.equal(k.t.store.keys.notices.value.hyperstack, undefined, "and says nothing");
  assert.equal(k.t.store.keys.pending.value.has("hyperstack"), false);
});

test("a removal after a replace names the replaced key's version", async () => {
  const k = await keysPage();
  k.submit("vast");
  await settle();
  k.submit("vast", "sk_live_second_key");
  await settle();
  k.button("vast", "Remove")!.click();
  await settle();
  k.button("vast", "Remove key")!.click();
  await settle();
  assert.match(k.keysLog().filter((l) => l.startsWith("KEYS DELETE"))[0] ?? "", /&version=2$/);
  assert.equal(k.b.credentials.size, 0, "removed");
});
