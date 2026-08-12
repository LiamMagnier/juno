/**
 * The tab strip.
 *
 * Built to the WAI-ARIA tabs pattern with a roving tabindex, which is what
 * makes the strip one stop in the page's tab order instead of one stop per
 * terminal. Two decisions worth stating because they are the ones people get
 * wrong:
 *
 *   - **Automatic activation.** Arrow keys move focus *and* select, because
 *     both panes are already mounted so selecting is free. Focus stays on the
 *     tab; it does not jump into the terminal, since a user arrowing through
 *     tabs is browsing, not typing. Enter, Space and a click do move focus into
 *     the terminal — those are commitments.
 *   - **The close affordance is not a nested button.** A focusable control
 *     inside a `role="tab"` breaks the pattern (and screen-reader navigation
 *     of it). The visible ✕ is an `aria-hidden` span handled by click, and the
 *     keyboard route is Delete or Backspace on the focused tab, which is the
 *     APG's own answer for deletable tabs.
 */

import type { TerminalSummary } from './protocol.js';

export interface TerminalTabsProps {
  terminals: TerminalSummary[];
  activeId: string | null;
  /** Stable ids for `aria-labelledby` on the panes. */
  tabIdFor: (terminalId: string) => string;
  onSelect: (terminalId: string, options: { focusTerminal: boolean }) => void;
  onClose: (terminalId: string) => void;
  onCreate: () => void;
  screenReaderMode: boolean;
  onToggleScreenReaderMode: () => void;
  busy: boolean;
}

export function TerminalTabs(props: TerminalTabsProps): React.JSX.Element {
  const {
    terminals,
    activeId,
    tabIdFor,
    onSelect,
    onClose,
    onCreate,
    screenReaderMode,
    onToggleScreenReaderMode,
    busy,
  } = props;

  const focusTabAt = (index: number): void => {
    const target = terminals[index];
    if (!target) return;
    onSelect(target.id, { focusTerminal: false });
    /* Focus follows selection within the strip. Deferred a frame so the roving
       tabindex has been re-applied before the element is focused — focusing an
       element that still has tabindex="-1" works, but leaves the strip with two
       candidates for one render and Safari-style AT gets confused by it. */
    window.requestAnimationFrame(() => {
      document.getElementById(tabIdFor(target.id))?.focus();
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        focusTabAt((index - 1 + terminals.length) % terminals.length);
        break;
      case 'ArrowRight':
        event.preventDefault();
        focusTabAt((index + 1) % terminals.length);
        break;
      case 'Home':
        event.preventDefault();
        focusTabAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusTabAt(terminals.length - 1);
        break;
      case 'Delete':
      case 'Backspace': {
        event.preventDefault();
        const target = terminals[index];
        if (target) onClose(target.id);
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const target = terminals[index];
        if (target) onSelect(target.id, { focusTerminal: true });
        break;
      }
      default:
        break;
    }
  };

  return (
    <div className="flex items-center gap-1 border-b border-border bg-card px-2 py-1">
      <div
        role="tablist"
        aria-label="Terminals"
        aria-orientation="horizontal"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {terminals.map((terminal, index) => {
          const selected = terminal.id === activeId;
          return (
            <div
              key={terminal.id}
              id={tabIdFor(terminal.id)}
              role="tab"
              aria-selected={selected}
              aria-label={`${terminal.title}${
                terminal.status === 'exited' ? ' (exited)' : ''
              }. Press Delete to close.`}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => {
                handleKeyDown(event, index);
              }}
              onClick={() => {
                onSelect(terminal.id, { focusTerminal: true });
              }}
              className={[
                'group flex max-w-[14rem] shrink-0 cursor-default items-center gap-1.5 rounded-md px-2.5 py-1 text-xs',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              ].join(' ')}
            >
              {terminal.status === 'exited' ? (
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground"
                />
              ) : (
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
              )}
              <span className="truncate font-mono">{terminal.title}</span>
              <span
                aria-hidden="true"
                title="Close"
                onClick={(event) => {
                  /* The tab's own click would re-select what is being closed. */
                  event.stopPropagation();
                  onClose(terminal.id);
                }}
                className="ml-0.5 shrink-0 rounded-sm px-1 leading-none opacity-0 hover:bg-accent group-hover:opacity-100"
              >
                ×
              </span>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onCreate}
        disabled={busy}
        title="New terminal (⌘T)"
        aria-label="New terminal"
        className="shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        +
      </button>

      {/*
        Visible only when focused. Screen-reader users reach it by tabbing and
        can turn on xterm's accessibility buffer; everyone else never sees a
        control that would mean nothing to them. Main can default this from
        `app.accessibilitySupportEnabled` once that is pushed — see the note in
        `TerminalProduct`.
      */}
      <button
        type="button"
        onClick={onToggleScreenReaderMode}
        aria-pressed={screenReaderMode}
        className="sr-only rounded-md px-2 py-1 text-xs focus:not-sr-only focus:relative focus:bg-secondary focus:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Screen reader mode
      </button>
    </div>
  );
}
