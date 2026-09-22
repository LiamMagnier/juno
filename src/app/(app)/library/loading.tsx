import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { LibraryBrowserSkeleton } from "@/components/library/library-browser";
import { LibraryToolbarSkeleton } from "@/components/library/library-toolbar";

/**
 * The header, the toolbar row, then the file list at the height the real one
 * settles at.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The toolbar's and the list's
 * placeholders are the ones the page itself draws while its first request is
 * out, so the route's skeleton and the page's cannot drift apart.
 */
export default function LibraryLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading your files">
      <AppPageHeaderSkeleton headingWidth="w-28" actions />

      <LibraryToolbarSkeleton />

      <div className="mt-5">
        <LibraryBrowserSkeleton view="list" announce={false} />
      </div>
    </AppPage>
  );
}
