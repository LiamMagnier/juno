/**
 * Tooltips.
 *
 * They exist here for one reason above all others: a control that cannot be
 * used must say why. "No dead buttons" means a disabled control still has to
 * explain itself, and an explanation the user can only get by hovering a mouse
 * is not an explanation for a keyboard or screen-reader user — so this
 * component shows on **focus** as well as hover, and the description is wired
 * with `aria-describedby` rather than a `title` attribute (which is announced
 * inconsistently, cannot be styled, and never appears for keyboard users).
 *
 * Positioned `fixed` from a measured rect and rendered in a portal, not
 * absolutely inside the trigger. Sidebars, the title bar and every scroll
 * container in this shell clip their overflow; an in-flow tooltip would be
 * sliced off by the first one of them it met.
 */

import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn.js';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  readonly label: string;
  /** Optional second line, for the "why is this disabled" case. */
  readonly detail?: string | undefined;
  readonly placement?: TooltipPlacement;
  readonly delayMs?: number;
  readonly children: ReactElement<{ 'aria-describedby'?: string | undefined }>;
}

interface Position {
  readonly top: number;
  readonly left: number;
}

export function Tooltip({
  label,
  detail,
  placement = 'bottom',
  delayMs = 320,
  children,
}: TooltipProps): ReactNode {
  const id = useId();
  const [position, setPosition] = useState<Position | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setPosition(null);
  }, [clearTimer]);

  const show = useCallback(
    (immediate: boolean) => {
      clearTimer();
      const run = (): void => {
        const rect = anchorRef.current?.getBoundingClientRect();
        if (!rect) return;
        setPosition(computePosition(rect, placement));
      };
      /* Keyboard focus shows immediately; a pointer waits, so that sweeping the
         cursor across a toolbar does not fire six tooltips. */
      if (immediate) run();
      else timer.current = window.setTimeout(run, delayMs);
    },
    [clearTimer, delayMs, placement],
  );

  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    if (!position) return;
    function onKeyDown(event: KeyboardEvent): void {
      /* Escape dismisses without moving focus — WCAG 1.4.13 ("Content on
         Hover or Focus") requires exactly this. */
      if (event.key === 'Escape') hide();
    }
    window.addEventListener('keydown', onKeyDown);
    /* A tooltip anchored to a rect measured before a scroll is a tooltip
       floating over unrelated content. Cheaper to dismiss than to track. */
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [position, hide]);

  const open = position !== null;

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex"
        onPointerEnter={() => show(false)}
        onPointerLeave={hide}
        onFocusCapture={() => show(true)}
        onBlurCapture={hide}
      >
        {cloneElement(children, { 'aria-describedby': open ? id : undefined })}
      </span>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              style={{ top: position.top, left: position.left }}
              className={cn(
                'pointer-events-none fixed z-popper max-w-xs rounded-menu border border-border px-2.5 py-1.5',
                'bg-popover/95 text-popover-foreground shadow-float backdrop-blur-xl',
                placement === 'top' && '-translate-x-1/2 -translate-y-full',
                placement === 'bottom' && '-translate-x-1/2',
                placement === 'left' && '-translate-x-full -translate-y-1/2',
                placement === 'right' && '-translate-y-1/2',
              )}
            >
              <span className="block text-caption font-medium leading-tight">{label}</span>
              {detail ? (
                <span className="mt-0.5 block text-caption leading-snug text-muted-foreground">{detail}</span>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const GAP = 8;

function computePosition(rect: DOMRect, placement: TooltipPlacement): Position {
  switch (placement) {
    case 'top':
      return { top: rect.top - GAP, left: rect.left + rect.width / 2 };
    case 'bottom':
      return { top: rect.bottom + GAP, left: rect.left + rect.width / 2 };
    case 'left':
      return { top: rect.top + rect.height / 2, left: rect.left - GAP };
    case 'right':
      return { top: rect.top + rect.height / 2, left: rect.right + GAP };
  }
}
