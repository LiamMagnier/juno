/**
 * The command palette (⌘K).
 *
 * A palette is a keyboard surface first, so the keyboard implementation is the
 * component and the rest is decoration:
 *
 *   - **Focus never leaves the input.** The options are not tab stops; the
 *     input owns focus and points at the active option with
 *     `aria-activedescendant`. This is the combobox pattern, and it is what
 *     lets a screen-reader user hear the highlighted option change while still
 *     typing — moving DOM focus row by row would interrupt the field they are
 *     typing into. Tab is swallowed, which is the whole focus trap: there is
 *     exactly one stop inside the dialog.
 *   - **Escape closes and focus goes back where it came from.** Restoring focus
 *     is not a nicety: without it, dismissing the palette drops the user at the
 *     top of the document and they have to tab back to where they were.
 *   - **Arrow keys wrap, Home/End jump.** Wrapping matters more here than in a
 *     menu, because the list is filtered and the user cannot see how long it is.
 *   - **Disabled commands are still listed, still selectable, and explain
 *     themselves on Enter.** Hiding them turns "I can't find it" into a support
 *     ticket.
 *
 * Glass, because this is transient chrome — it is the one place in the shell
 * where translucency is the correct answer, and it drops to opaque under
 * Reduce Transparency.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../lib/cn.js';
import { glassSurface, scrimSurface } from '../lib/surfaces.js';
import { useAnnounce } from '../state/announcer.js';
import { useShell } from '../state/shell-state.js';
import { useMotionProfile, useSystem } from '../state/system-state.js';
import { COMMAND_GROUP_ORDER, scoreCommand, useCommands, type Command, type CommandGroup } from '../state/commands.js';
import { Kbd } from './primitives/atoms.js';
import { SearchIcon } from './icons.js';

export function CommandPalette(): ReactNode {
  const { paletteOpen, closePalette } = useShell();
  const motionProfile = useMotionProfile();
  const { appearance } = useSystem();
  const announce = useAnnounce();
  const commands = useCommands();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  const results = useMemo(() => rank(commands, query), [commands, query]);
  const active = results[activeIndex];

  /* Remember where focus came from *before* the palette takes it. */
  useEffect(() => {
    if (!paletteOpen) return;
    const previous = document.activeElement;
    returnFocusTo.current = previous instanceof HTMLElement ? previous : null;
    setQuery('');
    setActiveIndex(0);
    /* One frame later: the input does not exist until the entrance renders. */
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [paletteOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  /* Keep the highlighted row visible without scrolling the whole dialog. */
  useEffect(() => {
    if (!active) return;
    const node = listRef.current?.querySelector(`#${CSS.escape(optionId(active.id))}`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function close(): void {
    closePalette();
    /* Focus is restored to whatever had it, unless that element has since left
       the document — which happens routinely here, because running a command
       is often what unmounted it. Falling back to the main pane keeps the
       keyboard user somewhere meaningful; dropping focus on <body> would send
       their next Tab back to the top of the window. */
    const previous = returnFocusTo.current;
    if (previous?.isConnected) previous.focus();
    else document.getElementById('juno-main-pane')?.focus();
  }

  function runCommand(command: Command): void {
    if (command.disabledReason) {
      announce(`${command.title} is unavailable. ${command.disabledReason}`, 'assertive');
      return;
    }
    close();
    command.run();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close();
        return;
      case 'Tab':
        /* The trap. One focusable element, so the correct behaviour is simply
           to refuse to leave. */
        event.preventDefault();
        return;
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length));
        return;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        return;
      case 'End':
        event.preventDefault();
        setActiveIndex(Math.max(0, results.length - 1));
        return;
      case 'Enter':
        event.preventDefault();
        if (active) runCommand(active);
        return;
      default:
        return;
    }
  }

  return (
    <AnimatePresence>
      {paletteOpen ? (
        <div className="fixed inset-0 z-modal flex items-start justify-center px-4 pt-[12vh]">
          <motion.div
            key="scrim"
            variants={motionProfile.scrim}
            initial="hidden"
            animate="visible"
            exit="hidden"
            onClick={close}
            className={cn('absolute inset-0', scrimSurface(appearance.reduceTransparency))}
            /* Decorative: the dialog is dismissible from the keyboard, so this
               does not need to be a control. */
            aria-hidden="true"
          />

          <motion.div
            key="panel"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            variants={motionProfile.overlay}
            initial="hidden"
            animate="visible"
            exit="hidden"
            onKeyDown={onKeyDown}
            className={cn(
              'relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-panel border border-border',
              'shadow-float',
              glassSurface(appearance.reduceTransparency),
            )}
          >
            <div className="flex items-center gap-2.5 border-b border-border px-3.5">
              <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls="juno-command-list"
                aria-autocomplete="list"
                aria-activedescendant={active ? optionId(active.id) : undefined}
                aria-label="Search commands"
                placeholder="Search commands…"
                value={query}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
                className={cn(
                  'h-12 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none',
                  'placeholder:text-muted-foreground',
                )}
              />
              <Kbd keys={['esc']} />
            </div>

            <div
              ref={listRef}
              id="juno-command-list"
              role="listbox"
              aria-label="Commands"
              className="max-h-[min(24rem,50vh)] overflow-y-auto py-1.5"
            >
              {results.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  Nothing matches <span className="text-foreground">{query}</span>.
                </p>
              ) : (
                groupResults(results).map(([group, items]) => (
                  <div key={group} role="group" aria-labelledby={groupId(group)}>
                    <div
                      id={groupId(group)}
                      className="px-3.5 pb-1 pt-2 font-mono text-label uppercase text-muted-foreground"
                    >
                      {group}
                    </div>
                    {items.map((command) => (
                      <Option
                        key={command.id}
                        command={command}
                        selected={command.id === active?.id}
                        onHover={() => setActiveIndex(results.indexOf(command))}
                        onSelect={() => runCommand(command)}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>

            {/* Result count, announced politely. Screen-reader users otherwise
                have no way to know the list narrowed as they typed. */}
            <div className="sr-only" aria-live="polite">
              {results.length} command{results.length === 1 ? '' : 's'}
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

function Option({
  command,
  selected,
  onHover,
  onSelect,
}: {
  command: Command;
  selected: boolean;
  onHover: () => void;
  onSelect: () => void;
}): ReactNode {
  const unavailable = Boolean(command.disabledReason);

  return (
    <div
      id={optionId(command.id)}
      role="option"
      aria-selected={selected}
      aria-disabled={unavailable || undefined}
      onPointerMove={onHover}
      onClick={onSelect}
      className={cn(
        'mx-1.5 flex cursor-default items-center gap-2.5 rounded-control py-1.5 pl-1.5 pr-2',
        selected && 'bg-muted',
      )}
    >
      {/* The same coral rule the sidebar uses for its selected row. A tinted
          background alone is a 4% lightness difference on a translucent panel,
          which is not a selection indicator on a glossy display in daylight —
          and it is nothing at all in greyscale. */}
      <span
        aria-hidden="true"
        className={cn('h-5 w-0.5 shrink-0 rounded-full', selected ? 'bg-primary' : 'bg-transparent')}
      />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[13px]', unavailable ? 'text-muted-foreground' : 'text-foreground')}>
          {command.title}
        </span>
        {/* The reason replaces the hint when there is one: at the moment a
            command cannot run, why is more useful than what. */}
        {command.disabledReason ?? command.hint ? (
          <span className="mt-0.5 block truncate text-caption text-muted-foreground">
            {command.disabledReason ?? command.hint}
          </span>
        ) : null}
      </span>
      {command.shortcut ? <Kbd keys={command.shortcut} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function rank(commands: readonly Command[], query: string): readonly Command[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return commands;
  return commands
    .map((command) => ({ command, score: scoreCommand(command, trimmed) }))
    .filter((entry) => entry.score > 0)
    /* Stable within a score so the list does not reshuffle as the user types a
       character that changes nothing. */
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.command);
}

function groupResults(results: readonly Command[]): readonly (readonly [CommandGroup, readonly Command[]])[] {
  const buckets = new Map<CommandGroup, Command[]>();
  for (const command of results) {
    const bucket = buckets.get(command.group);
    if (bucket) bucket.push(command);
    else buckets.set(command.group, [command]);
  }
  return COMMAND_GROUP_ORDER.flatMap((group) => {
    const items = buckets.get(group);
    return items && items.length > 0 ? [[group, items] as const] : [];
  });
}

const optionId = (id: string): string => `juno-command-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
const groupId = (group: string): string => `juno-command-group-${group.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
