/**
 * The composer.
 *
 * One implementation, used by every surface, because a product with two
 * composers has two sets of keyboard rules and users discover the difference by
 * losing a paragraph. It is the one piece of glass in the main column: it
 * floats over the transcript, so it reads as chrome rather than as content.
 *
 * Keyboard contract, which is the part that matters:
 *   - **Enter sends. Shift+Enter inserts a newline.** The convention for chat.
 *   - **⌘Enter also sends**, for people arriving from editors where Enter never
 *     submits.
 *   - **Escape blurs** rather than clearing. Clearing a draft on Escape is the
 *     single most destructive default a composer can have.
 *
 * The textarea grows with its content up to a ceiling and then scrolls. Height
 * is measured, not guessed from line counts, because a wrapped line and a
 * newline are the same height and only one of them is countable.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { glassSurface } from '../lib/surfaces.js';
import { useSystem } from '../state/system-state.js';
import { IconButton } from './primitives/Button.js';
import { ArrowUpIcon, StopIcon } from './icons.js';

const MAX_HEIGHT = 200;

interface ComposerProps {
  readonly placeholder: string;
  /** Present ⇒ the composer is read-only and this explains why. */
  readonly disabledReason?: string | undefined;
  /** A turn is in flight: the send button becomes stop. */
  readonly busy?: boolean;
  readonly onSubmit: (text: string) => void;
  readonly onStop?: (() => void) | undefined;
  /** Accessible label for the field. */
  readonly label: string;
  readonly footer?: ReactNode;
}

export function Composer({
  placeholder,
  disabledReason,
  busy = false,
  onSubmit,
  onStop,
  label,
  footer,
}: ComposerProps): ReactNode {
  const { appearance } = useSystem();
  const [value, setValue] = useState('');
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const disabled = Boolean(disabledReason);

  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;

    function measure(node: HTMLTextAreaElement): void {
      /* Collapse first, then read: `scrollHeight` on an element that is already
         taller than its content returns the element's height, not the
         content's, so measuring without this makes the field a one-way ratchet
         that never shrinks. */
      node.style.height = 'auto';
      const content = node.scrollHeight;
      node.style.height = `${Math.min(content, MAX_HEIGHT)}px`;
      node.style.overflowY = content > MAX_HEIGHT ? 'auto' : 'hidden';
    }

    measure(node);

    /* Two re-measures, for the same reason: the first pass can run against
       metrics that are not final. On the very first frame of a window the
       stylesheet may not be applied yet, and a web font swapping in changes the
       line box afterwards — either one leaves the field stuck at whatever it
       measured, with no keystroke coming to correct it while the composer is
       read-only. This was not hypothetical: it opened at its 200px ceiling. */
    const frame = window.requestAnimationFrame(() => measure(node));
    let cancelled = false;
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts.ready.then(() => {
        if (!cancelled) measure(node);
      });
    }

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [value]);

  function submit(): void {
    const text = value.trim();
    if (disabled || busy || text.length === 0) return;
    onSubmit(text);
    setValue('');
  }

  const canSend = !disabled && !busy && value.trim().length > 0;

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className={cn(
          'rounded-composer border border-border shadow-glass transition-colors duration-150',
          glassSurface(appearance.reduceTransparency),
          /* focus-within, not focus: the ring belongs to the shell the user
             perceives as the control, not to the bare textarea inside it. */
          'focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
          'focus-within:ring-offset-background',
          disabled && 'opacity-70',
        )}
      >
        <label className="sr-only" htmlFor="juno-composer">
          {label}
        </label>
        <textarea
          id="juno-composer"
          ref={textarea}
          rows={1}
          value={value}
          placeholder={placeholder}
          readOnly={disabled}
          aria-describedby={disabled ? 'juno-composer-reason' : undefined}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.blur();
              return;
            }
            if (event.key !== 'Enter') return;
            if (event.shiftKey) return;
            event.preventDefault();
            submit();
          }}
          className={cn(
            'block w-full resize-none bg-transparent px-4 pt-3 text-sm leading-relaxed text-foreground',
            'placeholder:text-muted-foreground focus:outline-none',
            disabled && 'cursor-default',
          )}
        />

        <div className="flex items-center justify-between gap-3 px-3 pb-2.5 pt-1.5">
          <div className="min-w-0 truncate text-caption text-muted-foreground">
            {disabled ? (
              <span id="juno-composer-reason">{disabledReason}</span>
            ) : (
              footer ?? <span className="font-mono">Enter to send · Shift+Enter for a new line</span>
            )}
          </div>

          {busy && onStop ? (
            <IconButton
              label="Stop this turn"
              variant="secondary"
              icon={<StopIcon className="h-3.5 w-3.5" />}
              onClick={onStop}
              tooltipPlacement="top"
            />
          ) : (
            <IconButton
              label="Send message"
              variant={canSend ? 'primary' : 'secondary'}
              icon={<ArrowUpIcon className="h-4 w-4" />}
              onClick={submit}
              tooltipPlacement="top"
              disabledReason={
                disabled ? disabledReason : value.trim().length === 0 ? 'Write something first.' : undefined
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
