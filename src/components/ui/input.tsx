import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The text field: the page fill, the `--input` hairline as its boundary, and
 * three states that can each be told apart at a glance.
 *
 *   rest    the hairline
 *   hover   the hairline one step toward ink (`foreground/30`), which says
 *           "this takes input" without looking like focus
 *   focus   the ACCENT edge plus a 3px accent halo (FLAT_UI.md §2, principle
 *           4: the focus edge on a text field is the accent)
 *
 * Focus used to be the border darkening to `foreground/70` from a hover of
 * `foreground/60`, so a focused field and a hovered one were the same line a
 * tenth of an alpha apart, and a reader who clicked into a form could not see
 * where the caret had gone. The accent edge measures above 3:1 against the
 * page in both themes, which is what a focus indicator needs, and the halo
 * gives it width without an offset outline.
 *
 * The global outline stays suppressed for text-entry controls only. Browsers
 * grant `:focus-visible` to a text field on pointer focus, so the 2px ring
 * offset 2px out would bloom on every click; the edge and the halo are this
 * control's indicator instead. They cross-fade on `duration-fast`, colour and
 * shadow only.
 *
 * Plain utilities rather than `.surface-inset`: a material class and a
 * `border-*` utility on the same element fight in the cascade (globals.css
 * explains the trap), and every one of this field's states is a border change.
 * The placeholder is the full `--muted-foreground`, tuned to 5:1. `coarse:`
 * matches Button and SelectTrigger so a field and the button beside it stay
 * aligned on a phone.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-field border border-foreground/[0.14] bg-foreground/[0.025] px-3.5 py-1 text-ui text-foreground shadow-none dark:border-white/[0.12] dark:bg-white/[0.03]",
          "transition-[border-color,box-shadow,background-color] duration-fast ease-out-soft motion-reduce:transition-none",
          "placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-ui file:font-medium",
          "hover:border-foreground/25 focus-visible:bg-background",
          "focus-visible:border-primary focus-visible:shadow-[0_0_0_3px_hsl(var(--primary)/0.16)] focus-visible:outline-none",
          "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:shadow-[0_0_0_3px_hsl(var(--destructive)/0.16)]",
          "disabled:cursor-not-allowed disabled:opacity-50 coarse:h-11",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
