import { redirect } from "next/navigation";
import { CODE_PREFILL_PARAMS, type PrefillParams } from "@/lib/code-prefill";

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
 * IT FORWARDS THE PARAMETERS THAT HAVE A READER, AND NOTHING ELSE. This route
 * forwarded no query string at all, on the argument that none of the ones it
 * saw were read anywhere: `?seed=` belonged to the run list's empty state,
 * which went with the list, and the `?project=` the project page sends was
 * never read. The rule was right and the facts under it changed — `/code` now
 * prefills its composer from the query string (src/lib/code-prefill.ts), so the
 * names in `CODE_PREFILL_PARAMS` have a reader and dropping them here would
 * silently throw away the task somebody wrote into a link. Every other
 * parameter is still dropped, and the list is imported rather than retyped so
 * that the two cannot disagree about what `/code` reads.
 *
 * Nothing is validated on the way past: the destination re-parses the whole
 * query and refuses what it cannot use, so this route must not grow a second
 * opinion about what a valid repository or branch is.
 *
 * No `loading.tsx` or `error.tsx` beside it any more: a redirect has no frame
 * to draw and nothing to fail at, and the skeletons that were there described a
 * page with a header and a seed-chip row that no longer exists.
 */
export default async function NewCodeSessionRedirect({
  searchParams,
}: {
  searchParams: Promise<PrefillParams>;
}): Promise<never> {
  const params = await searchParams;
  const forward = new URLSearchParams();
  for (const key of CODE_PREFILL_PARAMS) {
    const value = params[key];
    // A repeated key is a query string, not a list; `/code` reads the first
    // value of each, so that is the one carried across.
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && first) forward.set(key, first);
  }
  const query = forward.toString();
  redirect(query ? `/code?${query}` : "/code");
}
