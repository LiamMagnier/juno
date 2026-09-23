import { Skeleton } from "@/components/ui/skeleton";
import { MemoryHeader, MemoryHeaderActionsSkeleton } from "@/components/memory/memory-header";

/*
 * The memory page before its data lands, drawn in the page's own shape: the
 * real header, then the summary panel with its prompt bar, then the list's
 * heading and a section of rows.
 *
 * ONE SKELETON, TWO CALLERS. The route's loading.tsx and the manager's own
 * loading state both render this, so the hand-off between them is invisible.
 * They used to be two different stacks of grey blocks (h-64 and h-20 in one,
 * h-64, h-20 and h-48 in the other) that played one after the other, and
 * neither matched the order of the page that replaced them.
 */

export function MemoryPageSkeleton() {
  return (
    <>
      <MemoryHeader actions={<MemoryHeaderActionsSkeleton />} />
      <MemoryBodySkeleton />
    </>
  );
}

/** Everything under the header. */
export function MemoryBodySkeleton() {
  return (
    <div aria-hidden="true">
      {/* The summary panel: its heading row, a few lines of prose, its prompt bar. */}
      <div className="surface-raised rounded-panel">
        <div className="px-5 pb-1 pt-4">
          <div className="flex h-8 items-center justify-between">
            <Skeleton className="h-3.5 w-20 rounded-xs" />
            <Skeleton className="h-3.5 w-40 rounded-xs" />
          </div>
          <div className="space-y-2.5 pb-4 pt-3">
            <Skeleton className="h-3.5 w-24 rounded-xs" />
            <Skeleton className="h-4 w-full rounded-xs" />
            <Skeleton className="h-4 w-full rounded-xs" />
            <Skeleton className="h-4 w-4/5 rounded-xs" />
            <Skeleton className="mt-4 h-3.5 w-28 rounded-xs" />
            <Skeleton className="h-4 w-full rounded-xs" />
            <Skeleton className="h-4 w-2/3 rounded-xs" />
          </div>
        </div>
        <div className="p-2 pt-1">
          <Skeleton className="h-11 w-full rounded-field" />
        </div>
      </div>

      {/* The list: its heading row, one section heading, its rows. */}
      <div className="mt-10 flex items-center justify-between gap-3">
        <Skeleton className="h-5 w-32 rounded-xs" />
        <Skeleton className="h-8 w-60 max-w-[45%]" />
      </div>
      <Skeleton className="mt-7 h-3.5 w-24 rounded-xs" />
      <div className="mt-2 divide-y divide-border/70">
        {[0.92, 0.7, 0.84, 0.6, 0.78].map((width, i) => (
          <div key={i} className="space-y-2 py-3">
            <Skeleton className="h-3.5 rounded-xs" style={{ width: `${width * 100}%` }} />
            <Skeleton className="h-2.5 w-32 rounded-xs" />
          </div>
        ))}
      </div>
    </div>
  );
}
