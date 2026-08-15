import { Skeleton } from "@/components/ui/skeleton";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * Three skill rows.
 *
 * The rows come from `WorkRowSkeletons`, which is also what the page's own
 * in-flight fallback draws. The two used to be written out separately and had
 * drifted to different heights, so a route transition placed a row, then the
 * client placed a slightly taller one, then the real row landed — three layouts
 * for one load.
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
    <div className="app-page-scroll" role="status" aria-label="Loading skills">
      <div className="app-page-content max-w-3xl">
        {/* AppPageHeader, at its own metrics: the mb-3 nav row, the display-size
            heading, its lede and the rule that closes the block. Anything looser here
            and the whole page steps sideways at the moment the real header lands
            on top of it. */}
        <div className="mb-6 border-b border-border pb-5">
          <div className="mb-3 flex items-center gap-2">
            <Skeleton className="size-8 shrink-0" />
            {/* Work puts its four-destination switch in the eyebrow slot where
                every other page puts a one-word kicker. */}
            <div className="flex items-center gap-1">
              <Skeleton className="h-6 w-14 rounded-control" />
              <Skeleton className="h-6 w-20 rounded-control" />
              <Skeleton className="h-6 w-14 rounded-control" />
              <Skeleton className="h-6 w-12 rounded-control" />
            </div>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-8 w-28 max-w-full" />
              <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
            </div>
            <Skeleton className="h-8 w-28 shrink-0" />
          </div>
        </div>

        <WorkRowSkeletons count={3} className="space-y-2.5" />
      </div>
    </div>
  );
}
