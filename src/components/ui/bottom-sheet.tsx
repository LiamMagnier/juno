"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import type { SheetKind } from "@/components/ui/sheet-gesture";
import { cn } from "@/lib/utils";

/**
 * A sheet that rises from the bottom edge — the phone form of a panel or a
 * small form that would otherwise cover the whole conversation.
 *
 * It is a `SheetContent side="bottom"` (ui/sheet.tsx), so it shares the one
 * gesture module (ui/sheet-gesture.ts, spec O7: no second gesture module):
 * Radix Dialog underneath (focus trapped and handed back, Escape closes, the
 * page scroll-locked), a drag from the 44px header or the top of a scrolled
 * body, dismissal at 0.5px/ms or 30% of its travel, the D18 settle otherwise,
 * and the 220 ease-in exit with the scrim fading in step.
 *
 * By default it is a `glance` sheet (spec §5.6): it opens at the medium detent
 * with half the scrim when its content is taller than half the screen, and a
 * pull up takes it to large. A short sheet simply sits at its own height.
 *
 * `[data-sheet-drag]` inside the content (a panel's own header) is a handle
 * too, so a mouse or pen can drag from it.
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  tall = false,
  kind = "glance",
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
  /** The sheet grammar's kind (spec §5.6). */
  kind?: SheetKind;
  /** Where focus lands on open. Radix's default is the first focusable element. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        kind={kind}
        scrim="always"
        title={title}
        // No description: say so, rather than leave Radix pointing at none.
        {...(description ? {} : { "aria-describedby": undefined })}
        onOpenAutoFocus={(e) => {
          if (!initialFocus?.current) return;
          e.preventDefault();
          initialFocus.current.focus({ preventScroll: true });
        }}
        className={cn("flex max-h-[88dvh] flex-col pt-6", tall && "h-[88dvh]", className)}
      >
        {description ? <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description> : null}
        {children}
      </SheetContent>
    </Sheet>
  );
}
