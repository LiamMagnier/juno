"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Pressable } from "@/components/ui/pressable";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

/**
 * The dismiss affordance, in one place.
 *
 * This file used to describe the close button twice. `DialogContent` rendered a
 * 32px `rounded-full` glyph that fills on hover and dips on press; an exported
 * `dialogCloseClassName` described the stock shadcn one — `rounded-sm`,
 * `opacity-70`, and `focus:` rather than `focus-visible:`, so it drew a ring for
 * mouse users too. Consumers that reached for the export therefore got a
 * visibly different close button from every other dialog in the product, on the
 * one control that appears in all of them.
 *
 * Now there is one, built on `<Pressable kind="icon">` like every other bare
 * glyph affordance, and `position` is the only thing a call site can vary —
 * because the only real reason image-edit-overlay forked was that its close sits
 * over a dark image at a different inset, which is a position, not a style.
 */
export const DialogCloseButton = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close ref={ref} asChild {...props}>
    <Pressable kind="icon" size="lg" className={cn("absolute right-4 top-4 rounded-full", className)}>
      <X className="h-4 w-4" />
      <span className="sr-only">Close</span>
    </Pressable>
  </DialogPrimitive.Close>
));
DialogCloseButton.displayName = "DialogCloseButton";

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // The dim is a token, not a raw black literal, so a retheme reaches it and
      // the onboarding scrim can be reconciled with this one. Timing lives in the
      // overlay-in/out pair: the scrim leads on open and trails on close, because
      // a scrim that finishes first leaves a frame of undimmed app behind the panel.
      "fixed inset-0 z-modal bg-scrim backdrop-blur-sm data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out motion-reduce:animate-none",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Same warm-glass chrome as popovers/menus — not a second card material,
        // and now the shared .overlay-glass recipe rather than a sixth copy of it.
        //
        // Centring lives on the INDEPENDENT `translate` property, not on a
        // translate-x/y utility, so the keyframe can own `transform` outright.
        // This is mandatory rather than tidy: the old slide-in-from-*-1/2 pair
        // existed only to cancel the -50%/-50% transform, and a scale-only
        // keyframe writing `transform` would otherwise fling the dialog to the
        // top-left corner mid-animation.
        //
        // A centred dialog has no origin to fly in from, so it scales in place on
        // the modal pair (220 in / 160 out) instead of claiming a direction it
        // does not have. The old 360ms on ease-out-expo spent ~80% of its travel
        // in the first quarter of the time — a lunge, then a crawl; expo needs
        // 440ms or more to read as intended.
        "fixed left-[50%] top-[50%] z-modal grid w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] [translate:-50%_-50%] gap-4 overflow-y-auto rounded-panel overlay-glass p-6 data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      {children}
      {!hideClose && <DialogCloseButton />}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // gap-2, not sm:space-x-2: the spacing was scoped to sm and up, so the STACKED
  // mobile layout had none at all — every destructive confirm in the product put
  // Cancel and Delete edge to edge on a phone.
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  // font-serif here rather than at 19 call sites: a primitive every consumer has
  // to correct is not a primitive. `text-heading` is the token that the old
  // `text-lg font-semibold tracking-tight` triple was approximating by hand.
  <DialogPrimitive.Title ref={ref} className={cn("font-serif text-heading leading-none", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
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
