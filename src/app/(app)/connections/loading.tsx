import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The connector directory: a toolbar over a three-column grid of equal tiles.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The tiles come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function ConnectionsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading connections">
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
            <Skeleton className="h-8 w-72 max-w-full" />
            <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
          </div>
          <Skeleton className="h-6 w-28 shrink-0 rounded-full" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-56 rounded-menu" />
        <Skeleton className="h-9 w-72 max-w-full rounded-field" />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[...Array(6)].map((_, i) => (
          <Skeleton
            key={i}
            className="h-36 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i, "tight")}
          />
        ))}
      </div>
    </AppPage>
  );
}
