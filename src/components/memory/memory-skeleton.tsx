import { Skeleton } from "@/components/ui/skeleton";
import { MemoryHeaderActionsSkeleton } from "@/components/memory/memory-header";

/*
 * The memory page before its data lands, drawn in the page's own shape: the
 * hero (title, lede, three figures, the constellation's orbits), then the
 * summary and the list on their shared two-column grid.
 *
 * ONE SKELETON, TWO CALLERS. The route's loading.tsx and the manager's own
 * loading state both render this, so the hand-off between them is invisible.
 */

export function MemoryPageSkeleton() {
  return (
    <div className="mem @container/memory">
      <div className="grid items-center gap-x-10 gap-y-8 @[56rem]/memory:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-4">
            <h1 className="mem-display text-foreground">Memory</h1>
            <div className="pt-2 @[56rem]/memory:hidden">
              <MemoryHeaderActionsSkeleton />
            </div>
          </div>
          <div className="mt-5 space-y-2.5" aria-hidden="true">
            <Skeleton className="h-4 w-80 max-w-full rounded-xs" />
            <Skeleton className="h-4 w-64 max-w-full rounded-xs" />
          </div>
          <div className="mt-10 grid max-w-[30rem] grid-cols-3 gap-4" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2.5">
                <Skeleton className="h-7 w-14 rounded-xs" />
                <Skeleton className="h-2.5 w-16 rounded-xs" />
              </div>
            ))}
          </div>
        </div>
        <div className="relative hidden min-w-0 @[56rem]/memory:block" aria-hidden="true">
          <div className="absolute right-0 top-0">
            <MemoryHeaderActionsSkeleton />
          </div>
          <OrbitsAtRest />
        </div>
      </div>
      <div className="h-12" aria-hidden="true" />
      <MemoryBodySkeleton />
    </div>
  );
}

/** The constellation's rings without points: the shape the drawing lands in. */
function OrbitsAtRest() {
  const rings = [68, 102, 153, 229.5];
  return (
    <svg viewBox="0 0 640 360" className="mt-10 h-auto w-full px-2">
      {rings.map((rx) => (
        <ellipse key={rx} cx={320} cy={180} rx={rx} ry={rx * 0.52} className="mem-orbit mem-orbit-faint" />
      ))}
    </svg>
  );
}

/** Everything under the hero: the summary and the list, on their shared grid. */
export function MemoryBodySkeleton() {
  return (
    <div aria-hidden="true" className="@container/skel">
      <div className="grid gap-x-14 gap-y-5 @[50rem]/skel:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="space-y-3">
          <Skeleton className="h-7 w-32 rounded-xs" />
          <Skeleton className="h-2.5 w-28 rounded-xs" />
        </div>
        <div>
          <Skeleton className="h-2.5 w-16 rounded-xs" />
          <div className="mt-3 space-y-3">
            <Skeleton className="h-5 w-full rounded-xs" />
            <Skeleton className="h-5 w-11/12 rounded-xs" />
            <Skeleton className="h-5 w-3/5 rounded-xs" />
          </div>
          <Skeleton className="mt-10 h-14 w-full rounded-composer" />
        </div>
      </div>

      <div className="mt-16 grid gap-x-14 gap-y-6 @[50rem]/skel:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="space-y-3">
          <Skeleton className="h-7 w-36 rounded-xs" />
          <Skeleton className="h-9 w-full rounded-field" />
          {[0.7, 0.85, 0.55, 0.75, 0.6].map((width, i) => (
            <Skeleton key={i} className="h-3.5 rounded-xs" style={{ width: `${width * 100}%` }} />
          ))}
        </div>
        <div>
          <Skeleton className="h-6 w-28 rounded-xs" />
          <Skeleton className="mt-2.5 h-3 w-72 max-w-full rounded-xs" />
          <div className="mt-5 space-y-5">
            {[0.92, 0.7, 0.84, 0.6, 0.78].map((width, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 rounded-xs" style={{ width: `${width * 100}%` }} />
                <Skeleton className="h-2.5 w-32 rounded-xs" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
