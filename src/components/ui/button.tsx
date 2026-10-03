import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * The action button, on the flat material (docs/design/FLAT_UI.md).
 *
 *   default      `.control-primary` — solid accent fill, no shadow
 *   secondary    `.control-neu` — hairline at rest, tonal fill on hover
 *   ghost        flat at rest, tonal fill on hover, the on tone while held
 *   outline      hairline at rest, tonal fill on hover
 *   destructive  the primary recipe in the destructive hue
 *   link         text only
 *
 * The press is `.pressable` (globals.css): transform on --dur-press, every
 * other property on --dur-fast, scale 0.97 while held. It is one class rather
 * than a `transition-[…]` string here because the split timing cannot be
 * written as Tailwind utilities, and every control in the product dips the
 * same way for the same reason.
 *
 * No focus override: the global `:focus-visible` rule (globals.css) is
 * authoritative. A ring-offset fills the 2px gap with a SOLID named colour, so
 * a focused button on a card or inside a dialog wears a page-coloured halo that
 * belongs to no surface underneath it; outline-offset leaves the real surface
 * showing and is correct by construction.
 *
 * Every variant carries a 1px border (transparent where it has no colour) so
 * switching variants never changes a button's size by 2px.
 *
 * LOADING (`loading`, opt-in). Pass the prop — `true` or `false` — and the
 * label is kept in the box at zero opacity while a spinner fades in over it,
 * so the button holds its width instead of collapsing to a spinner-sized pill
 * mid-click, and the two cross-fade on the fast rung rather than cutting.
 * While loading it is `disabled` (no double submit) and `aria-busy`, but NOT
 * dimmed: a button that is working is not a button that is unavailable, and
 * the spinner is what says so. Leave the prop off entirely and the children
 * render exactly as before — the wrapper only exists for callers that asked.
 * Not available with `asChild`, whose Slot needs a single child.
 */
const buttonVariants = cva(
  "ui-button pressable relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control border text-ui font-medium disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "control-primary border-primary/90",
        destructive:
          "border-destructive bg-destructive text-destructive-foreground shadow-none hover:brightness-[1.06] active:brightness-[.94]",
        // Destructive hover language: calm at rest (outline + red text), a red
        // tint and a red hairline on hover via .danger-hover (globals.css) —
        // the one opt-in for delete/disconnect/remove/sign-out controls that
        // shouldn't shout. The solid fill stays the dialog's confirm button.
        "destructive-outline": "danger-hover border-border bg-transparent text-destructive shadow-none",
        // Flat at rest → tonal fill on hover → the on tone (`--selected`, a
        // rung past hover in both themes) while held, so a press deepens the
        // hover instead of paling it. The hairline darkens with the fill, so
        // the border colour is set here rather than left to a surface class (a
        // `border-*` utility on the base would beat the components-layer class).
        outline:
          "border-border bg-transparent shadow-none hover:border-foreground/20 hover:bg-accent active:bg-selected",
        secondary: "control-neu text-foreground",
        ghost:
          "border-transparent bg-transparent shadow-none hover:bg-accent hover:text-foreground active:bg-selected",
        link: "border-transparent text-primary underline-offset-4 hover:underline active:text-primary/75",
      },
      // Every size grows to a ~44px hit area on touch devices (coarse:) so a
      // field with a button beside it stays aligned on a phone.
      size: {
        default: "h-9 px-4 py-2 coarse:h-11",
        // Same face as `default` — a small button is shorter, not quieter. It
        // was text-xs (12px), a size between two rungs of the type scale.
        sm: "h-8 px-3 text-ui coarse:h-10",
        // text-body IS 0.9375rem — the arbitrary value was the token spelled out
        // longhand, minus the 1.6 line-height that comes with it.
        lg: "h-11 rounded-field px-6 text-body",
        icon: "size-9 coarse:size-11",
        "icon-sm": "size-8 coarse:size-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * Opt-in busy state: the label cross-fades to a spinner in place and the
   * button is disabled while `true`. See the note on `buttonVariants`.
   */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const managed = loading !== undefined && !asChild;
    const busy = managed && loading === true;
    return (
      <Comp
        className={cn(
          buttonVariants({ variant, size, className }),
          // Working is not unavailable: keep full strength while busy.
          busy && "disabled:opacity-100"
        )}
        ref={ref}
        disabled={busy || disabled}
        aria-busy={busy || undefined}
        data-loading={busy ? "" : undefined}
        {...props}
      >
        {managed ? (
          <>
            {/* The label keeps its box (and so the button's width) while it
                fades; `gap-[inherit]` hands the button's own gap to the
                icon + text pair inside it. */}
            <span
              className={cn(
                "inline-flex items-center justify-center gap-[inherit] transition-opacity duration-fast ease-out-soft",
                busy && "opacity-0"
              )}
            >
              {children}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                // Opacity keeps its timing under reduced motion; the scale reads
                // --motion-scale-from, which the reduced tier pins to 1.
                "pointer-events-none absolute inset-0 grid place-items-center transition-[opacity,transform] duration-fast ease-out-soft",
                busy ? "opacity-100" : "opacity-0 [transform:scale(var(--motion-scale-from,0.8))]"
              )}
            >
              <Loader2 className="size-4 animate-spin" />
            </span>
          </>
        ) : (
          children
        )}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
