import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The pull-request list: header, view switcher, then one column of rows.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. Same `AppPage` measure as page.tsx.
 */
export default function CodePullsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading pull requests">
      {/* AppPageHeader, at its own metrics: the mb-3 nav row, the display-size
          heading and its lede. */}
      {/* The header gives its rule to the tab row below, as the real
          AppPageHeader does on these pages (`mb-4 border-b-0 pb-0`). */}
      <div className="mb-4">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-3 w-12 rounded-xs" />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-9 w-64 max-w-full" />
            <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-xs" />
          </div>
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      {/* The underline tab row CodeSurfaceNav draws under the header: two
          labels on the page ground over the single rule, no track. */}
      <div className="mb-6 flex items-center gap-1 border-b border-border" aria-hidden="true">
        <Skeleton className="mx-3 my-2 h-5 w-10 rounded-xs" />
        <Skeleton className="mx-3 my-2 h-5 w-24 rounded-xs" />
      </div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <Skeleton className="h-4 w-52 rounded-xs" />
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="mb-2 h-3 w-20 rounded-xs" />
      <div className="surface-inset space-y-0.5 rounded-card p-1.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton
            key={i}
            className="h-14 w-full [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i, "tight")}
          />
        ))}
      </div>
    </AppPage>
  );
}
