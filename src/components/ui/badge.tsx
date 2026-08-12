import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  // Mono metadata voice. `text-caption` carries the same 11px/0.02em the arbitrary
  // values were approximating; it survives alongside the variant colours now that
  // cn() knows the type keys are sizes.
  "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-caption font-medium transition-[color,background-color,border-color] duration-fast ease-out-soft",
  {
    variants: {
      variant: {
        // Solid badges get a hairline top-highlight so they read as lit chips, not
        // flat rectangles — and all three draw it from --sheen. `default` and
        // `success` had `hsl(0 0% 100% / 0.22)` baked in: pure white at 22%,
        // where the sibling `secondary` beside them resolves the token to
        // `45 20% 96% / 0.055` on dark. Three variants of one component were
        // shipping two sheen systems four times apart in alpha, and the literal
        // is the one a retheme cannot reach.
        default: "border-transparent bg-primary text-primary-foreground [box-shadow:inset_0_1px_0_hsl(var(--sheen))]",
        secondary: "border-transparent bg-secondary text-secondary-foreground [box-shadow:inset_0_1px_0_hsl(var(--sheen))]",
        // A real surface and a readable edge. `bg-background/50` is pure black at
        // 50% on dark, so an outline badge dropped on a card was DARKER than its
        // own ground and on the page ground was nothing at all; both alpha
        // modifiers were tuned against the retired 9%-lightness ground.
        outline: "border-border bg-card text-foreground",
        success: "border-transparent bg-success text-success-foreground [box-shadow:inset_0_1px_0_hsl(var(--sheen))]",
        muted: "border-transparent bg-muted text-muted-foreground",
        // Tinted "soft" chip — premium, low-noise; the accent hue at low alpha.
        soft: "border-primary/25 bg-primary/12 text-primary",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
