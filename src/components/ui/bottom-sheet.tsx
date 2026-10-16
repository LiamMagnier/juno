"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { DialogOverlay } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/*
 * The sheet's travel. Its own keyframes because the shared sheet-in/out pair
 * travels on X only. Both read --motion-shift, so under reduced motion (the OS
 * query, or the in-app setting, which also zeroes durations) the sheet fades
 * in place instead of rising: the fade is information, the travel is not. The
 * exit runs on the exit rung and the accelerate, about 0.65 of the entrance.
 *
 * The entrance is `backwards`, not `both`, and only until it has played once
 * (`data-entered`, set on animationend): a filled animation outranks the
 * inline transform a drag writes, and re-adding it after a drag would replay
 * the entrance. While a finger holds the sheet it follows exactly; released
 * short of dismissal, it settles back on the strong decelerate.
 *
 * A string rendered as <style> beside the sheet (the citation audit's idiom)
 * rather than a CSS import, so the component stays importable by the
 * node:test suites that render it.
 */
export const BOTTOM_SHEET_CSS = `
@keyframes juno-bottom-sheet-in {
  from { opacity: 0; transform: translateY(calc(100% * var(--motion-shift, 1))); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes juno-bottom-sheet-out {
  from { opacity: 1; transform: translateY(var(--sheet-drag, 0px)); }
  to { opacity: 0; transform: translateY(calc(100% * var(--motion-shift, 1))); }
}
.juno-bottom-sheet[data-state="open"]:not([data-entered]) { animation: juno-bottom-sheet-in var(--dur-slow) var(--ease-drawer) backwards; }
.juno-bottom-sheet[data-state="closed"] { animation: juno-bottom-sheet-out var(--dur-exit) var(--ease-in) both; }
.juno-bottom-sheet[data-dragging] { transition: none; }
.juno-bottom-sheet[data-settling] { transition: transform var(--dur-base) var(--ease-out-strong); }
`;

/**
 * A sheet that rises from the bottom edge — the phone form of a panel or a
 * small form that would otherwise cover the whole conversation.
 *
 * Radix Dialog underneath, so focus is trapped and handed back, Escape closes
 * it and the page behind is scroll-locked; the scrim is the same token the
 * dialogs use. It never takes the full height: the top of the conversation
 * stays visible above it, which is what tells the reader they have not left.
 *
 * DRAG TO DISMISS. The grabber (and anything a caller marks with
 * `data-sheet-drag`) follows the finger: down freely, up with resistance. On
 * release it closes when it was flung (velocity) or pulled past a third of
 * its height, and otherwise settles back. The exit then continues from where
 * the finger left it (`--sheet-drag`), so a dismissal never jumps.
 *
 * The motion (BOTTOM_SHEET_CSS above) reads --motion-shift, so reduced
 * motion keeps the fade and drops the travel.
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  tall = false,
  initialFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read by screen readers as the dialog's name. Visually hidden: the content draws its own heading. */
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /** A reading surface (a trace, a document): a fixed tall sheet with its own scroller, not one sized to its content. */
  tall?: boolean;
  /** Where focus lands on open. Radix's default is the first focusable element. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  const sheetRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ y: number; t: number; dy: number; id: number } | null>(null);

  const setOffset = (dy: number) => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transform = dy ? `translateY(${dy}px)` : "";
    el.style.setProperty("--sheet-drag", `${Math.max(0, dy)}px`);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || !target.closest("[data-sheet-drag]")) return;
    // A control inside a drag region keeps its own press.
    if (target.closest("button, a, input, textarea, select, [role='button']")) return;
    const el = sheetRef.current;
    if (!el) return;
    el.setAttribute("data-entered", "");
    el.setAttribute("data-dragging", "");
    el.removeAttribute("data-settling");
    drag.current = { y: e.clientY, t: performance.now(), dy: 0, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const raw = e.clientY - d.y;
    // Upward travel is resisted, not refused: the sheet answers the finger
    // either way, which is how a reader learns it can be moved at all.
    d.dy = raw > 0 ? raw : raw * 0.25;
    setOffset(d.dy);
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const el = sheetRef.current;
    el?.removeAttribute("data-dragging");
    const elapsed = Math.max(1, performance.now() - d.t);
    const velocity = d.dy / elapsed;
    const height = el?.offsetHeight ?? 400;
    if (shouldDismissSheet(d.dy, velocity, height)) {
      onOpenChange(false);
      return;
    }
    el?.setAttribute("data-settling", "");
    setOffset(0);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {/* Hoisted into <head> and deduplicated by `href` (React 19), so every
          sheet on the page shares one copy, and it outlives the exit. */}
      <style href="juno-bottom-sheet" precedence="medium">
        {BOTTOM_SHEET_CSS}
      </style>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={sheetRef}
          // No description: say so, rather than leave Radix pointing at none.
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={(e) => {
            if (!initialFocus?.current) return;
            e.preventDefault();
            initialFocus.current.focus({ preventScroll: true });
          }}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget && e.currentTarget.dataset.state === "open") {
              e.currentTarget.setAttribute("data-entered", "");
            }
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          className={cn(
            "juno-bottom-sheet overlay-glass fixed inset-x-0 bottom-0 z-modal flex max-h-[88dvh] flex-col rounded-t-panel border-b-0 pb-safe outline-none",
            tall && "h-[88dvh]",
            className,
          )}
        >
          <VisuallyHidden.Root>
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description>{description}</DialogPrimitive.Description> : null}
          </VisuallyHidden.Root>
          {/* The grabber: a 36×4 pill in a 24px band, which is the part a thumb
              finds. Decorative to assistive tech, which closes with Escape or
              the content's own close control. */}
          <div data-sheet-drag className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing" aria-hidden="true">
            <span className="h-1 w-9 rounded-full bg-muted-foreground/35" />
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Whether a released drag dismisses: a fling (faster than 0.5px/ms downward,
 * over more than a jitter's 24px) or a pull past a third of the sheet. Pure,
 * so the thresholds are tested.
 */
export function shouldDismissSheet(dy: number, velocityPxPerMs: number, height: number): boolean {
  if (dy <= 0) return false;
  return (velocityPxPerMs > 0.5 && dy > 24) || dy > Math.max(80, height / 3);
}
