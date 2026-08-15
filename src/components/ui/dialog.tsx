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
    <Pressable
      kind="icon"
      size="lg"
      // No focus override. `focus-visible:outline-foreground/45` dimmed the
      // global ring's 0.55 on this one control — a fifth hand-forked focus
      // treatment on exactly the affordance the comment above exists to
      // de-duplicate, and a weaker indicator on the escape hatch of a modal.
      //
      // And no radius override either. `rounded-control` (9) was passed here
      // alongside `kind="icon"`, which sets `rounded-full` — the house idiom for
      // a bare glyph affordance, arrived at by counting (see pressable.tsx: 20
      // of 34 were already circular and the other 14 were spread over seven
      // radii). While cn() could not see that the two conflict, both survived
      // and Tailwind's emit order picked the winner; now that the radius ladder
      // is registered, last-one-wins would make the ONE close button every
      // dialog in the product shares the only non-circular icon control left.
      // Position is genuinely the only thing a call site needs to vary here,
      // which is what the note above already says.
      className={cn("absolute right-4 top-4", className)}
    >
      <ActionIcons.dismiss className="size-4" />
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
      //
      // A 2px backdrop blur, because on the black theme opacity alone cannot say
      // "pushed back": dimming a page that is already at zero lightness changes
      // almost nothing, so the scrim was reading as present-but-inert. Defocusing
      // what is behind the panel is the depth cue that still works at #000.
      //
      // No `motion-reduce:animate-none`: overlay-in/out are the opacity-only
      // fade-in/fade-out keyframes, and Tier A of the reduced-motion policy
      // (globals.css) explicitly keeps opacity. Killing them made a modal appear
      // by hard cut for exactly the users least able to follow a hard cut.
      "fixed inset-0 z-modal bg-scrim backdrop-blur-[2px] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out",
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
        //
        // The modal pair runs the pop-in/pop-out keyframes, which read
        // --motion-shift and --motion-scale-from — so under the reduced-motion
        // preference the travel and the overshoot already collapse to identity
        // and the panel cross-fades. The `motion-reduce:animate-none` that used
        // to close this string went one step further and removed the fade too,
        // which is the Tier A mistake globals.css warns about: the transform is
        // the part that needs reducing, not the feedback.
        "fixed left-[50%] top-[50%] z-modal grid w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] [translate:-50%_-50%] gap-4 overflow-y-auto rounded-panel overlay-glass p-5 data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out sm:p-6",
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
  // `text-lg font-semibold tracking-tight` triple was approximating by hand —
  // and the class list had gone on shipping that triple (plus an arbitrary
  // -0.02em where the token specifies -0.006em) while this comment described the
  // refactor as done. The token carries 1.125rem / 600 / -0.006em itself.
  <DialogPrimitive.Title ref={ref} className={cn("font-serif text-heading", className)} {...props} />
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
