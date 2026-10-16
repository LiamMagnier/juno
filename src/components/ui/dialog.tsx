"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ActionIcons } from "@/lib/app-icons";
import { Pressable } from "@/components/ui/pressable";
import { useDialogFocusReturn } from "@/components/ui/focus-return";
import { useMergedRef, useSwipeDismiss } from "@/components/ui/sheet-gesture";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

/**
 * The dismiss affordance, in one place: `<Pressable kind="icon">` like every
 * other bare glyph affordance, and `position` is the only thing a call site
 * can vary (image-edit-overlay's close sits over a dark image at a different
 * inset — a position, not a style). No focus or radius override: the global
 * ring is authoritative and `kind="icon"` is circular by house idiom.
 *
 * `print:hidden`, with the scrim below: a dialog that prints its content (the
 * research report reader) must not print a close glyph in the corner of page
 * one, and there is nothing to dismiss on paper.
 */
export const DialogCloseButton = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close ref={ref} asChild {...props}>
    <Pressable kind="icon" size="lg" className={cn("absolute right-4 top-4 print:hidden", className)}>
      <ActionIcons.dismiss className="size-4" />
      <span className="sr-only">Close</span>
    </Pressable>
  </DialogPrimitive.Close>
));
DialogCloseButton.displayName = "DialogCloseButton";

/**
 * The scrim. One token (`--scrim`) so a retheme reaches it; the overlay-in/out
 * pair leads on open and trails on close, because a scrim that finishes first
 * leaves a frame of undimmed app behind the panel. No blur (spec D15: no
 * backdrop-filter in product chrome); the tone of the scrim carries the depth.
 * No `motion-reduce:animate-none`: overlay-in/out are opacity-only, and Tier A
 * of the reduced-motion policy (globals.css) keeps opacity.
 */
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-modal bg-scrim data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out print:hidden",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * The panel is `.overlay-glass` at `rounded-panel` (16): opaque, because a
 * dialog holds content that has to be read, and glass is for chrome.
 *
 * Centring lives on the INDEPENDENT `translate` property, not on a
 * translate-x/y utility, so the pop keyframe can own `transform` outright — a
 * scale keyframe writing `transform` would otherwise fling the dialog to the
 * top-left corner mid-animation. It enters as an infrequent overlay (spec C7,
 * sheet.css): 220 on the standard spring from 0.97, out over 160 to 0.98, and
 * opacity only when opened from the keyboard or under reduced motion.
 *
 * ON A PHONE IT IS A SHEET (G54). Below 640px a centred card floats out of
 * the thumb's reach, so the dialog rises from the bottom edge instead, full
 * width, with a grabber, and is thrown back down to dismiss (a flick or a
 * long enough pull; sheet-gesture.ts). The layout lives in sheet.css, keyed
 * on `data-phone-sheet`, so every dialog gets it without restating classes.
 * `sheet={false}` keeps a dialog that already owns the whole phone screen
 * (Settings, the report reader) or sits under the keyboard (the palette).
 */
const PHONE_SHEET = "(max-width: 639.98px)";
const phoneSheetNow = () => typeof window !== "undefined" && window.matchMedia(PHONE_SHEET).matches;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    hideClose?: boolean;
    /** Below 640px, rise from the bottom as a sheet (default). */
    sheet?: boolean;
  }
>(({ className, children, hideClose, sheet = true, onCloseAutoFocus, ...props }, ref) => {
  // Focus goes back to whatever opened the dialog, not only to a
  // <DialogTrigger> — see focus-return.tsx.
  const focusReturn = useDialogFocusReturn(onCloseAutoFocus);
  const scrimRef = React.useRef<HTMLDivElement>(null);
  const swipeRef = useSwipeDismiss({ axis: "y", sign: 1, scrimRef, enabled: () => sheet && phoneSheetNow() });
  const panelRef = useMergedRef<HTMLDivElement>(ref, swipeRef);
  return (
    <DialogPortal>
      <DialogOverlay ref={scrimRef} data-swipe-scrim="" />
      <DialogPrimitive.Content
        ref={panelRef}
        data-swipe-panel=""
        data-phone-sheet={sheet ? "" : undefined}
        className={cn(
          "ui-dialog overlay-glass fixed left-[50%] top-[50%] z-modal grid w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] [translate:-50%_-50%] gap-4 overflow-y-auto rounded-panel p-5 outline-none ui-overlay-infrequent sm:p-6",
          className
        )}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        {...props}
      >
        {focusReturn.capture}
        {sheet ? <div className="ui-sheet-grabber" data-sheet-handle="" aria-hidden /> : null}
        {children}
        {!hideClose && <DialogCloseButton />}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // gap-2 at every width: the stacked mobile layout needs it as much as the row.
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  // `text-heading` carries 1.125rem / 600 / -0.006em itself.
  <DialogPrimitive.Title ref={ref} className={cn("font-sans text-heading", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-body text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
