import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The vote rail beside the title block, then the description — the shape that
 * replaces it, rather than two anonymous bars that reflow the whole column.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function RoadmapRequestLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading request">
      <div className="app-page-content max-w-3xl">
        <Skeleton className="mb-4 h-8 w-28 rounded-control" />
        <div className="flex gap-4">
          <Skeleton className="h-14 w-12 shrink-0 rounded-control" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-40 rounded-full" style={staggerDelay(1, "loose")} />
            <Skeleton className="h-7 w-3/4 rounded-control" style={staggerDelay(2, "loose")} />
            <Skeleton className="h-4 w-32 rounded-control" style={staggerDelay(3, "loose")} />
          </div>
        </div>
        <div className="mt-5 space-y-2">
          <Skeleton className="h-4 w-full rounded-control" style={staggerDelay(4, "loose")} />
          <Skeleton className="h-4 w-11/12 rounded-control" style={staggerDelay(5, "loose")} />
          <Skeleton className="h-4 w-2/3 rounded-control" style={staggerDelay(6, "loose")} />
        </div>
      </div>
    </div>
  );
}
