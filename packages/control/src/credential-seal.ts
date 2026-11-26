// An organization's provider key at rest (BYOK design r3, row 2): sealed with AES-256-GCM
// under a Worker secret, in the shape of seal.ts, with its own associated-data prefix.
//
// Two secrets, both parsed strictly, and neither ever in the database:
//   CREDENTIAL_KEKS             "<version>:<32 bytes, base64>" entries separated by commas, the
//                               first being the current KEK (every new seal uses it) and any
//                               others old ones, kept only for opening
//   CREDENTIAL_FINGERPRINT_KEY  32 bytes, base64: the HMAC key of the fingerprint, never a KEK
// Anything malformed (an empty or unparseable entry, whitespace, a bad version, a duplicate
// version, a wrong length, or a fingerprint key equal to a KEK) leaves the store unavailable:
// there is never a partial or default key.
//
// Each seal has a fresh 96-bit nonce, and its associated data binds it to the environment, the
// organization, the provider, the credential's id and version and the KEK's version, so a
// ciphertext copied to another organization, provider, row, version or environment doesn't
// open. Rotating: put a new KEK first and keep the old one after it; keys move to the new KEK
// at their next open (credentials.ts). A key whose KEK is removed can't be opened.

/** (WebCrypto's key type, named the way both Node's and the Workers' types know it) */
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface CredentialKeys {
  current: string;
  keks: Map<string, Key>;
  fingerprint: Key;
}

const VERSION = /^[A-Za-z0-9_-]{1,16}$/;
/** base64 of exactly 32 bytes: 43 characters and one "=" */
const B64_32 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const cache = new Map<string, Promise<CredentialKeys | null>>();

/** The parsed secrets, or null when either is missing or malformed (the store is then unavailable). */
export function credentialKeys(keks: string | undefined, fingerprintKey: string | undefined): Promise<CredentialKeys | null> {
  if (typeof keks !== "string" || typeof fingerprintKey !== "string") return Promise.resolve(null);
  const id = JSON.stringify([keks, fingerprintKey]);
  let p = cache.get(id);
  if (!p) {
    p = parse(keks, fingerprintKey);
    cache.set(id, p);
  }
  return p;
}

async function parse(secret: string, fingerprintKey: string): Promise<CredentialKeys | null> {
  if (!B64_32.test(fingerprintKey)) return null;
  const keks = new Map<string, Key>();
  let current: string | null = null;
  for (const part of secret.split(",")) {
    const i = part.indexOf(":");
    if (i < 0) return null;
    const v = part.slice(0, i);
    const k = part.slice(i + 1);
    if (!VERSION.test(v) || !B64_32.test(k) || keks.has(v) || k === fingerprintKey) return null;
    keks.set(v, await crypto.subtle.importKey("raw", unb64(k), "AES-GCM", false, ["encrypt", "decrypt"]));
    current ??= v;
  }
  if (!current) return null;
  const fingerprint = await crypto.subtle.importKey("raw", unb64(fingerprintKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { current, keks, fingerprint };
}

/** Which key a seal belongs to: every field is in its associated data. */
export interface CredentialSealContext {
  env: string;
  orgId: string;
  provider: string;
  credentialId: string;
  version: number;
}
const aad = (c: CredentialSealContext, kekVersion: string) =>
  enc.encode(`sbgpu-provider-credential\n${c.env}\n${c.orgId}\n${c.provider}\n${c.credentialId}\n${c.version}\n${kekVersion}`);

export interface Sealed {
  /** base64 of the ciphertext and its tag */
  sealed: string;
  /** base64 of the 96-bit nonce */
  nonce: string;
  kekVersion: string;
}

/** `key` sealed under the current KEK, with a fresh nonce. */
export async function sealCredential(k: CredentialKeys, c: CredentialSealContext, key: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(c, k.current) }, k.keks.get(k.current)!, enc.encode(key)));
  return { sealed: b64(ct), nonce: b64(iv), kekVersion: k.current };
}

/** The key, or null if its KEK is gone or it doesn't open in this context (another org, provider, row, version or environment). */
export async function openSealed(k: CredentialKeys, c: CredentialSealContext, s: Sealed): Promise<string | null> {
  const kek = k.keks.get(s.kekVersion);
  if (!kek) return null;
  try {
    const iv = unb64(s.nonce);
    const ct = unb64(s.sealed);
    if (iv.length !== 12 || ct.length < 16 + 1) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(c, s.kekVersion) }, kek, ct);
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

/** The key's fingerprint: the first 16 hex characters of its HMAC-SHA-256 under the fingerprint key. */
export async function credentialFingerprint(k: CredentialKeys, key: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k.fingerprint, enc.encode(key)));
  return [...mac.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
