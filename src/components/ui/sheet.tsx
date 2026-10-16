"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { DialogCloseButton, DialogOverlay } from "@/components/ui/dialog";
import { useDialogFocusReturn } from "@/components/ui/focus-return";
import { useMergedRef, useSwipeDismiss, type SheetKind } from "@/components/ui/sheet-gesture";
import { cn } from "@/lib/utils";

/** A side sheet (Radix Dialog under the hood → focus trap + Escape + scroll lock).
 *  Used for the mobile navigation drawer and the Memory activity panel. */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

/** While a navigation drawer is open, <html> carries this, so the card behind it can parallax (sheet.css). */
export const DRAWER_OPEN_ATTR = "data-drawer-open";

/**
 * `.surface-float` with `rounded-panel` (16) on the INNER edge only — the
 * edge it slides in from stays square against the viewport. It travels on the
 * sheet-in/out keyframes (drawer easing in, accelerate out); `--sheet-from`
 * tells the keyframe which side, and because the keyframe multiplies it by
 * --motion-shift the reduced-motion tier keeps the fade and drops the travel.
 *
 * `scrim` says at which widths the backdrop is drawn. The default, "mobile",
 * carries `md:hidden` for app-shell's nav drawer, which only exists below md.
 * A sheet that opens at every width (the Memory activity panel) passes
 * "always", because it is modal there too.
 *
 * FOLLOWS THE FINGER (G54, sheet-gesture.ts). On a touch screen every sheet
 * can be thrown back where it came from: a side drawer toward its edge, a
 * bottom sheet (`side="bottom"`) downward from its header.
 *
 * THE NAVIGATION DRAWER (spec C9). `drawer` (implied by `edgeSwipe`, which
 * marks the drawer an edge pull opens) sizes it to --drawer-width, dims the
 * page at --drawer-dim (0.12 light, 0.30 dark) instead of the full scrim, and
 * sets html[data-drawer-open] so the shell's [data-drawer-parallax] card
 * travels 0.22 of the way. Tapping outside closes it (Radix). Under reduced
 * motion the card stays still and the drawer cross-fades over it in 220.
 *
 * BOTTOM SHEET KINDS (spec §5.6). `glance` has detents medium and large and a
 * grabber, and opens at medium with half the scrim; `form` is large with a
 * leading ×; `page` is large with no grabber. Nested bottom sheets step the
 * one beneath back 16px.
 */
const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: "left" | "right" | "bottom";
    title?: string;
    scrim?: "mobile" | "always";
    /** An edge pull can open this sheet (useEdgeSwipeOpen). */
    edgeSwipe?: boolean;
    /** The navigation drawer: --drawer-width, the drawer dim and the parallax. Default: `edgeSwipe`. */
    drawer?: boolean;
    /** A bottom sheet's kind (spec §5.6); default `page`. */
    kind?: SheetKind;
  }
>(
  (
    { className, children, side = "left", title = "Navigation", scrim = "mobile", edgeSwipe = false, drawer, kind, onCloseAutoFocus, ...props },
    ref,
  ) => {
    // Focus goes back to whatever opened the sheet — see focus-return.tsx.
    const focusReturn = useDialogFocusReturn(onCloseAutoFocus);
    const scrimRef = React.useRef<HTMLDivElement>(null);
    const isDrawer = side !== "bottom" && (drawer ?? edgeSwipe);
    const sheetKind: SheetKind | undefined = side === "bottom" ? (kind ?? "page") : undefined;
    const swipeRef = useSwipeDismiss({
      axis: side === "bottom" ? "y" : "x",
      sign: side === "left" ? -1 : 1,
      scrimRef,
      kind: sheetKind,
    });
    const localRef = React.useRef<HTMLDivElement | null>(null);
    const panelRef = useMergedRef<HTMLDivElement>(ref, swipeRef, localRef);
    const pullTarget = edgeSwipe ? "" : undefined;

    // The drawer is open from mount until its exit starts: the card behind follows it.
    React.useEffect(() => {
      const panel = localRef.current;
      if (!isDrawer || !panel) return;
      const root = document.documentElement;
      const sync = () => {
        if (panel.getAttribute("data-state") === "closed") root.removeAttribute(DRAWER_OPEN_ATTR);
        else root.setAttribute(DRAWER_OPEN_ATTR, "");
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(panel, { attributes: true, attributeFilter: ["data-state"] });
      return () => {
        observer.disconnect();
        root.removeAttribute(DRAWER_OPEN_ATTR);
      };
    }, [isDrawer]);

    return (
      <DialogPrimitive.Portal>
        <DialogOverlay
          ref={scrimRef}
          data-swipe-scrim=""
          data-sheet-pull-target={pullTarget}
          data-drawer-scrim={isDrawer ? "" : undefined}
          data-sheet-scrim={side === "bottom" ? "" : undefined}
          className={scrim === "mobile" ? "md:hidden" : undefined}
        />
        <DialogPrimitive.Content
          ref={panelRef}
          data-swipe-panel=""
          data-side={side}
          data-drawer={isDrawer ? "" : undefined}
          data-sheet-kind={sheetKind}
          data-sheet-pull-target={pullTarget}
          className={cn(
            "ui-sheet overlay-glass fixed z-modal outline-none",
            side === "bottom"
              ? "inset-x-0 bottom-0 max-h-[calc(100dvh-env(safe-area-inset-top,0px)-1.5rem)] w-full rounded-t-panel border-b-0 pb-safe pl-safe pr-safe"
              : isDrawer
                ? "inset-y-0 h-full pb-safe pt-safe"
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
          {sheetKind === "form" ? <DialogCloseButton className="left-3 right-auto top-3" /> : null}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  }
);
SheetContent.displayName = "SheetContent";

export { Sheet, SheetTrigger, SheetClose, SheetContent };
