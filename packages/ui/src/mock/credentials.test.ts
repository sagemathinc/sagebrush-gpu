// The mock's credential routes, as the control plane will serve them: an organization's
// owners only, byok only, the key's shape first, then a recent sign-in, then the provider's
// check; only facts about a key are kept, and every refusal is one of CREDENTIAL_REFUSALS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CREDENTIAL_REFUSALS, RECENT_AUTH_WINDOW_MS, type CredentialRefusal } from "@sbgpu/api";
import { ApiError, createClient, type Client } from "../client.ts";
import { mockFetch } from "./fetch.ts";
import { seedDemo } from "./seed.ts";
import { MOCK_KEY_PROVIDERS, mockFingerprint } from "./backend.ts";

const KEY = "sk_live_Q7f!x~K3";

/** The seed, plus a byok organization the seed's owner owns and its manager views, with a project. */
function setup() {
  const demo = seedDemo();
  const b = demo.backend;
  const user = (e: string) => [...b.users.values()].find((u) => u.email === e)!;
  const org = b.addOrg("Own keys org", 0, 1_000_000_000, "byok");
  b.setOrgRole(org.id, user(demo.emails.owner).id, "owner");
  b.setOrgRole(org.id, user(demo.emails.manager).id, "viewer");
  const project = b.addProject(org.id, {
    name: "Own keys lab",
    budget: 500_000_000,
    startsAt: "2027-01-01T00:00:00.000Z",
    endsAt: "2027-12-01T00:00:00.000Z",
    policy: { allowedGpuTypes: ["L4"], allowedProviders: ["hyperstack", "runpod"] },
  });
  const client = createClient({ fetch: mockFetch(b) });
  const as = (email: string): Client => {
    assert.ok(b.signInAs(email), email);
    return client;
  };
  return { b, demo, org, project, client, as, user };
}

async function refused(p: Promise<unknown>, refusal: CredentialRefusal): Promise<void> {
  const { code, message } = CREDENTIAL_REFUSALS[refusal];
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ApiError, String(err));
    assert.deepEqual([err.code, err.message], [code, message], refusal);
    return true;
  });
}

const put = (c: Client, orgId: string, provider: string, key: unknown) =>
  c.call("putCredential", { params: { orgId, provider: provider as never }, body: { key } as never });

test("access: no session, someone not an owner, a stranger, a resold organization and a provider not taken each get their fixed refusal", async () => {
  const s = setup();
  const orgId = s.org.id;
  await refused(s.client.call("listCredentials", { params: { orgId } }), "signedOut");
  await refused(put(s.client, orgId, "shadeform", KEY), "signedOut");
  await refused(s.client.call("deleteCredential", { params: { orgId, provider: "shadeform" } }), "signedOut");
  for (const email of [s.demo.emails.manager, s.demo.emails.member]) {
    const c = s.as(email); // (a viewer of the organization, and a stranger to it)
    await refused(c.call("listCredentials", { params: { orgId } }), "notOwner");
    await refused(put(c, orgId, "shadeform", KEY), "notOwner");
    await refused(c.call("deleteCredential", { params: { orgId, provider: "shadeform" } }), "notOwner");
  }
  const owner = s.as(s.demo.emails.owner);
  await refused(owner.call("listCredentials", { params: { orgId: s.demo.orgId } }), "notByok"); // the seed's resold org
  await refused(put(owner, s.demo.orgId, "shadeform", KEY), "notByok");
  for (const provider of ["runpod", "nebius"]) {
    await refused(put(owner, orgId, provider, KEY), "unknownProvider");
    await refused(owner.call("deleteCredential", { params: { orgId, provider: provider as never } }), "unknownProvider");
  }
  assert.equal(s.b.credentials.size, 0);
});

test("the list: one row per provider taken (RunPod only behind the test flag), none set at first", async () => {
  const s = setup();
  const owner = s.as(s.demo.emails.owner);
  const { items } = await owner.call("listCredentials", { params: { orgId: s.org.id } });
  assert.deepEqual(items.map((i) => i.provider), ["shadeform", "hyperstack", "vast"]);
  assert.deepEqual([...MOCK_KEY_PROVIDERS], ["shadeform", "hyperstack", "vast"]);
  for (const i of items) {
    assert.deepEqual(i, { provider: i.provider, status: "none", fingerprint: null, setBy: null, setAt: null, lastCheckedAt: null, runningMachines: 0 });
  }
  s.b.runpodKeys = true;
  const listed = await owner.call("listCredentials", { params: { orgId: s.org.id } });
  assert.deepEqual(listed.items.map((i) => i.provider), ["shadeform", "hyperstack", "vast", "runpod"]);
  assert.equal((await put(owner, s.org.id, "runpod", KEY)).status, "ok");
});

test("the reauth window: /me says what's left from a sign-in, to the millisecond, and null once it has closed", async () => {
  const s = setup();
  const owner = s.as(s.demo.emails.owner);
  assert.equal((await owner.call("getMe")).recentAuthForMs, RECENT_AUTH_WINDOW_MS);
  s.b.advance(1000);
  assert.equal((await owner.call("getMe")).recentAuthForMs, RECENT_AUTH_WINDOW_MS - 1000);
  s.b.advance(RECENT_AUTH_WINDOW_MS - 2000);
  assert.equal((await owner.call("getMe")).recentAuthForMs, 1000);
  await put(owner, s.org.id, "shadeform", KEY); // (still open)
  s.b.advance(1000);
  assert.equal((await owner.call("getMe")).recentAuthForMs, null);
  await refused(put(owner, s.org.id, "hyperstack", KEY), "reauthenticate");
  await refused(owner.call("deleteCredential", { params: { orgId: s.org.id, provider: "shadeform" } }), "reauthenticate");
  assert.equal(s.b.credentials.size, 1, "a refused delete removes nothing");
  // Signing in again opens it again; signing out closes it.
  s.as(s.demo.emails.owner);
  assert.equal((await owner.call("getMe")).recentAuthForMs, RECENT_AUTH_WINDOW_MS);
  await owner.call("signOut", { body: {} });
  assert.equal(s.b.authenticatedAt, null);
});

test("a key's shape is checked before anything else, even with the window closed", async () => {
  const s = setup();
  const owner = s.as(s.demo.emails.owner);
  s.b.advance(RECENT_AUTH_WINDOW_MS);
  let checks = 0;
  s.b.keyCheck = () => (checks++, "ok");
  for (const bad of [undefined, null, 5, "", "a b", "k\u007f", "kéy", "x".repeat(4097), ["k"]]) {
    await refused(put(owner, s.org.id, "shadeform", bad), "badShape");
  }
  await refused(owner.call("putCredential", { params: { orgId: s.org.id, provider: "shadeform" }, body: {} as never }), "badShape");
  await refused(put(owner, s.org.id, "shadeform", "x".repeat(4096)), "reauthenticate"); // (the longest key is a key)
  assert.equal(checks, 0, "the provider is never asked about a refused request");
});

test("set, replace and remove: only a fingerprint and facts are kept; a refused replace keeps the previous key", async () => {
  const s = setup();
  const owner = s.as(s.demo.emails.owner);
  const orgId = s.org.id;
  const seen: string[] = [];
  s.b.keyCheck = (key, provider) => (seen.push(`${provider}:${key === KEY ? "KEY" : "other"}`), "ok");
  s.b.advance(2000);
  const set = await put(owner, orgId, "shadeform", KEY);
  assert.deepEqual(set, {
    provider: "shadeform",
    status: "ok",
    fingerprint: mockFingerprint(KEY),
    setBy: s.demo.emails.owner,
    setAt: "2027-02-01T09:00:02.000Z",
    lastCheckedAt: "2027-02-01T09:00:02.000Z",
    runningMachines: 0,
  });
  assert.deepEqual(seen, ["shadeform:KEY"]);
  assert.match(set.fingerprint!, /^[0-9a-f]{8}$/);
  assert.notEqual(mockFingerprint(KEY), mockFingerprint(KEY + "x"));
  assert.equal(mockFingerprint("k120"), "0493fd3b"); // (always eight digits)
  // Nothing the mock keeps, or answers, holds the key.
  assert.doesNotMatch(JSON.stringify([...s.b.credentials]), /sk_live/);
  const listed = await owner.call("listCredentials", { params: { orgId } });
  assert.doesNotMatch(JSON.stringify(listed), /sk_live/);
  assert.deepEqual(listed.items.find((i) => i.provider === "shadeform"), set);

  // A replace the provider refuses, or can't check, changes nothing.
  s.b.keyCheck = () => "rejected";
  await refused(put(owner, orgId, "shadeform", "other_key"), "rejected");
  s.b.keyCheck = () => "unavailable";
  await refused(put(owner, orgId, "shadeform", "other_key"), "checkUnavailable");
  await refused(put(owner, orgId, "hyperstack", "other_key"), "checkUnavailable");
  assert.deepEqual((await owner.call("listCredentials", { params: { orgId } })).items.map((i) => [i.provider, i.fingerprint]), [
    ["shadeform", mockFingerprint(KEY)],
    ["hyperstack", null],
    ["vast", null],
  ]);
  s.b.keyCheck = () => "ok";
  s.b.advance(1000);
  const replaced = await put(owner, orgId, "shadeform", "other_key");
  assert.deepEqual([replaced.fingerprint, replaced.setAt], [mockFingerprint("other_key"), "2027-02-01T09:00:03.000Z"]);

  assert.deepEqual(await owner.call("deleteCredential", { params: { orgId, provider: "shadeform" } }), { removed: true });
  await refused(owner.call("deleteCredential", { params: { orgId, provider: "shadeform" } }), "noKey");
  assert.equal((await owner.call("listCredentials", { params: { orgId } })).items[0]!.status, "none");
  assert.equal(s.b.credentials.size, 0);
});

test("runningMachines counts the organization's machines on that provider that still run there", async () => {
  const s = setup();
  const b = s.b;
  b.offers = b.offers.filter((o) => o.provider !== "runpod"); // (so an L4 lands on hyperstack, in either org)
  const ada = s.user(s.demo.emails.member);
  b.addMember(s.project.id, { email: ada.email, userId: ada.id, allocation: 25_000_000 });
  const owner = s.as(s.demo.emails.owner);
  const ownerId = b.currentUserId;
  const rows = async () =>
    Object.fromEntries((await owner.call("listCredentials", { params: { orgId: s.org.id } })).items.map((i) => [i.provider, i.runningMachines]));
  assert.deepEqual(await rows(), { shadeform: 0, hyperstack: 0, vast: 0 });
  // Ada starts one in the byok organization and one in the seed's (which isn't counted).
  b.currentUserId = ada.id;
  const started = b.request("POST", `/v1/projects/${s.project.id}/machines`, {}, { gpuType: "L4" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const m = started.body as { id: string; provider: string };
  assert.equal(m.provider, "hyperstack");
  const other = b.request("POST", `/v1/projects/${s.demo.projectId}/machines`, {}, { gpuType: "L4" });
  assert.equal((other.body as { provider: string }).provider, "hyperstack");
  b.currentUserId = ownerId;
  assert.deepEqual(await rows(), { shadeform: 0, hyperstack: 1, vast: 0 });
  b.advance(120_000); // (it's running now)
  assert.deepEqual(await rows(), { shadeform: 0, hyperstack: 1, vast: 0 });
  // Once it's stopped it no longer runs at the provider.
  b.currentUserId = ada.id;
  assert.equal(b.request("POST", `/v1/machines/${m.id}/stop`, {}, {}).status, 200);
  b.currentUserId = ownerId;
  b.advance(120_000);
  assert.deepEqual(await rows(), { shadeform: 0, hyperstack: 0, vast: 0 });
});
