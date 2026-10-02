import { Skeleton } from "@/components/ui/skeleton";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * `/code` while the shell resolves: the greeting and the composer, in the
 * places the landing puts them.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. It used to sketch a header, a tab row,
 * a toolbar and four list rows — a promise of a page this route no longer has,
 * which is the worst kind of skeleton: one that reserves room for furniture
 * that never arrives.
 *
 * The same ONE CENTRED BLOCK page.tsx draws — the greeting, its `mb-6
 * sm:mb-8`, the composer, centred together in the column. This skeleton used to
 * keep the old one-third / two-thirds split after the page gave it up, so the
 * greeting jumped from the top third to the middle, and the composer from the
 * floor to the middle, at the moment the real page landed.
 */
export default function CodeLandingLoading() {
  return (
    // role="status" with a label rather than aria-hidden: a screen-reader user
    // is owed the same "this is loading" the sighted reader gets from the
    // shimmer.
    <div
      role="status"
      aria-label={`Loading ${PRODUCT_NAME} Code`}
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      <div className="page-gutter mx-auto flex w-full max-w-[44rem] flex-1 flex-col items-center justify-center py-6 md:py-8">
        <Skeleton className="mb-6 h-9 w-80 max-w-full rounded-full sm:mb-8" />
        {/* The composer at its resting height — 138px: a 42px chip row, the
            52px field at one line, and a 44px controls row. One placeholder,
            because they are one box, and the height is spelled out here so that
            a composer that grows a tier does not leave this skeleton quietly
            short. */}
        <Skeleton className="h-[8.625rem] w-full rounded-composer" />
      </div>
    </div>
  );
}
