import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/code/new` while the composer resolves: header, view switcher, then the
 * composer in its centred column and the seed chips under it.
 *
 * A skeleton rather than a spinner, because a placeholder in the page's own
 * shape says what is about to be there and reserves the room for it, so
 * nothing jumps when the composer mounts. Drawn to the SAME frame the real
 * page now draws — `AppPage measure="wide"` + `AppPageHeader` + the view
 * switcher, like `/code` and `/code/pulls` — where it used to promise a header
 * the page never had, and the whole column shifted on every entry.
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
        <Skeleton className="h-9 w-48 max-w-full" />
        <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-xs" />
      </div>
      <Skeleton className="mb-5 h-9 w-72 rounded-menu" />
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
