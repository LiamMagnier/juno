/**
 * The terminal product surface: a tab strip over a stack of panes.
 *
 * This component owns the *session* state — which terminals exist, which one is
 * active — and nothing about xterm, which belongs to `TerminalPane`. The split
 * matters because the two have different lifetimes: a pane is torn down and
 * rebuilt whenever its terminal id changes, while the list of terminals
 * survives every one of those.
 *
 * Terminals are created in main and only *observed* here. The renderer never
 * names a directory: `create` sends a workspace id and main resolves it against
 * the trusted-workspace store, which is what makes the trust prompt mean
 * something.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';

import { isChannelMissingError, terminalBridge } from './bridge.js';
import type { TerminalSummary } from './protocol.js';
import { TerminalPane } from './TerminalPane.js';
import { TerminalTabs } from './TerminalTabs.js';
import type { TerminalCommand } from './use-terminal-view.js';

/**
 * The grid a terminal is born with.
 *
 * A placeholder, not a guess at the window size: the pane has not been laid out
 * when `create` is called, so there is nothing to measure. The fit addon
 * corrects it within a frame of mount and sends the real geometry.
 */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

/** More than this and the strip stops being navigable; main caps at 12. */
const MAX_TABS = 8;

export interface TerminalProductProps {
  /** The trusted workspace terminals are opened in. */
  workspaceId: string | null;
  className?: string;
}

type Phase = 'loading' | 'ready' | 'unavailable';

export function TerminalProduct({ workspaceId, className }: TerminalProductProps): React.JSX.Element {
  const idPrefix = useId();
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusToken, setFocusToken] = useState(0);
  const [busy, setBusy] = useState(false);

  /**
   * Screen-reader mode.
   *
   * xterm's accessibility buffer mirrors the viewport into an ARIA live region.
   * It is off by default because it costs real work on every write, and there
   * is no reliable web API for "a screen reader is running".
   *
   * The honest default comes from Electron: `app.accessibilitySupportEnabled`
   * is true when VoiceOver is on. That lives in main and is not on the
   * `SystemAppearance` payload yet — adding a `screenReader: boolean` field to
   * it would let this default correctly with no new channel. Until then the
   * initial value is read from a documented `data-` hook on the root element,
   * and the strip carries a focus-visible toggle so a keyboard user can reach
   * it without a mouse or a settings trip.
   */
  const [screenReaderMode, setScreenReaderMode] = useState(
    () => document.documentElement.dataset['screenReader'] === 'true',
  );

  /**
   * History replayed into each pane on its first mount.
   *
   * Consumed once. Held outside React state deliberately — it is up to a
   * quarter of a megabyte per terminal and it is never rendered, so putting it
   * in state would make every unrelated re-render carry it.
   */
  const historiesRef = useRef(new Map<string, string>());
  const bootstrappedFor = useRef<string | null>(null);

  const tabIdFor = useCallback(
    (terminalId: string) => `${idPrefix}-tab-${terminalId}`.replace(/:/g, '_'),
    [idPrefix],
  );

  const report = useCallback((cause: unknown): void => {
    setError(describeError(cause));
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Bootstrap                                                               */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!workspaceId) {
      setTerminals([]);
      setActiveId(null);
      setPhase('ready');
      return;
    }

    /* Set synchronously, before the first await. React's StrictMode runs this
       effect twice on mount, and a flag set after an await would let both runs
       reach `create` and spawn two shells for one tab. */
    const shouldCreateFirst = bootstrappedFor.current !== workspaceId;
    bootstrappedFor.current = workspaceId;

    let cancelled = false;

    void (async () => {
      try {
        /* Re-attach before creating. After a window reload the ptys in main are
           still running; listing with history is what turns that into a visible
           terminal rather than a second one beside an invisible first. */
        const existing = await terminalBridge.list(true);
        if (cancelled) return;

        const mine = existing.filter((terminal) => terminal.workspaceId === workspaceId);
        for (const terminal of mine) {
          if (terminal.history) historiesRef.current.set(terminal.id, terminal.history);
        }

        if (mine.length > 0) {
          setTerminals(mine.map(stripHistory));
          setActiveId((current) => current ?? mine[0]?.id ?? null);
          setPhase('ready');
          return;
        }

        if (!shouldCreateFirst) {
          setPhase('ready');
          return;
        }

        const created = await terminalBridge.create({
          workspaceId,
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
        });
        if (cancelled) return;
        setTerminals([created]);
        setActiveId(created.id);
        setPhase('ready');
      } catch (cause) {
        if (cancelled) return;
        if (isChannelMissingError(cause)) {
          setPhase('unavailable');
          return;
        }
        setPhase('ready');
        report(cause);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, report]);

  /* ---------------------------------------------------------------------- */
  /* Exit events                                                             */
  /* ---------------------------------------------------------------------- */

  useEffect(
    () =>
      terminalBridge.onExit((event) => {
        setTerminals((previous) => {
          if (event.released) {
            historiesRef.current.delete(event.terminalId);
            return previous.filter((terminal) => terminal.id !== event.terminalId);
          }
          return previous.map((terminal) =>
            terminal.id === event.terminalId
              ? {
                  ...terminal,
                  status: 'exited' as const,
                  exitCode: event.exitCode,
                  signal: event.signal,
                  pid: null,
                }
              : terminal,
          );
        });
      }),
    [],
  );

  /* Keep the selection pointing at something that exists. */
  useEffect(() => {
    if (terminals.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (activeId && terminals.some((terminal) => terminal.id === activeId)) return;
    setActiveId(terminals[0]?.id ?? null);
  }, [terminals, activeId]);

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  const selectTerminal = useCallback(
    (terminalId: string, options: { focusTerminal: boolean }): void => {
      setActiveId(terminalId);
      if (options.focusTerminal) setFocusToken((token) => token + 1);
    },
    [],
  );

  const createTerminal = useCallback((): void => {
    if (!workspaceId) return;
    setBusy(true);
    void (async () => {
      try {
        const created = await terminalBridge.create({
          workspaceId,
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
        });
        setTerminals((previous) => [...previous, created]);
        setActiveId(created.id);
        setFocusToken((token) => token + 1);
        setError(null);
      } catch (cause) {
        report(cause);
      } finally {
        setBusy(false);
      }
    })();
  }, [workspaceId, report]);

  const closeTerminal = useCallback(
    (terminalId: string): void => {
      void (async () => {
        try {
          await terminalBridge.kill({ terminalId });
        } catch (cause) {
          report(cause);
        } finally {
          /* Also removed locally rather than waiting for the exit event: an
             already-exited terminal is released without one, since there is no
             second exit to report. */
          historiesRef.current.delete(terminalId);
          setTerminals((previous) => previous.filter((terminal) => terminal.id !== terminalId));
        }
      })();
    },
    [report],
  );

  const restartTerminal = useCallback(
    (terminalId: string): void => {
      void (async () => {
        try {
          const restarted = await terminalBridge.restart(terminalId);
          historiesRef.current.delete(terminalId);
          setTerminals((previous) =>
            previous.map((terminal) => (terminal.id === restarted.id ? restarted : terminal)),
          );
          setFocusToken((token) => token + 1);
          setError(null);
        } catch (cause) {
          report(cause);
        }
      })();
    },
    [report],
  );

  const step = useCallback(
    (delta: number): void => {
      setActiveId((current) => {
        if (terminals.length === 0) return null;
        const index = terminals.findIndex((terminal) => terminal.id === current);
        const next = terminals[(index + delta + terminals.length) % terminals.length];
        return next?.id ?? current;
      });
      setFocusToken((token) => token + 1);
    },
    [terminals],
  );

  const handleCommand = useCallback(
    (command: TerminalCommand): void => {
      if (command === 'new-tab') {
        if (terminals.length >= MAX_TABS) {
          setError(`You can have ${MAX_TABS} terminals open at once. Close one first.`);
          return;
        }
        createTerminal();
        return;
      }
      if (command === 'close-tab') {
        if (activeId) closeTerminal(activeId);
        return;
      }
      if (command === 'next-tab') {
        step(1);
        return;
      }
      if (command === 'previous-tab') {
        step(-1);
        return;
      }
      const match = /^select-tab-(\d+)$/.exec(command);
      if (match?.[1]) {
        const target = terminals[Number(match[1])];
        if (target) selectTerminal(target.id, { focusTerminal: true });
      }
    },
    [activeId, closeTerminal, createTerminal, selectTerminal, step, terminals],
  );

  /**
   * Leave the terminal without a mouse.
   *
   * Focus goes to the active tab, which is in the normal tab order — so from
   * there the user can Tab onward into the rest of the app. This is the other
   * half of the keyboard-trap requirement: a way in *and* a way out.
   */
  const handleFocusEscape = useCallback((): void => {
    /* `getElementById` rather than a scoped `querySelector`: `useId` values are
       not valid CSS identifiers on their own, so the selector route needs
       `CSS.escape` and gets it wrong the day React changes the id format. */
    const target = activeId ? document.getElementById(tabIdFor(activeId)) : null;
    target?.focus();
    setAnnouncement('Left the terminal. Press Tab to continue, or Enter to go back in.');
  }, [activeId, tabIdFor]);

  const handleTitleChange = useCallback((terminalId: string, title: string): void => {
    const clean = sanitizeTitle(title);
    if (!clean) return;
    setTerminals((previous) =>
      previous.map((terminal) =>
        terminal.id === terminalId && terminal.title !== clean
          ? { ...terminal, title: clean }
          : terminal,
      ),
    );
  }, []);

  const toggleScreenReaderMode = useCallback((): void => {
    setScreenReaderMode((enabled) => {
      setAnnouncement(enabled ? 'Screen reader mode off.' : 'Screen reader mode on.');
      return !enabled;
    });
  }, []);

  /**
   * Release the one-shot replay buffers once the panes have consumed them.
   *
   * In an effect, not during render. Consuming them in a `useMemo` looked
   * tidier and was wrong: StrictMode double-invokes render and discards the
   * first result, so the first pass would delete the history and the pass that
   * actually committed would find nothing — a re-attached terminal would come
   * back blank, and only in development, which is the worst place for a bug to
   * only sometimes appear. Child effects run before parent effects, so by the
   * time this runs every pane has already written its replay.
   */
  useEffect(() => {
    if (historiesRef.current.size > 0) historiesRef.current.clear();
  });

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const shell = (children: React.ReactNode): React.JSX.Element => (
    <section
      aria-label="Terminal"
      className={['flex h-full min-h-0 w-full flex-col bg-background', className ?? ''].join(' ')}
    >
      {children}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </section>
  );

  if (!workspaceId) {
    return shell(
      <p className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">
        Open a workspace to use the terminal. Terminals run inside a workspace you have trusted.
      </p>,
    );
  }

  if (phase === 'unavailable') {
    return shell(
      <p className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">
        Terminals are not available in this build — the terminal IPC channels have not been
        registered.
      </p>,
    );
  }

  return shell(
    <>
      <TerminalTabs
        terminals={terminals}
        activeId={activeId}
        tabIdFor={tabIdFor}
        onSelect={selectTerminal}
        onClose={closeTerminal}
        onCreate={createTerminal}
        screenReaderMode={screenReaderMode}
        onToggleScreenReaderMode={toggleScreenReaderMode}
        busy={busy || terminals.length >= MAX_TABS}
      />

      {error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive-ink"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
            }}
            className="rounded-md px-2 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {terminals.map((terminal) => (
          /* Every pane stays mounted; `TerminalPane` hides the inactive ones
             with `hidden` on the tabpanel itself. Unmounting would dispose the
             xterm instance and lose the scrollback — see the note there. */
          <div key={terminal.id} className="absolute inset-0">
            <TerminalPane
              terminal={terminal}
              active={terminal.id === activeId}
              tabId={tabIdFor(terminal.id)}
              screenReaderMode={screenReaderMode}
              focusToken={focusToken}
              initialHistory={historiesRef.current.get(terminal.id)}
              onCommand={handleCommand}
              onFocusEscape={handleFocusEscape}
              onTitleChange={handleTitleChange}
              onRestart={restartTerminal}
              onClose={closeTerminal}
              onError={report}
            />
          </div>
        ))}

        {terminals.length === 0 && phase === 'ready' ? (
          <p className="absolute inset-0 m-auto flex items-center justify-center p-6 text-sm text-muted-foreground">
            No terminals open.
          </p>
        ) : null}
      </div>
    </>,
  );
}

function stripHistory(terminal: TerminalSummary): TerminalSummary {
  const { history: _history, ...rest } = terminal;
  return rest;
}

/**
 * A shell-supplied title is untrusted output.
 *
 * OSC 0/2 lets whatever is running set this string, and it is rendered in
 * Juno's own chrome. Control characters are stripped so an escape sequence
 * cannot reach anything downstream, and the length is capped so a title cannot
 * be used to blow out the tab strip.
 */
function sanitizeTitle(title: string): string | null {
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (clean.length === 0) return null;
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}

function describeError(cause: unknown): string {
  if (isChannelMissingError(cause)) return 'Terminals are not available in this build.';
  return cause instanceof Error ? cause.message : 'Something went wrong.';
}
