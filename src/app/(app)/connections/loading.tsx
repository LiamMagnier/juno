import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
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
      <AppPageHeaderSkeleton ledeLines={2} headingWidth="w-72" actions />

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
