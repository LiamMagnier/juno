import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
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
      <AppPageHeaderSkeleton ledeLines={2} headingWidth="w-40" />

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
