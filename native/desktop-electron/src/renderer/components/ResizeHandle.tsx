/**
 * The drag handle between two panes.
 *
 * A split that can only be resized with a mouse is a split half the users
 * cannot resize, so this is a real `role="separator"` with `aria-valuenow`,
 * a tab stop, and arrow-key control — the same pattern a native split view
 * exposes. Announced as "Sidebar width, 260" and moved with the arrow keys;
 * Shift for a coarse step, Home/End for the extremes, double-click to reset.
 *
 * Two details that make the pointer half feel right:
 *
 *   - **The hit area is wider than the line.** The visible separator is a 1px
 *     hairline; the target is 9px. Fitts's law does not care how thin the
 *     design is, and a 1px drag target is a design that tests badly and ships
 *     anyway because the person testing it knows exactly where to click.
 *   - **Pointer capture, not window listeners.** Capture keeps the drag glued
 *     to this element even when the cursor outruns it, which happens on every
 *     fast drag, and it releases correctly if the pointer is cancelled by the
 *     OS (a swipe, a display change) instead of leaving the app in a permanent
 *     drag state.
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

interface ResizeHandleProps {
  /** Announced name, e.g. "Sidebar width". */
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
  /**
   * Which side of the handle the panel being resized is on. `start` means the
   * panel is to the left, so dragging right makes it wider.
   */
  readonly side: 'start' | 'end';
  readonly onReset?: (() => void) | undefined;
}

const FINE_STEP = 8;
const COARSE_STEP = 32;

export function ResizeHandle({ label, value, min, max, onChange, side, onReset }: ResizeHandleProps): ReactNode {
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ x: number; value: number } | null>(null);

  const apply = useCallback(
    (next: number) => onChange(Math.min(max, Math.max(min, Math.round(next)))),
    [max, min, onChange],
  );

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { x: event.clientX, value };
    setDragging(true);
    /* Without this, a drag across text selects it, and the pane appears to
       resize while highlighting half the sidebar. */
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = origin.current;
    if (!start) return;
    const delta = event.clientX - start.x;
    apply(start.value + (side === 'start' ? delta : -delta));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!origin.current) return;
    origin.current = null;
    setDragging(false);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${value} pixels`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? COARSE_STEP : FINE_STEP;
        /* Arrow semantics are absolute (left shrinks a left-hand panel), not
           relative to the handle, because that is what the user sees happen. */
        const direction = side === 'start' ? 1 : -1;
        switch (event.key) {
          case 'ArrowLeft':
            event.preventDefault();
            apply(value - step * direction);
            return;
          case 'ArrowRight':
            event.preventDefault();
            apply(value + step * direction);
            return;
          case 'Home':
            event.preventDefault();
            apply(min);
            return;
          case 'End':
            event.preventDefault();
            apply(max);
            return;
          case 'Enter':
            if (onReset) {
              event.preventDefault();
              onReset();
            }
            return;
          default:
            return;
        }
      }}
      className={cn(
        'group relative z-20 w-px shrink-0 cursor-col-resize bg-border outline-none',
        'focus-visible:bg-primary',
        dragging && 'bg-primary',
      )}
    >
      {/* The real target: 9px wide, invisible, centred on the hairline. */}
      <span aria-hidden="true" className="absolute inset-y-0 -left-1 -right-1 block" />
      {/* Hover feedback lives on a child so the hairline itself never moves. */}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 -left-px -right-px block opacity-0 transition-opacity',
          'duration-150 group-hover:opacity-100',
          dragging && 'opacity-100',
          'bg-primary',
        )}
      />
    </div>
  );
}
