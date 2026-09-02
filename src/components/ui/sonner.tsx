"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toasts are `.surface-float` at `rounded-card` (16): a card that floats, on
 * the same material as every other floating layer. The `group-[.toaster]:`
 * variant is what makes the components-layer class beat sonner's own
 * `[data-sonner-toast][data-styled]` styles — it compiles to a three-class
 * selector, which outranks the two-attribute one.
 */
export function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: "group toast group-[.toaster]:rounded-card group-[.toaster]:surface-float group-[.toaster]:font-sans",
          // With richColors gone (providers.tsx), the semantic tiers are carried by
          // Juno's own AA text ramps instead of sonner's stock green/red fills.
          success: "group-[.toaster]:text-success-ink",
          error: "group-[.toaster]:text-destructive-ink",
          warning: "group-[.toaster]:text-warning-foreground",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:rounded-control group-[.toast]:control-primary",
          cancelButton: "group-[.toast]:rounded-control group-[.toast]:control-neu group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
