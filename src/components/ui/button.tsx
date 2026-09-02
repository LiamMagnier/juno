import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The action button, on the Soft UI surfaces (docs/design/SOFT_UI.md).
 *
 *   default      `.control-primary` — coral gradient, accent glow, raised
 *   secondary    `.control-neu` — raised at rest, pressed-inset while held
 *   ghost        flat at rest, RAISES on hover, presses on :active
 *   outline      hairline at rest, raises on hover, presses on :active
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
 */
const buttonVariants = cva(
  "ui-button pressable relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control border text-sm font-medium disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "control-primary border-primary/90",
        destructive:
          "border-destructive/90 bg-destructive text-destructive-foreground shadow-raised [background-image:linear-gradient(180deg,hsl(0_0%_100%/.14),hsl(0_0%_100%/0)_55%)] hover:brightness-[1.06] active:shadow-pressed active:brightness-[.96]",
        // Destructive hover language: calm at rest (outline + red text), fills
        // destructive red on hover via .danger-hover (globals.css) — the one
        // opt-in for delete/disconnect/remove controls that shouldn't shout.
        "destructive-outline": "danger-hover border-border bg-transparent text-destructive shadow-none",
        // Flat → raised on hover → pressed while held. The raised material
        // arrives WITH its hairline, so the border colour is set here rather
        // than left to `.surface-raised` (a `border-*` utility on the base
        // would beat the components-layer class).
        outline:
          "border-border bg-transparent shadow-none hover:border-border hover:bg-card hover:shadow-raised active:bg-secondary active:shadow-pressed",
        secondary: "control-neu border-border/60 text-foreground",
        ghost:
          "border-transparent bg-transparent shadow-none hover:border-border/60 hover:bg-card hover:text-foreground hover:shadow-raised active:bg-secondary active:shadow-pressed",
        link: "border-transparent text-primary underline-offset-4 hover:underline active:text-primary/75",
      },
      // Every size grows to a ~44px hit area on touch devices (coarse:) so a
      // field with a button beside it stays aligned on a phone.
      size: {
        default: "h-9 px-4 py-2 coarse:h-11",
        sm: "h-8 px-3 text-xs coarse:h-10",
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
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
