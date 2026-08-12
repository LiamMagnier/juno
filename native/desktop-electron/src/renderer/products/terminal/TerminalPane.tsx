/**
 * One terminal pane: an xterm surface plus the state a shell can be in.
 *
 * Every open tab keeps its pane mounted and hides the inactive ones with the
 * `hidden` attribute. That is the opposite of the usual "render only the active
 * tab" instinct, and it is deliberate: unmounting disposes the xterm instance,
 * which throws away the scrollback, the cursor position and any TUI's screen
 * state, so switching tabs and switching back would show a blank pane in front
 * of a live shell. `hidden` costs a detached DOM subtree per tab and keeps
 * everything else.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { TerminalSummary } from './protocol.js';
import { useTerminalView, type TerminalCommand } from './use-terminal-view.js';

export interface TerminalPaneProps {
  terminal: TerminalSummary;
  active: boolean;
  /** The `role="tab"` element that names this panel. */
  tabId: string;
  screenReaderMode: boolean;
  /**
   * Bumped by the parent when the active pane should take focus. A counter
   * rather than a boolean so two consecutive requests are distinguishable.
   */
  focusToken: number;
  initialHistory?: string | undefined;
  onCommand: (command: TerminalCommand) => void;
  onFocusEscape: () => void;
  onTitleChange: (terminalId: string, title: string) => void;
  onRestart: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
  onError: (message: string) => void;
}

export function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
  const {
    terminal,
    active,
    tabId,
    screenReaderMode,
    focusToken,
    initialHistory,
    onCommand,
    onFocusEscape,
    onTitleChange,
    onRestart,
    onClose,
    onError,
  } = props;

  const panelId = useId();
  const helpId = useId();
  const [truncated, setTruncated] = useState(0);

  const view = useTerminalView({
    terminalId: terminal.id,
    initialHistory,
    screenReaderMode,
    label: `Terminal: ${terminal.title}`,
    describedById: helpId,
    handlers: {
      onCommand,
      onFocusEscape,
      onError,
      onTitleChange: (title) => {
        onTitleChange(terminal.id, title);
      },
      onTruncated: (chars) => {
        setTruncated((total) => total + chars);
      },
    },
  });

  /* Re-fit when the pane becomes visible. A hidden pane has no box, so any
     resize that happened while it was hidden was skipped — without this, a tab
     restored after the window was resized keeps the old grid and the shell
     wraps every line at the wrong column. */
  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      view.fit();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [active, view]);

  useEffect(() => {
    if (active && focusToken > 0) view.focus();
    /* `view` is a stable object of stable callbacks; depending on it would fire
       this on every render and steal focus from wherever the user put it. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusToken]);

  /* Say so in the pane itself, not only in the tab. A shell that has exited
     still shows its last output, and without a line in the buffer there is
     nothing to distinguish "finished" from "hung". */
  const announcedExitRef = useRef<string | null>(null);
  useEffect(() => {
    if (terminal.status !== 'exited') {
      announcedExitRef.current = null;
      return;
    }
    const signature = `${terminal.exitCode ?? ''}/${terminal.signal ?? ''}`;
    if (announcedExitRef.current === signature) return;
    announcedExitRef.current = signature;
    view.writeNotice(describeExit(terminal));
  }, [terminal, view]);

  const exited = terminal.status === 'exited';

  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      hidden={!active}
      /* `bg-background`, no transparency and no blur. A terminal is an opaque
         surface: text at this density has to sit on a flat ground, and anything
         moving behind it competes with the thing the user is reading. */
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
    >
      <p id={helpId} className="sr-only">
        Terminal for {terminal.title}. Keyboard input is sent to the shell. Press Shift plus Escape,
        or F6, to move focus out of the terminal. Command C copies the selection, Command K clears
        the screen, Command T opens a terminal and Command W closes this one.
      </p>

      {/* The xterm host. Sized by the flex parent; the fit addon reads this
          box, so it must never be `height: auto`. */}
      <div ref={view.hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1.5" />

      {truncated > 0 ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 border-t border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground"
        >
          <span>
            Output arrived faster than it could be displayed —{' '}
            {truncated.toLocaleString()} characters were not shown.
          </span>
          <button
            type="button"
            onClick={() => {
              setTruncated(0);
            }}
            className="rounded-md px-2 py-0.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {exited ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 border-t border-border bg-secondary px-3 py-2 text-sm text-muted-foreground"
        >
          <span>{describeExit(terminal)}</span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onRestart(terminal.id);
              }}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Restart
            </button>
            <button
              type="button"
              onClick={() => {
                onClose(terminal.id);
              }}
              className="rounded-md px-2.5 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Close
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function describeExit(terminal: TerminalSummary): string {
  if (terminal.signal !== null && terminal.signal !== 0) {
    return `Process ended on signal ${terminal.signal}.`;
  }
  if (terminal.exitCode === 0) return 'Process exited.';
  return `Process exited with code ${terminal.exitCode ?? 'unknown'}.`;
}
