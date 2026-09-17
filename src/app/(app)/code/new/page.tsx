import { redirect } from "next/navigation";

/**
 * `/code/new` — kept as a redirect, not deleted.
 *
 * It used to be where the Code composer lived, because `/code` was a list page
 * and a composer had to go somewhere. Now the composer IS `/code`
 * (docs/design/TWO_PRODUCTS.md §3), so this route has nothing left to draw —
 * but it is not a dead URL. It is in the command palette, in the app's deep
 * links, in bookmarks, and in whatever somebody pasted into a message six
 * months ago; a 404 would tell all of them that Juno Code is gone.
 *
 * `redirect()` issues a 307, so the destination is not cached as permanent and
 * this file can become something else without a browser somewhere holding onto
 * a 308 forever.
 *
 * It forwards no query string. The one producer of `?seed=` was the run list's
 * empty state, which went with the list, and the `?project=` the project page
 * sends was never read by anything — so carrying a search string across would
 * be carrying parameters that have no reader.
 *
 * No `loading.tsx` or `error.tsx` beside it any more: a redirect has no frame
 * to draw and nothing to fail at, and the skeletons that were there described a
 * page with a header and a seed-chip row that no longer exists.
 */
export default function NewCodeSessionRedirect(): never {
  redirect("/code");
}
