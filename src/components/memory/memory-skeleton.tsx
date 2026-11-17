import { Skeleton } from "@/components/ui/skeleton";
import { MemoryHeaderActionsSkeleton, MemoryPageHeader } from "@/components/memory/memory-header";

/*
 * The memory page before its data lands, drawn in the page's own shape: the
 * real header (its words do not depend on the data, so they are drawn, not
 * shimmered), then the summary's surface and the list's rows.
 *
 * ONE SKELETON, TWO CALLERS. The route's loading.tsx and the manager's own
 * loading state both render this body, so the hand-off between them is
 * invisible.
 */

export function MemoryPageSkeleton() {
  return (
    <div className="mem">
      <MemoryPageHeader actions={<MemoryHeaderActionsSkeleton />} />
      <MemoryBodySkeleton />
    </div>
  );
}

/** Everything under the header: the summary's surface, then the list's title line and rows. */
export function MemoryBodySkeleton() {
  return (
    <div aria-hidden="true">
      <div className="mem-surface rounded-panel px-5 pb-5 pt-4">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-5 w-24 rounded-xs" />
          <Skeleton className="h-7 w-40 rounded-control" />
        </div>
        <div className="mt-4 max-w-prose space-y-2.5">
          <Skeleton className="h-3.5 w-20 rounded-xs" />
          <Skeleton className="h-4 w-full rounded-xs" />
          <Skeleton className="h-4 w-11/12 rounded-xs" />
          <Skeleton className="h-4 w-3/5 rounded-xs" />
        </div>
      </div>
      <Skeleton className="mt-3 h-12 w-full rounded-composer" />

      <div className="mt-12 flex items-center justify-between gap-4">
        <Skeleton className="h-5 w-32 rounded-xs" />
        <Skeleton className="h-8 w-52 rounded-control" />
      </div>
      <Skeleton className="mt-8 h-4 w-24 rounded-xs" />
      <div className="mt-4 space-y-6">
        {[0.82, 0.64, 0.74, 0.58, 0.7].map((width, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 rounded-xs" style={{ width: `${width * 100}%` }} />
            <Skeleton className="h-3 w-40 rounded-xs" />
          </div>
        ))}
      </div>
    </div>
  );
}
