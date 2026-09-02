import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkList } from "@/components/work/shell/work-section";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * Three skill rows at the height the real ones settle at, under the header and the tab row.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function WorkSkillsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading skills">
      {/* AppPageHeader, at its own metrics: the mb-3 nav row, the display-size
          heading, its lede and the rule that closes the block. Anything looser
          here and the whole page steps sideways at the moment the real header
          lands on top of it. */}
      <div className="mb-6 border-b border-border pb-5">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-3 w-10 rounded-sm" />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-8 w-24 max-w-full" />
            <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
          </div>
          <Skeleton className="h-8 w-24 shrink-0" />
        </div>
      </div>
      {/* The four-destination tab track WorkNav draws under the header. */}
      <div className="surface-inset inline-flex h-9 items-center gap-1 rounded-menu p-1" aria-hidden="true">
        <Skeleton className="h-7 w-16 rounded-control" />
        <Skeleton className="h-7 w-24 rounded-control" />
        <Skeleton className="h-7 w-14 rounded-control" />
        <Skeleton className="h-7 w-24 rounded-control" />
      </div>
      <WorkList className="mt-8">
        <WorkRowSkeletons count={3} />
      </WorkList>
    </AppPage>
  );
}
