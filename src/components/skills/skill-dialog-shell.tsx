"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "framer-motion";
import { DialogCloseButton, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A dialog whose panel changes height between steps without jumping.
 *
 * The house `DialogContent` with one difference: the panel is a framer
 * `layout` element, so when a step swaps a short form for a long list the
 * panel grows to it on the slow rung instead of snapping, and the content
 * inside is scale-corrected rather than stretched. That is transform-only
 * (layout animates by scale and translate), which is why it is allowed where a
 * height tween would not be. Everything else is `DialogContent`'s recipe
 * restated: the float material, the panel radius, the centring on the
 * independent `translate` property so the pop keyframe owns `transform`, and
 * the same modal-in / modal-out pair. The panel clips, so a step that scrolls
 * scrolls its own list rather than the whole dialog.
 *
 * Reduced motion: the panel snaps to its new height, and the steps inside
 * still cross-fade.
 */
export const SkillDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => {
  const reduce = useReducedMotion() ?? false;
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content ref={ref} asChild {...props}>
        <motion.div
          layout
          transition={{ layout: reduce ? { duration: 0 } : transition.slow }}
          // The radius rides `style` so framer keeps the corners true while it
          // scales the box between two heights.
          style={{ borderRadius: 20 }}
          className={cn(
            "surface-float fixed left-[50%] top-[50%] z-modal flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl flex-col overflow-hidden rounded-panel outline-none [translate:-50%_-50%] data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out",
            className
          )}
        >
          {children}
          {/* Positioned by a layout-aware wrapper rather than by the button's
              own classes, so the glyph is not drawn stretched while the panel
              changes height underneath it. */}
          {!hideClose && (
            <motion.div layout="position" className="absolute right-4 top-4 z-10">
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
 */
export function SkillDialogStep({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: reduce ? 0 : 4 }}
      animate={{ opacity: 1, y: 0, transition: transition.base }}
      exit={{ opacity: 0, y: reduce ? 0 : -4, transition: transition.exit }}
      className={cn("flex min-h-0 flex-col", className)}
    >
      {children}
    </motion.div>
  );
}
