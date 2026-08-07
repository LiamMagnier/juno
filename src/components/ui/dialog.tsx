"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

export const dialogCloseClassName =
  "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground";

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
      "fixed inset-0 z-50 bg-scrim backdrop-blur-sm data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out motion-reduce:animate-none",
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
        "fixed left-[50%] top-[50%] z-50 grid w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] [translate:-50%_-50%] gap-4 overflow-y-auto rounded-panel overlay-glass p-6 data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,transform] duration-fast ease-out-soft hover:bg-accent hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none coarse:h-10 coarse:w-10 motion-reduce:transition-none motion-reduce:active:scale-100">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
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
