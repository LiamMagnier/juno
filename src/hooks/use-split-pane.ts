"use client";

import * as React from "react";

/**
 * One resizable right-hand column, for every surface that has one.
 *
 * Three panes in this product are the same object: the canvas beside a chat,
 * the thought dock beside a chat, and the reference rail beside a Work task.
 * All three dock to the RIGHT of a primary reading column, are dragged by a
 * grip on their inner edge, remember their width, and must never be draggable
 * past the point where the column they sit beside stops being readable.
 *
 * They were three hand-rolled implementations, two of them (canvas, thought
 * dock) sitting 700 lines apart in chat-view.tsx and already diverging: only
 * one restored the body cursor when its pane unmounted mid-drag, only one had
 * a keyboard, only one refused to rewrite a desktop width while the pane was
 * full-bleed on a phone. The rail had none of it and could not be resized at
 * all. Divergence is the failure this hook exists to stop — a fix like "the
 * handle can vanish mid-drag" (below) was written once, for one of the three,
 * and the other two kept the bug.
 *
 * DOCKED RIGHT IS BAKED IN, deliberately. Every measurement here is
 * `container.right - clientX`, and an `edge: "left" | "right"` option would be
 * a second code path with no caller to keep it honest. A left-docked pane is a
 * change to this file when one exists, not a parameter shipped empty.
 */

export type SplitBounds = { minWidth: number; maxWidth: number };

/**
 * The width range a docked pane may be dragged through.
 *
 * The shape is the same everywhere and the three call sites only disagree
 * about the numbers, so it is written once here rather than as three
 * near-identical `…WidthBounds` functions that drift one clause at a time.
 *
 *  - `primaryMin` is reserved for the column the pane sits beside, ALWAYS.
 *    This is the whole point of the exercise: without it a drag can squeeze the
 *    transcript to nothing and the pane becomes a full-screen takeover the user
 *    never asked for.
 *  - `paneMin` is the pane's own floor, itself lowered to `paneFloor` on a
 *    container too narrow to give both columns what they want — a floor that
 *    cannot be reached is a handle that appears stuck.
 *  - `cssWidth` is for a pane whose UNDRAGGED width comes from a CSS class
 *    (the thought dock's `lg:w-[30rem]`, the Work rail's `22rem`/`26rem`
 *    track). That width is rendered by CSS no matter what these bounds say, so
 *    a max below it does not make the pane narrower — it only makes the HANDLE
 *    lie: pointer-down reads the live edge, clamps, and snaps the pane
 *    inwards before the user has moved. Keeping the CSS default reachable is
 *    what stops that.
 */
export function splitBounds({
  containerWidth,
  paneMin,
  paneFloor,
  primaryMin,
  fraction,
  cssWidth,
}: {
  containerWidth: number;
  paneMin: number;
  paneFloor: number;
  primaryMin: number;
  /** Share of the container the pane may take before the primary column's floor bites. */
  fraction: number;
  cssWidth?: number;
}): SplitBounds {
  const maxByPrimary = containerWidth - primaryMin;
  const minWidth = Math.min(paneMin, Math.max(paneFloor, maxByPrimary));
  const preferredMax = Math.min(Math.round(containerWidth * fraction), maxByPrimary);
  const maxWidth =
    cssWidth == null
      ? Math.max(minWidth, preferredMax)
      : // Capped by the container as well, so a pane that must be able to reach
        // its CSS default still cannot exceed the layout it lives in.
        Math.max(minWidth, Math.min(containerWidth, Math.max(preferredMax, cssWidth)));
  return { minWidth, maxWidth };
}

type SplitPaneOptions = {
  /** localStorage key. One per pane — widths are not shared between surfaces. */
  storageKey: string;
  /**
   * The box whose RIGHT edge is the pane's right edge, and whose width the
   * bounds are computed from. Not the pane itself: mid-drag the pane's own
   * width is the thing being changed, so measuring it would feed the result
   * back into the input.
   */
  containerRef: React.RefObject<HTMLElement | null>;
  bounds: (containerWidth: number) => SplitBounds;
  /**
   * The width to use when nothing is stored, and the one `reset()` returns to.
   * `null` means "the CSS default owns this column" — the hook then renders no
   * width at all rather than a number that merely happens to match the class,
   * which is what keeps `30rem` honest at a non-16px root font size.
   */
  resetWidth: (containerWidth: number) => number | null;
  /** What CSS gives the pane while the hook's width is null (for aria + keyboard). */
  cssWidth?: number;
  /**
   * What the SERVER renders for a pane that has no CSS default to fall back on.
   * Only the canvas needs it, and only in theory — it is opened by a click, so
   * it is never in the server's markup — but a pane whose entire width is an
   * inline custom property must not be able to render `nullpx`.
   */
  ssrWidth?: number;
  /**
   * Whether the stored width is actually applied at this viewport. Below the
   * breakpoint where these panes go full-bleed there is no width to constrain,
   * and clamping there destroys a width chosen on a wide monitor to satisfy a
   * constraint that does not exist — `resize` fires continuously on a phone
   * (the URL bar alone), so one scroll was enough to rewrite a 700px
   * preference down to the floor and persist it.
   */
  applies?: () => boolean;
  /**
   * Whether the pane (and therefore its handle) is on screen. Used only to
   * re-measure on open and to end a drag the handle cannot end itself — see
   * the unmount cleanup below.
   */
  active?: boolean;
  /**
   * Called when a drag asks for more width than the bounds allow, for a pane
   * with a legitimate "must be huge" case: the canvas collapses the sidebar
   * and the hook re-measures on the next frame, keeping the larger of the
   * current and requested widths. Omitted by panes where taking the sidebar to
   * read a side column would be a bad trade.
   */
  onRequestRoom?: () => void;
  /** Fired on the first pointer or key of a real resize (used to disarm entrance animations). */
  onUserResize?: () => void;
};

export type SplitPane = {
  /** null = never dragged; render the CSS default and no inline width. */
  width: number | null;
  /** Live range, kept truthful for the handle's aria — see the sync effect. */
  bounds: SplitBounds;
  resizing: boolean;
  /** Back to `resetWidth` (double-click, Home). */
  reset: () => void;
  /** Re-measure and re-clamp now, e.g. after the layout around the pane changed. */
  reclamp: () => void;
  /**
   * Spread onto the grip. The call site still supplies `aria-label`, `title`
   * and geometry: those are the only parts that differ between the three, and
   * a hook that owned them would be a component wearing a hook's name.
   */
  separatorProps: {
    role: "separator";
    "aria-orientation": "vertical";
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: () => void;
    onDoubleClick: () => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
};

/** Arrow nudge, and the Shift jump. Same rungs the thought dock shipped with. */
const STEP = 16;
const COARSE_STEP = 64;

export function useSplitPane({
  storageKey,
  containerRef,
  bounds,
  resetWidth,
  cssWidth,
  ssrWidth,
  applies,
  active = true,
  onRequestRoom,
  onUserResize,
}: SplitPaneOptions): SplitPane {
  /**
   * Every policy callback is read through a ref.
   *
   * Call sites pass inline arrows (`applies`, `onRequestRoom`, and in one case
   * a bounds function closing over a constant), so depending on them would
   * re-register the `resize` listener on every render of a component that
   * re-renders on every streamed token. The values are read at call time and
   * never during render, so a ref is the honest place for them.
   */
  const boundsRef = React.useRef(bounds);
  boundsRef.current = bounds;
  const resetWidthRef = React.useRef(resetWidth);
  resetWidthRef.current = resetWidth;
  const appliesRef = React.useRef(applies);
  appliesRef.current = applies;
  const requestRoomRef = React.useRef(onRequestRoom);
  requestRoomRef.current = onRequestRoom;
  const userResizeRef = React.useRef(onUserResize);
  userResizeRef.current = onUserResize;

  const appliesNow = React.useCallback(() => appliesRef.current?.() ?? true, []);

  const clamp = React.useCallback((width: number, containerWidth?: number) => {
    if (typeof window === "undefined") return width;
    const { minWidth, maxWidth } = boundsRef.current(containerWidth ?? window.innerWidth);
    return Math.min(Math.max(width, minWidth), maxWidth);
  }, []);

  const [width, setWidth] = React.useState<number | null>(() => {
    // The server has no viewport, so it renders the CSS default and lets the
    // client's first paint apply the stored width. Guessing a number here would
    // put a width in the markup that no user chose.
    if (typeof window === "undefined") return ssrWidth ?? null;
    let stored: number | null = null;
    try {
      const saved = Number(window.localStorage.getItem(storageKey));
      stored = Number.isFinite(saved) && saved > 0 ? saved : null;
    } catch {
      /* Storage can be unavailable (Safari private mode); the default is fine. */
    }
    // The container is not measured yet — the ref attaches with the first
    // commit — so the viewport stands in for it. The sync effect below corrects
    // this against the real container before the pane is interactive.
    const initial = stored ?? resetWidthRef.current(window.innerWidth);
    if (initial == null) return null;
    return appliesNow() ? clamp(initial, window.innerWidth) : initial;
  });

  React.useEffect(() => {
    try {
      // null is stored as ABSENCE, not as a number: "never dragged" has to
      // survive a reload, or Home/double-click would only reset until the next
      // refresh and then snap back to whatever number we had written for it.
      if (width == null) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, String(width));
    } catch {
      /* A pane that cannot persist its width still has to resize. */
    }
  }, [storageKey, width]);

  /**
   * The announced range, in state rather than read off the ref at render time.
   *
   * A ref read during render is not reactive, so `aria-valuemax` would have
   * been the placeholder below on the first paint and then never corrected.
   * The placeholder is deliberately computed from a zero-width container so it
   * is identical on the server and on the client's hydrating render — seeding
   * it from `innerWidth` instead put a different number in the two and cost a
   * hydration mismatch on an attribute nobody had read yet.
   */
  const [liveBounds, setLiveBounds] = React.useState<SplitBounds>(() => bounds(0));

  React.useEffect(() => {
    const sync = () => {
      const containerWidth = containerRef.current?.getBoundingClientRect().width;
      if (containerWidth) setLiveBounds(boundsRef.current(containerWidth));
      // Only where the width is actually applied — see `applies`.
      if (appliesNow()) setWidth((current) => (current == null ? current : clamp(current, containerWidth)));
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
    // `active` re-runs it on open: a width stored while the sidebar was
    // collapsed can exceed the container it opens into, and the range the
    // handle announces has to be right before it is first focused.
  }, [active, appliesNow, clamp, containerRef]);

  const reclamp = React.useCallback(() => {
    const containerWidth = containerRef.current?.getBoundingClientRect().width;
    if (containerWidth) setLiveBounds(boundsRef.current(containerWidth));
    if (appliesNow()) setWidth((current) => (current == null ? current : clamp(current, containerWidth)));
  }, [appliesNow, clamp, containerRef]);

  /**
   * Back to the default, CLAMPED — a computed default is not automatically a
   * legal one. "46% of the container" lands under the canvas's own minimum on
   * any container below ~910px, so an unclamped reset put the pane outside the
   * range its handle had just announced and left the chat column holding the
   * difference. A null default (the panes whose width CSS owns) is passed
   * through untouched: there is no number to clamp, which is the point of it.
   */
  const reset = React.useCallback(() => {
    const containerWidth =
      containerRef.current?.getBoundingClientRect().width ??
      (typeof window === "undefined" ? 0 : window.innerWidth);
    const next = resetWidthRef.current(containerWidth);
    setWidth(next == null ? null : clamp(next, containerWidth));
  }, [clamp, containerRef]);

  const sessionRef = React.useRef<{
    pointerId: number;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);
  const [resizing, setResizing] = React.useState(false);

  const updateFromPointer = React.useCallback(
    (clientX: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const requested = rect ? rect.right - clientX : window.innerWidth - clientX;
      if (rect && requestRoomRef.current && requested > boundsRef.current(rect.width).maxWidth) {
        requestRoomRef.current();
        window.requestAnimationFrame(() => {
          const next = containerRef.current?.getBoundingClientRect();
          // `Math.max` keeps the drag going in the direction the pointer asked
          // for: the frame that made room must not also undo the pull that
          // asked for it.
          setWidth((current) => clamp(Math.max(current ?? 0, requested), next?.width));
        });
        return;
      }
      setWidth(clamp(requested, rect?.width));
    },
    [clamp, containerRef],
  );

  const stop = React.useCallback((target?: HTMLElement, pointerId?: number) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    setResizing(false);
    document.body.style.cursor = session.previousCursor;
    document.body.style.userSelect = session.previousUserSelect;
    if (target && pointerId != null && target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  }, []);

  /**
   * THE HANDLE CAN VANISH MID-DRAG.
   *
   * `stop` otherwise only runs from the grip's own React handlers, and every
   * one of these panes can be closed while a drag is live: Escape on the
   * thought dock (nothing preventDefaults it during a pointer drag), a
   * regenerate landing the answer under a fresh id, a canvas closing from a
   * fetch that resolved. The implicit pointer release then fires at a DETACHED
   * node, and React 19 delegates to the root container, so
   * `onLostPointerCapture` never arrives: body would keep `cursor: col-resize`
   * and `user-select: none` app-wide until a reload, and — worse — the
   * still-non-null session would make the NEXT drag save those stuck values as
   * the ones to restore, so no clean pointer-up could ever undo it.
   *
   * Keyed on `active`, because it is the PANE and not the hook's owner that
   * unmounts. A no-op when no drag is in flight.
   */
  React.useEffect(() => () => stop(), [active, stop]);

  const separatorProps = React.useMemo(
    () => ({
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-valuenow": Math.round(width ?? cssWidth ?? 0),
      "aria-valuemin": liveBounds.minWidth,
      "aria-valuemax": liveBounds.maxWidth,
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        // preventDefault plus the saved userSelect are what stop a drag from
        // selecting the pane's text and leaving the cursor stuck afterwards.
        event.preventDefault();
        sessionRef.current = {
          pointerId: event.pointerId,
          previousCursor: document.body.style.cursor,
          previousUserSelect: document.body.style.userSelect,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        userResizeRef.current?.();
        setResizing(true);
        // Kept on BODY, not on the handle: the pointer routinely outruns a 12px
        // grip mid-drag, and a cursor that flickers back to an I-beam over the
        // transcript reads as the drag having been dropped.
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        updateFromPointer(event.clientX);
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        if (sessionRef.current?.pointerId !== event.pointerId) return;
        event.preventDefault();
        updateFromPointer(event.clientX);
      },
      onPointerUp: (event: React.PointerEvent<HTMLElement>) => stop(event.currentTarget, event.pointerId),
      onPointerCancel: (event: React.PointerEvent<HTMLElement>) => stop(event.currentTarget, event.pointerId),
      onLostPointerCapture: () => stop(),
      onDoubleClick: reset,
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        // KEYBOARD, NOT AN AFTERTHOUGHT. A pointer-only splitter is unusable
        // without a mouse, and the canvas grip shipped as a focusable button
        // labelled "Resize canvas" that answered no key at all. Left GROWS the
        // pane because the pane is on the right — the edge moves the way the key
        // points.
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
        const step = event.shiftKey ? COARSE_STEP : STEP;
        event.preventDefault();
        userResizeRef.current?.();
        if (event.key === "Home") {
          reset();
          return;
        }
        const rect = containerRef.current?.getBoundingClientRect();
        const delta = event.key === "ArrowLeft" ? step : -step;
        setWidth((current) => clamp((current ?? cssWidth ?? 0) + delta, rect?.width));
      },
    }),
    [clamp, containerRef, cssWidth, liveBounds.maxWidth, liveBounds.minWidth, reset, stop, updateFromPointer, width],
  );

  return { width, bounds: liveBounds, resizing, reset, reclamp, separatorProps };
}
