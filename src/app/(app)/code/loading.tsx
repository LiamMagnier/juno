import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * `/code` while the shell resolves.
 *
 * The page's own shape, not a spinner: a placeholder that reserves the room the
 * header, the view switcher, the toolbar and the first rows will occupy means
 * nothing jumps when the data lands. Same `AppPage` measure as page.tsx, so the
 * column does not step sideways at the moment the real page replaces this one.
 */
export default function CodeRunsLoading() {
  return (
    // role="status" with a label rather than aria-hidden: a screen-reader user
    // is owed the same "this is loading" the sighted reader gets from the
    // shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading your Juno Code runs">
      <div className="mb-6 border-b border-border pb-5">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-3 w-12 rounded-xs" />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-9 w-32" />
            <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-xs" />
          </div>
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <Skeleton className="mb-5 h-9 w-72 rounded-menu" />
      <div className="mb-4 flex items-center gap-2">
        <Skeleton className="h-9 w-64 rounded-field" />
        <Skeleton className="h-9 w-44 rounded-menu" />
      </div>
      <Skeleton className="mb-2 h-3 w-24 rounded-xs" />
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
