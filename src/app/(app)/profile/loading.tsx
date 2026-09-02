import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The identity plate is drawn first and at full height because it is the one
 * block on this page that renders before any request resolves — the stats below
 * it are what is actually in flight.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function ProfileLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="reading" role="status" aria-label="Loading your profile">
        {/* AppPageHeader, at its own metrics: the mb-3 nav row, the display-size
            heading and the rule that closes the block. Anything looser here
            and the whole page steps sideways at the moment the real header lands
            on top of it. */}
        <div className="mb-6 border-b border-border pb-5">
          <div className="mb-3 flex items-center gap-2">
            <Skeleton className="size-8 shrink-0" />
            <Skeleton className="h-3 w-16 rounded-sm" />
          </div>
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-8 w-48 max-w-full" />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 rounded-surface border border-border/60 bg-card p-5">
          <Skeleton className="size-16 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-40 max-w-full rounded-sm" />
            <Skeleton className="mt-2 h-3 w-56 max-w-full rounded-sm" />
            <Skeleton className="mt-2 h-2.5 w-32 rounded-sm" />
          </div>
        </div>
        <div className="mt-5 space-y-4">
          <Skeleton
            className="h-32 w-full rounded-surface [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(0, "base")}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {[...Array(2)].map((_, i) => (
              <Skeleton
                key={i}
                className="h-40 w-full rounded-surface [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i, "base")}
              />
            ))}
          </div>
        </div>
    </AppPage>
  );
}
