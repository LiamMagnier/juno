import { cn } from "@/lib/utils";

/**
 * A placeholder is a well the content will fill: `.skeleton` (globals.css)
 * is the muted fill pressed into its ground with a slow shimmer. `rounded-control`
 * (10), because rows, chips and sm buttons — what a skeleton most often stands
 * in for — are drawn at that rung, so the placeholder does not change shape
 * when the content arrives. Pass a radius to match anything larger.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-control", className)} {...props} />;
}

export { Skeleton };
