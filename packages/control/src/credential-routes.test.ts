// The credential routes (BYOK design r3, row 5): list, set or replace, remove. WorkOS is the fake,
// the provider check (row 3) a mock; nothing calls a provider and nothing is deployed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CREDENTIAL_REFUSALS, ERROR_STATUS, credentialRefusalBody, newId, type CredentialRefusal } from "@sbgpu/api";
import { AUTH_COOKIE, type AuthConfig } from "./auth.ts";
import { configFromEnv } from "./app.ts";
import { d1Db, stmt, type Db, type SqlValue, type Stmt } from "./db.ts";
import { SESSION_COOKIE, sha256Hex } from "./http.ts";
import { clearKeyCache } from "./workos.ts";
import { openCredential } from "./credentials.ts";
import { recordCheck, type CredentialCheck } from "./credential-routes.ts";
import { CLIENT, CONFIG, FakeWorkos } from "./testing/fake-workos.ts";
import { ORIGIN, T0, addMember, call, world, type World } from "./testing/world.ts";

const AUTH: AuthConfig = { workos: CONFIG, stateKey: "s".repeat(40), refreshKeys: `v1:${randomBytes(32).toString("base64")}` };
const FACTOR = "auth_factor_01TOTP";
const KEKS = `k1:${randomBytes(32).toString("base64")}`;
const FP = randomBytes(32).toString("base64");
const KEY1 = "rpa_FIRSTKEY0123456789abcdefghijklmnopqrst";
const KEY2 = "rpa_SECONDKEY0123456789abcdefghijklmnopqrs";

class MockCheck implements CredentialCheck {
  providers = ["runpod", "shadeform"] as const;
  result: "ok" | "rejected" | "revoked" | "error" | "throw" = "ok";
  calls: string[] = [];
  async check(provider: string, key: string) {
    this.calls.push(`${provider} ${key.length}`);
    if (this.result === "throw") throw new Error(`provider down (${key})`);
    return this.result;
  }
}

let fake: FakeWorkos;
let checker: MockCheck;
let w: World;
beforeEach(async () => {
  clearKeyCache();
  fake = new FakeWorkos();
  checker = new MockCheck();
  w = await world({ auth: AUTH, fetch: fake.fetch, budget: 0, credentialCheck: checker, credentialSecrets: { keks: KEKS, fingerprintKey: FP } });
  fake.now = () => w.clock.t;
});

const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`) && !c.includes("Max-Age=0"))?.split(";")[0];

let n = 0;
/** A person signed in through the fake WorkOS with one TOTP factor, an owner of `orgId` (a fresh byok org by default). */
async function owner(o: { orgId?: string; mode?: string; role?: string } = {}) {
  const i = ++n;
  const email = `owner${i}@example.com`;
  const sub = `user_01OWNER${i}`;
  await addMember(w, email, "member");
  const start = await call(w, "GET", "/v1/auth/start?reauth=1");
  const to = new URL(start.res.headers.get("location")!);
  fake.grantChallenge(`code_${i}`, to.searchParams.get("code_challenge")!, { subject: sub, sid: `session_01S${i}`, email });
  const done = await call(w, "GET", `/v1/auth/callback?code=code_${i}&state=${to.searchParams.get("state")}`, { cookie: cookieOf(start.res, AUTH_COOKIE)! });
  const cookie = cookieOf(done.res, SESSION_COOKIE)!;
  const hash = await sha256Hex(cookie.split("=")[1]!);
  const userId = (await w.db.all<{ user_id: string }>(`SELECT user_id FROM sessions WHERE id_sha256 = ?`, [hash]))[0]!.user_id;
  const orgId = o.orgId ?? newId("org");
  if (!o.orgId) await w.db.batch([stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'B', ?, 0, ?)`, orgId, o.mode ?? "byok", T0)]);
  await w.db.batch([stmt(`INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)`, orgId, userId, o.role ?? "owner")]);
  fake.factors.set(sub, [{ id: FACTOR, type: "totp", user_id: sub }]);
  return { cookie, userId, hash, sub, orgId, email };
}
type Owner = Awaited<ReturnType<typeof owner>>;

async function assure(p: Owner) {
  const r = await call(w, "POST", `/v1/orgs/${p.orgId}/credentials/assurance`, { cookie: p.cookie, body: { code: fake.totpCode } });
  assert.equal(r.res.status, 200, JSON.stringify(r.json));
}
const put = (p: Owner, key: unknown, expected: unknown, o: { provider?: string; orgId?: string; body?: unknown } = {}) =>
  call(w, "PUT", `/v1/orgs/${o.orgId ?? p.orgId}/credentials/${o.provider ?? "runpod"}`, { cookie: p.cookie, body: o.body ?? { key, expected } });
const del = (p: Owner, q: string, o: { provider?: string; orgId?: string } = {}) =>
  call(w, "DELETE", `/v1/orgs/${o.orgId ?? p.orgId}/credentials/${o.provider ?? "runpod"}${q}`, { cookie: p.cookie });
const list = (p: Owner, orgId = p.orgId) => call(w, "GET", `/v1/orgs/${orgId}/credentials`, { cookie: p.cookie });

function refused(r: Awaited<ReturnType<typeof call>>, name: CredentialRefusal, why: string = name) {
  assert.equal(r.res.status, ERROR_STATUS[CREDENTIAL_REFUSALS[name].code], `${why}: ${JSON.stringify(r.json)}`);
  assert.deepEqual(r.json, credentialRefusalBody(name), why);
}

const rows = (db: Db = w.db) => db.all<Record<string, SqlValue>>(`SELECT id, org_id, provider, version, fingerprint, status, set_by, sealed FROM provider_credentials ORDER BY org_id, provider`);
const events = (db: Db = w.db) => db.all<Record<string, SqlValue>>(`SELECT org_id, provider, credential_id, credential_version, kind, fingerprint, status, actor FROM credential_events ORDER BY id`);
const unused = async (p: Owner) => (await w.db.all(`SELECT 1 FROM credential_assurances WHERE session_sha256 = ? AND used_ms IS NULL AND expires_ms >= ?`, [p.hash, w.clock.t])).length;
const quota = async (orgId: string) => (await w.db.all<{ u: number }>(`SELECT coalesce(sum(used), 0) AS u FROM credential_check_quota WHERE org_id = ?`, [orgId]))[0]!.u;
const SECRETS = { env: ORIGIN, CREDENTIAL_KEKS: KEKS, CREDENTIAL_FINGERPRINT_KEY: FP };
/** Everything observable at once: the rows, the events, the assurances' use and the quota. */
const state = async () => JSON.stringify([await rows(), await events(), await w.db.all(`SELECT id, used_ms FROM credential_assurances ORDER BY id`), await w.db.all(`SELECT * FROM credential_check_quota ORDER BY org_id`)]);

async function setKey(p: Owner, key = KEY1) {
  await assure(p);
  const r = await put(p, key, null);
  assert.equal(r.res.status, 200, JSON.stringify(r.json));
  return r.json as { id: string; version: number };
}

// ---------------------------------------------------------------- set, replace, remove

test("set: one batch writes the sealed key, its set event and the assurance's use; the key opens; the answer is its view", async () => {
  const p = await owner();
  await assure(p);
  w.clock.t = T0 + 10;
  const r = await put(p, KEY1, null);
  assert.equal(r.res.status, 200);
  const [row] = await rows();
  assert.deepEqual({ ...row, sealed: undefined }, { id: row!.id, org_id: p.orgId, provider: "runpod", version: 1, fingerprint: row!.fingerprint, status: "ok", set_by: p.userId, sealed: undefined });
  assert.match(String(row!.id), /^crd_/);
  assert.deepEqual(r.json, { provider: "runpod", id: row!.id, version: 1, status: "ok", fingerprint: row!.fingerprint, setBy: p.email, setAt: new Date(T0 + 10).toISOString(), lastCheckedAt: new Date(T0 + 10).toISOString(), runningMachines: 0 });
  assert.deepEqual((await events()).map((e) => ({ ...e })), [{ org_id: p.orgId, provider: "runpod", credential_id: row!.id, credential_version: 1, kind: "set", fingerprint: row!.fingerprint, status: null, actor: p.userId }]);
  assert.equal(await unused(p), 0);
  assert.equal(await quota(p.orgId), 2, "the verify and the check");
  assert.deepEqual(checker.calls, [`runpod ${KEY1.length}`]);
  assert.deepEqual(await openCredential(w.db, SECRETS, p.orgId, "runpod", w.clock.t), { ok: true, key: KEY1, credentialId: row!.id, version: 1 });
});

test("replace: names the listed key; the version steps up; a replace event; the new key opens and the old doesn't", async () => {
  const p = await owner();
  const v1 = await setKey(p);
  await assure(p);
  const r = await put(p, KEY2, { id: v1.id, version: 1 });
  assert.equal(r.res.status, 200);
  assert.equal((r.json as { version: number }).version, 2);
  assert.deepEqual((await events()).map((e) => [e.kind, e.credential_version, e.credential_id]), [["set", 1, v1.id], ["replace", 2, v1.id]]);
  assert.notEqual((await events())[0]!.fingerprint, (await events())[1]!.fingerprint);
  assert.deepEqual(await openCredential(w.db, SECRETS, p.orgId, "runpod", w.clock.t), { ok: true, key: KEY2, credentialId: v1.id, version: 2 });
});

test("remove: names the listed key; the row goes at once with a remove event from the row itself; no provider call and no quota", async () => {
  const p = await owner();
  const v1 = await setKey(p);
  const fp = (await rows())[0]!.fingerprint;
  await assure(p);
  const before = await quota(p.orgId);
  checker.calls.length = 0;
  const r = await del(p, `?id=${v1.id}&version=1`);
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json, { removed: true });
  assert.equal((await rows()).length, 0);
  assert.deepEqual({ ...(await events())[1] }, { org_id: p.orgId, provider: "runpod", credential_id: v1.id, credential_version: 1, kind: "remove", fingerprint: fp, status: null, actor: p.userId });
  assert.equal(await quota(p.orgId), before);
  assert.deepEqual(checker.calls, []);
  assert.equal(await unused(p), 0);
  // and after it: no key
  await assure(p);
  refused(await del(p, `?id=${v1.id}&version=1`), "noKey");
});

// ---------------------------------------------------------------- refusals, in order

test("put: each refusal in its place, writing nothing (the quota only from its own step on)", async () => {
  const p = await owner();
  const s0 = await state();
  const none = async (why: string) => {
    assert.equal(await state(), s0, why);
    assert.deepEqual(checker.calls, [], why);
  };
  // the body: over 8 KiB (refused before parsing), the key's shape, then expected
  refused(await put(p, "k".repeat(9000), null), "badShape", "oversized");
  for (const key of ["", "a b", "k".repeat(4097), 7, null, "é"]) refused(await put(p, key, null), "badShape", JSON.stringify(key));
  for (const body of [{ key: KEY1 }, { key: KEY1, expected: {} }, { key: KEY1, expected: { id: "crd_x", version: 1 } }, { key: KEY1, expected: { id: newId("credential"), version: 0 } }, { key: KEY1, expected: null, extra: 1 }, { key: KEY1, expected: { id: newId("credential"), version: 1, x: 1 } }]) {
    refused(await put(p, null, null, { body }), "badExpected", JSON.stringify(body));
  }
  // the provider; the caller; the organization
  for (const provider of ["aws", "vast", "hyperstack", "Runpod"]) refused(await put(p, KEY1, null, { provider }), "unknownProvider", provider);
  refused(await call(w, "PUT", `/v1/orgs/${p.orgId}/credentials/runpod`, { body: { key: KEY1, expected: null } }), "signedOut");
  const viewer = await owner({ orgId: p.orgId, role: "viewer" });
  refused(await put(viewer, KEY1, null), "notOwner");
  refused(await put(p, KEY1, null, { orgId: newId("org") }), "notOwner", "another org");
  const resold = await owner({ mode: "resold" });
  refused(await put(resold, KEY1, null), "notByok");
  await none("before the assurance");
  // no assurance; the factor gone since it was verified
  refused(await put(p, KEY1, null), "reauthenticate", "no assurance");
  await assure(p);
  const s1 = await state();
  fake.factors.set(p.sub, []);
  refused(await put(p, KEY1, null), "mfaRequired", "factor removed");
  fake.factors.set(p.sub, [{ id: "auth_factor_01RESET", type: "totp", user_id: p.sub }]);
  refused(await put(p, KEY1, null), "reauthenticate", "factor reset");
  fake.factors.set(p.sub, [{ id: FACTOR, type: "totp", user_id: p.sub }, { id: "auth_factor_02", type: "totp", user_id: p.sub }]);
  refused(await put(p, KEY1, null), "mfaRequired", "two factors");
  fake.factors.set(p.sub, [{ id: FACTOR, type: "totp", user_id: p.sub }]);
  fake.factorsStatus = 503;
  refused(await put(p, KEY1, null), "checkUnavailable", "WorkOS down");
  fake.factorsStatus = 200;
  assert.equal(await state(), s1);
  assert.deepEqual(checker.calls, []);
});

test("put: at the quota's cap, tooManyChecks with no provider call; failures count", async () => {
  const p = await owner();
  await assure(p); // (1)
  checker.result = "rejected";
  for (let i = 0; i < 4; i++) {
    refused(await put(p, KEY1, null), "rejected", String(i)); // (2, 4, 6, 8: each check; each uses its assurance)
    await assure(p); // (3, 5, 7, 9)
  }
  checker.result = "ok";
  assert.equal(await quota(p.orgId), 9);
  assert.equal((await put(p, KEY1, null)).res.status, 200, "the 10th unit"); // (10)
  // (no unit left for a verify, nor a check)
  refused(await call(w, "POST", `/v1/orgs/${p.orgId}/credentials/assurance`, { cookie: p.cookie, body: { code: fake.totpCode } }), "tooManyChecks");
  assert.equal(checker.calls.length, 5);
});

test("put: only an ok check saves; a refused or failed check uses the assurance and keeps the previous key exactly", async () => {
  for (const [result, refusal] of [["rejected", "rejected"], ["revoked", "rejected"], ["error", "checkUnavailable"], ["throw", "checkUnavailable"]] as const) {
    const p = await owner();
    const v1 = await setKey(p);
    const before = JSON.stringify([await rows(), await events()]);
    await assure(p);
    checker.result = result;
    refused(await put(p, KEY2, { id: v1.id, version: 1 }), refusal, result);
    checker.result = "ok";
    assert.equal(JSON.stringify([await rows(), await events()]), before, result);
    assert.equal(await unused(p), 0, `${result}: the assurance is used`);
    assert.deepEqual(await openCredential(w.db, SECRETS, p.orgId, "runpod", w.clock.t), { ok: true, key: KEY1, credentialId: v1.id, version: 1 }, result);
  }
});

test("delete: each refusal in its place, writing nothing", async () => {
  const p = await owner();
  const v1 = await setKey(p);
  const s0 = await state();
  for (const q of ["", `?id=${v1.id}`, "?version=1", `?id=crd_x&version=1`, `?id=${v1.id}&version=0`, `?id=${v1.id}&version=01`, `?id=${v1.id}&version=-1`, `?id=${v1.id}&version=1.0`, `?id=${v1.id}&version=99999999999999999999`]) {
    refused(await del(p, q), "badExpected", q);
  }
  refused(await del(p, `?id=${v1.id}&version=1`, { provider: "aws" }), "unknownProvider");
  refused(await call(w, "DELETE", `/v1/orgs/${p.orgId}/credentials/runpod?id=${v1.id}&version=1`), "signedOut");
  const viewer = await owner({ orgId: p.orgId, role: "viewer" });
  refused(await del(viewer, `?id=${v1.id}&version=1`), "notOwner");
  refused(await del(p, `?id=${v1.id}&version=1`, { provider: "shadeform" }), "noKey");
  refused(await del(p, `?id=${v1.id}&version=2`), "busy", "another version");
  refused(await del(p, `?id=${newId("credential")}&version=1`), "busy", "another id");
  refused(await del(p, `?id=${v1.id}&version=1`), "reauthenticate", "no assurance");
  const resold = await owner({ mode: "resold" });
  refused(await del(resold, `?id=${v1.id}&version=1`), "notByok");
  assert.equal(await state(), s0);
});

// ---------------------------------------------------------------- crossed operations (H2)

test("crossed: replace against replace; the loser is busy, its assurance used, and a retry with it refused", async () => {
  const a = await owner();
  const b = await owner({ orgId: a.orgId });
  const v1 = await setKey(a);
  await assure(a);
  await assure(b);
  assert.equal((await put(a, KEY2, { id: v1.id, version: 1 })).res.status, 200);
  const won = JSON.stringify([await rows(), await events()]);
  refused(await put(b, "rpa_LOSER", { id: v1.id, version: 1 }), "busy");
  assert.equal(JSON.stringify([await rows(), await events()]), won);
  assert.equal(await unused(b), 0, "the loser's assurance is used");
  refused(await put(b, "rpa_LOSER", { id: v1.id, version: 2 }), "reauthenticate", "no replay");
  assert.equal(JSON.stringify([await rows(), await events()]), won);
});

test("crossed: set against set; replace and delete, in both orders; delete then recreate against a stale replace", async () => {
  // set against set
  const a = await owner();
  const b = await owner({ orgId: a.orgId });
  await assure(a);
  await assure(b);
  assert.equal((await put(a, KEY1, null)).res.status, 200);
  refused(await put(b, KEY2, null), "busy", "a second set");
  assert.equal(await unused(b), 0);
  const v1 = (await rows())[0]!;
  // replace, then a delete of the old version: busy, nothing used (the listed key is gone)
  await assure(a);
  assert.equal((await put(a, KEY2, { id: v1.id, version: 1 })).res.status, 200);
  await assure(b);
  refused(await del(b, `?id=${v1.id}&version=1`), "busy", "delete after replace");
  assert.equal((await rows())[0]!.version, 2);
  // delete, then a replace of the deleted version: busy, its assurance used, nothing written
  assert.equal((await del(b, `?id=${v1.id}&version=2`)).res.status, 200);
  const c = await owner({ orgId: a.orgId });
  await assure(c);
  refused(await put(c, "rpa_STALE", { id: v1.id, version: 2 }), "busy", "replace after delete");
  assert.equal((await rows()).length, 0);
  assert.equal(await unused(c), 0);
  // recreated (a new id): a stale replace naming the old id is busy, the new key untouched
  // (the next hour, for the organization's check quota: fresh sign-ins then)
  w.clock.t = T0 + 3_600_000;
  const d = await owner({ orgId: a.orgId });
  const fresh = await setKey(d, "rpa_RECREATED");
  assert.notEqual(fresh.id, v1.id);
  const e = await owner({ orgId: a.orgId });
  await assure(e);
  refused(await put(e, "rpa_STALE2", { id: v1.id, version: 1 }), "busy", "stale id after recreate");
  assert.deepEqual(await openCredential(w.db, SECRETS, a.orgId, "runpod", w.clock.t), { ok: true, key: "rpa_RECREATED", credentialId: fresh.id, version: 1 });
  assert.deepEqual((await events()).map((x) => x.kind), ["set", "replace", "remove", "set"]);
});

test("crossed: a replace landing between a delete's read and its batch; the delete is busy, its assurance used, the new key and its event kept", async () => {
  const a = await owner();
  const b = await owner({ orgId: a.orgId });
  const v1 = await setKey(a);
  await assure(a);
  await assure(b);
  // (a's replace runs right after b's delete reads the row)
  const real = w.deps.db;
  let fired = false;
  w.deps.db = {
    ...real,
    async all<T>(sql: string, p?: SqlValue[]) {
      const out = await real.all<T>(sql, p);
      if (!fired && /SELECT id, version, fingerprint FROM provider_credentials/.test(sql)) {
        fired = true;
        w.deps.db = real;
        assert.equal((await put(a, KEY2, { id: v1.id, version: 1 })).res.status, 200);
      }
      return out;
    },
  };
  refused(await del(b, `?id=${v1.id}&version=1`), "busy");
  w.deps.db = real;
  assert.equal((await rows())[0]!.version, 2);
  assert.deepEqual((await events()).map((x) => x.kind), ["set", "replace"]);
  assert.equal(await unused(b), 0);
});

test("crossed: an old scheduled check against a new replacement records nothing; on the exact key it records with its event", async () => {
  const p = await owner();
  const v1 = await setKey(p);
  await assure(p);
  assert.equal((await put(p, KEY2, { id: v1.id, version: 1 })).res.status, 200);
  assert.equal(await recordCheck(w.db, { orgId: p.orgId, provider: "runpod", id: v1.id, version: 1 }, "revoked", w.clock.t), false);
  assert.equal((await rows())[0]!.status, "ok");
  assert.equal((await events()).length, 2);
  for (const [k, why] of [[{ orgId: newId("org"), provider: "runpod", id: v1.id, version: 2 }, "another org"], [{ orgId: p.orgId, provider: "shadeform", id: v1.id, version: 2 }, "another provider"], [{ orgId: p.orgId, provider: "runpod", id: newId("credential"), version: 2 }, "another id"]] as const) {
    assert.equal(await recordCheck(w.db, k, "revoked", w.clock.t), false, why);
  }
  assert.equal(await recordCheck(w.db, { orgId: p.orgId, provider: "runpod", id: v1.id, version: 2 }, "revoked", w.clock.t + 5), true);
  assert.equal((await rows())[0]!.status, "revoked");
  assert.deepEqual({ ...(await events())[2] }, { org_id: p.orgId, provider: "runpod", credential_id: v1.id, credential_version: 2, kind: "check", fingerprint: (await rows())[0]!.fingerprint, status: "revoked", actor: null });
});

test("an assurance used between the live check and the batch: reauthenticate, nothing written", async () => {
  for (const op of ["put", "delete"] as const) {
    const p = await owner();
    const v1 = op === "delete" ? await setKey(p) : null;
    await assure(p);
    const real = w.deps.db;
    w.deps.db = {
      ...real,
      async all<T>(sql: string, params?: SqlValue[]) {
        const out = await real.all<T>(sql, params);
        if (/FROM credential_assurances a WHERE/.test(sql)) {
          w.deps.db = real;
          await real.batch([stmt(`UPDATE credential_assurances SET used_ms = ? WHERE session_sha256 = ? AND used_ms IS NULL`, w.clock.t, p.hash)]);
        }
        return out;
      },
    };
    const before = JSON.stringify([await rows(), await events()]);
    refused(op === "put" ? await put(p, KEY1, null) : await del(p, `?id=${v1!.id}&version=1`), "reauthenticate", op);
    w.deps.db = real;
    assert.equal(JSON.stringify([await rows(), await events()]), before, op);
  }
});

// ---------------------------------------------------------------- the authority scope (r3 H1)

test("scope: another org's credential id, or this org's for another provider, matches nothing and writes nothing", async () => {
  const p = await owner();
  const q = await owner();
  const mine = await setKey(p);
  const theirs = await setKey(q);
  // this org's shadeform key
  await assure(p);
  const sh = await put(p, "shd_KEY0123456789", null, { provider: "shadeform" });
  assert.equal(sh.res.status, 200);
  const shId = (sh.json as { id: string }).id;
  const before = await state();
  // replace naming another org's id, or this org's shadeform id on runpod
  await assure(p);
  refused(await put(p, "rpa_CROSS", { id: theirs.id, version: 1 }), "busy", "another org's id");
  await assure(p);
  refused(await put(p, "rpa_CROSS", { id: shId, version: 1 }), "busy", "another provider's id");
  // delete naming them
  await assure(p);
  refused(await del(p, `?id=${theirs.id}&version=1`), "busy", "delete: another org's id");
  refused(await del(p, `?id=${shId}&version=1`), "busy", "delete: another provider's id");
  const after = JSON.parse(await state()) as unknown[];
  const was = JSON.parse(before) as unknown[];
  assert.deepEqual([after[0], after[1]], [was[0], was[1]], "no credential or event changed");
  assert.deepEqual(await openCredential(w.db, SECRETS, q.orgId, "runpod", w.clock.t), { ok: true, key: KEY1, credentialId: theirs.id, version: 1 });
  assert.deepEqual(await openCredential(w.db, SECRETS, p.orgId, "runpod", w.clock.t), { ok: true, key: KEY1, credentialId: mine.id, version: 1 });
});

// ---------------------------------------------------------------- failures

test("a database error at any of the batch's three statements changes nothing at all, and is never a success", async () => {
  for (const at of [0, 2, 3] as const) {
    for (const op of ["set", "replace", "remove"] as const) {
      const p = await owner();
      const v1 = op === "set" ? null : await setKey(p);
      await assure(p);
      const before = await state();
      const real = w.deps.db;
      // (the statement at `at`, of the next batch that uses an assurance, fails: 0 the use, 2 the swap, 3 the event)
      w.deps.db = {
        ...real,
        async batch(stmts: Stmt[]) {
          if (stmts[0]?.sql.includes("UPDATE credential_assurances") && stmts.length === 4) {
            w.deps.db = real;
            const broken = stmts.map((s, i) => (i === at ? { sql: `INSERT INTO no_such_table (x) VALUES (?)`, params: [1] } : s));
            return real.batch(broken);
          }
          return real.batch(stmts);
        },
      };
      const r = op === "set" ? await put(p, KEY2, null) : op === "replace" ? await put(p, KEY2, { id: v1!.id, version: 1 }) : await del(p, `?id=${v1!.id}&version=1`);
      w.deps.db = real;
      refused(r, "checkUnavailable", `${op} at ${at}`);
      const after = await state();
      if (op === "remove") assert.equal(after, before, `${op} at ${at}`);
      else {
        // (only the quota's reservation, taken before the provider check, remains: never released)
        const [a0, a1, a2] = JSON.parse(after) as unknown[];
        const [b0, b1, b2] = JSON.parse(before) as unknown[];
        assert.deepEqual([a0, a1, a2], [b0, b1, b2], `${op} at ${at}`);
      }
      assert.equal(await unused(p), 1, `${op} at ${at}: the assurance is still unused`);
    }
  }
});

test("store unavailable: every route answers checkUnavailable with an alert, before reading or writing anything", async () => {
  for (const secrets of [{ keks: "k1:short", fingerprintKey: FP }, { fingerprintKey: FP }, { keks: KEKS }, { keks: KEKS, fingerprintKey: KEKS.slice(3) }]) {
    w = await world({ auth: AUTH, fetch: fake.fetch, budget: 0, credentialCheck: checker, credentialSecrets: secrets });
    fake.now = () => w.clock.t;
    const p = await owner();
    await assure(p);
    const s0 = await state();
    refused(await list(p), "checkUnavailable", JSON.stringify(secrets));
    refused(await put(p, KEY1, null), "checkUnavailable");
    refused(await del(p, `?id=${newId("credential")}&version=1`), "checkUnavailable");
    assert.equal(await state(), s0);
    assert.ok(w.alerts.length >= 3 && w.alerts.every((a) => /credential store unavailable/.test(a)));
    assert.deepEqual(checker.calls, []);
  }
});

// ---------------------------------------------------------------- the list, and secrecy

test("list: one entry per accepted provider, none where unset; running machines by the pinned account", async () => {
  const p = await owner();
  const empty = await list(p);
  assert.deepEqual(empty.json, { items: ["runpod", "shadeform"].map((provider) => ({ provider, id: null, version: null, status: "none", fingerprint: null, setBy: null, setAt: null, lastCheckedAt: null, runningMachines: 0 })) });
  const v1 = await setKey(p);
  // org-account launches on runpod: two live, one terminated; and a platform launch (not this org's account)
  const proj = newId("project");
  await w.db.batch([stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'P', ?, ?, 0, ?)`, proj, p.orgId, T0, T0 + 1, T0)]);
  for (const [account, outcome] of [["org", "creating"], ["org", "creating"], ["org", "terminated"], ["platform", "creating"]] as const) {
    const [a, m, holder] = [newId("allocation"), newId("machine"), newId("member")];
    await w.db.batch([
      stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', ?, 0, ?)`, a, proj, holder, T0),
      stmt(`INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms) VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, ?, 'runpod', 'L4', 1, 'X', 'starting', 1, ?)`, m, proj, a, holder, T0),
      stmt(
        `INSERT INTO launches (machine_id, incarnation, mode, provider, agent_sha256, credential_kind, account_kind, account_org_id, outcome, next_ms, created_ms)
         VALUES (?, 1, 'container', 'runpod', ?, ?, ?, ?, 'creating', ?, ?)`,
        m, "a".repeat(64), account === "org" ? "org" : "ours", account, account === "org" ? p.orgId : null, T0, T0,
      ),
    ]);
    if (outcome === "terminated") await w.db.batch([stmt(`INSERT INTO launch_rates (machine_id, incarnation, provider_cost_per_hour, margin_bps) VALUES (?, 1, 1000, 0)`, m), stmt(`UPDATE launches SET outcome = 'terminated', terminate_reason = 'abort', terminated_ms = ?, next_ms = NULL WHERE machine_id = ?`, T0, m)]);
  }
  const r = await list(p);
  const items = (r.json as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(items.map((i) => [i.provider, i.id, i.version, i.status, i.runningMachines, i.setBy]), [["runpod", v1.id, 1, "ok", 2, p.email], ["shadeform", null, null, "none", 0, null]]);
  // owners only; byok only
  const viewer = await owner({ orgId: p.orgId, role: "viewer" });
  refused(await list(viewer), "notOwner");
  const resold = await owner({ mode: "resold" });
  refused(await list(resold), "notByok");
});

test("secrecy: the key is in no response, error, alert, event or stored row but its seal", async () => {
  const p = await owner();
  const out: unknown[] = [];
  out.push((await (async () => { await assure(p); return put(p, KEY1, null); })()).json);
  const id = (out[0] as { id: string }).id;
  for (const result of ["rejected", "error", "throw"] as const) {
    checker.result = result;
    await assure(p);
    out.push((await put(p, KEY2, { id, version: 1 })).json);
  }
  checker.result = "ok";
  await assure(p);
  out.push((await put(p, KEY2, { id, version: 1 })).json, (await list(p)).json);
  out.push((await put(p, KEY2 + " ", { id, version: 2 })).json, (await put(p, KEY2, { id: "x", version: 2 })).json);
  const dump = JSON.stringify([out, w.alerts, await events(), await w.db.all(`SELECT id, org_id, provider, version, nonce, kek_version, fingerprint, status FROM provider_credentials`), await w.db.all(`SELECT * FROM credential_assurances`)]);
  for (const k of [KEY1, KEY2, KEY1.slice(4, 24), KEY2.slice(4, 24)]) assert.equal(dump.includes(k), false, k);
  const sealed = JSON.stringify(await w.db.all(`SELECT sealed FROM provider_credentials`));
  assert.equal(sealed.includes(KEY2.slice(4, 24)), false);
});

test("d1Db's batch reports each statement's change count; a result without one is never a change", async () => {
  const fakeD1 = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) as never }),
    batch: async (ss: unknown[]) => ss.map((_, i) => (i === 1 ? {} : { meta: { changes: i + 1 } })),
  };
  assert.deepEqual(await d1Db(fakeD1).batch([stmt("A"), stmt("B"), stmt("C")]), [{ changes: 1 }, { changes: -1 }, { changes: 3 }]);
  assert.deepEqual(await d1Db(fakeD1).batch([]), []);
  // (and the test database reports them too)
  const p = await owner();
  assert.deepEqual(await w.db.batch([stmt(`UPDATE orgs SET name = 'x' WHERE id = ?`, p.orgId), stmt(`UPDATE orgs SET name = 'x' WHERE id = 'none'`)]), [{ changes: 1 }, { changes: 0 }]);
  void CLIENT;
});

test("config: the store's two secrets are read from the environment as set (parsed later, strictly); anything else is absent", () => {
  const base = { APP_ORIGIN: "https://gpu.example.com", MACHINE_DOMAIN: "m.example.com" };
  const c = configFromEnv({ ...base, CREDENTIAL_KEKS: KEKS, CREDENTIAL_FINGERPRINT_KEY: FP });
  assert.equal(c.credentialKeks, KEKS);
  assert.equal(c.credentialFingerprintKey, FP);
  const none = configFromEnv({ ...base, CREDENTIAL_KEKS: 7, CREDENTIAL_FINGERPRINT_KEY: null });
  assert.equal("credentialKeks" in none, false);
  assert.equal("credentialFingerprintKey" in none, false);
});
