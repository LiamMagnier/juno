/**
 * One xterm.js instance, wired to one pty in main.
 *
 * The hook owns the whole lifecycle, and the reason it is a hook rather than
 * inline effects is teardown: an xterm instance holds a renderer, a parser, a
 * texture atlas and a pile of DOM, and every one of those leaks if the instance
 * outlives its component. A tab strip that creates a terminal per switch and
 * disposes none is the standard way this feature turns into a memory bug, so
 * every subscription created here is returned to the same cleanup.
 */

import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalBridge } from './bridge.js';
import { buildTerminalTheme, MINIMUM_CONTRAST_RATIO, themeFingerprint } from './theme.js';

/**
 * How long a resize must settle before the grid is recomputed.
 *
 * A window drag fires `ResizeObserver` on every frame, and every `fit()` costs
 * a full reflow plus a `TIOCSWINSZ` and a `SIGWINCH` to the child — which
 * redraws whatever TUI is running. 80ms is short enough to feel immediate on
 * release and long enough that a drag produces one resize, not sixty.
 */
const FIT_DEBOUNCE_MS = 80;

/** Renderer-side scrollback. Independent of main's bounded replay buffer. */
const SCROLLBACK_LINES = 5_000;

export type TerminalCommand =
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | `select-tab-${number}`;

export interface TerminalViewHandlers {
  onCommand: (command: TerminalCommand) => void;
  /** Move focus out of the terminal, to something the user can tab from. */
  onFocusEscape: () => void;
  onTitleChange?: (title: string) => void;
  onError: (message: string) => void;
  /** Main dropped output to stay under its per-event cap. */
  onTruncated?: (chars: number) => void;
}

export interface TerminalViewOptions {
  terminalId: string;
  /** Replayed into the pane on mount, so a re-attach is not a blank screen. */
  initialHistory?: string | undefined;
  screenReaderMode: boolean;
  /** Label announced for the terminal's input. */
  label: string;
  /** Id of the element describing how to leave the terminal. */
  describedById: string;
  handlers: TerminalViewHandlers;
}

export interface TerminalView {
  hostRef: RefObject<HTMLDivElement | null>;
  focus: () => void;
  fit: () => void;
  copySelection: () => void;
  clear: () => void;
  /** Write a line of our own into the pane (exit notices, warnings). */
  writeNotice: (text: string) => void;
}

export function useTerminalView(options: TerminalViewOptions): TerminalView {
  const { terminalId, initialHistory, screenReaderMode, label, describedById } = options;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const themeRef = useRef<string>('');

  /* Handlers live in a ref so the expensive effect below depends only on
     `terminalId`. Putting them in the dependency array would tear down and
     rebuild the entire terminal — losing its scrollback — every time the parent
     re-rendered with a new closure. */
  const handlersRef = useRef(options.handlers);
  useEffect(() => {
    handlersRef.current = options.handlers;
  });

  const applyTheme = useCallback((): void => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return;
    const { theme, fontFamily } = buildTerminalTheme(host);
    const fingerprint = themeFingerprint(theme);
    if (fingerprint === themeRef.current) return;
    themeRef.current = fingerprint;
    term.options.theme = theme;
    term.options.fontFamily = fontFamily;
  }, []);

  const fit = useCallback((): void => {
    const term = termRef.current;
    const addon = fitRef.current;
    const host = hostRef.current;
    if (!term || !addon || !host) return;
    /* A hidden tab has no box. `fit()` on a zero-sized element proposes NaN and
       xterm ends up with a 1x1 grid that the child then wraps every line to. */
    if (host.clientWidth === 0 || host.clientHeight === 0) return;

    const proposed = addon.proposeDimensions();
    if (!proposed) return;
    const { cols, rows } = proposed;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    if (cols === term.cols && rows === term.rows) return;

    try {
      addon.fit();
    } catch {
      /* Disposed mid-frame. The next fit will settle it. */
    }
  }, []);

  const focus = useCallback((): void => {
    termRef.current?.focus();
  }, []);

  const clear = useCallback((): void => {
    termRef.current?.clear();
  }, []);

  const copySelection = useCallback((): void => {
    const term = termRef.current;
    if (!term || !term.hasSelection()) return;
    void copyToClipboard(term.getSelection());
  }, []);

  const writeNotice = useCallback((text: string): void => {
    /* Dim + reset, on its own line, so a notice from Juno is visually distinct
       from anything the shell printed. */
    termRef.current?.write(`\r\n\u001b[2m${text}\u001b[0m\r\n`);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* The instance                                                            */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const { theme, fontFamily } = buildTerminalTheme(host);
    themeRef.current = themeFingerprint(theme);

    /* Respect the OS motion preference for the one thing in a terminal that
       animates. `prefers-reduced-motion` covers this case without needing
       main's appearance push. */
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const term = new Terminal({
      theme,
      fontFamily,
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: SCROLLBACK_LINES,
      cursorBlink: !reduceMotion,
      cursorStyle: 'bar',
      smoothScrollDuration: reduceMotion ? 0 : 100,
      /* The safety net under a partly-derived palette. See `theme.ts`. */
      minimumContrastRatio: MINIMUM_CONTRAST_RATIO,
      screenReaderMode,
      /* macOS convention: Option composes characters rather than sending Meta,
         matching Terminal.app's default. Users who want Meta will expect a
         setting, not a surprise. */
      macOptionIsMeta: false,
      allowProposedApi: false,
      /* No transparency. The terminal is an opaque surface — a translucent one
         puts moving content behind text that has to stay readable. */
      allowTransparency: false,
    });

    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(host);

    termRef.current = term;
    fitRef.current = addon;

    /* Accessibility. xterm's hidden textarea is the real focus target and the
       element a screen reader lands on, so the labelling goes there rather than
       on the wrapper — a label on a div the user never focuses is decoration. */
    const textarea = term.textarea;
    if (textarea) {
      textarea.setAttribute('aria-label', label);
      textarea.setAttribute('aria-describedby', describedById);
    }

    if (initialHistory) term.write(initialHistory);

    const disposables: IDisposable[] = [];

    /* Keystrokes and pastes out. `onData` covers both — xterm turns the DOM
       paste event into one `onData` with the whole payload, which is why Cmd+V
       is deliberately not intercepted in the key handler below. */
    disposables.push(
      term.onData((data) => {
        void terminalBridge.write({ terminalId, data }).catch((error: unknown) => {
          handlersRef.current.onError(describeError(error));
        });
      }),
    );

    disposables.push(
      term.onResize(({ cols, rows }) => {
        void terminalBridge.resize({ terminalId, cols, rows }).catch(() => {
          /* A resize racing a kill is not worth a banner. */
        });
      }),
    );

    disposables.push(
      term.onTitleChange((title) => {
        handlersRef.current.onTitleChange?.(title);
      }),
    );

    term.attachCustomKeyEventHandler(makeKeyHandler(term, handlersRef, copySelection));

    /* Output in. Every pane receives every terminal's events and filters —
       with a handful of tabs that is cheaper than a shared router, and it keeps
       the subscription's lifetime identical to the instance's. */
    const offOutput = terminalBridge.onOutput((event) => {
      if (event.terminalId !== terminalId) return;
      term.write(event.chunk);
      if (event.truncatedChars > 0) handlersRef.current.onTruncated?.(event.truncatedChars);
    });

    /* Resize. Debounced, and re-fitted once at mount because the first layout
       pass has usually not happened when `open()` runs. */
    let pending: number | null = null;
    const scheduleFit = (): void => {
      if (pending !== null) window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        pending = null;
        window.requestAnimationFrame(() => {
          fit();
        });
      }, FIT_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    scheduleFit();

    return () => {
      if (pending !== null) window.clearTimeout(pending);
      observer.disconnect();
      offOutput();
      for (const disposable of disposables) disposable.dispose();
      addon.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      themeRef.current = '';
    };
    /* `label` and `describedById` are stable per pane, and `initialHistory` is
       a mount-time replay — including them would rebuild the terminal to change
       an aria attribute. `screenReaderMode` is applied by its own effect below
       for the same reason. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  /* ---------------------------------------------------------------------- */
  /* Live option updates                                                     */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.screenReaderMode = screenReaderMode;
  }, [screenReaderMode]);

  /* Repaint the palette when the theme moves. Three signals because one system
     toggle can arrive through any of them: a `.dark` class flip from the theme
     provider, the media query when the app follows the system, and main's
     appearance push (which is the only source for macOS Reduce Transparency and
     Increase Contrast). `themeFingerprint` collapses the duplicates. */
  useEffect(() => {
    applyTheme();

    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-accent'],
    });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', applyTheme);
    const offAppearance = terminalBridge.onAppearanceChanged(applyTheme);

    return () => {
      observer.disconnect();
      media.removeEventListener('change', applyTheme);
      offAppearance();
    };
  }, [applyTheme]);

  /* Memoised so the returned object has a stable identity. Consumers put it in
     dependency arrays; a fresh literal every render would make every one of
     those effects fire on every render — including the one that focuses the
     pane, which would yank focus back from wherever the user put it. */
  return useMemo(
    () => ({ hostRef, focus, fit, copySelection, clear, writeNotice }),
    [focus, fit, copySelection, clear, writeNotice],
  );
}

/* -------------------------------------------------------------------------- */
/* Keyboard                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The custom key handler.
 *
 * Returning `false` tells xterm not to process the event, which is how a
 * shortcut is claimed for the application instead of being sent to the shell.
 * Everything not claimed here falls through to the pty, which is the default a
 * terminal has to preserve — a terminal that swallows keys is worse than one
 * with no shortcuts at all.
 *
 * **Cmd+V is deliberately absent.** `security.ts` denies every permission
 * request, including `clipboard-read`, so `navigator.clipboard.readText()`
 * cannot work in this renderer. The path that *does* work is the browser's
 * native `paste` event on xterm's textarea, which xterm already handles (and
 * wraps in bracketed-paste when the child asked for it). Intercepting Cmd+V
 * would cancel that event and break paste entirely in exchange for nothing.
 */
function makeKeyHandler(
  term: Terminal,
  handlersRef: RefObject<TerminalViewHandlers>,
  copySelection: () => void,
): (event: KeyboardEvent) => boolean {
  return (event) => {
    /* keydown only: the handler is called for keydown, keypress and keyup, and
       acting on all three fires every shortcut three times. */
    if (event.type !== 'keydown') return true;

    /* The escape hatch. A terminal grabs almost every key, so there has to be a
       way out that does not require a mouse — WCAG 2.1.2 (No Keyboard Trap).
       Shift+Escape rather than Escape: a TUI cannot distinguish the two (both
       send a bare ESC), so claiming it costs the shell nothing, while claiming
       plain Escape would break vim. F6 is the platform convention for cycling
       panes and is claimed as well. */
    if ((event.key === 'Escape' && event.shiftKey) || event.key === 'F6') {
      event.preventDefault();
      handlersRef.current.onFocusEscape();
      return false;
    }

    const isCommand = event.metaKey && !event.ctrlKey && !event.altKey;
    if (!isCommand) return true;

    switch (event.key.toLowerCase()) {
      case 'c':
        /* Only claim it when there is something to copy. With no selection,
           letting it through costs nothing (Cmd never reaches the pty) and
           keeps the browser's own handling intact. */
        if (term.hasSelection()) {
          event.preventDefault();
          copySelection();
          return false;
        }
        return true;
      case 'a':
        event.preventDefault();
        term.selectAll();
        return false;
      case 'k':
        event.preventDefault();
        term.clear();
        return false;
      case 't':
        event.preventDefault();
        handlersRef.current.onCommand('new-tab');
        return false;
      case 'w':
        event.preventDefault();
        handlersRef.current.onCommand('close-tab');
        return false;
      default:
        break;
    }

    /* Brackets and digits by `code`, not `key`: with Shift held, `[` reports as
       `{`, and on a non-US layout the digit row moves. */
    if (event.shiftKey && event.code === 'BracketLeft') {
      event.preventDefault();
      handlersRef.current.onCommand('previous-tab');
      return false;
    }
    if (event.shiftKey && event.code === 'BracketRight') {
      event.preventDefault();
      handlersRef.current.onCommand('next-tab');
      return false;
    }

    const digit = /^Digit([1-9])$/.exec(event.code);
    if (digit?.[1]) {
      event.preventDefault();
      handlersRef.current.onCommand(`select-tab-${Number(digit[1]) - 1}`);
      return false;
    }

    return true;
  };
}

/* -------------------------------------------------------------------------- */
/* Clipboard                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Copy, without needing a permission this app does not grant.
 *
 * `navigator.clipboard.writeText` is tried first because it is the modern API
 * and works when Chromium treats the write as user-gesture-scoped. It can still
 * be refused — `security.ts` installs a permission *check* handler that returns
 * false for everything — so the fallback is the pre-Permissions-API path: a
 * detached textarea plus `execCommand('copy')`, which is gated on a user
 * gesture rather than on a permission and therefore survives the hardening.
 */
async function copyToClipboard(text: string): Promise<void> {
  if (text.length === 0) return;
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* Fall through. */
  }

  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.setAttribute('aria-hidden', 'true');
  /* Off-screen rather than `display: none` — a hidden element cannot be
     selected, and an unselectable one cannot be copied from. */
  scratch.style.position = 'fixed';
  scratch.style.top = '-1000px';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);

  const previous = document.activeElement;
  try {
    scratch.select();
    document.execCommand('copy');
  } catch {
    /* Nothing further to try; the selection stays available for a manual copy. */
  } finally {
    scratch.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
