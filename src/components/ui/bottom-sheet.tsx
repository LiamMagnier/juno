"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * A sheet that rises from the bottom edge — the phone form of a panel or a
 * small form that would otherwise cover the whole conversation.
 *
 * ONE SHEET ENGINE. This used to be a third bottom-sheet implementation, with
 * its own keyframes, its own pointer code and its own numbers: a grabber in a
 * different ink, an 88dvh cap, a 160ms exit where every other sheet sinks in
 * 220, a drag that only started on the grabber, a dismiss threshold of "a
 * third", no keyboard avoidance and no focus return to the opener. It is now
 * the house `SheetContent side="bottom"` (ui/sheet.tsx + sheet.css +
 * sheet-gesture.ts), so it rises, sinks, follows the finger, clears the
 * on-screen keyboard and hands focus back exactly the way a dialog on a phone
 * does. Radix underneath: focus is trapped, Escape closes it, the page behind
 * is scroll-locked, and the scrim is the same token.
 *
 * `tall` is a reading surface (a trace, a document): it takes the sheet's full
 * height, under the same top margin every sheet keeps so the conversation
 * stays visible above it, which is what tells the reader they have not left.
 * The content starts under the grabber's 20px band.
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
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        // A sheet over the conversation dims it at every width it appears at.
        scrim="always"
        title={title}
        // No description: say so, rather than leave Radix pointing at none.
        {...(description ? {} : { "aria-describedby": undefined })}
        onOpenAutoFocus={(e) => {
          if (!initialFocus?.current) return;
          e.preventDefault();
          initialFocus.current.focus({ preventScroll: true });
        }}
        className={cn(
          "flex flex-col pt-5",
          tall && "h-[calc(100dvh-env(safe-area-inset-top,0px)-1.5rem)]",
          className,
        )}
      >
        {description ? (
          <VisuallyHidden.Root>
            <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
          </VisuallyHidden.Root>
        ) : null}
        {children}
      </SheetContent>
    </Sheet>
  );
}
