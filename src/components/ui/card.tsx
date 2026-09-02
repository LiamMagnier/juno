import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A card is `.surface-raised` (docs/design/SOFT_UI.md §2.2): the card fill,
 * the hairline, and the dual top-left-light / bottom-right-dark shadow.
 *
 *   default      raised
 *   elevated     the bigger throw — hero cards, pricing, project tiles
 *   flat         fill + hairline, no shadow — for a card that sits INSIDE
 *                another raised surface, where a second shadow would stack
 *   interactive  raised, lifts to the large throw on hover and presses into
 *                the page on :active — the whole body is the hit target
 *
 * The transition is scoped (not transition-all) so panel resizes and layout
 * changes never animate.
 */
const cardVariants = cva(
  "rounded-card text-card-foreground transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft",
  {
    variants: {
      variant: {
        default: "surface-raised",
        elevated: "surface-raised-lg",
        flat: "border border-border/60 bg-card shadow-none",
        // `hover:` and `active:` utilities outrank the components-layer class
        // (pseudo-class specificity), which is what lets the surface change
        // depth without a second material. `active:` is here because hover is
        // not an affordance on touch.
        interactive:
          "surface-raised hover:border-foreground/20 hover:shadow-raised-lg active:bg-secondary active:shadow-pressed focus-within:border-foreground/25 motion-reduce:transition-none",
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
  ({ className, ...props }, ref) => <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
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
