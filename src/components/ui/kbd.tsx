"use client";

import * as React from "react";
import { useModifierKeyLabel } from "@/hooks/use-modifier-key-label";
import { cn } from "@/lib/utils";

/**
 * A keycap: an inset well in the mono metadata voice. Inset rather than
 * raised on purpose — a raised keycap next to a raised button reads as a
 * second button, and the shortcut label is a hint, not a control. Use it for
 * "⌘K" beside a search field, for the Enter/Shift hint under a composer, and
 * for shortcut columns in menus.
 *
 * `text-kbd` (11px mono, spec §3.5 and D16): the one rung under the 12px
 * floor, allowed only here and in count badges.
 *
 * PLATFORM FORM (spec §5.7). Pass `chord` in Apple glyphs ("⇧⌘F") and it
 * prints as written on a Mac, iPhone or iPad and as "Ctrl+Shift+F" on Windows
 * and Linux (hooks/use-modifier-key-label.ts). Children print as given.
 */
export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** A chord in Apple glyphs, rendered in the reader's platform form. */
  chord?: string;
}

const Kbd = React.forwardRef<HTMLElement, KbdProps>(({ className, chord, children, ...props }, ref) => {
  const label = useModifierKeyLabel(chord ?? "");
  return (
    <kbd
      ref={ref}
      className={cn(
        "surface-inset inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-xs border-border/60 px-1.5 text-kbd font-medium text-muted-foreground",
        className
      )}
      {...props}
    >
      {chord !== undefined ? label : children}
    </kbd>
  );
});
Kbd.displayName = "Kbd";

export { Kbd };
