import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The Projects grid in placeholder form: the toolbar row and six tiles, in
 * the tile's own anatomy (mark, name, two preview lines, meta row).
 *
 * One component for both places the grid waits, `loading.tsx` (the route
 * streaming in) and the page's own first fetch, because they had drifted:
 * the route drew the old side-by-side tile with a hairline footer while the
 * page drew its own copy, so the grid changed shape twice on the way in.
 *
 * The tiles carry their surface rather than being bare blocks: the thing they
 * stand in for is a raised Card, and an unfilled outline on the ground would
 * step up a rung the moment the data lands.
 */
export function ProjectsGridSkeleton({ toolbar = true, className }: { toolbar?: boolean; className?: string }) {
  return (
    <div className={className} role="status" aria-label="Loading projects">
      {toolbar && (
        <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
          <Skeleton className="h-9 w-full max-w-xs rounded-field" />
          <Skeleton className="h-9 w-36 rounded-menu" />
          <Skeleton className="h-9 w-44 rounded-field" />
        </div>
      )}
      <div className={cn("grid gap-4 @[40rem]/page:grid-cols-2 @5xl/page:grid-cols-3", toolbar && "mt-6")} aria-hidden="true">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="surface-raised flex min-h-44 flex-col rounded-card p-4 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i)}
          >
            <Skeleton className="size-9 shrink-0 rounded-field" />
            <Skeleton className="mt-3 h-4 w-1/2" />
            <div className="mt-2 space-y-1.5">
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
            <div className="mt-auto flex items-center justify-between pt-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
