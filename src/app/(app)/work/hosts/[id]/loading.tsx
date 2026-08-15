import { Skeleton } from "@/components/ui/skeleton";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * Four permission blocks, matching the page's own pre-data shape.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function WorkHostLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading Mac">
      <div className="app-page-content max-w-3xl">
        {/* AppPageHeader, at its own metrics: the mb-3 nav row, the display-size
            heading and the rule that closes the block. Anything looser here
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
              <Skeleton className="h-8 w-24 max-w-full" />
            </div>
          </div>
        </div>

        <WorkRowSkeletons count={4} height={64} className="space-y-3" />
      </div>
    </div>
  );
}
