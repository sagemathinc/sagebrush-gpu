// The agent-token signer (VM enroll, design r3, SEC clear): control's Ed25519 private key,
// a Worker secret, used only after it is proved ready. Ready means:
// - the private key is a closed JWK (exactly kty "OKP", crv "Ed25519", d, x);
// - its kid is well formed;
// - the deployment pins a public key for that kid (a closed map of closed public JWKs), equal
//   to the private key's own x;
// - a signature by the private key over a fixed message verifies under that pinned public
//   key, which proves the pair.
// Anything else is "not ready": enroll then refuses before any state change, and alerts.
// Nothing here ever returns, logs or throws key material.

import { KID_PATTERN, b64urlDecode, type Key } from "@sbgpu/api";

export interface AgentSigner {
  kid: string;
  privateKey: Key;
}

/** Where a request gets the signer: null when it isn't ready (missing, malformed, mismatched). */
export type AgentSignerSource = () => Promise<AgentSigner | null>;

/** The most published keys a deployment pins (current and next, plus retired ones kept for verifiers). */
export const MAX_PINNED_KEYS = 8;
const MAX_JWK_CHARS = 1024;
const CHECK_MESSAGE = new TextEncoder().encode("sbgpu agent signer readiness v1");

function closedObject(x: unknown, keys: string): Record<string, unknown> | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  return Object.keys(x).sort().join(",") === keys ? (x as Record<string, unknown>) : null;
}

/** 32 bytes of canonical base64url, as Ed25519's x and d are (checked on every pin, not only the one imported). */
function ed25519Part(x: unknown): x is string {
  if (typeof x !== "string") return false;
  const b = b64urlDecode(x);
  return b !== null && b.length === 32;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string" || text.length > MAX_JWK_CHARS * MAX_PINNED_KEYS) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The signer, if ready: `privateJwk` is the secret's text, `kid` its key id, `publicKeys` the
 * deployment's pinned map `{ kid: { kty, crv, x } }` as text. Else null.
 */
export async function loadAgentSigner(privateJwk: unknown, kid: unknown, publicKeys: unknown): Promise<AgentSigner | null> {
  // (the kid must be one of the pins, whose kids are checked below)
  if (typeof kid !== "string") return null;
  const jwk = closedObject(parseJson(privateJwk), "crv,d,kty,x");
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !ed25519Part(jwk.d) || !ed25519Part(jwk.x)) return null;
  const pinned = parseJson(publicKeys);
  if (typeof pinned !== "object" || pinned === null || Array.isArray(pinned)) return null;
  const kids = Object.keys(pinned);
  if (kids.length === 0 || kids.length > MAX_PINNED_KEYS || !kids.every((k) => KID_PATTERN.test(k))) return null;
  // (every pin is a closed public Ed25519 JWK, the one used or not)
  const pins = new Map<string, Record<string, unknown>>();
  for (const k of kids) {
    const p = closedObject((pinned as Record<string, unknown>)[k], "crv,kty,x");
    if (!p || p.kty !== "OKP" || p.crv !== "Ed25519" || !ed25519Part(p.x)) return null;
    pins.set(k, p);
  }
  const pub = pins.get(kid);
  if (!pub || pub.x !== jwk.x) return null;
  try {
    const privateKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, "Ed25519", false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: pub.x }, "Ed25519", false, ["verify"]);
    const sig = await crypto.subtle.sign("Ed25519", privateKey, CHECK_MESSAGE);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, sig, CHECK_MESSAGE))) return null;
    return { kid, privateKey };
  } catch {
    return null;
  }
}
