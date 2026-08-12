/**
 * The segmented switch used for both product mode and the Chat/Work surface.
 *
 * Implemented as an ARIA **tablist**, not a radio group and not a row of
 * buttons, because that is what it is: each segment reveals a different pane,
 * so `role="tab"` + `aria-controls` + `aria-selected` is the pattern that tells
 * assistive technology what pressing it will do. That brings obligations, and
 * they are all met here: a single tab stop for the whole group (roving
 * tabindex), arrow keys to move between segments, Home/End to jump to the ends.
 * Tabbing into a group of five and having to press Tab five times to leave it
 * is the failure this pattern exists to prevent.
 *
 * The selected segment is marked three ways over — a filled surface, a heavier
 * text colour, and a coral rule beneath it — because "the user must never
 * wonder where they are" is not satisfied by a 4% lightness difference that
 * disappears on a glossy display in daylight.
 */

import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/cn.js';
import { useMotionProfile } from '../state/system-state.js';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
  /** Rendered as a tooltip-free hint inside the segment's accessible name. */
  readonly hint?: string;
}

interface SegmentedControlProps<T extends string> {
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Names the group for screen readers, e.g. "Product mode". */
  readonly label: string;
  /** Must be unique per mounted control — it keys the shared-element thumb. */
  readonly layoutId: string;
  readonly size?: 'sm' | 'md';
  /** id of the panel each segment reveals, for `aria-controls`. Tabs only. */
  readonly panelId?: string;
  /**
   * `tabs` when the segments reveal different panes; `radio` when they set a
   * value in place. The distinction is not cosmetic — a tab announces "this
   * shows a different view" and a radio announces "this changes a setting", and
   * a permission-mode switch labelled as a tab tells the user something false
   * about what pressing it will do.
   */
  readonly pattern?: 'tabs' | 'radio';
  readonly className?: string | undefined;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  layoutId,
  size = 'md',
  panelId,
  pattern = 'tabs',
  className,
}: SegmentedControlProps<T>): ReactNode {
  const motionProfile = useMotionProfile();
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  function focusValue(next: T): void {
    onChange(next);
    /* Focus follows selection so the roving tabindex stays on the active
       segment; without this, arrow-key navigation moves the selection out from
       under the focused element. */
    window.requestAnimationFrame(() => buttons.current.get(next)?.focus());
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const index = options.findIndex((option) => option.value === value);
    if (index === -1) return;

    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      nextIndex = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = options.length - 1;
    if (nextIndex === null) return;

    const next = options[nextIndex];
    if (!next) return;
    event.preventDefault();
    focusValue(next.value);
  }

  return (
    <div
      role={pattern === 'tabs' ? 'tablist' : 'radiogroup'}
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-menu border border-border bg-muted/60 p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) buttons.current.set(option.value, node);
              else buttons.current.delete(option.value);
            }}
            type="button"
            role={pattern === 'tabs' ? 'tab' : 'radio'}
            aria-selected={pattern === 'tabs' ? selected : undefined}
            aria-checked={pattern === 'radio' ? selected : undefined}
            aria-controls={pattern === 'tabs' ? panelId : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative inline-flex items-center gap-1.5 rounded-control font-medium transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              'focus-visible:ring-offset-background',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-[13px]',
              selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {selected ? <Thumb layoutId={layoutId} animated={motionProfile.layout} /> : null}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {option.icon}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The moving surface behind the active segment.
 *
 * With motion enabled it is a shared element, so switching modes slides rather
 * than cuts — the one place in this shell where a shared-element transition
 * genuinely aids comprehension, because it shows that the two segments are one
 * control. Under Reduce Motion the same surface simply appears in its new
 * place: no travel, and no cross-fade either, since a fade between two
 * positions reads as a ghost.
 */
function Thumb({ layoutId, animated }: { layoutId: string; animated: boolean }): ReactNode {
  const className =
    'absolute inset-0 z-0 rounded-control border border-border bg-background ' +
    /* The coral rule. 2px, inset from the ends, under the label. */
    "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary after:content-['']";

  if (!animated) return <span aria-hidden="true" className={className} />;
  return (
    <motion.span
      aria-hidden="true"
      layoutId={layoutId}
      className={className}
      transition={{ type: 'spring', stiffness: 520, damping: 42, mass: 0.7 }}
    />
  );
}
