import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The heading here is followed by a paragraph rather than AppPageHeader's lede
 * (the page passes className="mb-0" and writes its own), then the interval
 * switch, then the plan cards.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function UpgradeLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading plans">
      <div className="app-page-content max-w-5xl">
        {/* AppPageHeader, at its own metrics: the mb-3 nav row, the display-size
            heading and the rule that closes the block. Anything looser here
            and the whole page steps sideways at the moment the real header lands
            on top of it. */}
        <div className="border-b border-border pb-5">
          <div className="mb-3 flex items-center gap-2">
            <Skeleton className="size-8 shrink-0" />
            <Skeleton className="h-3 w-16 rounded-sm" />
          </div>
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-8 w-80 max-w-full" />
            </div>
          </div>
        </div>

        <Skeleton className="mt-2 h-4 w-full max-w-prose rounded-sm" />
        <Skeleton className="mt-6 h-9 w-44 rounded-full" />
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton
              key={i}
              className="h-[420px] w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "loose")}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
