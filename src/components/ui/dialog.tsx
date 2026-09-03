"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ActionIcons } from "@/lib/app-icons";
import { Pressable } from "@/components/ui/pressable";
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
 */
export const DialogCloseButton = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close ref={ref} asChild {...props}>
    <Pressable kind="icon" size="lg" className={cn("absolute right-4 top-4", className)}>
      <ActionIcons.dismiss className="size-4" />
      <span className="sr-only">Close</span>
    </Pressable>
  </DialogPrimitive.Close>
));
DialogCloseButton.displayName = "DialogCloseButton";

/**
 * The scrim. One token (`--scrim`) so a retheme reaches it; the overlay-in/out
 * pair leads on open and trails on close, because a scrim that finishes first
 * leaves a frame of undimmed app behind the panel. The 2px backdrop blur is
 * the depth cue that says "pushed back" where opacity alone reads as a film.
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
      "fixed inset-0 z-modal bg-scrim backdrop-blur-[2px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * The panel is `.surface-float` at `rounded-panel` (20) — opaque, because a
 * dialog holds content that has to be read, and glass is for chrome.
 *
 * Centring lives on the INDEPENDENT `translate` property, not on a
 * translate-x/y utility, so the pop keyframe can own `transform` outright — a
 * scale keyframe writing `transform` would otherwise fling the dialog to the
 * top-left corner mid-animation. It pops in on the spring (modal-in, 220ms)
 * and leaves on the accelerate (modal-out, 160ms); both keyframes read
 * --motion-shift / --motion-scale-from, so the reduced tier cross-fades.
 */
const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "surface-float fixed left-[50%] top-[50%] z-modal grid w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] [translate:-50%_-50%] gap-4 overflow-y-auto rounded-panel p-5 outline-none data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out sm:p-6",
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
