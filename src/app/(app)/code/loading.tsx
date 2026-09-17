import { Skeleton } from "@/components/ui/skeleton";

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
 * The same one-part-above / two-parts-below split page.tsx uses, so the
 * greeting does not step up the column at the moment the real page lands.
 */
export default function CodeLandingLoading() {
  return (
    // role="status" with a label rather than aria-hidden: a screen-reader user
    // is owed the same "this is loading" the sighted reader gets from the
    // shimmer.
    <div
      role="status"
      aria-label="Loading Juno Code"
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      <div className="page-gutter mx-auto flex w-full max-w-[44rem] flex-1 flex-col pb-4 pt-6">
        <div className="flex min-h-0 flex-[1_1_0] flex-col justify-end">
          <Skeleton className="mx-auto h-9 w-80 max-w-full rounded-full" />
        </div>
        <div aria-hidden className="min-h-0 flex-[2_2_0]" />
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
