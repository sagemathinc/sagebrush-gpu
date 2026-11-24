import { test } from "node:test";
import assert from "node:assert/strict";

import type { webcrypto } from "node:crypto";
import { type Key, KID_PATTERN, TOKEN_MAX_CHARS, b64urlDecode, b64urlEncode, signToken, verifyToken } from "./jws.ts";
import { newId } from "./ids.ts";
import { TOKEN_KINDS, TOKEN_TTL_SECONDS, type ClaimsOf, type TokenKind } from "./tokens.ts";

const NOW = 1_800_000_000;
const mch = newId("machine");
const mbr = newId("member");
const prj = newId("project");
const jti = "AAAAAAAAAAAAAAAAAAAAAA";
const enc = new TextEncoder();

const base = (kind: TokenKind) => ({ v: 1 as const, kind, jti, iat: NOW - 10, exp: NOW - 10 + TOKEN_TTL_SECONDS[kind], mch, inc: 3 });
const CLAIMS: { [K in TokenKind]: ClaimsOf<K> } = {
  agent: base("agent") as ClaimsOf<"agent">,
  page: { ...base("page"), mbr } as ClaimsOf<"page">,
  "jupyter-link": { ...base("jupyter-link"), mbr } as ClaimsOf<"jupyter-link">,
  workspace: {
    ...base("workspace"), mbr, prj, team: null,
    grants: [{ area: "member", mode: "rw", quotaBytes: 50e9 }, { area: "project-data", mode: "ro" }],
    mode: { kind: "normal" },
  } as ClaimsOf<"workspace">,
};

type KeyPair = webcrypto.CryptoKeyPair;
const pair = () => crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as unknown as Promise<KeyPair>;
const K1 = await pair();
const K2 = await pair();
const KEYS = new Map([["k1", K1.publicKey]]);

const reason = async (token: unknown, kind: TokenKind = "agent", keys: ReadonlyMap<string, Key> = KEYS, now = NOW) => {
  const r = await verifyToken(token, keys, kind, now);
  return r.ok ? "ok" : r.reason;
};
const parts = (t: string) => t.split(".") as [string, string, string];
const text = (s: string) => b64urlEncode(enc.encode(s));
/** A token over arbitrary header and payload text, signed properly by `key`. */
async function forge(header: string, payload: string, key: Key = K1.privateKey): Promise<string> {
  const input = `${text(header)}.${text(payload)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, enc.encode(input)));
  return `${input}.${b64urlEncode(sig)}`;
}
const HEADER = '{"alg":"EdDSA","kid":"k1"}';

test("a round trip for every kind, and the token's exact form", async () => {
  for (const kind of TOKEN_KINDS) {
    const t = await signToken(CLAIMS[kind], K1.privateKey, "k1");
    const r = await verifyToken(t, KEYS, kind, NOW);
    assert.ok(r.ok, kind);
    assert.deepEqual(r.ok && r.claims, CLAIMS[kind]);
    const [h, p] = parts(t);
    assert.equal(new TextDecoder().decode(b64urlDecode(h)!), HEADER);
    assert.equal(new TextDecoder().decode(b64urlDecode(p)!), JSON.stringify(CLAIMS[kind]));
    assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
  }
});

test("a token of one kind verified as another is refused", async () => {
  for (const kind of TOKEN_KINDS) {
    const t = await signToken(CLAIMS[kind], K1.privateKey, "k1");
    for (const other of TOKEN_KINDS) if (other !== kind) assert.equal(await reason(t, other), "kind", `${kind} as ${other}`);
  }
});

test("one changed character in any part is refused", async () => {
  const t = await signToken(CLAIMS.agent, K1.privateKey, "k1");
  for (let part = 0; part < 3; part++) {
    const orig = parts(t)[part]!;
    for (const i of [0, Math.floor(orig.length / 2), orig.length - 2]) {
      const ps: string[] = parts(t);
      ps[part] = orig.slice(0, i) + (orig[i] === "A" ? "B" : "A") + orig.slice(i + 1);
      assert.notEqual(await reason(ps.join(".")), "ok", `part ${part} at ${i}`);
    }
  }
});

test("header swaps: another alg, extra or missing keys, another order, an unknown kid", async () => {
  const payload = JSON.stringify(CLAIMS.agent);
  assert.equal(await reason(await forge(HEADER, payload)), "ok"); // (the control: forge() signs as control does)
  for (const h of [
    '{"alg":"none","kid":"k1"}', '{"alg":"HS256","kid":"k1"}', '{"alg":"RS256","kid":"k1"}', '{"alg":"ES256","kid":"k1"}',
    '{"alg":"EdDSA","kid":"k1","typ":"JWT"}', '{"alg":"EdDSA"}', '{"kid":"k1","alg":"EdDSA"}', '{"alg":"EdDSA", "kid":"k1"}',
    '{"alg":"EdDSA","kid":"k1","kid":"k1"}', '{"alg":"EdDSA","kid":"k\\u0031"}', '{"alg":"EdDSA","kid":"k/1"}', "",
  ]) {
    assert.equal(await reason(await forge(h, payload)), "header", h);
  }
  assert.equal(await reason(await forge('{"alg":"EdDSA","kid":"k9"}', payload)), "unknown kid");
  // (a kid that is a property of every object is still unknown)
  assert.equal(await reason(await forge('{"alg":"EdDSA","kid":"constructor"}', payload)), "unknown kid");
  assert.equal(await reason(await forge(HEADER, payload), "agent", new Map()), "unknown kid");
});

test("keys: rotation by kid, another key's signature, and keys that aren't Ed25519 public keys", async () => {
  const t2 = await signToken(CLAIMS.agent, K2.privateKey, "k2");
  assert.equal(await reason(t2, "agent", new Map([["k1", K1.publicKey], ["k2", K2.publicKey]])), "ok");
  assert.equal(await reason(t2, "agent", new Map([["k2", K1.publicKey]])), "signature");
  assert.equal(await reason(await signToken(CLAIMS.agent, K2.privateKey, "k1")), "signature");
  assert.equal(await reason(t2, "agent", new Map([["k2", K2.privateKey]])), "key");
  const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as KeyPair;
  assert.equal(await reason(t2, "agent", new Map([["k2", ec.publicKey]])), "key");
  assert.equal(await reason(t2, "agent", { get: () => K2.publicKey, has: () => true } as unknown as Map<string, Key>), "unknown kid");
});

test("encoding: padding, standard base64, set trailing bits, bad lengths, empty parts and the size cap", async () => {
  const t = await signToken(CLAIMS.agent, K1.privateKey, "k1");
  const [h, p, s] = parts(t);
  assert.equal(await reason(`${h}=.${p}.${s}`), "header encoding");
  assert.equal(await reason(`${h}.${p}=.${s}`), "payload encoding");
  assert.equal(await reason(`${h}.${p}.${s}==`), "signature encoding");
  assert.equal(await reason(`${h}.${p.replace(/-/g, "+").replace(/_/g, "/")}.${s}`), p.includes("-") || p.includes("_") ? "payload encoding" : "ok");
  // (set trailing bits: the last character of an 86-character, 64-byte signature carries 4 unused bits)
  const last = s[s.length - 1]!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const other = alphabet[alphabet.indexOf(last) ^ 1]!;
  assert.equal(await reason(`${h}.${p}.${s.slice(0, -1)}${other}`), "signature encoding");
  assert.equal(await reason(`${h}.${p}.${s.slice(0, -2)}`), "signature encoding"); // (63 bytes)
  assert.equal(await reason(`${h}.${p}.${s}AAAA`), "signature encoding"); // (67 bytes)
  assert.equal(await reason(`${h}.${p}`), "shape");
  assert.equal(await reason(`${h}.${p}.${s}.x`), "shape");
  assert.equal(await reason(`.${p}.${s}`), "header");
  assert.equal(await reason(`${h}..${s}`), "signature");
  assert.equal(await reason(7), "not a string");
  assert.equal(await reason("x".repeat(TOKEN_MAX_CHARS + 1)), "too long");
  assert.equal(await reason(`${h}.${p}.${s}`.padEnd(TOKEN_MAX_CHARS, "A")), "signature encoding"); // (at the cap: decoded, then refused)
  assert.equal(b64urlDecode("A"), null);
  assert.equal(b64urlDecode("A==="), null);
  assert.deepEqual(b64urlDecode(""), new Uint8Array(0));
});

test("the payload: JSON, its one serialization, then validateClaims (no claim read before the signature)", async () => {
  const c = CLAIMS.agent;
  assert.equal(await reason(await forge(HEADER, "not json")), "payload json");
  assert.equal(await reason(await forge(HEADER, JSON.stringify(c, null, 1))), "payload not canonical");
  assert.equal(await reason(await forge(HEADER, JSON.stringify(c).replace('"v":1', '"v":1,"v":1'))), "payload not canonical");
  // (claims the validator refuses: expired, not yet valid, past the lifetime cap, wrong keys)
  assert.equal(await reason(await signToken(c, K1.privateKey, "k1"), "agent", KEYS, c.exp), "expired");
  assert.equal(await reason(await signToken(c, K1.privateKey, "k1"), "agent", KEYS, c.exp - 1), "ok");
  assert.equal(await reason(await forge(HEADER, JSON.stringify({ ...c, iat: NOW + 31, exp: NOW + 100 }))), "issued in the future");
  assert.equal(await reason(await forge(HEADER, JSON.stringify({ ...c, exp: c.iat + TOKEN_TTL_SECONDS.agent + 1 }))), "lifetime over the cap");
  assert.equal(await reason(await forge(HEADER, JSON.stringify({ ...c, extra: 1 }))), "keys");
  // (a bad signature on bad claims reports the signature, not the claims: claims are read only after it)
  const bad = await forge(HEADER, JSON.stringify({ ...c, extra: 1 }), K2.privateKey);
  assert.equal(await reason(bad), "signature");
  assert.equal(await reason(await forge(HEADER, "not json", K2.privateKey)), "signature");
  // (bytes that aren't UTF-8 in the payload)
  const input = `${text(HEADER)}.${b64urlEncode(new Uint8Array([0xff, 0xfe]))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", K1.privateKey, enc.encode(input)));
  assert.equal(await reason(`${input}.${b64urlEncode(sig)}`), "payload json");
});

test("signToken refuses what no verifier would accept", async () => {
  await assert.rejects(signToken({ ...CLAIMS.agent, exp: CLAIMS.agent.iat }, K1.privateKey, "k1"), /invalid claims/);
  await assert.rejects(signToken({ ...CLAIMS.agent, extra: 1 } as unknown as ClaimsOf<"agent">, K1.privateKey, "k1"), /invalid claims/);
  await assert.rejects(signToken(CLAIMS.agent, K1.privateKey, "k/1"), /bad kid/);
  await assert.rejects(signToken(CLAIMS.agent, K1.privateKey, ""), /bad kid/);
  await assert.rejects(signToken(CLAIMS.agent, K1.privateKey, "k".repeat(65)), /bad kid/);
  assert.ok(KID_PATTERN.test("k".repeat(64)));
  await assert.rejects(signToken(CLAIMS.agent, K1.publicKey, "k1"), /not an Ed25519 private key/);
});
