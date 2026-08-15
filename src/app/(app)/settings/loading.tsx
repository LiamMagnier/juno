import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * Two columns above lg — the 13rem section rail and the content measure — because
 * a single column here would hand the rail's width to the tiles and then take it
 * back a frame later.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function SettingsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading settings">
      <div className="app-page-content mx-auto w-full max-w-5xl">
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
              <Skeleton className="h-8 w-40 max-w-full" />
              <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
            </div>
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12">
          <div className="hidden lg:block">
            <div className="space-y-2">
              {[...Array(6)].map((_, i) => (
                <Skeleton
                  key={i}
                  className="h-7 w-full rounded-control [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                  style={staggerDelay(i, "tight")}
                />
              ))}
            </div>
          </div>
          <div className="min-w-0 space-y-6">
            {[...Array(4)].map((_, i) => (
              <Skeleton
                key={i}
                className="h-44 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i, "base")}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
