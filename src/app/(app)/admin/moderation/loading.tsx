import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The flag queue: a filter bar over a single card of rows.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function AdminModerationLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading moderation queue">
      <div className="app-page-content flex max-w-6xl flex-col gap-6">
        {/* AppPageHeader, at its own metrics: the mb-3 nav row, the display-size
            heading, its lede and the rule that closes the block. Anything looser here
            and the whole page steps sideways at the moment the real header lands
            on top of it. */}
        <div className="border-b border-border pb-5">
          <div className="mb-3 flex items-center gap-2">
            <Skeleton className="size-8 shrink-0" />
            <Skeleton className="h-3 w-16 rounded-sm" />
          </div>
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-8 w-56 max-w-full" />
              <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
            </div>
            <Skeleton className="h-8 w-44 shrink-0" />
          </div>
        </div>

        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            <Skeleton className="h-8 w-56 max-w-full rounded-full" />
            <Skeleton className="h-3 w-16 rounded-sm" />
          </div>
          <div className="flex flex-col gap-2 p-4">
            {[...Array(8)].map((_, i) => (
              <Skeleton
                key={i}
                className="h-14 w-full rounded-field [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i, "tight")}
              />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
