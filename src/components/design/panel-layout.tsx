"use client";

/**
 * How wide the rails are and how tall the timeline is — remembered, and dragged.
 *
 * The three panes were literal constants: `w-52` on the layers rail, `w-64` on
 * the inspector, `height: 244` on the motion dock. That is a fine default and a
 * poor rule. A layer tree twelve levels deep truncates every row at 208px; the
 * inspector's own fields are laid out two-up inside 256px and clip their labels
 * when a value is long; and the timeline is the one pane whose useful height
 * depends entirely on how many tracks the animation has — four tracks fit, ten
 * do not. None of that is knowable from here, which is exactly why it should be
 * the user's to set.
 *
 * Sizes persist per pane in `localStorage`, because a rail you widen and then
 * find narrow again on the next design is a rail you stop widening.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

export interface PaneBounds {
  /** Below this the pane stops being usable rather than merely tight, so the
   *  drag clamps here instead of letting the pane collapse by accident —
   *  collapsing is a separate, reversible, labelled gesture. */
  min: number;
  max: number;
  initial: number;
}

/**
 * Ceilings are generous but real. A rail dragged past half the window stops
 * being a rail, and the canvas — the thing the other two exist to serve — is
 * what pays for it.
 */
export const PANE_BOUNDS = {
  layers: { min: 168, max: 420, initial: 208 },
  inspector: { min: 208, max: 480, initial: 256 },
  timeline: { min: 152, max: 640, initial: 244 },
  // No `as const`: the numbers are sizes, not a union of three literals, and a
  // literal type here makes `setSize(anything else)` a type error.
} satisfies Record<string, PaneBounds>;

export type PaneName = keyof typeof PANE_BOUNDS;

/** Which edge of the pane the grip sits on, which is the whole of what decides
 *  whether a rightward drag grows the pane or shrinks it. */
export type PaneSide = "start" | "end" | "top";

const SIZE_KEY = (pane: PaneName) => `juno.design.pane.${pane}.size`;
const COLLAPSED_KEY = (pane: PaneName) => `juno.design.pane.${pane}.collapsed`;

export function clampPaneSize(value: number, bounds: PaneBounds): number {
  if (!Number.isFinite(value)) return bounds.initial;
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}

/**
 * The size a drag produces, as a pure function of where it began and where the
 * pointer is now.
 *
 * The sign is the entire content of this function and it is the thing that
 * ships inverted: the layers rail's grip is on its right edge, so moving right
 * makes it wider, while the inspector's grip is on its left edge and moving
 * right makes it *narrower*. The timeline's grip is on its top edge and moving
 * up makes it taller.
 */
export function paneSizeFromDrag(side: PaneSide, from: number, origin: number, pointer: number, bounds: PaneBounds): number {
  const delta = side === "end" || side === "top" ? origin - pointer : pointer - origin;
  return clampPaneSize(from + delta, bounds);
}

/** Arrow keys on a focused grip, in the direction the same drag would go. Null
 *  for a key this grip has no answer for, so the caller leaves the event alone. */
export function paneSizeFromKey(
  side: PaneSide,
  size: number,
  key: string,
  shiftKey: boolean,
  bounds: PaneBounds
): number | null {
  if (key === "Home") return bounds.initial;
  const towardsLarger = side === "end" || side === "top" ? ["ArrowLeft", "ArrowUp"] : ["ArrowRight", "ArrowDown"];
  const towardsSmaller = side === "end" || side === "top" ? ["ArrowRight", "ArrowDown"] : ["ArrowLeft", "ArrowUp"];
  const step = shiftKey ? 32 : 8;
  if (towardsLarger.includes(key)) return clampPaneSize(size + step, bounds);
  if (towardsSmaller.includes(key)) return clampPaneSize(size - step, bounds);
  return null;
}

/** Storage is a hint, never an authority: a stale number from an older build
 *  whose bounds have since moved is clamped rather than obeyed. */
function readSize(pane: PaneName, bounds: PaneBounds): number | null {
  try {
    const stored = window.localStorage.getItem(SIZE_KEY(pane));
    if (stored === null) return null;
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? clampPaneSize(parsed, bounds) : null;
  } catch {
    // Private mode, or storage disabled. A preference we cannot read is not a
    // reason to fail to render the editor.
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* as above */
  }
}

/**
 * A pane's size, its collapsed state, and the handler that drags it.
 *
 * Read on mount rather than during render, so the server-rendered markup and
 * the first client paint agree — reading `localStorage` in the initial state is
 * a hydration mismatch waiting to happen.
 */
export function usePaneSize(pane: PaneName, side: PaneSide) {
  const bounds = PANE_BOUNDS[pane];
  const [size, setSizeState] = React.useState(bounds.initial);
  const [collapsed, setCollapsedState] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    const stored = readSize(pane, bounds);
    if (stored !== null) setSizeState(stored);
    try {
      if (window.localStorage.getItem(COLLAPSED_KEY(pane)) === "1") setCollapsedState(true);
    } catch {
      /* see readSize */
    }
  }, [bounds, pane]);

  const setSize = React.useCallback(
    (next: number) => {
      const clamped = clampPaneSize(next, bounds);
      setSizeState(clamped);
      write(SIZE_KEY(pane), String(clamped));
    },
    [bounds, pane]
  );

  const setCollapsed = React.useCallback(
    (next: boolean) => {
      setCollapsedState(next);
      write(COLLAPSED_KEY(pane), next ? "1" : "0");
    },
    [pane]
  );

  /**
   * Pointer capture, not a window listener.
   *
   * The canvas beneath these rails takes focus on pointer-down and runs its own
   * pointer handlers; without capture, a drag that crossed onto it would start
   * a marquee selection over the artwork halfway through resizing a rail. The
   * `size` used as the origin is read at pointer-down and carried in the
   * closure, so a re-render mid-drag cannot make the delta jump.
   */
  const onResizeStart = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // A collapsed rail draws no handle, so this is belt and braces — but a
      // drag that survived a collapse would keep writing widths nobody can see.
      if (event.button !== 0 || collapsed) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const origin = side === "top" ? event.clientY : event.clientX;
      const from = size;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Capture can be refused (an already-captured pointer, a synthetic
        // event in a test). The drag still tracks; it just stops at the edge of
        // the handle, which is a smaller failure than not resizing at all.
      }
      setDragging(true);

      const move = (moveEvent: PointerEvent) => {
        setSize(paneSizeFromDrag(side, from, origin, side === "top" ? moveEvent.clientY : moveEvent.clientX, bounds));
      };
      const stop = () => {
        setDragging(false);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    },
    [bounds, collapsed, setSize, side, size]
  );

  /** Arrow keys on a focused handle, in the same units a drag moves. A pane you
   *  can only size with a pointer is a pane a keyboard user cannot size. */
  const onResizeKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      const next = paneSizeFromKey(side, size, event.key, event.shiftKey, bounds);
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation(); // the editor's single-key tool shortcuts
      setSize(next);
    },
    [bounds, setSize, side, size]
  );

  return { size, setSize, collapsed, setCollapsed, dragging, onResizeStart, onResizeKeyDown, bounds };
}

/**
 * The grip between a pane and the canvas.
 *
 * Four points of line inside twelve points of target. A grip drawn at the width
 * it is grabbed at is either a one-pixel edge nobody hits on the first try or a
 * visible gutter running down the middle of the editor; the padded span is what
 * lets it be neither. The line only appears on hover, focus and during the
 * drag, so at rest the editor is still two panes meeting at a border.
 *
 * A `separator` with `aria-valuenow`, so a screen reader gets what the pointer
 * gets: a thing between two panes whose size can be changed — and the arrow
 * keys actually change it.
 */
export function PaneResizer({
  label,
  orientation,
  pane,
  className,
}: {
  label: string;
  orientation: "vertical" | "horizontal";
  pane: ReturnType<typeof usePaneSize>;
  className?: string;
}) {
  const vertical = orientation === "vertical";
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={pane.size}
      aria-valuemin={pane.bounds.min}
      aria-valuemax={pane.bounds.max}
      tabIndex={0}
      onPointerDown={pane.onResizeStart}
      onKeyDown={pane.onResizeKeyDown}
      onDoubleClick={() => pane.setSize(pane.bounds.initial)}
      title={`${label} — drag, or double-click to reset`}
      className={cn(
        "group relative z-10 shrink-0 touch-none outline-none",
        vertical ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
        className
      )}
    >
      {/* The grip is wider than the line it draws: the coloured bar is the 4px
          the eye sees, the padded box around it is the 8px the pointer needs. */}
      <span
        aria-hidden
        className={cn(
          "absolute bg-primary/60 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100",
          vertical ? "inset-y-0 -left-0.5 w-1" : "inset-x-0 -top-0.5 h-1",
          pane.dragging && "opacity-100"
        )}
      />
      <span aria-hidden className={cn("absolute", vertical ? "inset-y-0 -inset-x-1" : "inset-x-0 -inset-y-1")} />
    </div>
  );
}
