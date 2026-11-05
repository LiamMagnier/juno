"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import { DialogCloseButton, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { useDialogFocusReturn } from "@/components/ui/focus-return";
import { useMergedRef, useSwipeDismiss } from "@/components/ui/sheet-gesture";
import { PHONE_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import { RADIUS } from "@/lib/design/tokens.generated";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/lib/motion-preference";

/**
 * A dialog whose panel changes height between steps without jumping.
 *
 * The house `DialogContent` with one difference: the panel is a framer
 * `layout` element, so when a step swaps a short form for a long list the
 * panel grows to it on the slow rung instead of snapping, and the content
 * inside is scale-corrected rather than stretched. That is transform-only
 * (layout animates by scale and translate), which is why it is allowed where a
 * height tween would not be. Everything else is `DialogContent`'s recipe,
 * restated because the panel has to be the framer element: the `.ui-dialog`
 * frame on `.overlay-glass`, the panel radius (the generated token, carried in
 * `style` so framer keeps the corners true while it scales; it was a literal
 * 20 against the house 16), the centring on the independent `translate`
 * property so the pop keyframe owns `transform`, the modal-in / modal-out
 * pair, the ✕ in the house corner, focus return to the opener, and below
 * 640px the same bottom sheet every dialog becomes (sheet.css keys on
 * `data-phone-sheet`; the grabber and the downward throw come with it). The
 * panel clips, so a step that scrolls scrolls its own list rather than the
 * whole dialog.
 *
 * On a phone the panel is not a layout element: the sheet's rise and sink own
 * its transform there, and a sheet that grows from the bottom edge needs no
 * scale correction to stay true.
 *
 * Reduced motion: the panel snaps to its new height, and the steps inside
 * still cross-fade.
 */
export const SkillDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, onCloseAutoFocus, ...props }, ref) => {
  const reduce = useReducedMotion() ?? false;
  const phone = useMediaQuery(PHONE_QUERY);
  const focusReturn = useDialogFocusReturn(onCloseAutoFocus);
  const scrimRef = React.useRef<HTMLDivElement>(null);
  const swipeRef = useSwipeDismiss({ axis: "y", sign: 1, scrimRef, enabled: () => window.matchMedia(PHONE_QUERY).matches });
  const panelRef = useMergedRef<HTMLDivElement>(ref, swipeRef);
  return (
    <DialogPortal>
      <DialogOverlay ref={scrimRef} data-swipe-scrim="" />
      <DialogPrimitive.Content ref={panelRef} asChild onCloseAutoFocus={focusReturn.onCloseAutoFocus} {...props}>
        <motion.div
          layout={!phone}
          data-swipe-panel=""
          data-phone-sheet=""
          data-dialog-layout="bare"
          data-dialog-close={hideClose ? undefined : ""}
          transition={{ layout: reduce ? { duration: 0 } : transition.slow }}
          style={phone ? undefined : { borderRadius: RADIUS.panel }}
          className={cn(
            "ui-dialog overlay-glass fixed left-[50%] top-[50%] z-modal flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl flex-col overflow-hidden rounded-panel outline-none [translate:-50%_-50%] data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out",
            className
          )}
        >
          {focusReturn.capture}
          <div className="ui-sheet-grabber" data-sheet-handle="" aria-hidden />
          {children}
          {/* Positioned by a layout-aware wrapper rather than by the button's
              own classes, so the glyph is not drawn stretched while the panel
              changes height underneath it. `ui-dialog-close` gives the wrapper
              the house corner (dialog.css). */}
          {!hideClose && (
            <motion.div layout={phone ? false : "position"} className="ui-dialog-close absolute right-4 top-4">
              <DialogCloseButton className="static" />
            </motion.div>
          )}
        </motion.div>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
SkillDialogContent.displayName = "SkillDialogContent";

/**
 * A part of the panel that is not a step (a header that stays put while the
 * body below it changes): scale-corrected like a step, and nothing else.
 */
export function SkillDialogFixed({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div layout="position" className={className}>
      {children}
    </motion.div>
  );
}

/**
 * One step's content: out on the exit rung with a small drop, in on the base
 * rung with a small rise, and scale-corrected against the panel's layout
 * animation so its text is never drawn stretched.
 *
 * The steps sit under `AnimatePresence mode="popLayout"`, so the leaving step
 * is lifted out of the flow and fades over the arriving one while the panel
 * grows to the new step: a cross-fade, not an empty panel between two steps.
 * popLayout measures the leaving child through its ref, hence `forwardRef`.
 */
export const SkillDialogStep = React.forwardRef<
  HTMLDivElement,
  { children: React.ReactNode; className?: string }
>(function SkillDialogStep({ children, className }, ref) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      ref={ref}
      layout="position"
      initial={{ opacity: 0, y: reduce ? 0 : 4 }}
      animate={{ opacity: 1, y: 0, transition: transition.base }}
      exit={{ opacity: 0, y: reduce ? 0 : -4, transition: transition.exit }}
      className={cn("flex min-h-0 flex-col", className)}
    >
      {children}
    </motion.div>
  );
});
