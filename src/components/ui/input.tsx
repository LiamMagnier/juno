import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The text field: the page fill, the `--input` hairline as its boundary, and
 * four states that can each be told apart at a glance.
 *
 *   rest      the hairline
 *   hover     the hairline one step toward ink (`foreground/25`), which says
 *             "this takes input" without looking like focus
 *   focus     a click, a tap or a script's autofocus: the edge steps up again
 *             (`foreground/40`, `white/35` on dark). No halo, no ring.
 *   keyboard  ONE continuous 2px line in `--ring` at 0.55, the composer's
 *             ring (`kbd-focus:`, which only matches while the person is
 *             using the keyboard, lib/input-modality.ts): 3.8:1 on the light
 *             page, 5.1:1 on the dark one.
 *
 * The keyboard ring used to be the focus state for every focus: the accent
 * edge plus a 3px accent halo. A text field matches :focus-visible on every
 * focus, and under the default Graphite accent the accent is the same
 * near-black as --ring, so every click into a field, and every dialog that
 * focused its first field on open, drew a near-black double line. In dark
 * mode it was the other way round: `dark:border-white/[0.12]` comes after
 * `focus-visible:` in the stylesheet, so the edge never moved and the 16%
 * halo, about 1.5:1, was all a keyboard user got.
 *
 * Before that, focus was the border darkening to `foreground/70` from a hover
 * of `foreground/60`, a tenth of an alpha apart. Pointer focus is now well
 * clear of hover (0.40 against 0.25, on the page fill instead of the tint),
 * and the caret is in the field the person just pressed.
 *
 * The global outline stays suppressed for text-entry controls only. Browsers
 * grant `:focus-visible` to a text field on pointer focus, so the 2px ring
 * offset 2px out would bloom on every click; the edge and the keyboard line
 * are this control's indicator instead. They cross-fade on `duration-fast`,
 * colour and shadow only. An invalid field keeps its destructive edge in
 * every state and both themes (`dark:aria-[invalid=true]:` outranks the
 * dark rest and focus edges), and its keyboard line is destructive too.
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
          "focus-visible:border-foreground/40 dark:focus-visible:border-white/35 focus-visible:outline-none",
          "kbd-focus:border-[hsl(var(--ring)/0.55)] kbd-focus:shadow-[0_0_0_1px_hsl(var(--ring)/0.55)]",
          "aria-[invalid=true]:border-destructive dark:aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:shadow-[0_0_0_3px_hsl(var(--destructive)/0.16)]",
          "aria-[invalid=true]:kbd-focus:border-destructive aria-[invalid=true]:kbd-focus:shadow-[0_0_0_1px_hsl(var(--destructive))]",
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
