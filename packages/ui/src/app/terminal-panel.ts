// A machine's terminal, embedded on the project page: xterm.js on screen, TerminalSession
// on the wire. The status line says what the connection is doing and offers the next step.

import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { REAL_TIMERS, type PollTimers } from "./polling.ts";
import { html } from "./html.ts";
import type { Store } from "./store.ts";
import { TerminalSession, type Connect, type InputNotice, type SessionIdStore, type TerminalStatus } from "../terminal/session.ts";
import { formatBytes } from "../view.ts";
import { createXterm, type CreateTerm, type TermLike } from "../terminal/xterm.ts";

/** The browser's WebSocket as the session's socket. */
export const browserConnect: Connect = (url, h) => {
  const ws = new WebSocket(url);
  ws.onopen = () => h.onOpen();
  ws.onmessage = (e) => {
    if (typeof e.data === "string") h.onMessage(e.data);
  };
  ws.onclose = (e) => h.onClose(e.code, e.reason);
  return { send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) };
};

/** Session ids by machine, for this tab only (a reload reattaches; another tab starts its own). */
export const tabSessionIds: SessionIdStore = {
  get: (machineId) => {
    try {
      return sessionStorage.getItem(`sbgpu.terminal.${machineId}`);
    } catch {
      return null;
    }
  },
  set: (machineId, id) => {
    try {
      if (id == null) sessionStorage.removeItem(`sbgpu.terminal.${machineId}`);
      else sessionStorage.setItem(`sbgpu.terminal.${machineId}`, id);
    } catch {
      // storage unavailable: a reload starts a new shell
    }
  },
};

export function statusText(status: TerminalStatus): string {
  switch (status.kind) {
    case "connecting":
      return "Connecting…";
    case "replaying":
      return "Restoring the screen…";
    case "live":
      return "";
    case "reconnecting":
      return `Connection lost. Reconnecting in ${Math.ceil(status.inMs / 1000)} s…`;
    case "elsewhere":
      return "This terminal is open in another tab or window.";
    case "exited": {
      const how = status.signal ? `ended by ${status.signal}` : status.code === 0 || status.code == null ? "ended" : `exited with code ${status.code}`;
      return status.earlier ? `This shell ${how} earlier.` : `The shell ${how}.`;
    }
    case "closed":
      return status.detail;
  }
}

export function inputNoticeText(notice: InputNotice | null): string {
  if (notice == null) return "";
  if (notice.kind === "waiting") return `Waiting for the machine to take ${formatBytes(notice.bytes)} of input…`;
  return `That paste is too large (${formatBytes(notice.bytes)}): at most ${formatBytes(notice.limit)} of input can wait at a time. Nothing of it was sent.`;
}

export interface TerminalPanelProps {
  store: Store;
  machineId: string;
  onClose: () => void;
  /** For tests: the screen, the socket, storage and timers. */
  createTerm?: CreateTerm | undefined;
  connect?: Connect | undefined;
  storage?: SessionIdStore | undefined;
  timers?: PollTimers | undefined;
}

export function TerminalPanel({ store, machineId, onClose, createTerm, connect, storage, timers }: TerminalPanelProps): VNode {
  const screen = useRef<HTMLDivElement>(null);
  const session = useRef<TerminalSession | null>(null);
  const [status, setStatus] = useState<TerminalStatus>({ kind: "connecting" });
  const [notice, setNotice] = useState<InputNotice | null>(null);

  useEffect(() => {
    let term: TermLike | null = null;
    let disposed = false;
    const listeners: Array<{ dispose(): void }> = [];
    const onWindowResize = () => term?.fit();
    void (createTerm ?? createXterm)().then(
      (t) => {
      // Closed before xterm loaded: Preact has cleared the ref, so nothing to open into.
      if (screen.current == null) return t.dispose();
      term = t;
      t.open(screen.current);
      t.fit();
      const s = new TerminalSession({
        machineId,
        connect: connect ?? browserConnect,
        open: () => store.terminalAccess(machineId),
        sink: { write: (bytes, done) => t.write(bytes, done), reset: () => t.reset() },
        storage: storage ?? tabSessionIds,
        timers: timers ?? REAL_TIMERS,
        size: () => ({ rows: t.rows, cols: t.cols }),
        onStatus: (next) => {
          t.setInputEnabled(next.kind === "live");
          setStatus(next);
        },
        onInputNotice: setNotice,
      });
      session.current = s;
      listeners.push(t.onData((data) => s.input(data)));
      listeners.push(t.onResize(({ rows, cols }) => s.resize(rows, cols)));
      if (typeof window !== "undefined") window.addEventListener("resize", onWindowResize);
      s.start();
      t.focus();
      },
      (err: unknown) => {
        if (!disposed) setStatus({ kind: "closed", reason: "fault", detail: `The terminal couldn't load: ${err instanceof Error ? err.message : String(err)}` });
      },
    );
    return () => {
      disposed = true;
      if (typeof window !== "undefined") window.removeEventListener("resize", onWindowResize);
      for (const l of listeners) l.dispose();
      session.current?.dispose();
      session.current = null;
      term?.dispose();
    };
  }, [machineId]);

  const text = [statusText(status), inputNoticeText(notice)].filter((x) => x !== "").join(" ");
  return html`<section class="terminal" aria-label="Terminal">
    <header>
      <strong>Terminal</strong>
      <span class="small muted" role="status">${text}</span>
      <span class="actions">
        ${status.kind === "exited" || status.kind === "closed" && status.reason !== "revoked"
          ? html`<button class="secondary" onClick=${() => session.current?.newShell()}>Start a new shell</button>`
          : null}
        ${status.kind === "elsewhere" ? html`<button class="secondary" onClick=${() => session.current?.reconnect()}>Use it here</button>` : null}
        ${status.kind === "reconnecting" ? html`<button class="secondary" onClick=${() => session.current?.reconnect()}>Reconnect now</button>` : null}
        <button class="link" onClick=${onClose}>Close</button>
      </span>
    </header>
    <div class="screen" ref=${screen}></div>
  </section>`;
}
