import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/code/new` while the composer resolves: header, then the composer in its
 * centred column and the seed chips under it.
 *
 * A skeleton rather than a spinner, because a placeholder in the page's own
 * shape says what is about to be there and reserves the room for it, so
 * nothing jumps when the composer mounts. Drawn to the SAME frame the real
 * page now draws — `AppPage measure="wide"` + `AppPageHeader`, with NO view
 * tabs: starting a task is not a view of Code, so this page keeps its
 * header's own rule and the row of tabs is gone from both.
 */
export default function NewCodeSessionLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading Juno Code">
      <AppPageHeaderSkeleton ledeLines={2} headingWidth="w-36" />
      <div className="mx-auto w-full max-w-[44rem] pt-6">
        {/* One tier: the field and the controls row. */}
        <Skeleton className="h-[7.25rem] w-full rounded-composer" />
        <Skeleton className="mx-auto mt-3 h-3 w-64 max-w-full rounded-xs" />
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 w-36 rounded-full" />
          ))}
        </div>
      </div>
    </AppPage>
  );
}
