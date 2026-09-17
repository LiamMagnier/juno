import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/code/customize` while the shell resolves: the header, then the four
 * sections' own shape — a mono section label, a lede, and rows on hairlines.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it.
 * The lists inside the sections draw their own row placeholders once this is
 * replaced, so this stops at the section frame rather than sketching rows
 * twice.
 *
 * No `error.tsx` beside it: this page has no failure of its own to explain.
 * Its two lists each say what could not be reached, in place and with a retry,
 * and anything above that is the app group's boundary.
 */
export default function CodeCustomizeLoading() {
  return (
    // role="status" with a label rather than aria-hidden: a screen-reader user
    // is owed the same "this is loading" the sighted reader gets from the
    // shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading your Juno Code settings">
      <AppPageHeaderSkeleton headingWidth="w-44" ledeLines={2} />
      <div className="divide-y divide-border/60">
        {[0, 1].map((section) => (
          <div key={section} className="py-6 first:pt-0">
            <Skeleton className="h-3 w-28 rounded-xs" />
            <Skeleton className="mt-2 h-5 w-full max-w-prose rounded-xs" />
            <div className="mt-4 divide-y divide-border/60">
              {[0, 1, 2].map((row) => (
                <div key={row} className="py-3.5">
                  <Skeleton className="h-5 w-48 max-w-full rounded-xs" />
                  <Skeleton className="mt-1.5 h-4 w-72 max-w-full rounded-xs" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </AppPage>
  );
}
