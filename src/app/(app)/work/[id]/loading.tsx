import { Skeleton } from "@/components/ui/skeleton";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * The task thread opens with the same mb-1 nav row the loaded header uses; at
 * any other gap the eyebrow visibly jumps the moment the task resolves.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function WorkThreadLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading task">
      <div className="app-page-content max-w-2xl">
        <div className="mb-1 flex items-center gap-2">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-3 w-12 rounded-sm" />
        </div>
        <Skeleton className="mt-3 h-8 w-2/3 max-w-full" />
        <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
        <WorkRowSkeletons count={5} height={64} className="mt-7 space-y-3" />
      </div>
    </div>
  );
}
