import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * One `RequestCard` before its data: the vote rail on the left, then the
 * status and category chips, the title, two lines of description and the
 * author row — the card's own anatomy on the card's own raised surface.
 *
 * It was a bare slab, 112px on the board and 96px in the route's loading
 * file, standing in for a card that is neither: a placeholder the wrong height
 * reserves the wrong room, and every card jumped when the board landed. The
 * route transition and the page's fetch render this one component, so they
 * draw one picture. Server-component safe.
 */
export function RequestCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <div
      aria-hidden="true"
      className="surface-raised flex gap-3 rounded-card p-4 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
      style={staggerDelay(index, "tight")}
    >
      <Skeleton className="h-14 w-12 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="mt-2.5 h-4 w-3/4" />
        <Skeleton className="mt-2 h-3 w-full" />
        <Skeleton className="mt-1.5 h-3 w-2/3" />
        <Skeleton className="mt-3 h-2.5 w-28" />
      </div>
    </div>
  );
}
