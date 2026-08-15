import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The sticky filter bar, then the four-column grid of square thumbnails.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function LibraryLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading your files">
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
              <Skeleton className="h-8 w-52 max-w-full" />
              <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
            </div>
            <Skeleton className="h-8 w-44 shrink-0" />
          </div>
        </div>

        <div className="-mx-1 border-b border-border/55 px-1 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Skeleton className="h-8 w-64 max-w-full rounded-full" />
            <Skeleton className="h-8 w-40 max-w-full rounded-full sm:ml-auto" />
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-6 lg:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <div
              key={i}
              className="[animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "tight")}
            >
              <Skeleton className="aspect-square w-full rounded-card" />
              <Skeleton className="mt-2 h-3 w-3/4 rounded-sm" />
              <Skeleton className="mt-2 h-2.5 w-1/2 rounded-sm" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
