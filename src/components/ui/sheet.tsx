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

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: "left" | "right"; title?: string }
>(({ className, children, side = "left", title = "Navigation", ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/* Shared scrim — a sheet and a dialog must read as the same product. It
        carries the drawer's own md:hidden (the only mount site is app-shell's
        mobile nav): unqualified, rotating a tablet or resizing with the drawer
        open dimmed the whole page behind an invisible, still-focus-trapped panel. */}
    <DialogOverlay className="md:hidden" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // 220 in / 160 out. The drawer travels 280px, which wants ~240ms, so the
        // old 360ms was a third too slow — and its 220ms exit outlasted the
        // scrim's, so the panel finished sliding over an already-undimmed page.
        // ease-out-expo was also running below its ~440ms floor.
        "fixed inset-y-0 z-modal h-full w-[280px] max-w-[85vw] border-sidebar-border bg-sidebar pb-safe pt-safe shadow-float outline-none duration-base ease-out-strong data-[state=closed]:duration-exit data-[state=closed]:ease-in data-[state=open]:animate-in data-[state=closed]:animate-out",
        side === "left"
          ? "left-0 border-r pl-safe data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
          : "right-0 border-l pr-safe data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
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
