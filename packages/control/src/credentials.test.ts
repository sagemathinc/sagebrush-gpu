// The credential store (0016, credential-seal.ts, credentials.ts) and the resolver's use of it
// (billing.ts): BYOK design r3, row 2. Every row uses mocks: no provider is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { newId } from "@sbgpu/api";
import { stmt, type Db, type SqlValue } from "./db.ts";
import { sqliteDb, type TestDb } from "./testing/sqlite.ts";
import { T0 } from "./testing/world.ts";
import { credentialFingerprint, credentialKeys, openSealed, sealCredential, type CredentialSealContext } from "./credential-seal.ts";
import { openCredential, type CredentialSecrets } from "./credentials.ts";
import { credentialForLaunch, credentialForOrg } from "./billing.ts";

const b64key = () => randomBytes(32).toString("base64");
const NUL = String.fromCharCode(0);
const KEY = "rpa_TESTKEY0123456789abcdefghijklmnop";

function secrets(keks = `k1:${b64key()}`, fp = b64key(), env = "test"): CredentialSecrets {
  return { env, CREDENTIAL_KEKS: keks, CREDENTIAL_FINGERPRINT_KEY: fp };
}

const org = (id: string, mode: string) =>
  stmt(`INSERT INTO orgs (id, name, billing_mode, margin_bps, created_ms) VALUES (?, 'O', ?, 0, ?)`, id, mode, T0);
const project = (id: string, orgId: string) =>
  stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, margin_bps_override, budget, created_ms) VALUES (?, ?, 'P', ?, ?, NULL, 0, ?)`, id, orgId, T0, T0 + 1, T0);

async function setup(mode = "byok") {
  const db = sqliteDb();
  const [orgId, userId] = [newId("org"), newId("user")];
  await db.batch([org(orgId, mode), stmt(`INSERT INTO users (id, email, created_ms) VALUES (?, ?, ?)`, userId, `${userId}@example.com`, T0)]);
  return { db, orgId, userId };
}

/** A row's columns, sealed for real under `s`. */
async function row(s: CredentialSecrets, orgId: string, userId: string, o: { provider?: string; key?: string; id?: string; version?: number; status?: string } = {}) {
  const provider = o.provider ?? "runpod";
  const id = o.id ?? newId("credential");
  const version = o.version ?? 1;
  const keys = (await credentialKeys(s.CREDENTIAL_KEKS, s.CREDENTIAL_FINGERPRINT_KEY))!;
  const sealed = await sealCredential(keys, { env: s.env, orgId, provider, credentialId: id, version }, o.key ?? KEY);
  const status = o.status ?? "ok";
  return {
    id, org_id: orgId, provider, version, sealed: sealed.sealed, nonce: sealed.nonce, kek_version: sealed.kekVersion,
    fingerprint: await credentialFingerprint(keys, o.key ?? KEY), status, last_checked_ms: status === "unchecked" ? null : T0,
    set_by: userId, set_ms: T0,
  };
}
const insert = (db: Db, table: string, v: Record<string, SqlValue>) => {
  const cols = Object.keys(v);
  return db.batch([{ sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: Object.values(v) }]);
};
const one = async (db: Db, sql: string, p: SqlValue[] = []) => ({ ...(await db.all<Record<string, SqlValue>>(sql, p))[0] });
const count = async (db: Db, table: string) => (await db.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))[0]!.n;
const events = (db: Db) => db.all<Record<string, SqlValue>>(`SELECT org_id, provider, credential_id, credential_version, kind, fingerprint, status, actor, at_ms FROM credential_events ORDER BY id`);

// ---------------------------------------------------------------- the schema

test("store: only a byok organization holds a key; a resold or unknown one never does", async () => {
  const s = secrets();
  for (const mode of ["resold", "byok"]) {
    const { db, orgId, userId } = await setup(mode);
    const r = await row(s, orgId, userId);
    if (mode === "resold") await assert.rejects(insert(db, "provider_credentials", r), /only a byok organization/);
    else await insert(db, "provider_credentials", r);
    assert.equal(await count(db, "provider_credentials"), mode === "byok" ? 1 : 0);
  }
  const { db, userId } = await setup();
  await assert.rejects(insert(db, "provider_credentials", await row(s, newId("org"), userId)), /only a byok organization/);
});

test("store: one key per organization and provider; another provider or organization is its own slot", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  await insert(db, "provider_credentials", await row(s, orgId, userId));
  await assert.rejects(insert(db, "provider_credentials", await row(s, orgId, userId)), /UNIQUE constraint failed: provider_credentials\.org_id, provider_credentials\.provider/);
  await insert(db, "provider_credentials", await row(s, orgId, userId, { provider: "shadeform" }));
  const other = newId("org");
  await db.batch([org(other, "byok")]);
  await insert(db, "provider_credentials", await row(s, other, userId));
  assert.equal(await count(db, "provider_credentials"), 3);
});

test("store: every column's bounds, in stored bytes, with no NUL", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  const base = await row(s, orgId, userId);
  const b64 = (n: number) => "A".repeat(n);
  const bad: [string, SqlValue][] = [
    ["id", "crd_" + "0".repeat(19)], ["id", "crd_" + "0".repeat(21)], ["id", "crx_" + "0".repeat(20)], ["id", "crd_" + "0".repeat(19) + "i"],
    ["id", "crd_" + "0".repeat(19) + NUL], ["id", "crd_" + "0".repeat(19) + "é"], ["id", "crd_" + "0".repeat(19) + "A"],
    ["provider", "aws"], ["provider", ""], ["provider", "Runpod"],
    ["version", 0], ["version", -1], ["version", 9007199254740992],
    ["sealed", b64(23)], ["sealed", b64(5485)], ["sealed", b64(23) + NUL], ["sealed", b64(23) + "é"], ["sealed", b64(23) + "-"], ["sealed", b64(23) + " "],
    ["nonce", b64(15)], ["nonce", b64(17)], ["nonce", b64(15) + "="], ["nonce", b64(15) + NUL], ["nonce", b64(14) + "é"],
    ["kek_version", ""], ["kek_version", "k".repeat(17)], ["kek_version", "k:1"], ["kek_version", "k" + NUL], ["kek_version", "é"],
    ["fingerprint", "0".repeat(15)], ["fingerprint", "0".repeat(17)], ["fingerprint", "A".repeat(16)], ["fingerprint", "0".repeat(15) + "g"], ["fingerprint", "0".repeat(15) + NUL],
    ["status", "none"], ["status", "OK"], ["status", null],
    ["set_by", newId("user")], ["set_by", null], ["set_ms", -1], ["set_ms", null], ["last_checked_ms", -1],
  ];
  for (const [col, v] of bad) await assert.rejects(insert(db, "provider_credentials", { ...base, [col]: v }), `${col}=${JSON.stringify(v)}`);
  // unchecked exactly when never checked
  await assert.rejects(insert(db, "provider_credentials", { ...base, status: "unchecked", last_checked_ms: T0 }), /CHECK/);
  await assert.rejects(insert(db, "provider_credentials", { ...base, status: "ok", last_checked_ms: null }), /CHECK/);
  assert.equal(await count(db, "provider_credentials"), 0);
  // the edges pass
  for (const [i, over] of ([
    { sealed: b64(24) }, { sealed: b64(5484) }, { kek_version: "k".repeat(16) }, { kek_version: "A-z_9" }, { status: "unchecked", last_checked_ms: null }, { version: 9007199254740991 },
  ] as Record<string, SqlValue>[]).entries()) {
    const o = newId("org");
    await db.batch([org(o, "byok")]);
    await insert(db, "provider_credentials", { ...base, ...over, id: newId("credential"), org_id: o }).catch((e) => assert.fail(`${i}: ${e}`));
  }
});

test("store: a row's id, organization and provider are fixed; the version only steps up by 1", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  const r = await row(s, orgId, userId);
  await insert(db, "provider_credentials", r);
  const other = newId("org");
  await db.batch([org(other, "byok")]);
  const upd = (set: string, ...p: SqlValue[]) => db.batch([stmt(`UPDATE provider_credentials SET ${set} WHERE id = ?`, ...p, r.id)]);
  await assert.rejects(upd(`id = ?`, newId("credential")), /id, organization and provider are fixed/);
  await assert.rejects(upd(`org_id = ?`, other), /id, organization and provider are fixed/);
  await assert.rejects(upd(`provider = 'shadeform'`), /id, organization and provider are fixed/);
  for (const v of [0, 3, 1 + 2 ** 20]) await assert.rejects(upd(`version = ?`, v), /only moves up by 1/);
  await upd(`id = id, org_id = org_id, provider = provider`); // (the same values: no change)
  const r2 = await row(s, orgId, userId, { id: r.id as string, version: 2, key: "rpa_SECONDKEY" });
  await upd(`version = 2, sealed = ?, nonce = ?, fingerprint = ?, set_ms = ?`, r2.sealed, r2.nonce, r2.fingerprint, T0 + 1);
  await assert.rejects(upd(`version = 1`), /only moves up by 1/);
  assert.equal((await one(db, `SELECT version FROM provider_credentials`)).version, 2);
});

test("store: the same version is the same key (fingerprint, setter and time fixed); a new seal has a new nonce", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  const r = await row(s, orgId, userId);
  await insert(db, "provider_credentials", r);
  const u2 = newId("user");
  await db.batch([stmt(`INSERT INTO users (id, email, created_ms) VALUES (?, ?, ?)`, u2, `${u2}@example.com`, T0)]);
  const upd = (set: string, ...p: SqlValue[]) => db.batch([stmt(`UPDATE provider_credentials SET ${set} WHERE id = ?`, ...p, r.id)]);
  await assert.rejects(upd(`fingerprint = ?`, "f".repeat(16)), /keeps its fingerprint and setter/);
  await assert.rejects(upd(`set_by = ?`, u2), /keeps its fingerprint and setter/);
  await assert.rejects(upd(`set_ms = ?`, T0 + 1), /keeps its fingerprint and setter/);
  await assert.rejects(upd(`sealed = ?`, "B".repeat(40)), /new seal has a new nonce/);
  // a check (status) and a re-seal (sealed, nonce, kek) keep the version
  await upd(`status = 'rejected', last_checked_ms = ?`, T0 + 5);
  await upd(`sealed = ?, nonce = ?, kek_version = 'k2'`, "B".repeat(40), "C".repeat(16));
  // a new version may change all three
  await upd(`version = 2, fingerprint = ?, set_by = ?, set_ms = ?, sealed = ?, nonce = ?`, "e".repeat(16), u2, T0 + 9, "D".repeat(40), "E".repeat(16));
  assert.deepEqual(await one(db, `SELECT version, fingerprint, set_by, status FROM provider_credentials`), { version: 2, fingerprint: "e".repeat(16), set_by: u2, status: "rejected" });
});

test("events: append-only, and each kind's fields", async () => {
  const { db, orgId, userId } = await setup();
  const ev = (over: Record<string, SqlValue> = {}) =>
    insert(db, "credential_events", { org_id: orgId, provider: "runpod", credential_id: newId("credential"), credential_version: 1, kind: "set", fingerprint: "0".repeat(16), status: null, actor: userId, at_ms: T0, ...over });
  await ev();
  await ev({ kind: "replace", credential_version: 2 });
  await ev({ kind: "remove", credential_version: 7 });
  await ev({ kind: "check", status: "ok", actor: null });
  await ev({ kind: "check", status: "revoked" });
  for (const over of [
    { kind: "set", credential_version: 2 }, { kind: "replace", credential_version: 1 },
    { kind: "check", status: null }, { kind: "set", status: "ok" }, { kind: "remove", status: "error" },
    { kind: "set", actor: null }, { kind: "replace", credential_version: 2, actor: null }, { kind: "remove", actor: null },
    { kind: "check", status: "unchecked" }, { kind: "check", status: "none" }, { kind: "other" },
    { actor: newId("user") }, { org_id: newId("org") }, { provider: "aws" }, { credential_id: "crd_x" }, { fingerprint: "F".repeat(16) }, { at_ms: -1 },
  ] as Record<string, SqlValue>[]) await assert.rejects(ev(over), JSON.stringify(over));
  assert.equal(await count(db, "credential_events"), 5);
  await assert.rejects(db.batch([stmt(`UPDATE credential_events SET at_ms = at_ms + 1`)]), /never changed/);
  await assert.rejects(db.batch([stmt(`UPDATE credential_events SET kind = kind`)]), /never changed/);
  await assert.rejects(db.batch([stmt(`DELETE FROM credential_events`)]), /never deleted/);
  assert.equal(await count(db, "credential_events"), 5);
});

// ---------------------------------------------------------------- sealing

const CTX: CredentialSealContext = { env: "test", orgId: "org_00000000000000000000", provider: "runpod", credentialId: "crd_00000000000000000000", version: 1 };

test("seal: opens in its own context only; each associated field changed fails; a tampered seal fails", async () => {
  const k = (await credentialKeys(`k1:${b64key()}`, b64key()))!;
  const s = await sealCredential(k, CTX, KEY);
  assert.equal(s.kekVersion, "k1");
  assert.equal(Buffer.from(s.nonce, "base64").length, 12);
  assert.doesNotMatch(s.sealed, new RegExp(KEY));
  assert.equal(await openSealed(k, CTX, s), KEY);
  for (const other of [
    { ...CTX, env: "prod" }, { ...CTX, orgId: "org_00000000000000000001" }, { ...CTX, provider: "shadeform" },
    { ...CTX, credentialId: "crd_00000000000000000001" }, { ...CTX, version: 2 },
  ]) assert.equal(await openSealed(k, other, s), null, JSON.stringify(other));
  // the KEK version is in the associated data too: the same KEK under another name doesn't open it
  const raw = b64key();
  const k1 = (await credentialKeys(`k1:${raw}`, b64key()))!;
  const k2 = (await credentialKeys(`k2:${raw}`, b64key()))!;
  const s1 = await sealCredential(k1, CTX, KEY);
  assert.equal(await openSealed(k2, CTX, { ...s1, kekVersion: "k2" }), null);
  // fresh nonces
  const again = await sealCredential(k, CTX, KEY);
  assert.notEqual(again.nonce, s.nonce);
  assert.notEqual(again.sealed, s.sealed);
  // tampered tag, tampered body, another nonce, truncated, not base64, a missing KEK
  const flip = (b64: string, i: number) => { const b = Buffer.from(b64, "base64"); b[i < 0 ? b.length + i : i]! ^= 1; return b.toString("base64"); };
  assert.equal(await openSealed(k, CTX, { ...s, sealed: flip(s.sealed, -1) }), null);
  assert.equal(await openSealed(k, CTX, { ...s, sealed: flip(s.sealed, 0) }), null);
  assert.equal(await openSealed(k, CTX, { ...s, nonce: flip(s.nonce, 0) }), null);
  assert.equal(await openSealed(k, CTX, { ...s, sealed: Buffer.from(s.sealed, "base64").subarray(0, 16).toString("base64") }), null);
  assert.equal(await openSealed(k, CTX, { ...s, nonce: Buffer.alloc(16).toString("base64") }), null);
  assert.equal(await openSealed(k, CTX, { ...s, sealed: "%%%" }), null);
  assert.equal(await openSealed(k, CTX, { ...s, kekVersion: "k9" }), null);
});

test("config: anything malformed leaves the store unavailable, never a partial or default key", async () => {
  const [a, b, f] = [b64key(), b64key(), b64key()];
  assert.ok(await credentialKeys(`k1:${a}`, f));
  const two = (await credentialKeys(`k2:${b},k1:${a}`, f))!;
  assert.equal(two.current, "k2");
  assert.deepEqual([...two.keks.keys()], ["k2", "k1"]);
  const short = randomBytes(31).toString("base64");
  const long = randomBytes(33).toString("base64");
  const noncanonical = a.slice(0, 42) + "B=";
  for (const [keks, fp] of [
    [undefined, f], [`k1:${a}`, undefined], ["", f], [`k1:${a}`, ""],
    [`k1:${short}`, f], [`k1:${long}`, f], [`k1:${noncanonical}`, f], [`k1:${a.slice(0, -1)}`, f],
    [`k1:${a},k1:${b}`, f], [`k1:${a},`, f], [`,k1:${a}`, f], [`k1:${a},,k2:${b}`, f],
    [` k1:${a}`, f], [`k1: ${a}`, f], [`k1:${a} `, f], [`k1:${a}, k2:${b}`, f], [`k1:${a}\n`, f],
    [`:${a}`, f], [`k 1:${a}`, f], [`${"k".repeat(17)}:${a}`, f], [`k1${a}`, f], [`k1:${a}:x`, f],
    [`k1:${a}`, a], [`k2:${b},k1:${a}`, a], [`k1:${a}`, short], [`k1:${a}`, ` ${f}`], [`k1:${a}`, `${f.slice(0, 42)}B=`],
  ] as [string | undefined, string | undefined][]) {
    assert.equal(await credentialKeys(keks, fp), null, JSON.stringify([keks, fp]));
  }
  // and the store refuses with it, before reading anything
  const { db, orgId, userId } = await setup();
  const s = secrets();
  await insert(db, "provider_credentials", await row(s, orgId, userId));
  assert.deepEqual(await openCredential(db, { ...s, CREDENTIAL_KEKS: `k1:${short}` }, orgId, "runpod", T0), { ok: false, reason: "unavailable" });
  assert.deepEqual(await openCredential(db, { ...s, CREDENTIAL_FINGERPRINT_KEY: s.CREDENTIAL_KEKS!.slice(3) }, orgId, "runpod", T0), { ok: false, reason: "unavailable" });
  assert.deepEqual(await openCredential(db, { env: "test" }, orgId, "runpod", T0), { ok: false, reason: "unavailable" });
});

test("fingerprint: 16 hex characters, stable for a key, different across keys, under its own secret (never the KEK)", async () => {
  const [a, b, f, g] = [b64key(), b64key(), b64key(), b64key()];
  const k = (await credentialKeys(`k1:${a}`, f))!;
  const fp = await credentialFingerprint(k, KEY);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(await credentialFingerprint(k, KEY), fp);
  assert.notEqual(await credentialFingerprint(k, KEY + "x"), fp);
  // another KEK, the same fingerprint key: the same fingerprint; another fingerprint key: a different one
  assert.equal(await credentialFingerprint((await credentialKeys(`k9:${b}`, f))!, KEY), fp);
  assert.notEqual(await credentialFingerprint((await credentialKeys(`k1:${a}`, g))!, KEY), fp);
  // it is the HMAC under the fingerprint key, and not under the KEK
  const { createHmac } = await import("node:crypto");
  assert.equal(fp, createHmac("sha256", Buffer.from(f, "base64")).update(KEY).digest("hex").slice(0, 16));
  assert.notEqual(fp, createHmac("sha256", Buffer.from(a, "base64")).update(KEY).digest("hex").slice(0, 16));
});

// ---------------------------------------------------------------- opening

test("open: round-trips the key, and only this org and provider's row", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  const r = await row(s, orgId, userId);
  await insert(db, "provider_credentials", r);
  assert.deepEqual(await openCredential(db, s, orgId, "runpod", T0), { ok: true, key: KEY, credentialId: r.id, version: 1 });
  assert.deepEqual(await openCredential(db, s, orgId, "shadeform", T0), { ok: false, reason: "no-credential" });
  assert.deepEqual(await openCredential(db, s, newId("org"), "runpod", T0), { ok: false, reason: "no-credential" });
  // another environment's secrets of the same KEK don't open it (and mark it, below)
  assert.equal(await count(db, "credential_events"), 0);
});

test("open: a ciphertext moved to another org's (or provider's) row doesn't open: that row is marked error, never a fallback", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  const other = newId("org");
  await db.batch([org(other, "byok")]);
  const mine = await row(s, orgId, userId);
  const theirs = await row(s, other, userId, { key: "rpa_THEIRS" });
  await insert(db, "provider_credentials", mine);
  // their row carries my ciphertext and nonce (copied), under its own id
  await insert(db, "provider_credentials", { ...theirs, sealed: mine.sealed, nonce: mine.nonce, kek_version: mine.kek_version });
  assert.deepEqual(await openCredential(db, s, other, "runpod", T0 + 7), { ok: false, reason: "unopenable" });
  assert.deepEqual(await one(db, `SELECT status, last_checked_ms FROM provider_credentials WHERE org_id = ?`, [other]), { status: "error", last_checked_ms: T0 + 7 });
  assert.deepEqual((await events(db)).map((e) => ({ ...e })), [
    { org_id: other, provider: "runpod", credential_id: theirs.id, credential_version: 1, kind: "check", fingerprint: theirs.fingerprint, status: "error", actor: null, at_ms: T0 + 7 },
  ]);
  // now paused: a second open refuses without another event
  assert.deepEqual(await openCredential(db, s, other, "runpod", T0 + 8), { ok: false, reason: "paused" });
  assert.equal(await count(db, "credential_events"), 1);
  // mine is untouched and still opens
  assert.deepEqual(await openCredential(db, s, orgId, "runpod", T0), { ok: true, key: KEY, credentialId: mine.id, version: 1 });
  // the same for a copy into the same org's other provider
  const sh = await row(s, orgId, userId, { provider: "shadeform" });
  await insert(db, "provider_credentials", { ...sh, sealed: mine.sealed, nonce: mine.nonce });
  assert.deepEqual(await openCredential(db, s, orgId, "shadeform", T0), { ok: false, reason: "unopenable" });
});

test("open: another environment's secrets don't open a key", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  await insert(db, "provider_credentials", await row(s, orgId, userId));
  assert.deepEqual(await openCredential(db, { ...s, env: "prod" }, orgId, "runpod", T0), { ok: false, reason: "unopenable" });
});

test("open: a pausing status refuses before opening; unchecked and ok open", async () => {
  const s = secrets();
  for (const status of ["unchecked", "ok", "rejected", "revoked", "error"]) {
    const { db, orgId, userId } = await setup();
    await insert(db, "provider_credentials", await row(s, orgId, userId, { status }));
    const got = await openCredential(db, s, orgId, "runpod", T0);
    if (status === "ok" || status === "unchecked") assert.equal(got.ok && got.key, KEY, status);
    else assert.deepEqual(got, { ok: false, reason: "paused" }, status);
    assert.equal(await count(db, "credential_events"), 0);
  }
});

test("rotation: an old KEK still opens, and the key is re-sealed under the current one (same version, no event)", async () => {
  const [a, b, f] = [b64key(), b64key(), b64key()];
  const old = secrets(`k1:${a}`, f);
  const { db, orgId, userId } = await setup();
  const r = await row(old, orgId, userId);
  await insert(db, "provider_credentials", r);
  const both = secrets(`k2:${b},k1:${a}`, f);
  assert.deepEqual(await openCredential(db, both, orgId, "runpod", T0), { ok: true, key: KEY, credentialId: r.id, version: 1 });
  const after = await one(db, `SELECT version, kek_version, sealed, nonce, fingerprint, status FROM provider_credentials`);
  assert.equal(after.kek_version, "k2");
  assert.equal(after.version, 1);
  assert.equal(after.fingerprint, r.fingerprint);
  assert.equal(after.status, "ok");
  assert.notEqual(after.sealed, r.sealed);
  assert.notEqual(after.nonce, r.nonce);
  assert.equal(await count(db, "credential_events"), 0);
  // the new seal opens under the new KEK alone (the old one can go)
  assert.deepEqual(await openCredential(db, secrets(`k2:${b}`, f), orgId, "runpod", T0), { ok: true, key: KEY, credentialId: r.id, version: 1 });
  // a current-KEK open writes nothing
  const before = await one(db, `SELECT sealed, nonce FROM provider_credentials`);
  await openCredential(db, both, orgId, "runpod", T0);
  assert.deepEqual(await one(db, `SELECT sealed, nonce FROM provider_credentials`), before);
});

test("rotation: a removed KEK can't open: status error with its event, never a fallback to another key", async () => {
  const [a, b, f] = [b64key(), b64key(), b64key()];
  const { db, orgId, userId } = await setup();
  const r = await row(secrets(`k1:${a}`, f), orgId, userId);
  await insert(db, "provider_credentials", r);
  assert.deepEqual(await openCredential(db, secrets(`k2:${b}`, f), orgId, "runpod", T0 + 3), { ok: false, reason: "unopenable" });
  assert.deepEqual(await one(db, `SELECT status, last_checked_ms, sealed, kek_version FROM provider_credentials`), { status: "error", last_checked_ms: T0 + 3, sealed: r.sealed, kek_version: "k1" });
  assert.deepEqual((await events(db)).map((e) => [e.kind, e.status, e.actor, e.credential_id]), [["check", "error", null, r.id]]);
});

/** `db`, with `between` run once right after the first read of provider_credentials (a write crossing the open). */
function crossing(db: TestDb, between: () => Promise<unknown>): Db {
  let done = false;
  return {
    ...db,
    async all<T>(sql: string, p?: SqlValue[]) {
      const out = await db.all<T>(sql, p);
      if (!done && /FROM provider_credentials/.test(sql)) {
        done = true;
        await between();
      }
      return out;
    },
  };
}

test("rotation: a re-seal never touches a newer key (a replace crossing the open wins, untouched)", async () => {
  const [a, b, f] = [b64key(), b64key(), b64key()];
  const { db, orgId, userId } = await setup();
  const r = await row(secrets(`k1:${a}`, f), orgId, userId);
  await insert(db, "provider_credentials", r);
  const both = secrets(`k2:${b},k1:${a}`, f);
  const r2 = await row(both, orgId, userId, { id: r.id as string, version: 2, key: "rpa_NEWER" });
  const replace = () => db.batch([stmt(`UPDATE provider_credentials SET version = 2, sealed = ?, nonce = ?, kek_version = ?, fingerprint = ?, set_ms = ? WHERE id = ?`, r2.sealed, r2.nonce, r2.kek_version, r2.fingerprint, T0 + 1, r.id)]);
  // the open read version 1 under k1, then the replace landed: it still returns what it read (v1), and leaves v2 as written
  const got = await openCredential(crossing(db, replace), both, orgId, "runpod", T0);
  assert.deepEqual(got, { ok: true, key: KEY, credentialId: r.id, version: 1 });
  assert.deepEqual(await one(db, `SELECT version, sealed, nonce, kek_version, fingerprint FROM provider_credentials`), { version: 2, sealed: r2.sealed, nonce: r2.nonce, kek_version: "k2", fingerprint: r2.fingerprint });
  assert.deepEqual(await openCredential(db, both, orgId, "runpod", T0), { ok: true, key: "rpa_NEWER", credentialId: r.id, version: 2 });
  // a replace sealed under the old KEK (by an isolate that doesn't have the new one yet) crossing the open: kept as written
  const oo = newId("org");
  await db.batch([org(oo, "byok")]);
  const v1 = await row(secrets(`k1:${a}`, f), oo, userId);
  await insert(db, "provider_credentials", v1);
  const v2 = await row(secrets(`k1:${a}`, f), oo, userId, { id: v1.id as string, version: 2, key: "rpa_NEWER" });
  const sameKek = () => db.batch([stmt(`UPDATE provider_credentials SET version = 2, sealed = ?, nonce = ?, fingerprint = ?, set_ms = ? WHERE id = ?`, v2.sealed, v2.nonce, v2.fingerprint, T0 + 1, v1.id)]);
  assert.equal((await openCredential(crossing(db, sameKek), both, oo, "runpod", T0)).ok, true);
  assert.deepEqual(await one(db, `SELECT version, sealed, nonce, kek_version FROM provider_credentials WHERE id = ?`, [v1.id]), { version: 2, sealed: v2.sealed, nonce: v2.nonce, kek_version: "k1" });
  assert.deepEqual(await openCredential(db, both, oo, "runpod", T0), { ok: true, key: "rpa_NEWER", credentialId: v1.id, version: 2 });
  // and a re-seal by another open (the KEK version moved) isn't re-done over it
  const r3 = await row(secrets(`k1:${a}`, f), orgId, userId, { key: "rpa_THIRD", id: newId("credential") });
  const o3 = newId("org");
  await db.batch([org(o3, "byok")]);
  const s3 = await row(secrets(`k1:${a}`, f), o3, userId, { key: "rpa_THIRD", id: r3.id as string });
  await insert(db, "provider_credentials", s3);
  const keys = (await credentialKeys(both.CREDENTIAL_KEKS, both.CREDENTIAL_FINGERPRINT_KEY))!;
  const other = await sealCredential(keys, { env: "test", orgId: o3, provider: "runpod", credentialId: s3.id as string, version: 1 }, "rpa_THIRD");
  const reseal = () => db.batch([stmt(`UPDATE provider_credentials SET sealed = ?, nonce = ?, kek_version = 'k2' WHERE id = ?`, other.sealed, other.nonce, s3.id)]);
  assert.equal((await openCredential(crossing(db, reseal), both, o3, "runpod", T0)).ok, true);
  assert.deepEqual(await one(db, `SELECT sealed, nonce FROM provider_credentials WHERE id = ?`, [s3.id]), { sealed: other.sealed, nonce: other.nonce });
});

test("open: the error mark never touches a newer key (a replace crossing a failed open wins, with no event)", async () => {
  const [a, b, f] = [b64key(), b64key(), b64key()];
  const { db, orgId, userId } = await setup();
  const r = await row(secrets(`k1:${a}`, f), orgId, userId);
  await insert(db, "provider_credentials", r);
  const now = secrets(`k2:${b}`, f); // (k1 removed)
  const r2 = await row(now, orgId, userId, { id: r.id as string, version: 2, key: "rpa_NEWER" });
  const replace = () => db.batch([stmt(`UPDATE provider_credentials SET version = 2, sealed = ?, nonce = ?, kek_version = ?, fingerprint = ?, set_ms = ? WHERE id = ?`, r2.sealed, r2.nonce, r2.kek_version, r2.fingerprint, T0 + 1, r.id)]);
  assert.deepEqual(await openCredential(crossing(db, replace), now, orgId, "runpod", T0 + 2), { ok: false, reason: "unopenable" });
  assert.deepEqual(await one(db, `SELECT version, status, kek_version FROM provider_credentials`), { version: 2, status: "ok", kek_version: "k2" });
  assert.equal(await count(db, "credential_events"), 0);
  // a replace under the same removed KEK crossing it (its isolate still has k1): not marked either
  const oo = newId("org");
  await db.batch([org(oo, "byok")]);
  const v1 = await row(secrets(`k1:${a}`, f), oo, userId);
  await insert(db, "provider_credentials", v1);
  const v2 = await row(secrets(`k1:${a}`, f), oo, userId, { id: v1.id as string, version: 2, key: "rpa_NEWER" });
  const sameKek = () => db.batch([stmt(`UPDATE provider_credentials SET version = 2, sealed = ?, nonce = ?, fingerprint = ?, set_ms = ? WHERE id = ?`, v2.sealed, v2.nonce, v2.fingerprint, T0 + 1, v1.id)]);
  assert.deepEqual(await openCredential(crossing(db, sameKek), now, oo, "runpod", T0 + 2), { ok: false, reason: "unopenable" });
  assert.deepEqual(await one(db, `SELECT version, status FROM provider_credentials WHERE id = ?`, [v1.id]), { version: 2, status: "ok" });
  assert.equal(await count(db, "credential_events"), 0);
  // and a re-seal crossing a failed open (same version, the KEK version moved) isn't marked either
  const o2 = newId("org");
  await db.batch([org(o2, "byok")]);
  const x = await row(secrets(`k1:${a}`, f), o2, userId);
  await insert(db, "provider_credentials", x);
  const keys = (await credentialKeys(now.CREDENTIAL_KEKS, now.CREDENTIAL_FINGERPRINT_KEY))!;
  const fresh = await sealCredential(keys, { env: "test", orgId: o2, provider: "runpod", credentialId: x.id as string, version: 1 }, KEY);
  const reseal = () => db.batch([stmt(`UPDATE provider_credentials SET sealed = ?, nonce = ?, kek_version = 'k2' WHERE id = ?`, fresh.sealed, fresh.nonce, x.id)]);
  assert.deepEqual(await openCredential(crossing(db, reseal), now, o2, "runpod", T0 + 2), { ok: false, reason: "unopenable" });
  assert.deepEqual(await one(db, `SELECT status, kek_version FROM provider_credentials WHERE id = ?`, [x.id]), { status: "ok", kek_version: "k2" });
  assert.equal(await count(db, "credential_events"), 0);
});

test("secrecy: the key is in no stored row or event, and no refusal", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  await insert(db, "provider_credentials", await row(s, orgId, userId));
  const o2 = newId("org");
  await db.batch([org(o2, "byok")]);
  const bad = await row(s, o2, userId);
  await insert(db, "provider_credentials", { ...bad, sealed: (await row(s, orgId, userId)).sealed });
  const results = [await openCredential(db, s, o2, "runpod", T0), await openCredential(db, s, o2, "runpod", T0), await openCredential(db, { env: "x" }, orgId, "runpod", T0)];
  const dump = JSON.stringify([
    await db.all(`SELECT * FROM provider_credentials`), await db.all(`SELECT * FROM credential_events`), results,
    await credentialForOrg(db, orgId, "runpod"), await credentialForOrg(db, o2, "runpod"),
  ]);
  assert.equal(dump.includes(KEY), false);
  assert.equal(dump.includes(KEY.slice(4, 20)), false);
});

// ---------------------------------------------------------------- the resolver

test("resolver: a byok org uses its one credential, or none (absent, or a pausing status); a resold org uses ours", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  assert.deepEqual(await credentialForOrg(db, orgId, "runpod"), { use: "none", reason: "no-credential" });
  const r = await row(s, orgId, userId);
  await insert(db, "provider_credentials", r);
  assert.deepEqual(await credentialForOrg(db, orgId, "runpod"), { use: "org", provider: "runpod", orgId, credentialId: r.id, version: 1 });
  assert.deepEqual(await credentialForOrg(db, orgId, "shadeform"), { use: "none", reason: "no-credential" });
  for (const [status, use] of [["unchecked", "org"], ["rejected", "none"], ["revoked", "none"], ["error", "none"], ["ok", "org"]] as const) {
    await db.batch([stmt(`UPDATE provider_credentials SET status = ?, last_checked_ms = ? WHERE id = ?`, status, status === "unchecked" ? null : T0, r.id)]);
    const got = await credentialForOrg(db, orgId, "runpod");
    assert.equal(got.use, use, status);
    if (got.use === "none") assert.equal(got.reason, "credential-paused");
  }
  // another org's credential is never this org's
  const other = newId("org");
  await db.batch([org(other, "byok")]);
  assert.deepEqual(await credentialForOrg(db, other, "runpod"), { use: "none", reason: "no-credential" });
  const res = await setup("resold");
  assert.deepEqual(await credentialForOrg(res.db, res.orgId, "runpod"), { use: "ours", provider: "runpod" });
  assert.deepEqual(await credentialForOrg(db, orgId, "aws"), { use: "none", reason: "unknown-provider" });
  assert.deepEqual(await credentialForOrg(db, newId("org"), "runpod"), { use: "none", reason: "no-such-org" });
});

test("resolver: the stored status fails closed (a status this code doesn't know is paused)", async () => {
  const { db, orgId } = await setup();
  const odd = (status: unknown): Db => ({ ...db, all: async <T,>() => [{ billing_mode: "byok", credential_id: "crd_00000000000000000000", credential_version: 1, credential_status: status }] as T[] });
  for (const status of ["none", "OK", "", null, 1, "paused"]) assert.deepEqual(await credentialForOrg(odd(status), orgId, "runpod"), { use: "none", reason: "credential-paused" }, String(status));
});

async function launchIn(db: Db, orgId: string, account: "platform" | "org") {
  const [p, a, m] = [newId("project"), newId("allocation"), newId("machine")];
  await db.batch([
    project(p, orgId),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', 'mbr_x', 0, ?)`, a, p, T0),
    stmt(`INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, created_ms) VALUES ('m:prj_00000000000000000000:mbr_00000000000000000000', ?, ?, ?, 'mbr_x', 'runpod', 'L4', 1, 'X', 'starting', 1, ?)`, m, p, a, T0),
    stmt(
      `INSERT INTO launches (machine_id, incarnation, mode, provider, agent_sha256, credential_kind, account_kind, account_org_id, outcome, next_ms, created_ms)
       VALUES (?, 1, 'container', 'runpod', ?, ?, ?, ?, 'creating', ?, ?)`,
      m, "a".repeat(64), account === "org" ? "org" : "ours", account, account === "org" ? orgId : null, T0, T0,
    ),
  ]);
  return { projectId: p, machineId: m };
}

test("resolver: a launch uses the account it pinned at its intent, never its machine's current owner", async () => {
  const s = secrets();
  const { db, orgId, userId } = await setup();
  const mine = await launchIn(db, orgId, "org");
  const ours = await launchIn(db, orgId, "platform");
  assert.deepEqual(await credentialForLaunch(db, mine.machineId, 1), { use: "none", reason: "no-credential" });
  assert.deepEqual(await credentialForLaunch(db, ours.machineId, 1), { use: "ours", provider: "runpod" });
  // the pinned org's key for another provider isn't this launch's
  await insert(db, "provider_credentials", await row(s, orgId, userId, { provider: "shadeform" }));
  assert.deepEqual(await credentialForLaunch(db, mine.machineId, 1), { use: "none", reason: "no-credential" });
  const r = await row(s, orgId, userId);
  await insert(db, "provider_credentials", r);
  assert.deepEqual(await credentialForLaunch(db, mine.machineId, 1), { use: "org", provider: "runpod", orgId, credentialId: r.id, version: 1 });
  // a platform launch of a byok org stays ours, whatever the org now holds
  assert.deepEqual(await credentialForLaunch(db, ours.machineId, 1), { use: "ours", provider: "runpod" });
  // the project moves to another byok org that holds its own key: the launch still uses the pinned org's
  const other = newId("org");
  await db.batch([org(other, "byok")]);
  const theirs = await row(s, other, userId, { key: "rpa_THEIRS" });
  await insert(db, "provider_credentials", theirs);
  await db.batch([stmt(`UPDATE projects SET org_id = ? WHERE id = ?`, other, mine.projectId)]);
  assert.deepEqual(await credentialForLaunch(db, mine.machineId, 1), { use: "org", provider: "runpod", orgId, credentialId: r.id, version: 1 });
  // the pinned org's key paused, or removed: none, never the new owner's
  await db.batch([stmt(`UPDATE provider_credentials SET status = 'revoked' WHERE id = ?`, r.id)]);
  assert.deepEqual(await credentialForLaunch(db, mine.machineId, 1), { use: "none", reason: "credential-paused" });
  await db.batch([stmt(`DELETE FROM provider_credentials WHERE id = ?`, r.id)]);
  assert.deepEqual(await credentialForLaunch(db, mine.machineId, 1), { use: "none", reason: "no-credential" });
  // a launch that doesn't exist (another incarnation, another machine)
  assert.deepEqual(await credentialForLaunch(db, mine.machineId, 2), { use: "none", reason: "no-such-launch" });
  assert.deepEqual(await credentialForLaunch(db, newId("machine"), 1), { use: "none", reason: "no-such-launch" });
});

test("resolver: a launch's stored account or provider it doesn't know fails closed", async () => {
  const { db } = await setup();
  const odd = (v: Record<string, unknown>): Db => ({ ...db, all: async <T,>() => [{ provider: "runpod", account_kind: "org", account_org_id: "org_00000000000000000000", credential_id: "crd_00000000000000000000", credential_version: 1, credential_status: "ok", ...v }] as T[] });
  for (const kind of ["", "Platform", "ours", null, "byok"]) assert.deepEqual(await credentialForLaunch(odd({ account_kind: kind }), "m", 1), { use: "none", reason: "no-such-launch" }, String(kind));
  assert.deepEqual(await credentialForLaunch(odd({ account_org_id: null }), "m", 1), { use: "none", reason: "no-such-launch" });
  assert.deepEqual(await credentialForLaunch(odd({ provider: "aws" }), "m", 1), { use: "none", reason: "unknown-provider" });
  assert.deepEqual(await credentialForLaunch(odd({ provider: "aws", account_kind: "platform" }), "m", 1), { use: "none", reason: "unknown-provider" });
  assert.deepEqual(await credentialForLaunch(odd({ credential_status: "none" }), "m", 1), { use: "none", reason: "credential-paused" });
  assert.equal((await credentialForLaunch(odd({}), "m", 1)).use, "org");
});
