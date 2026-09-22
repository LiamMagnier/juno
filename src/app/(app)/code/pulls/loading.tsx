import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { PullsSkeleton } from "@/components/code/pulls-skeleton";

/**
 * The pull-request list: header, then the list's own furniture — the account
 * line and Refresh, a section heading, a repository label, and the rows as the
 * separate cards `PullsList` draws (it used to be one inset well of 56px bars,
 * a shape the page never shows, so the list re-cornered as it landed). That
 * part is `PullsSkeleton`, shared with PullsList's own loading phase.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. Same `AppPage` measure as page.tsx.
 */
export default function CodePullsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the placeholders.
    <AppPage measure="wide" role="status" aria-label="Loading pull requests">
      {/* AppPageHeader, at its own metrics: the mb-3 eyebrow row, the
          display-size heading, its lede, and the rule it now keeps for itself
          — the tab row it used to hand that rule to is gone. */}
      <div className="mb-6 border-b border-border pb-5">
        <div className="mb-3 flex items-center gap-2">
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
      {/* The list itself: the same placeholder PullsList draws while its own
          fetch is in flight, so the hand-off from this route skeleton to that
          one moves nothing. */}
      <PullsSkeleton />
    </AppPage>
  );
}
