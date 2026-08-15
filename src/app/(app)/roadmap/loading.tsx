import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * Search and sort over the category chips, then the request list.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function RoadmapLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading the roadmap">
      <div className="app-page-content max-w-6xl">
        {/* AppPageHeader, at its own metrics: the mb-3 nav row, the display-size
            heading, its lede and the rule that closes the block. Anything looser here
            and the whole page steps sideways at the moment the real header lands
            on top of it. */}
        <div className="mb-6 border-b border-border pb-5">
          <div className="mb-3 flex items-center gap-2">
            <Skeleton className="size-8 shrink-0" />
            <Skeleton className="h-3 w-16 rounded-sm" />
          </div>
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-8 w-64 max-w-full" />
              <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
            </div>
            <Skeleton className="h-8 w-44 shrink-0" />
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Skeleton className="h-10 flex-1 rounded-field" />
          <Skeleton className="h-9 w-56 shrink-0 rounded-field" />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {[...Array(5)].map((_, i) => (
            <Skeleton
              key={i}
              className="h-7 w-24 rounded-full [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "tight")}
            />
          ))}
        </div>
        <div className="mt-6 space-y-2.5">
          {[...Array(6)].map((_, i) => (
            <Skeleton
              key={i}
              className="h-24 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "tight")}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
