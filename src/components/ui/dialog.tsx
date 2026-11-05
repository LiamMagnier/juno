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
 * The dismiss affordance, in one place: `<Pressable kind="icon" size="lg">`
 * like every other bare glyph affordance (36px, 44px on a coarse pointer, a
 * circular tonal fill on hover, the 16px dismiss glyph). `CloseButton` is the
 * drawing for a surface that is not a Radix dialog (the document viewer's
 * split pane); `DialogCloseButton` is the same button wired to `Dialog.Close`
 * (dialogs and sheets alike). `position` is the only thing a call site
 * varies: `static` in a header row (a side sheet, the computer view, the MCP
 * dialog), or the panel's corner. No focus or radius override: the global
 * ring is authoritative and `kind="icon"` is circular by house idiom.
 *
 * `size="md"` (32px, 40 + a 44px hit pad on touch) is only for a close that
 * sits in a row of 32px toolbar buttons (the document viewer, the computer
 * view), so it keeps the row's height; the plate, glyph and hover are the same.
 *
 * `print:hidden`, with the scrim below: a dialog that prints its content (the
 * research report reader) must not print a close glyph in the corner of page
 * one, and there is nothing to dismiss on paper.
 */
export const CloseButton = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentPropsWithoutRef<typeof Pressable>, "kind" | "size" | "children"> & {
    /** The accessible name. "Close" unless the surface needs to say what closes. */
    label?: string;
    size?: "md" | "lg";
  }
>(({ className, label = "Close", size = "lg", ...props }, ref) => (
  <Pressable ref={ref} kind="icon" size={size} className={cn("print:hidden", className)} {...props}>
    <ActionIcons.dismiss className="size-4" aria-hidden="true" />
    <span className="sr-only">{label}</span>
  </Pressable>
));
CloseButton.displayName = "CloseButton";

export const DialogCloseButton = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close> & { label?: string; size?: "md" | "lg" }
>(({ className, label, size, ...props }, ref) => (
  <DialogPrimitive.Close ref={ref} asChild {...props}>
    <CloseButton label={label} size={size} className={cn("absolute right-4 top-4", className)} />
  </DialogPrimitive.Close>
));
DialogCloseButton.displayName = "DialogCloseButton";

/**
 * The scrim. One token (`--scrim`) so a retheme reaches it; the overlay-in/out
 * pair leads on open and trails on close, because a scrim that finishes first
 * leaves a frame of undimmed app behind the panel. The scrim separates the
 * opaque panel from the page without filtering the page behind every dialog.
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
 * PINNED CHROME (dialog.css). The panel is a frame that never scrolls; its
 * content sits in one body that does. So the ✕ and the phone grabber, which
 * belong to the frame, stay put however long the content is, and a
 * `DialogHeader` / `DialogFooter` inside the body is pinned to its top and
 * bottom edge (sticky, on the panel's own fill): the title and the actions
 * stay on screen while the middle scrolls between them. The header keeps a
 * gutter for the ✕, so a long title wraps before it reaches the button, and
 * the ✕ is centred on the title's first line.
 *
 * `bare` is for a dialog that lays out its whole panel itself (its own
 * padding, header bar and scroller: Quick Look, onboarding, the report
 * reader). The frame then draws no padding and no body, which is also why a
 * bare dialog can no longer pick up half of the default padding by accident:
 * a call site's `p-0` used to drop `p-5` but keep `sm:p-6`.
 *
 * Centring lives on the INDEPENDENT `translate` property, not on a
 * translate-x/y utility, so the pop keyframe can own `transform` outright — a
 * scale keyframe writing `transform` would otherwise fling the dialog to the
 * top-left corner mid-animation. It pops in on the spring (modal-in, 220ms)
 * and leaves on the accelerate (modal-out, 160ms); both keyframes read
 * --motion-shift / --motion-scale-from, so the reduced tier cross-fades.
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
    /** The call site lays out the whole panel: no padding and no scrolling body. */
    bare?: boolean;
  }
>(({ className, children, hideClose, sheet = true, bare = false, onCloseAutoFocus, ...props }, ref) => {
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
        data-dialog-layout={bare ? "bare" : "pinned"}
        data-dialog-close={hideClose ? undefined : ""}
        className={cn(
          "ui-dialog overlay-glass fixed left-[50%] top-[50%] z-modal w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] [translate:-50%_-50%] rounded-panel outline-none data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out",
          bare ? "grid gap-4 overflow-y-auto" : "flex flex-col overflow-hidden",
          className
        )}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        {...props}
      >
        {focusReturn.capture}
        {sheet ? <div className="ui-sheet-grabber" data-sheet-handle="" aria-hidden /> : null}
        {bare ? children : <div className="ui-dialog-body">{children}</div>}
        {!hideClose && <DialogCloseButton className="ui-dialog-close" />}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

/** Pinned to the top of the body, with a gutter for the ✕ (dialog.css). */
function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-dialog-header flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />;
}

/** Pinned to the bottom of the body (dialog.css), so the actions never scroll away. */
function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // gap-2 at every width: the stacked mobile layout needs it as much as the row.
  return <div className={cn("ui-dialog-footer flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  // `text-heading` carries 1.125rem / 600 / -0.006em itself. A tracking
  // utility here used to override the token's own letter-spacing.
  <DialogPrimitive.Title ref={ref} className={cn("font-sans text-heading font-semibold", className)} {...props} />
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
