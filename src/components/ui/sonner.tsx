"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

export function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          // .overlay-glass rather than the hand-copied material: bare shadow-glass
          // omitted the `inset 0 1px 0 hsl(var(--sheen))` rim light, which made the
          // toast the one glass object in the product with no top sheen. Radius
          // moves onto the popover rung so it matches the surfaces it floats over.
          toast: "group toast group-[.toaster]:rounded-popover group-[.toaster]:overlay-glass",
          // With richColors gone (providers.tsx), the semantic tiers are carried by
          // Juno's own AA text ramps instead of sonner's stock green/red fills.
          success: "group-[.toaster]:text-success-ink",
          error: "group-[.toaster]:text-destructive-ink",
          warning: "group-[.toaster]:text-warning-foreground",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:rounded-[10px] group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:rounded-[10px] group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
