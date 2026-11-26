// The one request path for an organization's provider keys, apart from the shared client
// (client.ts) on purpose: the body that carries a key goes straight to fetch, so nothing
// that wraps the shared client (recording, retries, errors that carry a request) ever sees
// it. It never retries, never throws, and its outcomes are fixed: a refusal is named by the
// contract's list (CREDENTIAL_REFUSALS), and nothing in an outcome comes from the request.

import {
  CREDENTIAL_REFUSALS,
  isCredentialStatus,
  isCredentialVersion,
  isId,
  isProviderId,
  type CredentialRefusal,
  type ProviderCredential,
  type ProviderId,
} from "@sbgpu/api";
import type { FetchFn } from "./client.ts";

/**
 * How a credential request ended. "network": no answer (or the request was aborted);
 * "badResponse": an answer that isn't the contract's (an unknown refusal included).
 */
export type CredentialOutcome<T> = { ok: true; value: T } | { ok: false; refusal: CredentialRefusal | "network" | "badResponse" };

const PATH = /^\/v1\/orgs\/[A-Za-z0-9._-]+\/credentials(\/[a-z]+)?$/;
/** A DELETE names the key it removes: its id and version, and nothing else. */
const DELETE_PATH = /^\/v1\/orgs\/[A-Za-z0-9._-]+\/credentials\/[a-z]+\?id=crd_[0-9a-z]{20}&version=[1-9][0-9]{0,15}$/;

/**
 * Send one credential request: GET or DELETE with no body (null), PUT with `body` (the JSON
 * text the caller built from the key). A DELETE's path carries exactly ?id=&version=, and
 * only a DELETE's does. Not an async function: fetch is called before it returns, and nothing
 * here holds `body` after that (the browser's network stack has it while it sends). The
 * answer is read only as far as the contract shapes it.
 */
export function credentialRequest<T>(
  fetchFn: FetchFn,
  method: "GET" | "PUT" | "DELETE",
  path: string,
  body: string | null,
  signal: AbortSignal,
  read: (x: unknown) => T | null,
): Promise<CredentialOutcome<T>> {
  if (!(method === "DELETE" ? DELETE_PATH : PATH).test(path)) return Promise.resolve({ ok: false, refusal: "badResponse" });
  const init: RequestInit = { method, credentials: "same-origin", headers: { accept: "application/json" }, signal, redirect: "error" };
  if (body !== null) {
    init.headers = { accept: "application/json", "content-type": "application/json" };
    init.body = body;
  }
  let sent: Promise<Response>;
  try {
    sent = fetchFn(path, init);
  } catch {
    return Promise.resolve({ ok: false, refusal: "network" });
  }
  return sent.then(
    (response) => answer(response, read),
    () => ({ ok: false, refusal: "network" }) as const, // (the reason, an abort's included, is dropped)
  );
}

async function answer<T>(response: Response, read: (x: unknown) => T | null): Promise<CredentialOutcome<T>> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, refusal: "badResponse" };
  }
  if (response.ok) {
    const value = read(json);
    return value == null ? { ok: false, refusal: "badResponse" } : { ok: true, value };
  }
  return { ok: false, refusal: refusalOf(json) };
}

/** Which of the contract's refusals an error body is: its code and its exact words, or "badResponse". */
export function refusalOf(json: unknown): CredentialRefusal | "badResponse" {
  const e = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (e == null || typeof e !== "object") return "badResponse";
  for (const [name, r] of Object.entries(CREDENTIAL_REFUSALS)) {
    if (r.code === e.code && r.message === e.message) return name as CredentialRefusal;
  }
  return "badResponse";
}

/** A ProviderCredential as the contract has it, copied field by field; null otherwise. */
export function readCredential(x: unknown): ProviderCredential | null {
  if (typeof x !== "object" || x === null) return null;
  const c = x as Record<string, unknown>;
  const str = (v: unknown) => v === null || typeof v === "string";
  if (!isProviderId(c.provider) || !isCredentialStatus(c.status)) return null;
  if (!str(c.fingerprint) || !str(c.setBy) || !str(c.setAt) || !str(c.lastCheckedAt)) return null;
  if (!Number.isSafeInteger(c.runningMachines) || (c.runningMachines as number) < 0) return null;
  // id and version: both null exactly when no key is set, else a credential id and a version.
  const none = c.status === "none";
  if (none ? c.id !== null || c.version !== null : !isId("credential", c.id) || !isCredentialVersion(c.version)) return null;
  return {
    provider: c.provider,
    id: c.id as string | null,
    version: c.version as number | null,
    status: c.status,
    fingerprint: c.fingerprint as string | null,
    setBy: c.setBy as string | null,
    setAt: c.setAt as string | null,
    lastCheckedAt: c.lastCheckedAt as string | null,
    runningMachines: c.runningMachines as number,
  };
}

/** The list's answer: every item a ProviderCredential, each provider once. */
export function readCredentialList(x: unknown): ProviderCredential[] | null {
  const items = (x as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const out: ProviderCredential[] = [];
  for (const item of items) {
    const c = readCredential(item);
    if (c == null || out.some((o) => o.provider === c.provider)) return null;
    out.push(c);
  }
  return out;
}

export function readRemoved(x: unknown): true | null {
  return (x as { removed?: unknown } | null)?.removed === true ? true : null;
}

export function credentialsPath(orgId: string, provider?: ProviderId): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/credentials${provider === undefined ? "" : `/${provider}`}`;
}
