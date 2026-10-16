"use client";

import * as React from "react";
import {
  dragOffset,
  inSheetDragZone,
  mediumDetentOffset,
  releaseDetent,
  rubberBand,
  SHEET_DRAG_ZONE_PX,
  type SheetDetent,
  gestureIntent,
  keyboardInset,
  pushSample,
  settleMs,
  shouldDismiss,
  shouldOpen,
  startsAtEdge,
  velocityOf,
  type VelocitySample,
} from "@/lib/sheet-gesture";

/*
 * SHEETS THAT FOLLOW THE FINGER (G54): the DOM half of lib/sheet-gesture.ts.
 *
 *   useSwipeDismiss   a bottom sheet dragged down, or a side drawer dragged
 *                     back to its edge, follows the finger and goes on a
 *                     flick or a long enough pull; otherwise it springs home.
 *   useEdgeSwipeOpen  a pull from the screen's edge brings the drawer in
 *                     under the finger, as ChatGPT's and Claude's apps do.
 *
 * Both write styles straight onto the panel (no React render per frame) and
 * talk to sheet.css through one attribute, `data-gesture`, on the panel and
 * its scrim:
 *
 *   drag    the finger owns the transform; no animation, no transition
 *   settle  finishing the move the finger started (a transition)
 *   held    open after a gesture: the entrance keyframe must not replay
 *           while it stays open (it plays its exit normally on close)
 *   gone    thrown away: no exit keyframe, so it leaves from where it is
 *
 * A dismissal is an Escape: the panel dispatches the key, so a dialog that
 * refuses Escape (a save in flight) refuses the swipe too, and the sheet
 * comes back. Callers that own their open state pass `onDismiss` instead.
 *
 * A bottom sheet also rides above the on-screen keyboard: the keyboard
 * shrinks only the visual viewport, so the sheet's `bottom` is lifted by what
 * it covers (`--sheet-keyboard`, with `data-keyboard` while it is up).
 *
 * Touch scrolls first: a drag starts only when the content under the finger
 * is already at its top (or its edge, for a drawer), and never from a field,
 * a slider or anything marked `data-sheet-no-drag`. A mouse or pen can drag
 * from the grabber (`data-sheet-handle`), which is how the sheet is tried at
 * a narrow desktop window.
 */

type Axis = "x" | "y";

const NO_DRAG = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='slider'], [data-sheet-no-drag]";

function noDrag(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest(NO_DRAG);
  if (!field) return false;
  // A checkbox or a button-like input is pressed, not typed into.
  if (field instanceof HTMLInputElement && ["checkbox", "radio", "button", "submit", "reset"].includes(field.type)) return false;
  return true;
}

/**
 * Whether anything between the touch and the panel can still scroll the way
 * the finger is pulling, in which case the pull is a scroll, not a drag.
 */
function scrollsFirst(target: EventTarget | null, panel: HTMLElement, axis: Axis, sign: 1 | -1): boolean {
  let node = target instanceof Element ? target : null;
  while (node) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node);
      if (axis === "y") {
        const scrolls = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
        // Pulling down (sign +1) scrolls content up until it is at its top.
        if (scrolls && (sign > 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1)) return true;
      } else {
        const scrolls = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
        const left = Math.abs(node.scrollLeft);
        const max = node.scrollWidth - node.clientWidth;
        // Pulling left (sign -1) scrolls content toward its right end.
        if (scrolls && (sign < 0 ? left < max - 1 : left > 0)) return true;
      }
    }
    if (node === panel) break;
    node = node.parentElement;
  }
  return false;
}

function translate(axis: Axis, px: number): string {
  return axis === "y" ? `translate3d(0, ${px}px, 0)` : `translate3d(${px}px, 0, 0)`;
}

function setGesture(el: HTMLElement | null | undefined, value: "drag" | "settle" | "held" | "gone" | null) {
  if (!el) return;
  if (value) el.setAttribute("data-gesture", value);
  else el.removeAttribute("data-gesture");
}

function escapeFrom(panel: HTMLElement) {
  panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}

export type SheetKind = "glance" | "form" | "page";

export interface SwipeDismissOptions {
  /** The axis the panel leaves on. */
  axis: Axis;
  /** Toward dismissal: +1 down or right, -1 up or left. */
  sign: 1 | -1;
  /** Checked at each touch: a sheet that is only a sheet on a phone passes a width test. */
  enabled?: () => boolean;
  /** The scrim behind the panel, which fades with the pull. */
  scrimRef?: React.RefObject<HTMLElement | null>;
  /** Close the panel. Default: an Escape from the panel (see above). */
  onDismiss?: () => void;
  /**
   * A bottom sheet's kind (spec §5.6). A `glance` sheet has two detents and
   * opens at medium; `form` and `page` open at large and have one.
   */
  kind?: SheetKind;
}

/* ——— Nested sheets (spec C8): every open bottom sheet under the top one steps back 16px ——— */

const sheetStack: HTMLElement[] = [];

function restack() {
  sheetStack.forEach((panel, i) => {
    if (i < sheetStack.length - 1) panel.setAttribute("data-sheet-covered", "");
    else panel.removeAttribute("data-sheet-covered");
  });
}

/** Registers an open bottom sheet; returns its removal. Exported for tests. */
export function pushSheet(panel: HTMLElement): () => void {
  sheetStack.push(panel);
  restack();
  return () => {
    const i = sheetStack.indexOf(panel);
    if (i >= 0) sheetStack.splice(i, 1);
    panel.removeAttribute("data-sheet-covered");
    restack();
  };
}

/** The scroll container a touch landed in, inside the panel, if any. */
function scrollBodyOf(target: EventTarget | null, panel: HTMLElement): HTMLElement | null {
  let node = target instanceof Element ? target : null;
  while (node && node !== panel) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Drag-to-dismiss for a sheet. Returns a ref callback for the panel; compose
 * it with any ref the panel already has.
 *
 * A bottom sheet drags only from its 44px header or the first 44px of a body
 * scrolled to the top (spec C8); a side drawer drags from anywhere along its
 * axis. On release it dismisses at 0.5px/ms or 30% of its travel, otherwise it
 * settles back over clamp(remaining / |v|, 140, 300)ms on --ease-drawer (D18).
 * A glance sheet moves between its medium and large detents the same way.
 */
export function useSwipeDismiss({ axis, sign, enabled, scrimRef, onDismiss, kind }: SwipeDismissOptions): (node: HTMLElement | null) => void {
  const [panel, setPanel] = React.useState<HTMLElement | null>(null);
  const options = React.useRef({ enabled, scrimRef, onDismiss });
  options.current = { enabled, scrimRef, onDismiss };
  const bottom = axis === "y" && sign > 0;
  const detents = bottom && kind === "glance";

  // An open bottom sheet joins the stack; the one under it steps back.
  React.useEffect(() => {
    if (!panel || !bottom) return;
    return pushSheet(panel);
  }, [panel, bottom]);

  React.useEffect(() => {
    if (!panel) return;
    let start: { x: number; y: number; target: EventTarget | null } | null = null;
    let origin = 0;
    let dragging = false;
    let size = 1;
    let offset = 0;
    let samples: VelocitySample[] = [];
    let timer = 0;
    let pointerId: number | null = null;
    let detent: SheetDetent | null = detents ? "medium" : null;
    let detentPx = 0;

    const scrim = () => options.current.scrimRef?.current ?? null;
    const along = (x: number, y: number) => (axis === "x" ? x : y);
    /** The height on screen: the panel less the medium detent's push-down. */
    const visible = () => Math.max(1, size - (detent === "medium" ? detentPx : 0));

    const writeDetent = () => {
      if (!detent) return;
      detentPx = mediumDetentOffset(panel.offsetHeight, window.innerHeight);
      panel.style.setProperty("--sheet-detent-offset", `${detentPx}px`);
      panel.setAttribute("data-detent", detent);
      scrim()?.setAttribute("data-detent", detent);
    };
    writeDetent();
    const onResize = () => writeDetent();
    if (detents) window.addEventListener("resize", onResize);

    const apply = (px: number) => {
      offset = px;
      panel.style.transform = translate(axis, px * sign);
      const s = scrim();
      if (s) s.style.opacity = String(Math.min(1, Math.max(0, 1 - Math.max(0, px) / visible())));
    };

    const clearInline = () => {
      panel.style.transform = "";
      panel.style.transition = "";
      const s = scrim();
      if (s) {
        s.style.opacity = "";
        s.style.transition = "";
      }
    };

    /** Settles the panel at rest (offset 0) from wherever the finger left it. */
    const springBack = (velocity: number) => {
      const ms = settleMs(offset, velocity);
      setGesture(panel, "settle");
      setGesture(scrim(), "settle");
      panel.style.transition = `transform ${ms}ms var(--ease-drawer)`;
      const s = scrim();
      if (s) s.style.transition = `opacity ${ms}ms var(--ease-drawer)`;
      apply(0);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        clearInline();
        // Still open, and its entrance already played: hold it, never replay.
        setGesture(panel, "held");
        setGesture(scrim(), "held");
      }, ms + 20);
    };

    /** Moves a glance sheet to `next` without a visible jump, then settles there. */
    const moveToDetent = (next: SheetDetent, velocity: number) => {
      const before = detent === "medium" ? detentPx : 0;
      detent = next;
      panel.style.transition = "none";
      const s = scrim();
      if (s) s.style.transition = "none";
      writeDetent();
      const after = next === "medium" ? detentPx : 0;
      // Same place on screen: the detent's translate changed by (after − before).
      apply(offset + before - after);
      void panel.offsetHeight;
      springBack(velocity);
    };

    const throwAway = (velocity: number) => {
      const remaining = visible() - offset;
      const ms = settleMs(remaining, velocity);
      setGesture(panel, "settle");
      setGesture(scrim(), "settle");
      panel.style.transition = `transform ${ms}ms var(--ease-drawer)`;
      const s = scrim();
      if (s) s.style.transition = `opacity ${ms}ms var(--ease-drawer)`;
      apply(visible() + 24);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setGesture(panel, "gone");
        setGesture(scrim(), "gone");
        const dismiss = options.current.onDismiss;
        if (dismiss) return dismiss();
        escapeFrom(panel);
        // A dialog that refused the Escape is still mounted and still open: bring it back.
        timer = window.setTimeout(() => {
          if (panel.isConnected && panel.getAttribute("data-state") === "open") springBack(0);
        }, 250);
      }, ms);
    };

    const begin = (x: number, y: number) => {
      dragging = true;
      origin = along(x, y);
      size = Math.max(1, axis === "y" ? panel.offsetHeight : panel.offsetWidth);
      samples = [{ at: 0, t: performance.now() }];
      window.clearTimeout(timer);
      setGesture(panel, "drag");
      setGesture(scrim(), "drag");
      panel.style.transition = "none";
      const s = scrim();
      if (s) s.style.transition = "none";
    };

    const move = (x: number, y: number) => {
      const travel = (along(x, y) - origin) * sign;
      samples = pushSample(samples, { at: travel, t: performance.now() });
      // At the medium detent a pull up follows the finger to large, then resists.
      if (detent === "medium" && travel < 0) {
        apply(travel >= -detentPx ? travel : -detentPx + rubberBand(travel + detentPx));
        return;
      }
      apply(dragOffset(travel));
    };

    const end = () => {
      if (!dragging) return;
      dragging = false;
      start = null;
      const velocity = velocityOf(samples);
      if (detent) {
        const next = releaseDetent({ detent, offset, velocity, detentOffset: detentPx, visible: visible() });
        if (next === "dismiss") throwAway(velocity);
        else if (next !== detent) moveToDetent(next, velocity);
        else springBack(velocity);
        return;
      }
      if (shouldDismiss({ offset, size, velocity })) throwAway(velocity);
      else springBack(velocity);
    };

    const zoneAllows = (target: EventTarget | null, y: number) => {
      if (axis !== "y") return true;
      const body = scrollBodyOf(target, panel);
      return inSheetDragZone({
        y,
        panelTop: panel.getBoundingClientRect().top,
        body: body ? { top: body.getBoundingClientRect().top, scrollTop: body.scrollTop } : null,
      });
    };

    const onTouchStart = (event: TouchEvent) => {
      start = null;
      if (event.touches.length !== 1 || dragging) return;
      if (options.current.enabled && !options.current.enabled()) return;
      if (noDrag(event.target)) return;
      const touch = event.touches[0];
      if (!zoneAllows(event.target, touch.clientY)) return;
      start = { x: touch.clientX, y: touch.clientY, target: event.target };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!start || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!dragging) {
        // A glance sheet at medium can also be pulled up, toward large.
        const upAllowed = detent === "medium" && touch.clientY < start.y;
        const intent = upAllowed ? gestureIntent(touch.clientX - start.x, start.y - touch.clientY, axis, 1) : gestureIntent(touch.clientX - start.x, touch.clientY - start.y, axis, sign);
        if (intent === null) return;
        if (intent === "ignore" || (!upAllowed && scrollsFirst(start.target, panel, axis, sign))) {
          start = null;
          return;
        }
        begin(touch.clientX, touch.clientY);
      }
      // The page behind is scroll-locked; this stops the sheet's own content
      // from scrolling under a finger that is moving the sheet.
      if (event.cancelable) event.preventDefault();
      move(touch.clientX, touch.clientY);
    };

    const onTouchEnd = () => {
      if (dragging) end();
      start = null;
    };

    // A mouse or pen drags from the grabber, or a bottom sheet's header zone.
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      if (!(event.target instanceof Element)) return;
      const handle = event.target.closest("[data-sheet-handle], [data-sheet-drag]") !== null && !event.target.closest("button, a, [role='button']");
      const header = bottom && !noDrag(event.target) && !event.target.closest("button, a, [role='button']") && zoneAllows(event.target, event.clientY) && event.clientY - panel.getBoundingClientRect().top <= SHEET_DRAG_ZONE_PX;
      if (!handle && !header) return;
      if (options.current.enabled && !options.current.enabled()) return;
      pointerId = event.pointerId;
      panel.setPointerCapture?.(event.pointerId);
      begin(event.clientX, event.clientY);
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pointerId !== event.pointerId || !dragging) return;
      move(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      end();
    };

    // A bottom sheet keeps its fields above the keys (lib/sheet-gesture.ts keyboardInset).
    const viewport = bottom ? window.visualViewport : null;
    const lift = () => {
      if (!viewport) return;
      const on = !options.current.enabled || options.current.enabled();
      const inset = on
        ? keyboardInset({ layoutHeight: window.innerHeight, viewportHeight: viewport.height, viewportTop: viewport.offsetTop, scale: viewport.scale })
        : 0;
      if (inset > 0) {
        panel.style.setProperty("--sheet-keyboard", `${inset}px`);
        panel.setAttribute("data-keyboard", "");
        // A field needs the room: a glance sheet goes large while the keys are up.
        if (detent === "medium") moveToDetent("large", 0);
      } else {
        panel.style.removeProperty("--sheet-keyboard");
        panel.removeAttribute("data-keyboard");
      }
    };
    lift();
    viewport?.addEventListener("resize", lift);
    viewport?.addEventListener("scroll", lift);

    panel.addEventListener("touchstart", onTouchStart, { passive: true });
    panel.addEventListener("touchmove", onTouchMove, { passive: false });
    panel.addEventListener("touchend", onTouchEnd);
    panel.addEventListener("touchcancel", onTouchEnd);
    panel.addEventListener("pointerdown", onPointerDown);
    panel.addEventListener("pointermove", onPointerMove);
    panel.addEventListener("pointerup", onPointerUp);
    panel.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.clearTimeout(timer);
      if (detents) window.removeEventListener("resize", onResize);
      viewport?.removeEventListener("resize", lift);
      viewport?.removeEventListener("scroll", lift);
      panel.removeEventListener("touchstart", onTouchStart);
      panel.removeEventListener("touchmove", onTouchMove);
      panel.removeEventListener("touchend", onTouchEnd);
      panel.removeEventListener("touchcancel", onTouchEnd);
      panel.removeEventListener("pointerdown", onPointerDown);
      panel.removeEventListener("pointermove", onPointerMove);
      panel.removeEventListener("pointerup", onPointerUp);
      panel.removeEventListener("pointercancel", onPointerUp);
    };
  }, [panel, axis, sign, bottom, detents]);

  return setPanel;
}

export interface EdgeSwipeOptions {
  /** Listen at all (a phone-width layout). */
  enabled: boolean;
  /** Checked when a touch lands: false while the drawer is already open. */
  canStart?: () => boolean;
  /** The screen edge the drawer lives on. */
  edge: "left" | "right";
  /** The drawer's open width in px, read when the pull starts. */
  width: () => number;
  /** Mount the drawer: the pull drives it from its first frame (sheet.css). */
  onOpen: () => void;
  /** The pull fell short: unmount it again. */
  onCancel: () => void;
}

const PULL_ATTR = "data-sheet-pull";

/** A dialog or sheet is already open: its own gestures own the screen, the drawer stays put. */
function modalOpen(): boolean {
  return document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']") !== null;
}

/**
 * A pull from the screen's edge opens the drawer under the finger. The drawer
 * (a SheetContent with `edgeSwipe`) is mounted on the first frame of the pull
 * and positioned from two variables on <html>, so it is under the finger
 * before React has even painted it; on release it settles open or slides
 * back out and unmounts.
 *
 * On iOS Safari (not the installed app) the very edge also belongs to the
 * browser's own Back swipe; when Safari takes the touch, it cancels it, and
 * the drawer goes back.
 */
export function useEdgeSwipeOpen({ enabled, canStart, edge, width, onOpen, onCancel }: EdgeSwipeOptions) {
  const callbacks = React.useRef({ canStart, width, onOpen, onCancel });
  callbacks.current = { canStart, width, onOpen, onCancel };

  React.useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const sign: 1 | -1 = edge === "left" ? 1 : -1;
    let start: { x: number; y: number; target: EventTarget | null } | null = null;
    let pulling = false;
    let w = 280;
    let travel = 0;
    let samples: VelocitySample[] = [];
    let frame = 0;
    let timer = 0;

    const targets = () => Array.from(document.querySelectorAll<HTMLElement>("[data-sheet-pull-target]"));

    const paint = () => {
      frame = 0;
      const x = sign > 0 ? travel - w : w - travel;
      root.style.setProperty("--sheet-pull-x", `${x}px`);
      root.style.setProperty("--sheet-pull-progress", String(travel / w));
    };

    const release = () => {
      root.removeAttribute(PULL_ATTR);
      root.style.removeProperty("--sheet-pull-x");
      root.style.removeProperty("--sheet-pull-progress");
      root.style.removeProperty("--sheet-pull-ms");
    };

    const settle = (open: boolean, velocity: number) => {
      pulling = false;
      start = null;
      if (frame) cancelAnimationFrame(frame);
      const ms = settleMs(open ? w - travel : travel, velocity);
      root.style.setProperty("--sheet-pull-ms", `${ms}ms`);
      root.setAttribute(PULL_ATTR, "settle");
      travel = open ? w : 0;
      paint();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (open) {
          // Hold the entrance keyframe off before the variables go, or it replays.
          for (const el of targets()) setGesture(el, "held");
          release();
          return;
        }
        for (const el of targets()) setGesture(el, "gone");
        callbacks.current.onCancel();
        // Let it unmount where it is before the variables stop holding it there.
        requestAnimationFrame(() => requestAnimationFrame(release));
      }, ms + 20);
    };

    const onTouchStart = (event: TouchEvent) => {
      start = null;
      if (event.touches.length !== 1 || pulling) return;
      const touch = event.touches[0];
      if (!startsAtEdge(touch.clientX, window.innerWidth, edge) || noDrag(event.target)) return;
      if ((callbacks.current.canStart && !callbacks.current.canStart()) || modalOpen()) return;
      start = { x: touch.clientX, y: touch.clientY, target: event.target };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!start || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      if (!pulling) {
        const intent = gestureIntent(dx, touch.clientY - start.y, "x", sign);
        if (intent === null) return;
        // A row that can still scroll back toward the edge (the home's chips) scrolls instead.
        if (intent === "ignore" || scrollsFirst(start.target, document.documentElement, "x", sign)) {
          start = null;
          return;
        }
        pulling = true;
        w = Math.max(1, callbacks.current.width());
        // Measure from here, so the drawer does not jump by the slop.
        start = { x: touch.clientX, y: touch.clientY, target: start.target };
        travel = 0;
        samples = [{ at: 0, t: performance.now() }];
        window.clearTimeout(timer);
        root.setAttribute(PULL_ATTR, "drag");
        paint();
        callbacks.current.onOpen();
      }
      if (event.cancelable) event.preventDefault();
      const raw = (touch.clientX - start.x) * sign;
      travel = Math.min(w, Math.max(0, raw));
      samples = pushSample(samples, { at: raw, t: performance.now() });
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const onTouchEnd = () => {
      if (!pulling) {
        start = null;
        return;
      }
      const velocity = velocityOf(samples);
      settle(shouldOpen({ progress: travel / w, velocity }), velocity);
    };

    const onTouchCancel = () => {
      if (pulling) settle(false, 0);
      start = null;
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
    document.addEventListener("touchcancel", onTouchCancel);
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchCancel);
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      if (pulling) release();
    };
  }, [enabled, edge]);
}

/** Merge refs onto one node (the panel's forwarded ref and the gesture's). */
export function useMergedRef<T>(...refs: Array<React.Ref<T> | undefined>): (node: T | null) => void {
  // The callback changes only when one of the refs does (callers pass a fixed
  // number of them), so React does not detach and reattach it every render.
  return React.useCallback(
    (node: T | null) => {
      for (const ref of refs) {
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    refs,
  );
}
