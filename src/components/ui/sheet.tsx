"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { DialogOverlay } from "@/components/ui/dialog";
import { useDialogFocusReturn } from "@/components/ui/focus-return";
import { useMergedRef, useSwipeDismiss } from "@/components/ui/sheet-gesture";
import { cn } from "@/lib/utils";

/** A side sheet (Radix Dialog under the hood → focus trap + Escape + scroll lock).
 *  Used for the mobile navigation drawer and the Memory activity panel. */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

/**
 * `.surface-float` with `rounded-panel` (16) on the INNER edge only — the
 * edge it slides in from stays square against the viewport. It travels on the
 * sheet-in/out keyframes (drawer easing in, accelerate out); `--sheet-from`
 * tells the keyframe which side, and because the keyframe multiplies it by
 * --motion-shift the reduced-motion tier keeps the fade and drops the travel
 * — which tailwindcss-animate's slide-in-from-* could never do.
 *
 * `scrim` says at which widths the backdrop is drawn. The default, "mobile",
 * carries `md:hidden` for app-shell's nav drawer, which only exists below md:
 * unqualified, rotating a tablet with the drawer open dimmed the whole page
 * behind an invisible, still-focus-trapped panel. A sheet that opens at every
 * width (the Memory activity panel) passes "always", because it is modal
 * there too: focus is trapped, the page is scroll-locked, and a click on the
 * page only closes the sheet. Without a scrim the page behind looks live.
 *
 * FOLLOWS THE FINGER (G54, sheet-gesture.ts). On a touch screen every sheet
 * can be thrown back where it came from: a side drawer toward its edge, a
 * bottom sheet (`side="bottom"`, with its grabber) downward. `edgeSwipe`
 * marks the drawer an edge pull opens (app-shell's navigation), so the pull
 * can position it from its first frame.
 */
const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: "left" | "right" | "bottom";
    title?: string;
    scrim?: "mobile" | "always";
    /** An edge pull can open this sheet (useEdgeSwipeOpen). */
    edgeSwipe?: boolean;
  }
>(({ className, children, side = "left", title = "Navigation", scrim = "mobile", edgeSwipe = false, onCloseAutoFocus, ...props }, ref) => {
  // Focus goes back to whatever opened the sheet — see focus-return.tsx.
  const focusReturn = useDialogFocusReturn(onCloseAutoFocus);
  const scrimRef = React.useRef<HTMLDivElement>(null);
  const swipeRef = useSwipeDismiss({
    axis: side === "bottom" ? "y" : "x",
    sign: side === "left" ? -1 : 1,
    scrimRef,
  });
  const panelRef = useMergedRef<HTMLDivElement>(ref, swipeRef);
  const pullTarget = edgeSwipe ? "" : undefined;
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay
        ref={scrimRef}
        data-swipe-scrim=""
        data-sheet-pull-target={pullTarget}
        className={scrim === "mobile" ? "md:hidden" : undefined}
      />
      <DialogPrimitive.Content
        ref={panelRef}
        data-swipe-panel=""
        data-side={side}
        data-sheet-pull-target={pullTarget}
        className={cn(
          "ui-sheet overlay-glass fixed z-modal outline-none",
          side === "bottom"
            ? "inset-x-0 bottom-0 max-h-[calc(100dvh-env(safe-area-inset-top,0px)-1.5rem)] w-full rounded-t-panel border-b-0 pb-safe pl-safe pr-safe"
            : "inset-y-0 h-full w-[280px] max-w-[85vw] pb-safe pt-safe data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out",
          side === "left" && "left-0 rounded-r-panel border-l-0 pl-safe [--sheet-from:-100%]",
          side === "right" && "right-0 rounded-l-panel border-r-0 pr-safe [--sheet-from:100%]",
          className
        )}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        {...props}
      >
        {focusReturn.capture}
        <VisuallyHidden.Root>
          <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
        </VisuallyHidden.Root>
        {side === "bottom" ? <div className="ui-sheet-grabber" data-sheet-handle="" aria-hidden /> : null}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
SheetContent.displayName = "SheetContent";

export { Sheet, SheetTrigger, SheetClose, SheetContent };
