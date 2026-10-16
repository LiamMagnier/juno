"use client";

import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { CheckCircle2 } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";

/**
 * Where a toast sits (spec C15): 16px above the composer when the route has
 * one, 16px above the bottom edge when it does not. The composer publishes
 * its height as `--composer-h` on <html> (hooks/use-composer-height.ts) and
 * resets it to 0 on unmount, so one expression covers every route without a
 * list of composer paths to keep in step with the router.
 */
export const TOAST_BOTTOM_OFFSET = "calc(var(--composer-h, 0px) + 16px)";

/**
 * THE STATUS GLYPHS, from the one set. Sonner's stock marks are solid discs
 * drawn at a different weight from every other icon in the product.
 *
 * The TIER lives in the glyph, not the sentence: the title keeps the
 * foreground ink and the 16px mark carries the status on the AA ink ramps.
 * `error`, `warning` and `info` are the registry's marks (`StatusIcons`);
 * success is the circled check, so the four tiers read as one family. Loading
 * is the galaxy, the product's one working mark.
 */
const TOAST_ICONS: NonNullable<ToasterProps["icons"]> = {
  success: <CheckCircle2 className="size-4 text-success-ink" />,
  error: <StatusIcons.error className="size-4 text-destructive-ink" />,
  warning: <StatusIcons.warning className="size-4 text-warning-foreground" />,
  info: <StatusIcons.info className="size-4 text-muted-foreground" />,
  loading: <GalaxyMark phase="working" size={16} className="text-muted-foreground" />,
  close: <ActionIcons.dismiss className="size-3.5" />,
};

/**
 * Toasts are `.surface-float` at `rounded-card` (12): a card that floats, on
 * the same material as every other floating layer. The `group-[.toaster]:`
 * variant is what makes the components-layer class beat sonner's own
 * `[data-sonner-toast][data-styled]` styles.
 *
 * MOTION (spec C15, sheet.css "Toasts"): an 8px rise over 220 on the standard
 * spring, a 4px drop over 160 on the accelerate. Sonner's stock 400ms full
 * height slide is overridden.
 *
 * The Toaster stays mounted in providers.tsx for the whole app; Sonner is the
 * only web toast system (Code already uses it).
 */
export function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-center"
      // Bottom, not top: the transcript's newest content sits at the top of
      // the scroll area, so a top-center toast landed directly on the message
      // that caused it, and on a phone it covered the whole top bar.
      offset={{ bottom: TOAST_BOTTOM_OFFSET }}
      // Sonner ignores the x-position below 600px and goes full-bleed, so the
      // phone offset is set explicitly, on the same composer expression.
      mobileOffset={{ bottom: TOAST_BOTTOM_OFFSET, left: "0.75rem", right: "0.75rem" }}
      closeButton
      icons={TOAST_ICONS}
      toastOptions={{
        classNames: {
          // `text-ui` rather than sonner's stock 13px; `pr-9` keeps the label
          // off the close chip, which sits inside the toast's own edge.
          toast:
            "group toast group-[.toaster]:rounded-card group-[.toaster]:surface-float group-[.toaster]:font-sans group-[.toaster]:text-ui group-[.toaster]:pr-9",
        },
      }}
      {...props}
    />
  );
}
