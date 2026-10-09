"use client";

/**
 * One terminal rendered by xterm.js (DESIGN §5.16). Fed from a bounded tail
 * (`TerminalBuffer`): each render writes only what is new since the last
 * write, so a chatty shell never re-paints the whole screen. Keystrokes go to
 * `onInput` (the env server's `terminal.write`, directly or through the
 * device link); the fit addon keeps cols/rows in step with the pane and
 * reports them through `onResize` (`terminal.resize`).
 *
 * xterm and its stylesheet are loaded on mount, so they stay out of the
 * server bundle, the gallery's first paint and the unit tests' renders.
 */
import * as React from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { cssColorFromToken, terminalDelta, type TerminalBuffer } from "@/lib/code-v2/terminal-stream";

export interface XtermViewProps {
  /** Changing it starts a fresh screen. */
  terminalId: string;
  buffer: TerminalBuffer;
  readOnly: boolean;
  label: string;
  onInput?(data: string): void;
  onResize?(cols: number, rows: number): void;
}

function themeFrom(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const tok = (name: string, fallback: string) => cssColorFromToken(cs.getPropertyValue(name), fallback);
  return {
    background: "rgba(0,0,0,0)",
    foreground: tok("--foreground", "#1b1c1f"),
    cursor: tok("--foreground", "#1b1c1f"),
    cursorAccent: tok("--background", "#fbfbfd"),
    selectionBackground: tok("--muted", "rgba(127,127,127,0.25)"),
  };
}

export function XtermView({ terminalId, buffer, readOnly, label, onInput, onResize }: XtermViewProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const term = React.useRef<Terminal | null>(null);
  const fit = React.useRef<FitAddon | null>(null);
  const written = React.useRef(0);
  const latest = React.useRef({ buffer, onInput, onResize });
  latest.current = { buffer, onInput, onResize };
  const [loaded, setLoaded] = React.useState(false);

  const flush = React.useCallback(() => {
    const t = term.current;
    if (!t) return;
    const d = terminalDelta(latest.current.buffer, written.current);
    if (d.reset) t.reset();
    if (d.data) t.write(d.data);
    written.current = d.position;
  }, []);

  React.useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    const offs: { dispose(): void }[] = [];
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
      const el = host.current;
      if (disposed || !el) return;
      const mono = getComputedStyle(document.body).getPropertyValue("--font-mono").trim();
      const t = new Terminal({
        convertEol: true,
        disableStdin: readOnly,
        cursorBlink: !readOnly,
        cursorStyle: readOnly ? "underline" : "block",
        cursorInactiveStyle: "none",
        fontFamily: `${mono ? `${mono}, ` : ""}ui-monospace, SFMono-Regular, Menlo, monospace`,
        fontSize: 12,
        lineHeight: 1.45,
        scrollback: 5_000,
        allowTransparency: true,
        theme: themeFrom(el),
        screenReaderMode: false,
      });
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(el);
      t.textarea?.setAttribute("aria-label", label);
      term.current = t;
      fit.current = f;
      written.current = 0;
      offs.push(t.onData((data) => latest.current.onInput?.(data)));
      offs.push(t.onResize(({ cols, rows }) => latest.current.onResize?.(cols, rows)));
      const refit = () => {
        try {
          if (el.clientWidth > 0 && el.clientHeight > 0) f.fit();
        } catch {
          /* detached mid-resize */
        }
      };
      refit();
      latest.current.onResize?.(t.cols, t.rows);
      observer = new ResizeObserver(() => requestAnimationFrame(refit));
      observer.observe(el);
      // Follow the app's light / dark switch.
      const scheme = matchMedia("(prefers-color-scheme: dark)");
      const retheme = () => (t.options.theme = themeFrom(el));
      scheme.addEventListener("change", retheme);
      const mo = new MutationObserver(retheme);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
      offs.push({ dispose: () => (scheme.removeEventListener("change", retheme), mo.disconnect()) });
      flush();
      setLoaded(true);
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      for (const o of offs) o.dispose();
      term.current?.dispose();
      term.current = null;
      fit.current = null;
      setLoaded(false);
    };
    // A new terminal (or a switch between read-only and live) is a new screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, readOnly]);

  React.useEffect(() => {
    if (loaded) flush();
  }, [buffer.output, buffer.offset, loaded, flush]);

  return <div ref={host} className="cv2-xterm" data-readonly={readOnly || undefined} role={readOnly ? "log" : undefined} aria-label={readOnly ? label : undefined} />;
}
