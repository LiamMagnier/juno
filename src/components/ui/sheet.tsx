"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { DialogOverlay } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** A side sheet (Radix Dialog under the hood → focus trap + Escape + scroll lock).
 *  Used for the mobile navigation drawer. */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

/**
 * `.surface-float` with `rounded-panel` (20) on the INNER edge only — the
 * edge it slides in from stays square against the viewport. It travels on the
 * sheet-in/out keyframes (drawer easing in, accelerate out); `--sheet-from`
 * tells the keyframe which side, and because the keyframe multiplies it by
 * --motion-shift the reduced-motion tier keeps the fade and drops the travel
 * — which tailwindcss-animate's slide-in-from-* could never do.
 *
 * The scrim carries `md:hidden` because the only mount site is app-shell's
 * mobile nav: unqualified, rotating a tablet with the drawer open dimmed the
 * whole page behind an invisible, still-focus-trapped panel.
 */
const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: "left" | "right"; title?: string }
>(({ className, children, side = "left", title = "Navigation", ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogOverlay className="md:hidden" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "surface-float fixed inset-y-0 z-modal h-full w-[280px] max-w-[85vw] pb-safe pt-safe outline-none data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out",
        side === "left"
          ? "left-0 rounded-r-panel border-l-0 pl-safe [--sheet-from:-100%]"
          : "right-0 rounded-l-panel border-r-0 pr-safe [--sheet-from:100%]",
        className
      )}
      {...props}
    >
      <VisuallyHidden.Root>
        <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
      </VisuallyHidden.Root>
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";

export { Sheet, SheetTrigger, SheetClose, SheetContent };
