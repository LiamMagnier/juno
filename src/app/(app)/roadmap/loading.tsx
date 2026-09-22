import { Skeleton } from "@/components/ui/skeleton";
import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { staggerDelay } from "@/lib/motion";
import { RequestCardSkeleton } from "@/components/roadmap/request-card-skeleton";

/**
 * Search and sort over the category chips, then the request list.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function RoadmapLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading the roadmap">
        <AppPageHeaderSkeleton headingWidth="w-64" actions />

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Skeleton className="h-10 flex-1 rounded-field" />
          <Skeleton className="h-9 w-56 shrink-0 rounded-field" />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {[...Array(5)].map((_, i) => (
            <Skeleton
              key={i}
              className="h-7 w-24 rounded-full [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "tight")}
            />
          ))}
        </div>
        {/* The request card's anatomy, from the component the board's own
            pre-data branch renders — one picture for one load. */}
        <div className="mt-6 space-y-2.5">
          {[...Array(6)].map((_, i) => (
            <RequestCardSkeleton key={i} index={i} />
          ))}
        </div>
    </AppPage>
  );
}
