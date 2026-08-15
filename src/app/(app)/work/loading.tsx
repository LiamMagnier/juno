import { Skeleton } from "@/components/ui/skeleton";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * Work's home is centred rather than left-aligned — nav, greeting, composer,
 * then the task sections — so this is the one page skeleton that is not the
 * AppPageHeader shape.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function WorkLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading Juno Work">
      <div className="app-page-content max-w-3xl">
        <div className="mb-7 flex justify-center">
          <div className="flex items-center gap-1">
            <Skeleton className="h-6 w-14 rounded-control" />
            <Skeleton className="h-6 w-20 rounded-control" />
            <Skeleton className="h-6 w-14 rounded-control" />
            <Skeleton className="h-6 w-12 rounded-control" />
          </div>
        </div>
        <div className="flex flex-col items-center">
          <Skeleton className="h-3 w-20 rounded-sm" />
          <Skeleton className="mt-3 h-10 w-80 max-w-full" />
        </div>
        <Skeleton className="mt-6 h-[92px] w-full rounded-composer sm:mt-7" />
        <div className="mt-10 space-y-2.5">
          <Skeleton className="h-3 w-24 rounded-sm" />
          <WorkRowSkeletons count={3} className="space-y-2.5" />
        </div>
      </div>
    </div>
  );
}
