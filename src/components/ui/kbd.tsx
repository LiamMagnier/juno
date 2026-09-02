import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A keycap: an inset well in the mono metadata voice. Inset rather than
 * raised on purpose — a raised keycap next to a raised button reads as a
 * second button, and the shortcut label is a hint, not a control. Use it for
 * "⌘K" beside a search field, for the Enter/Shift hint under a composer, and
 * for shortcut columns in menus. Sentence case; the glyphs carry the case.
 */
const Kbd = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(({ className, ...props }, ref) => (
  <kbd
    ref={ref}
    className={cn(
      "surface-inset inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-xs border-border/60 px-1.5 font-mono text-micro font-medium text-muted-foreground",
      className
    )}
    {...props}
  />
));
Kbd.displayName = "Kbd";

export { Kbd };
