import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The tiles carry their fill and border rather than being bare blocks: the
 * thing they stand in for is a Card, and an unfilled outline on the black ground
 * means every tile steps up a rung the moment the data lands.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function ProjectsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading projects">
      <div className="app-page-content max-w-5xl">
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
              <Skeleton className="h-8 w-56 max-w-full" />
              <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
            </div>
            <Skeleton className="h-8 w-52 shrink-0" />
          </div>
        </div>

        <Skeleton className="mt-6 h-10 w-full rounded-field" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className="surface-raised flex h-40 flex-col justify-between rounded-card border border-border/70 bg-card p-5 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i)}
            >
              <div className="space-y-2.5">
                <Skeleton className="h-4 w-1/2 rounded-full" />
                <Skeleton className="h-3 w-4/5 rounded-full" />
                <Skeleton className="h-3 w-3/5 rounded-full" />
              </div>
              <div className="flex items-center justify-between border-t border-border/40 pt-3">
                <Skeleton className="h-2.5 w-20 rounded-full" />
                <Skeleton className="h-2.5 w-10 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
