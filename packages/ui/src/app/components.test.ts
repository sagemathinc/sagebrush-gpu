// The screens rendered to HTML in Node, from a store filled by the mock backend.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { createClient } from "../client.ts";
import { mockFetch } from "../mock/fetch.ts";
import { seedDemo } from "../mock/seed.ts";
import { App, GpuRow, html, MeterCard, ProjectPage, type Nav } from "./components.ts";
import { GENERIC_LABELS } from "../labels.ts";
import { Store } from "./store.ts";
import { signInAs } from "./testkit.ts";

const MIN = 60_000;

function nav(path: string, search = "?mock=1"): Nav {
  return { path, search, go: () => {} };
}

/** Visible text, roughly: tags dropped, whitespace collapsed, entities decoded. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function memberStore(email?: string) {
  const demo = seedDemo();
  const store = new Store(createClient({ fetch: mockFetch(demo.backend) }), () => demo.backend.now());
  await signInAs(store, demo.backend, email ?? demo.emails.member);
  await store.openProject(demo.projectId);
  return { demo, store };
}

test("before /me loads: a loading page; signed out: one sign-in link, with demo accounts only when given", async () => {
  const demo = seedDemo();
  const store = new Store(createClient({ fetch: mockFetch(demo.backend) }));
  assert.match(text(renderToString(html`<${App} store=${store} nav=${nav("/")} />`)), /Loading/);
  await store.loadMe();
  const out = renderToString(html`<${App} store=${store} nav=${nav("/")} />`);
  assert.equal(text(out), "sagebrush-gpu Sign in Sign in with your Sagebrush account");
  assert.match(out, /<a class="button" href="\/v1\/auth\/start">/);
  assert.doesNotMatch(out, /<form|<input|role="status"|role="alert"/);
  assert.doesNotMatch(renderToString(html`<${App} store=${store} nav=${nav("/")} demoAccounts=${[]} />`), /Demo accounts/);
  // Signed out on a deeper page: come back to it.
  assert.match(renderToString(html`<${App} store=${store} nav=${nav("/p/prj_1/manage")} />`), /href="\/v1\/auth\/start\?return=%2Fp%2Fprj_1%2Fmanage"/);
  const withDemo = renderToString(
    html`<${App} store=${store} nav=${nav("/")} demoAccounts=${[{ label: "A member", email: "ada@example.org", signIn: async () => {} }]} />`,
  );
  assert.match(text(withDemo), /Demo accounts \(mock data\) A member ada@example.org/);
  assert.doesNotMatch(withDemo, /Sign out/);
});

test("the sign-in screen says why it is showing; only a passing failure offers Try again", async () => {
  const demo = seedDemo();
  const store = new Store(createClient({ fetch: mockFetch(demo.backend) }));
  await store.loadMe();
  const shown = () => {
    const out = renderToString(html`<${App} store=${store} nav=${nav("/")} />`);
    const notice = /<p class="([^"]*)" role="status">([^<]*)<\/p>/.exec(out);
    const link = /<a class="button"[^>]*>([^<]*)<\/a>/.exec(out);
    return [notice?.[1], notice?.[2]?.replace(/&#39;|&apos;/g, "'"), link?.[1]];
  };
  store.signInNotice.value = "refused";
  assert.deepEqual(shown(), [
    "notice warn",
    "This Sagebrush account hasn't been invited to a project here. Ask whoever runs your project to invite the email address you use with Sagebrush.",
    "Sign in with your Sagebrush account",
  ]);
  store.signInNotice.value = "error";
  assert.deepEqual(shown(), ["notice warn", "Signing in didn't work.", "Try again"]);
  store.signInNotice.value = "expired";
  assert.deepEqual(shown(), ["notice warn", "Signing in took too long or was interrupted.", "Try again"]);
  store.signInNotice.value = "unavailable";
  assert.deepEqual(shown(), ["notice warn", "Signing in isn't possible at the moment.", "Try again"]);
  store.signInNotice.value = "signedOut";
  assert.deepEqual(shown(), ["notice", "Signed out of sagebrush-gpu.", "Sign in with your Sagebrush account"]);
});

test("home lists the user's projects with links that keep ?mock=1", async () => {
  const { demo, store } = await memberStore();
  const out = renderToString(html`<${App} store=${store} nav=${nav("/")} />`);
  assert.match(out, new RegExp(`href="/p/${demo.projectId}\\?mock=1"`));
  assert.match(text(out), /Your projects Fine-tuning lab member/);
  assert.match(text(out), /ada@example.org Sign out/);
  const nowhere = text(renderToString(html`<${App} store=${store} nav=${nav("/nope")} />`));
  assert.match(nowhere, /Not found/);
});

test("project page: meters, prices with their split, and why a type can't start", async () => {
  const { store } = await memberStore();
  const out = renderToString(html`<${ProjectPage} store=${store} projectId=${store.projectId.value} />`);
  const t = text(out);
  assert.match(t, /Fine-tuning lab Course · you are a student/);
  assert.match(t, /Your allocation Remaining \$25\.00 Used \$0\.00 of \$25\.00/);
  assert.match(t, /Your team's allocation Remaining \$50\.00/);
  assert.match(t, /1× L4 24 GB \$0\.62\/h provider \$0\.48 \+ service \$0\.14 Start/);
  assert.match(t, /1× A6000 48 GB \$1\.03\/h provider \$0\.79 \+ service \$0\.24 Few left Start/);
  assert.match(t, /Over the course's price limit\./);
  assert.match(t, /No capacity right now\./);
  assert.match(t, /None yet\. Start one above\./);
  assert.equal((out.match(/<button disabled/g) ?? []).length, 2); // A100-80GB and A10
  assert.doesNotMatch(t, /Held for the final save/);
});

test("a running machine: actions, cost, and the reserve on the meter", async () => {
  const { demo, store } = await memberStore();
  await store.start("L4");
  demo.backend.advance(30 * MIN);
  await store.refresh();
  const t = text(renderToString(html`<${ProjectPage} store=${store} projectId=${store.projectId.value} />`));
  assert.match(t, /1× L4 Running runpod · EU-SE-1 · provider \$0\.48\/h \+ service \$0\.14\/h = \$0\.62\/h/);
  assert.match(t, /Cost so far: \$0\.31 · started 28 min ago/);
  assert.match(t, /Open Jupyter Save now Stop/);
  assert.match(t, /Held for the final save \$0\.11/); // reserveCharge: 11 ledger minutes
  assert.match(t, /Now: provider \$0\.48\/h \+ service \$0\.14\/h = \$0\.62\/h\. About 1 d 15 h left at \$0\.62\/h\./);
  assert.match(t, /Too many machines running\. Stop one first\./); // one machine per member
});

test("saving and stopped machines say what is happening and why", async () => {
  const { demo, store } = await memberStore();
  await store.start("L4");
  demo.backend.advance(90_000);
  const id = store.machines.value[0]?.id as string;
  await store.stop(id);
  demo.backend.advance(3000);
  await store.refresh();
  let t = text(renderToString(html`<${ProjectPage} store=${store} projectId=${store.projectId.value} />`));
  assert.match(t, /Saving before stop/);
  assert.match(t, /Saving workspace: 50%/);
  assert.match(t, /You stopped it\./);
  assert.doesNotMatch(t, /Open Jupyter|Save now/);
  demo.backend.advance(MIN);
  await store.refresh();
  t = text(renderToString(html`<${ProjectPage} store=${store} projectId=${store.projectId.value} />`));
  assert.match(t, /Stopped .* Last saved just now\. You stopped it\. Start again Delete/);
});

test("a hard stop is explained, and an empty allocation is called out", async () => {
  const demo = seedDemo();
  const store = new Store(createClient({ fetch: mockFetch(demo.backend) }), () => demo.backend.now());
  await signInAs(store, demo.backend, demo.emails.manager);
  const grace = [...demo.backend.members.values()].find((m) => m.email === demo.emails.lowMember);
  assert.ok(grace);
  await store.client.call("setMemberAllocation", { params: { projectId: demo.projectId, memberId: grace.id }, body: { amount: 400_000 } });
  await signInAs(store, demo.backend, demo.emails.lowMember);
  await store.openProject(demo.projectId);
  await store.start("L4");
  demo.backend.advance(40 * MIN);
  await store.refresh();
  const t = text(renderToString(html`<${ProjectPage} store=${store} projectId=${store.projectId.value} />`));
  assert.match(t, /Stopped because the allocation was nearly used up\./);
  assert.match(t, /Remaining \$0\.12 Used \$0\.28 of \$0\.40/);
  assert.match(t, /Last saved 12 min ago\./);
  assert.match(t, /Not enough allocation left to start\./);
});

test("meter card: an empty allocation", () => {
  const out = text(
    renderToString(
      html`<${MeterCard} title="Your allocation" now=${Date.parse("2027-02-01T10:00:00.000Z")} meter=${{
        allocationId: "alc_1",
        holder: { kind: "member", memberId: "mbr_1" },
        amount: 1_000_000,
        spent: { providerCost: 800_000, margin: 240_000, total: 1_040_000 },
        reserved: 0,
        remaining: 0,
        currentRatePerHour: { providerCost: 0, margin: 0, total: 0 },
        storage: { usedBytes: 1536, quotaBytes: 1024 ** 3 },
        asOf: "2027-02-01T09:57:00.000Z",
      }} />`,
    ),
  );
  assert.match(out, /Remaining \$0\.00 Used \$1\.04 of \$1\.00 Storage 1\.5 KB of 1\.0 GB/);
  assert.match(out, /This allocation is used up\. Ask a manager for more\./);
  assert.match(out, /Updated 3 min ago\./);
});

test("an error banner shows the last failure", async () => {
  const { store } = await memberStore();
  await store.start("A10");
  const out = renderToString(html`<${App} store=${store} nav=${nav("/")} />`);
  assert.match(out, /role="alert"/);
  assert.match(text(out), /cannot start: noCapacity Dismiss/);
});

test("a stop without a save and a provider failure are both shown", async () => {
  const { demo, store } = await memberStore();
  await store.start("L4");
  demo.backend.advance(90_000);
  const id = store.machines.value[0]?.id as string;
  await signInAs(store, demo.backend, demo.emails.manager);
  await store.client.call("stopMachine", { params: { machineId: id }, body: { save: false } });
  await signInAs(store, demo.backend, demo.emails.member);
  demo.backend.advance(MIN);
  await store.refresh();
  let t = text(renderToString(html`<${ProjectPage} store=${store} projectId=${store.projectId.value} />`));
  assert.match(t, /Stopped by an instructor\. The final save didn't finish; work after the last save was lost\./);
  await store.restart(id);
  demo.backend.advance(90_000);
  demo.backend.failMachine(id, "GPU host lost");
  await store.refresh();
  t = text(renderToString(html`<${ProjectPage} store=${store} projectId=${store.projectId.value} />`));
  assert.match(t, /Failed .* GPU host lost Stop Delete/);
  assert.doesNotMatch(t, /didn't finish/);
});

test("save now keeps Jupyter open and hides Save now", async () => {
  const { demo, store } = await memberStore();
  await store.start("L4");
  demo.backend.advance(90_000);
  await store.save(store.machines.value[0]?.id as string);
  const t = text(renderToString(html`<${ProjectPage} store=${store} projectId=${store.projectId.value} />`));
  assert.match(t, /Running, saving .* Saving workspace: 0% .* Open Jupyter Stop/);
  assert.doesNotMatch(t, /Save now/);
});

test("an assistant's page names their role", async () => {
  const demo = seedDemo();
  const { store } = await memberStore(demo.emails.assistant);
  assert.match(text(renderToString(html`<${ProjectPage} store=${store} projectId=${store.projectId.value} />`)), /you are a TA/);
});

test("a GPU row shows the quote's price, with parts that add up", async () => {
  const { store } = await memberStore();
  const item = { gpuType: "L4", gpuCount: 1, gpuMemoryGb: 24, pricePerHour: { providerCost: 480_000, margin: 144_000, total: 624_000 }, stock: "high" };
  const quote = {
    gpuType: "L4", gpuCount: 1, allocationId: null, remaining: 0, requiredToStart: 1, canStart: true,
    offers: [{ provider: "runpod", gpuType: "L4", gpuCount: 1, dataCenter: "x", country: "SE", stock: "high", pricePerHour: { providerCost: 125_000, margin: 125_000, total: 250_000 } }],
  };
  const t = text(renderToString(html`<table><tbody><${GpuRow} store=${store} item=${item} quote=${quote} labels=${GENERIC_LABELS} /></tbody></table>`));
  assert.match(t, /\$0\.250\/h provider \$0\.125 \+ service \$0\.125 Start/);
});

test("meter card: a low allocation says so", () => {
  const out = text(
    renderToString(
      html`<${MeterCard} title="Your allocation" now=${Date.parse("2027-02-01T10:00:00.000Z")} meter=${{
        allocationId: "alc_1",
        holder: { kind: "member", memberId: "mbr_1" },
        amount: 10_000_000,
        spent: { providerCost: 7_000_000, margin: 1_500_000, total: 8_500_000 },
        reserved: 0,
        remaining: 1_500_000,
        currentRatePerHour: { providerCost: 0, margin: 0, total: 0 },
        storage: { usedBytes: 0, quotaBytes: 1024 ** 3 },
        asOf: "2027-02-01T10:00:00.000Z",
      }} />`,
    ),
  );
  assert.match(out, /Remaining \$1\.50 .* Running low\./);
  assert.doesNotMatch(out, /used up/);
});
