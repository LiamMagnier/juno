import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A card is `.surface-raised`: a quiet tonal fill and a hairline, with no
 * shadow at rest. Elevation is reserved for a surface above its page.
 *
 *   default      quiet grouped content
 *   elevated     the bigger throw — hero cards, pricing, project tiles
 *   flat         fill + hairline, no shadow — for a card that sits INSIDE
 *                another raised surface, where a second shadow would stack
 *   interactive  quiet; on hover the hairline darkens and the fill takes a
 *                faint tonal wash, and it goes a shade deeper while held —
 *                the whole body is the hit target
 *
 * Interactive cards share the surface link's one-pixel hover lift, only with
 * a precise pointer and full motion. Pressing settles the card onto the page
 * and strengthens its fill. Reduced motion keeps the tonal fades; touch gets
 * the press state without a hover that can remain after the finger leaves.
 * Large surfaces never scale.
 *
 * The transition is scoped (not transition-all) so panel resizes and layout
 * changes never animate.
 */
const cardVariants = cva(
  "rounded-card text-card-foreground transition-[border-color,background-color,box-shadow,transform] duration-base ease-out-expo motion-reduce:transition-[border-color,background-color,box-shadow]",
  {
    variants: {
      variant: {
        default: "surface-raised",
        elevated: "surface-raised-lg",
        flat: "border border-border/60 bg-card shadow-none",
        interactive: [
          "surface-raised focus-within:border-foreground/25 active:bg-selected active:shadow-raised",
          "[@media_(hover:hover)_and_(pointer:fine)]:hover:border-foreground/20 [@media_(hover:hover)_and_(pointer:fine)]:hover:bg-accent/40 [@media_(hover:hover)_and_(pointer:fine)]:hover:shadow-raised-lg",
          // Repeat the press fill in the same media group so it outranks the
          // hovered state in Tailwind's emitted order.
          "[@media_(hover:hover)_and_(pointer:fine)]:active:bg-selected [@media_(hover:hover)_and_(pointer:fine)]:active:shadow-raised",
          "motion-safe:[@media_(hover:hover)_and_(pointer:fine)]:hover:-translate-y-px motion-safe:[@media_(hover:hover)_and_(pointer:fine)]:active:translate-y-0",
        ],
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} className={cn(cardVariants({ variant }), className)} {...props} />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex flex-col space-y-1.5 p-5", className)} {...props} />
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("font-semibold leading-none tracking-tight", className)} {...props} />
  )
);
CardTitle.displayName = "CardTitle";

/**
 * Mono eyebrow for card sections — the Juno label voice. `text-label` is
 * 0.75rem/500/0.10em; muted-foreground is what makes it an eyebrow rather
 * than a second title.
 */
const CardEyebrow = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("font-mono text-label text-muted-foreground", className)} {...props} />
  )
);
CardEyebrow.displayName = "CardEyebrow";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("text-body text-muted-foreground", className)} {...props} />
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-5 pt-0", className)} {...props} />
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex items-center p-5 pt-0", className)} {...props} />
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardEyebrow, CardDescription, CardContent, cardVariants };
