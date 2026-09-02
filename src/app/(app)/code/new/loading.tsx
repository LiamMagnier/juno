import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/code/new` while the composer resolves: header, view switcher, then the
 * composer shell in its centred column.
 *
 * A skeleton rather than a spinner, because a placeholder in the page's own
 * shape says what is about to be there and reserves the room for it, so
 * nothing jumps when the composer mounts. Same `AppPage` measure as page.tsx.
 */
export default function NewCodeSessionLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading Juno Code">
      <div className="mb-6 border-b border-border pb-5">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-3 w-12 rounded-xs" />
        </div>
        <Skeleton className="h-9 w-56 max-w-full" />
        <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-xs" />
      </div>
      <Skeleton className="mb-5 h-9 w-72 rounded-menu" />
      <div className="mx-auto w-full max-w-[44rem] pt-6">
        {/* Taller than the chat composer: this one carries a second tier with
            the machine, the checkout and the branch on it. */}
        <Skeleton className="h-[148px] w-full rounded-panel" />
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-9 w-32 rounded-card" />
          ))}
        </div>
      </div>
    </AppPage>
  );
}
