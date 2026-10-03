import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The Projects grid in placeholder form: the toolbar row and six tiles, in
 * the tile's own anatomy (annotation, serif name, two preview lines, counts).
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
      <div className={cn("grid gap-3 @[30rem]/page:grid-cols-2 @[42rem]/page:grid-cols-3 @[42rem]/page:gap-4", toolbar && "mt-6")} aria-hidden="true">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="surface-raised nest-card nest-p-1 flex min-h-48 flex-col [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i)}
          >
            <div className="flex-1 px-3 pt-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-3 h-5 w-1/2" />
              <div className="mt-3 space-y-1.5">
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-4 px-3 pb-2 pt-2.5">
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 w-10" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
