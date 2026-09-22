import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Mono metadata voice. `text-caption` carries the same 11px/0.02em the
 * arbitrary values were approximating. Flat, like every in-flow surface: a
 * fill or a hairline and no shadow at all — at ~20px tall any throw reads as a
 * smudge. `muted` and `secondary` are tonal; `outline` is the hairline alone;
 * `default` is the one accent fill and is for state, not decoration.
 */
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-caption font-medium transition-[color,background-color,border-color] duration-fast ease-out-soft",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border bg-transparent text-foreground",
        success: "border-transparent bg-success text-success-foreground",
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
