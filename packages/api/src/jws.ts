// Signed tokens: compact JWS with Ed25519 (WebCrypto), the one encoding control signs and every verifier (relay,
// storage gateway, control) checks.  Claims are tokens.ts's; validateClaims is the one claims language.
//
//   token = base64url(header) "." base64url(payload) "." base64url(signature)
//   header = exactly {"alg":"EdDSA","kid":"<kid>"}  (these bytes, in this order, nothing else)
//   payload = JSON.stringify(claims), exactly
//   signature = Ed25519 over the ASCII bytes of base64url(header) "." base64url(payload)
//
// verifyToken checks, in this order, and reads no claim before the signature holds: the token's size and shape; each
// part's canonical base64url; the header's exact bytes; its kid among the given keys; the signature; the payload's JSON
// and its one serialization; then validateClaims for the expected kind at `now`.
import { type ClaimsCheck, type ClaimsOf, type TokenKind, validateClaims } from "./tokens.ts";

/** A token's most characters: well above any claims this contract can hold, checked before anything is decoded. */
export const TOKEN_MAX_CHARS = 4096;
/** A key id: what control publishes with each public key (current and next, for rotation). */
export const KID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A WebCrypto key (Ed25519 here): the global CryptoKey, the same in Node, Workers and browsers. */
export type Key = InstanceType<typeof CryptoKey>;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const B64URL = /^[A-Za-z0-9_-]*$/;

/** base64url without padding. */
export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of canonical base64url (no padding, no other characters, no set trailing bits), or null. */
export function b64urlDecode(s: string): Uint8Array | null {
  if (!B64URL.test(s) || s.length % 4 === 1) return null;
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // (the one encoding of these bytes: a string with set trailing bits decodes to the same bytes, but re-encodes differently)
  return b64urlEncode(out) === s ? out : null;
}

function headerText(kid: string): string {
  return JSON.stringify({ alg: "EdDSA", kid });
}

function isEd25519(key: unknown, type: "public" | "private"): key is Key {
  return (
    typeof key === "object" && key !== null && (key as Key).type === type &&
    (key as Key).algorithm?.name === "Ed25519"
  );
}

/**
 * A signed token for `claims`.  The claims must be valid for their own kind at their own iat (so control can't sign
 * what no verifier would accept); kid must match KID_PATTERN; the key must be an Ed25519 private key.
 */
export async function signToken(claims: ClaimsOf<TokenKind>, privateKey: Key, kid: string): Promise<string> {
  if (!KID_PATTERN.test(kid)) throw new Error("bad kid");
  if (!isEd25519(privateKey, "private")) throw new Error("not an Ed25519 private key");
  // (one snapshot: serialized once, then that exact text parsed, validated and signed, so nothing about the live
  // object (an accessor, say) can change between the check and the signature)
  const payload = JSON.stringify(claims);
  const snapshot = JSON.parse(payload) as { kind: TokenKind; iat: number };
  const check = validateClaims(snapshot, snapshot.kind, snapshot.iat);
  if (!check.ok) throw new Error(`invalid claims: ${check.reason}`);
  const signingInput = `${b64urlEncode(enc.encode(headerText(kid)))}.${b64urlEncode(enc.encode(payload))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, enc.encode(signingInput)));
  const token = `${signingInput}.${b64urlEncode(sig)}`;
  if (token.length > TOKEN_MAX_CHARS) throw new Error("token over TOKEN_MAX_CHARS");
  return token;
}

/**
 * Verify a token as `kind` at `nowSeconds`: { ok: true, claims } only if every check passes, else { ok: false, reason }.
 * `keys` maps each published kid to its Ed25519 public key.
 */
export async function verifyToken<K extends TokenKind>(
  token: unknown,
  keys: ReadonlyMap<string, Key>,
  kind: K,
  nowSeconds: number,
): Promise<ClaimsCheck<K>> {
  const fail = (reason: string): ClaimsCheck<K> => ({ ok: false, reason });
  // ---- size and shape, before anything is decoded
  if (typeof token !== "string") return fail("not a string");
  if (token.length > TOKEN_MAX_CHARS) return fail("too long");
  const parts = token.split(".");
  if (parts.length !== 3) return fail("shape");
  const [h, p, s] = parts as [string, string, string];
  // ---- the header: canonical base64url, exactly the one header text, a known kid
  const hb = b64urlDecode(h);
  if (!hb) return fail("header encoding");
  let ht: string;
  try {
    ht = dec.decode(hb);
  } catch {
    return fail("header encoding");
  }
  const kidMatch = /^\{"alg":"EdDSA","kid":"([A-Za-z0-9_-]{1,64})"\}$/.exec(ht);
  if (!kidMatch) return fail("header");
  const kid = kidMatch[1]!;
  if (!(keys instanceof Map) || !keys.has(kid)) return fail("unknown kid");
  const key = keys.get(kid);
  if (!isEd25519(key, "public")) return fail("key");
  // ---- the signature over the exact signing input
  const pb = b64urlDecode(p);
  if (!pb) return fail("payload encoding");
  const sb = b64urlDecode(s);
  if (!sb || sb.length !== 64) return fail("signature encoding");
  let good: boolean;
  try {
    good = await crypto.subtle.verify("Ed25519", key, sb, enc.encode(`${h}.${p}`));
  } catch {
    return fail("signature");
  }
  if (!good) return fail("signature");
  // ---- only now the claims: JSON, its one serialization, then the contract's validator
  let pt: string;
  let claims: unknown;
  try {
    pt = dec.decode(pb);
    claims = JSON.parse(pt);
  } catch {
    return fail("payload json");
  }
  if (JSON.stringify(claims) !== pt) return fail("payload not canonical");
  return validateClaims(claims, kind, nowSeconds);
}
