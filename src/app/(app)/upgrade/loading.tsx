import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. Same measure as page.tsx (`wide`) for
 * the same reason.
 */
export default function UpgradeLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading plans">
      {/* AppPageHeader, at its own metrics: the mb-3 nav row, the page-title
          heading, the lede and the rule that closes the block. */}
      <div className="mb-6 border-b border-border pb-5">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-3 w-12 rounded-xs" />
        </div>
        <Skeleton className="h-8 w-40 max-w-full" />
        <Skeleton className="mt-2.5 h-4 w-full max-w-prose rounded-xs" />
      </div>

      <Skeleton className="mb-6 h-9 w-44 rounded-menu" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton
            key={i}
            className="h-96 w-full rounded-card motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            style={staggerDelay(i, "loose")}
          />
        ))}
      </div>
    </AppPage>
  );
}
