import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/code/customize` while the shell resolves: the header, then the sections'
 * own shape — a mono section label, a lede, and rows on hairlines.
 *
 * FOUR OF THEM, which is how many `CodeCustomize` draws (repositories, Macs,
 * what a run may do, the cloud machine). A skeleton that reserves two sections
 * for a page with four does the one thing a skeleton exists to prevent: the
 * column grows under the reader's eyes at the moment the real page arrives.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it.
 * The lists inside the sections draw their own row placeholders once this is
 * replaced, so this stops at the section frame rather than sketching rows
 * twice.
 *
 * There IS an `error.tsx` beside it, and the reason is worth stating here
 * because this file used to claim the opposite. Failing to draw is not the same
 * failure as a list that could not be reached: the two lists each report their
 * own, in place and with a retry, but if the page itself throws the nearest
 * boundary above is `/code/error.tsx`, which is written for the landing and
 * tells the reader a composer failed and that no run was cancelled — neither of
 * which is about a settings page.
 */
export default function CodeCustomizeLoading() {
  return (
    // role="status" with a label rather than aria-hidden: a screen-reader user
    // is owed the same "this is loading" the sighted reader gets from the
    // shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading your Juno Code settings">
      <AppPageHeaderSkeleton headingWidth="w-44" ledeLines={2} />
      <div className="divide-y divide-border/60">
        {[0, 1, 2, 3].map((section) => (
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
