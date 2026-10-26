import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The multi-line text field, on exactly Input's recipe: the page fill and the
 * `--input` hairline at rest, the hairline a step toward ink on hover, the
 * edge a step further on a click or an autofocus, and one continuous 2px
 * `--ring` line only for the keyboard (`kbd-focus:`). input.tsx has the
 * reasoning; the short version is that a text field matches :focus-visible on
 * every focus, so the old accent edge plus halo drew a near-black double line
 * on every click, and a textarea sitting under an Input in the same form must
 * not answer focus differently from it.
 *
 * Plain utilities rather than `.surface-inset` for the same cascade reason
 * input.tsx gives: every state here is a border change, and a material class
 * with its own `border` fights a `border-*` utility on the same element.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[60px] w-full rounded-field border border-foreground/[0.14] bg-foreground/[0.025] px-3.5 py-2.5 focus-visible:bg-background dark:border-white/[0.12] dark:bg-white/[0.03] text-ui text-foreground shadow-none",
          "transition-[border-color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
          "placeholder:text-muted-foreground",
          "hover:border-foreground/30",
          "focus-visible:border-foreground/40 dark:focus-visible:border-white/35 focus-visible:outline-none",
          "kbd-focus:border-[hsl(var(--ring)/0.55)] kbd-focus:shadow-[0_0_0_1px_hsl(var(--ring)/0.55)]",
          "aria-[invalid=true]:border-destructive dark:aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:shadow-[0_0_0_3px_hsl(var(--destructive)/0.16)]",
          "aria-[invalid=true]:kbd-focus:border-destructive aria-[invalid=true]:kbd-focus:shadow-[0_0_0_1px_hsl(var(--destructive))]",
          "disabled:cursor-not-allowed disabled:opacity-50 coarse:min-h-[72px]",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
