import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Mono metadata voice. Flat, like every in-flow surface: a fill or a hairline
 * and no shadow at all — at ~20px tall any throw reads as a smudge. `muted`
 * and `secondary` are tonal; `outline` is the hairline alone; `default` is the
 * one accent fill and is for state, not decoration.
 *
 * SIZE (spec §3.5, D16). A count badge of up to three characters ("3",
 * "99+") is set in `text-kbd`, the one 11px rung, which exists for exactly
 * this; any longer label is metadata and takes `text-label` (12px mono), so
 * a badge never drops under the type floor for words.
 */
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono font-medium transition-[color,background-color,border-color] duration-fast ease-out-soft",
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
      size: {
        label: "text-label",
        count: "text-kbd tabular-nums",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

/** A count of up to three characters takes the keycap rung; anything else the label rung. */
export function badgeSizeFor(children: React.ReactNode): "label" | "count" {
  const text = typeof children === "number" ? String(children) : typeof children === "string" ? children : null;
  return text !== null && Array.from(text.trim()).length <= 3 ? "count" : "label";
}

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, size: size ?? badgeSizeFor(children) }), className)} {...props}>
      {children}
    </div>
  );
}

export { Badge, badgeVariants };
