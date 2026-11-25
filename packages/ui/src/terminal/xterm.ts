// The screen side of the terminal: the small part of xterm.js the panel uses, behind an
// interface so tests drive the panel with a fake. xterm itself is loaded on demand, so the
// app's bundle doesn't carry it until someone opens a terminal.

export interface TermLike {
  readonly rows: number;
  readonly cols: number;
  open(element: HTMLElement): void;
  /** Write bytes; done() once they are on the screen (the agent is acked from here). */
  write(bytes: Uint8Array, done: () => void): void;
  reset(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: { rows: number; cols: number }) => void): { dispose(): void };
  /** Fit the grid to the element's size. */
  fit(): void;
  focus(): void;
  /** Stop or allow keyboard input (after an exit, nothing typed goes anywhere). */
  setInputEnabled(enabled: boolean): void;
  /** What the screen's buffer holds, line by line (trailing blank lines dropped). */
  bufferText(): string;
  dispose(): void;
}

export type CreateTerm = () => Promise<TermLike>;

/**
 * A CommonJS package's export through a dynamic import: bundlers put it either on the
 * namespace or on its `default` (xterm's case with esbuild), so look in both.
 */
export function cjsExport<T>(mod: unknown, name: string): T {
  const m = mod as Record<string, unknown> & { default?: Record<string, unknown> };
  const value = m[name] ?? m.default?.[name];
  if (value == null) throw new Error(`${name} isn't exported by the loaded module`);
  return value as T;
}

export const createXterm: CreateTerm = async () => {
  const [xterm, fitAddon] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
  const Terminal = cjsExport<typeof import("@xterm/xterm").Terminal>(xterm, "Terminal");
  const FitAddon = cjsExport<typeof import("@xterm/addon-fit").FitAddon>(fitAddon, "FitAddon");
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    scrollback: 5000,
    // Links in output are plain text: nothing opens on a click.
    linkHandler: null,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return {
    get rows() {
      return term.rows;
    },
    get cols() {
      return term.cols;
    },
    open: (element) => term.open(element),
    write: (bytes, done) => term.write(bytes, done),
    reset: () => term.reset(),
    onData: (listener) => term.onData(listener),
    onResize: (listener) => term.onResize(({ rows, cols }) => listener({ rows, cols })),
    fit: () => fit.fit(),
    focus: () => term.focus(),
    setInputEnabled: (enabled) => {
      term.options.disableStdin = !enabled;
    },
    bufferText: () => {
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return lines.join("\n");
    },
    dispose: () => term.dispose(),
  };
};
