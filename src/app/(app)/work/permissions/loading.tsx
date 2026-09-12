import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkList } from "@/components/work/shell/work-section";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * The permissions page's shape, held open while it loads: the floor, the three modes, then two Mac rows.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function WorkPermissionsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading your permissions">
      {/* AppPageHeader, at its own metrics: the mb-3 nav row, the display-size
          heading and its lede. Anything looser here and the whole page steps
          sideways at the moment the real header lands on top of it. */}
      {/* The header gives its rule to the tab row below, as the real
          AppPageHeader does on these pages (`mb-4 border-b-0 pb-0`). */}
      <div className="mb-4">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-3 w-10 rounded-sm" />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-8 w-32 max-w-full" />
            <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
          </div>
          
        </div>
      </div>
      {/* The underline tab row WorkNav draws under the header: four labels on
          the page ground over the single rule, no track. */}
      <div className="mb-6 flex items-center gap-1 border-b border-border" aria-hidden="true">
        <Skeleton className="mx-3 my-2 h-5 w-10 rounded-xs" />
        <Skeleton className="mx-3 my-2 h-5 w-20 rounded-xs" />
        <Skeleton className="mx-3 my-2 h-5 w-9 rounded-xs" />
        <Skeleton className="mx-3 my-2 h-5 w-20 rounded-xs" />
      </div>
      <div className="mt-8">
        <Skeleton className="h-5 w-40 rounded-sm" />
        <Skeleton className="mt-2 h-4 w-full max-w-md rounded-sm" />
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11 w-full rounded-card" />
          ))}
        </div>
      </div>
      <div className="mt-8">
        <Skeleton className="h-5 w-48 rounded-sm" />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-card" />
          ))}
        </div>
      </div>
      <div className="mt-8">
        <Skeleton className="h-5 w-24 rounded-sm" />
        <WorkList className="mt-4">
          <WorkRowSkeletons count={2} />
        </WorkList>
      </div>
    </AppPage>
  );
}
