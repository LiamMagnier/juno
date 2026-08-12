import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // No focus override: the global `:focus-visible` rule (globals.css) is authoritative.
  // A ring-offset fills the 2px gap with a SOLID named colour, so a focused button on
  // a card or inside a dialog wears a page-coloured halo that belongs to no surface
  // underneath it — which is why four hand-forked offset colours had accumulated.
  // outline-offset leaves the real surface showing and is correct by construction.
  "ui-button relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-field text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-fast ease-out-soft active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // The two solid fills carry the same hairline top-highlight the solid
        // Badge variants do. They were `shadow-none`, which on the OLED-black
        // theme left the product's single most important control as a flat
        // coral rectangle with no lit edge — the one place a 1px sheen is worth
        // most, because on black it is the ONLY elevation cue that survives.
        default:
          "border border-primary/90 bg-primary text-primary-foreground [box-shadow:inset_0_1px_0_hsl(var(--sheen))] hover:bg-primary/[0.92] active:bg-primary/[0.86]",
        destructive:
          "border border-destructive/90 bg-destructive text-destructive-foreground [box-shadow:inset_0_1px_0_hsl(var(--sheen))] hover:bg-destructive/[0.92] active:bg-destructive/[0.86]",
        // Destructive hover language: calm at rest (outline + red text), fills
        // destructive red on hover via .danger-hover (globals.css) — the one
        // opt-in for delete/disconnect/remove controls that shouldn't shout.
        "destructive-outline": "danger-hover border border-border bg-transparent text-destructive shadow-none",
        // Every variant now answers a press, not just the two solid ones. The
        // scale dip is shared, but a scale alone is not an affordance on a
        // touch device where nothing hovered first: `outline`, `secondary`,
        // `ghost` and `link` went from rest straight back to rest with no
        // visual acknowledgement that the tap landed.
        outline:
          "border border-border bg-transparent shadow-none hover:border-foreground/25 hover:bg-accent/70 hover:text-accent-foreground active:bg-accent",
        secondary:
          "border border-transparent bg-secondary text-secondary-foreground shadow-none hover:bg-secondary/[0.82] active:bg-secondary/[0.7]",
        ghost: "hover:bg-accent hover:text-accent-foreground active:bg-accent/80",
        link: "text-primary underline-offset-4 hover:underline active:text-primary/75",
      },
      // Every size grows to a ~44px hit area on touch devices (coarse:).
      // `default` was the exception and it is the one that matters most: at h-9
      // it stayed 36px on touch while Input, Textarea and SelectTrigger all grow
      // to 44 (their comments each cite "matches Button"), so the commonest form
      // row in the product — a field with a button beside it — visibly
      // de-aligned on a phone, and the default button sat under the target size.
      size: {
        default: "h-9 px-4 py-2 coarse:h-11",
        sm: "h-8 rounded-control px-3 text-xs coarse:h-10",
        // text-body IS 0.9375rem — the arbitrary value was the token spelled out
        // longhand, minus the 1.6 line-height that comes with it.
        lg: "h-11 px-6 text-body",
        icon: "h-9 w-9 coarse:h-11 coarse:w-11",
        "icon-sm": "h-8 w-8 rounded-control coarse:h-10 coarse:w-10",
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
