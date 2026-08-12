import { cn } from "@/lib/utils";

// `rounded-control` (9), not `rounded-md`. A skeleton stands in for the thing
// that is loading, so it has to sit on the same ladder that thing does — and
// `md` is one of the two generic Tailwind steps the semantic ladder was
// introduced to replace, an 8px value no rung in the product uses. 9 is its
// nearest neighbour and is what the rows, chips and sm buttons a skeleton most
// often replaces are already drawn at, so the placeholder no longer changes
// shape at the moment the content arrives.
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-control", className)} {...props} />;
}

export { Skeleton };
