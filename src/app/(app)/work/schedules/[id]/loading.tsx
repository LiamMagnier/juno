import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * One automation: the editor fields, then the recent runs.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function WorkScheduleLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="reading" role="status" aria-label="Loading automation">
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
            <Skeleton className="h-8 w-56 max-w-full" />
            
          </div>
          <Skeleton className="h-8 w-44 shrink-0" />
        </div>
      </div>
      <WorkRowSkeletons count={4} height={64} className="space-y-3" />
    </AppPage>
  );
}
