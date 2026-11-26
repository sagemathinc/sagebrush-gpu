// An organization's provider keys on its page (an owner's, of a byok organization): the
// list, the window after a fresh sign-in in which keys may change, and set, replace and
// remove. No DOM here, and never a key: the page hands put() the request body it built and
// keeps nothing; what's kept is the server's facts about each key, and fixed words.
//
// Every request is fenced to what it was started for: the organization, its row, and a
// generation that leave() moves on (an organization switch, unmount, the session's end), which
// also aborts it. A completion that doesn't match changes nothing, even one that wins the race
// with its abort; and since an abort isn't a rollback, an organization opened again is read
// again from the server.

import { batch, signal } from "@preact/signals";
import {
  isRecentAuthForMs,
  type CredentialRefusal,
  type CredentialStatus,
  type ProviderCredential,
  type ProviderId,
} from "@sbgpu/api";
import type { FetchFn } from "../client.ts";
import {
  credentialRequest,
  credentialsPath,
  readCredential,
  readCredentialList,
  readRemoved,
  type CredentialOutcome,
} from "../credential-request.ts";
import type { PollTimers } from "./polling.ts";

/** The page's own words for every way a credential request can end badly (never the server's). */
export const KEY_REFUSAL_WORDS: Readonly<Record<CredentialRefusal | "network" | "badResponse", string>> = Object.freeze({
  badShape: "That isn't a key: a key is 1 to 4096 letters, digits and punctuation marks, with no spaces. Nothing was saved.",
  rejected: "The provider refused this key. Nothing was saved; any key set before is unchanged.",
  checkUnavailable: "The provider couldn't be reached to check this key. Nothing was saved; try again later.",
  notOwner: "Only an owner of this organization can see or change its provider keys.",
  notByok: "This organization uses our provider accounts, so it has no keys of its own.",
  reauthenticate: "Confirm it's you again to change provider keys.",
  unknownProvider: "Keys for this provider aren't accepted.",
  noKey: "No key is set for this provider.",
  busy: "Another change to this key is in progress. Nothing was saved; try again in a moment.",
  tooManyChecks: "Too many key checks for now. Nothing was saved; try again in a few minutes.",
  signedOut: "Your session has ended. Sign in again to change provider keys.",
  mfaRequired: "Changing provider keys needs two-step verification with an authenticator app. Set one up for your account, then try again.",
  mfaInvalid: "That code didn't work. Enter the current six-digit code from your authenticator app. Nothing was saved.",
  badExpected: "This change didn't match the key as listed. Reload the page and try again. Nothing was saved.",
  network: "The server didn't answer. The list below shows what's set now; paste the key again to retry.",
  badResponse: "The server's answer wasn't one this page understands. Reload the page to see what's set.",
});

export const KEY_SAVED_WORDS = "Saved: the provider accepted the key.";
export const KEY_REMOVED_WORDS = "Removed: new machines can't start on this provider with your key.";

export const KEY_STATUS_WORDS: Readonly<Record<CredentialStatus, string>> = Object.freeze({
  none: "Not set",
  unchecked: "Set, not checked yet",
  ok: "Working",
  rejected: "Refused by the provider",
  revoked: "Revoked at the provider",
  error: "Couldn't be checked",
});

/**
 * The window's default timer: the real one, except that a pending window doesn't keep a
 * process alive (in Node, tests'; a browser has no such notion).
 */
export const WINDOW_TIMERS: PollTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface KeyClocks {
  /** A monotonic clock, ms (performance.now): the reauth window is measured on it. */
  monotonic: () => number;
  timers: PollTimers;
}

/** One request in flight: what it was started for, and its abort. */
interface Ticket {
  generation: number;
  orgId: string;
  slot: ProviderId | "list";
  controller: AbortController;
}

export class ProviderKeys {
  /** The organization the keys are for; null when none is open. */
  readonly orgId = signal<string | null>(null);
  /** Its keys, as the server last said; null until read. */
  readonly rows = signal<ProviderCredential[] | null>(null);
  /** Fixed words for each row's last outcome, and the list's ("list"). */
  readonly notices = signal<Readonly<Partial<Record<ProviderId | "list", string>>>>({});
  /** Rows (and "list") with a request in flight: one at a time each. */
  readonly pending = signal<ReadonlySet<ProviderId | "list">>(new Set());
  /** Whether keys may change now (a recent sign-in); the server decides on every change too. */
  readonly windowOpen = signal(false);

  readonly #fetch: FetchFn;
  readonly #clocks: KeyClocks;
  readonly #signedOut: () => void;
  #generation = 0;
  /** Credential changes ended so far (any outcome): a list read that saw this move is stale. */
  #writes = 0;
  readonly #controllers = new Set<AbortController>();
  #deadline: number | null = null;
  #timer: unknown = null;

  /** Reads /me's window for one organization (GET /v1/me?orgId=): what it says, or a throw. */
  readonly #readWindow: (orgId: string) => Promise<unknown>;

  constructor(fetchFn: FetchFn, clocks: KeyClocks, signedOut: () => void, readWindow: (orgId: string) => Promise<unknown> = async () => null) {
    this.#fetch = fetchFn;
    this.#clocks = clocks;
    this.#signedOut = signedOut;
    this.#readWindow = readWindow;
  }

  // ---------------------------------------------------------------- the reauth window

  /**
   * The window from a /me answer: `sentAt` is the monotonic time taken just before the
   * request was sent, and `forMs` what the server said was left when it answered. Counted
   * from the request's start, the window can only end early (by the request's transit),
   * never after the server's. Anything but an integer from 0 to five minutes means closed.
   */
  setWindow(sentAt: number, forMs: unknown): void {
    this.#stopTimer();
    if (!isRecentAuthForMs(forMs)) return this.closeWindow();
    this.#deadline = sentAt + forMs;
    this.#checkWindow();
  }

  closeWindow(): void {
    this.#stopTimer();
    this.#deadline = null;
    this.windowOpen.value = false;
  }

  #checkWindow(): void {
    const left = this.#deadline == null ? 0 : this.#deadline - this.#clocks.monotonic();
    if (!(left > 0)) return this.closeWindow();
    this.windowOpen.value = true;
    this.#timer = this.#clocks.timers.setTimeout(() => {
      this.#timer = null;
      this.#checkWindow();
    }, left);
  }

  #stopTimer(): void {
    if (this.#timer != null) this.#clocks.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  // ---------------------------------------------------------------- the organization

  /**
   * Show `orgId`'s keys: whatever was open is left (its window with it), and the list and this
   * organization's window are read from the server.
   */
  open(orgId: string): Promise<void> {
    this.leave();
    this.orgId.value = orgId;
    return Promise.all([this.#load(), this.refreshWindow()]).then(() => undefined);
  }

  /**
   * Read the open organization's window again (an assurance is for one organization). An answer
   * for an organization since left, or from an older read, changes nothing; a failed read closes it.
   */
  async refreshWindow(): Promise<void> {
    const orgId = this.orgId.value;
    if (orgId == null) return; // (none open: the window closed when it was left, or was never opened)
    const generation = this.#generation;
    const sentAt = this.#clocks.monotonic();
    let forMs: unknown = null;
    try {
      forMs = await this.#readWindow(orgId);
    } catch {
      forMs = null;
    }
    if (generation !== this.#generation || this.orgId.value !== orgId) return;
    this.setWindow(sentAt, forMs);
  }

  /**
   * Leave the organization (a switch, unmount, the session's end): every request in flight is
   * aborted, none of their answers will change anything, and its window closes (it was that
   * organization's).
   */
  leave(): void {
    this.#generation++;
    this.closeWindow();
    for (const c of this.#controllers) c.abort();
    this.#controllers.clear();
    batch(() => {
      this.orgId.value = null;
      this.rows.value = null;
      this.notices.value = {};
      this.pending.value = new Set();
    });
  }

  /** The session ended: leave, and the window is closed. */
  endSession(): void {
    this.leave();
    this.closeWindow();
  }

  // ---------------------------------------------------------------- requests

  /**
   * Set or replace `provider`'s key with `body`, the JSON the page built from it (and has
   * already cleared from its field). False, and nothing is sent, when the window is closed
   * or the row has a request in flight. Never retried.
   */
  put(provider: ProviderId, body: string): Promise<boolean> {
    if (!this.windowOpen.value) return Promise.resolve(false);
    const t = this.#begin(provider);
    if (t == null) return Promise.resolve(false);
    // (an answer naming another provider is not this request's: it changes no row)
    const forThisRow = (x: unknown) => {
      const c = readCredential(x);
      return c != null && c.provider === provider ? c : null;
    };
    return credentialRequest(this.#fetch, "PUT", credentialsPath(t.orgId, provider), body, t.controller.signal, forThisRow).then((o) =>
      this.#settle(t, o, (c) => {
        this.rows.value = (this.rows.value ?? []).map((r) => (r.provider === c.provider ? c : r));
        return KEY_SAVED_WORDS;
      }),
    );
  }

  /**
   * Remove `provider`'s key (after the page's confirmation), naming it as listed (its id and
   * version), so a key replaced meanwhile is never removed by mistake; the list is then read
   * again. False, and nothing is sent, when the row lists no key.
   */
  remove(provider: ProviderId): Promise<boolean> {
    if (!this.windowOpen.value) return Promise.resolve(false);
    const row = this.rows.value?.find((r) => r.provider === provider);
    if (row == null || row.id == null || row.version == null) return Promise.resolve(false);
    const t = this.#begin(provider);
    if (t == null) return Promise.resolve(false);
    const query = `?id=${encodeURIComponent(row.id)}&version=${row.version}`;
    return credentialRequest(this.#fetch, "DELETE", credentialsPath(t.orgId, provider) + query, null, t.controller.signal, readRemoved).then((o) =>
      this.#settle(t, o, () => KEY_REMOVED_WORDS),
    );
  }

  /** A key the page refused before sending it: its words on the row, as the server's would be. */
  refuseLocally(provider: ProviderId, refusal: CredentialRefusal): void {
    this.notices.value = { ...this.notices.value, [provider]: KEY_REFUSAL_WORDS[refusal] };
  }

  /**
   * Read the list. A read during which a credential change ended may predate the change: its
   * rows are discarded and the list is read again. (A change's own re-read, asked for while
   * an older read is in flight, is that case: the older read is stale and reads again.)
   */
  async #load(): Promise<void> {
    const t = this.#begin("list");
    if (t == null) return;
    const writes = this.#writes;
    const o = await credentialRequest(this.#fetch, "GET", credentialsPath(t.orgId), null, t.controller.signal, readCredentialList);
    if (!this.#end(t)) return;
    const stale = writes !== this.#writes;
    if (!o.ok) this.#refused("list", o.refusal);
    else if (!stale) this.rows.value = o.value;
    if (stale) void this.#load();
  }

  /** Start a request for `slot`, unless one is in flight there (or no organization is open). */
  #begin(slot: ProviderId | "list"): Ticket | null {
    const orgId = this.orgId.value;
    if (orgId == null || this.pending.value.has(slot)) return null;
    const controller = new AbortController();
    this.#controllers.add(controller);
    this.pending.value = new Set([...this.pending.value, slot]);
    return { generation: this.#generation, orgId, slot, controller };
  }

  /**
   * The request is over: true when it still answers the open organization and page. (Every
   * change of organization goes through leave(), which moves the generation on, so the
   * organization's check is defense in depth.)
   */
  #end(t: Ticket): boolean {
    this.#controllers.delete(t.controller);
    if (t.generation !== this.#generation || t.orgId !== this.orgId.value) return false;
    const next = new Set(this.pending.value);
    next.delete(t.slot);
    this.pending.value = next;
    return true;
  }

  #settle<T>(t: Ticket, o: CredentialOutcome<T>, applied: (value: T) => string): boolean {
    if (!this.#end(t)) return false;
    this.#writes++;
    const slot = t.slot as ProviderId;
    if (o.ok) {
      const words = applied(o.value);
      this.notices.value = { ...this.notices.value, [slot]: words };
      if (words === KEY_REMOVED_WORDS) void this.#load();
      return true;
    }
    this.#refused(slot, o.refusal);
    // No answer: the change may or may not have been made, so the list is read again.
    if (o.refusal === "network") void this.#load();
    return false;
  }

  #refused(slot: ProviderId | "list", refusal: CredentialRefusal | "network" | "badResponse"): void {
    this.notices.value = { ...this.notices.value, [slot]: KEY_REFUSAL_WORDS[refusal] };
    if (refusal === "reauthenticate") this.closeWindow();
    if (refusal === "signedOut") this.#signedOut();
  }
}
