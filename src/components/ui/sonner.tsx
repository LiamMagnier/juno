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
          // Same 18px + warm-glass as PopoverContent — a toast is a popover
          // that shows up on its own, not a third material.
          toast:
            "group toast group-[.toaster]:rounded-[18px] group-[.toaster]:border-border/60 group-[.toaster]:bg-popover/80 group-[.toaster]:backdrop-blur-xl group-[.toaster]:text-popover-foreground group-[.toaster]:glass-raised",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:rounded-[10px] group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:rounded-[10px] group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
