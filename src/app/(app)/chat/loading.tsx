import { PrivateGreeting } from "@/components/chat/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { composerRestHeightClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";
import { startingGridClass } from "@/components/ui/starting-tile";

/**
 * The new-chat page in its own frame: the header band, the greeting, the
 * composer and the starter chips, centred where chat-view centres them.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands.
 *
 * Every measure below is the real page's, read from where it is declared:
 *
 *  - The band above the column is chat-view's header band, which is `h-11`
 *    from md up on a chat with no title yet and absent below md.
 *  - The column is chat-view's landing column: `.page-gutter`, `max-w-4xl`,
 *    centred on `py-6 md:py-8`.
 *  - The greeting row is chat-view's one-cell grid, which stacks the greeting
 *    and the incognito greeting so the two can cross-fade. The row is as tall
 *    as the TALLER of them, and that is the incognito one (a title and a
 *    sentence, about 99px on a laptop) rather than the single `text-display`
 *    line (52px). So the incognito greeting is drawn here too, invisible, to
 *    give the row its real height, and the bar sits centred in it where the
 *    display line will. The row keeps the greeting's `mb-6 sm:mb-8`.
 *  - The composer is `composerRestHeightClass` from composer-shell.tsx, in the
 *    composer's `landing` frame (composer.tsx): the dock's content width and
 *    no padding of its own. It was a hand-written 68px against a 98px
 *    composer, and then the dock frame's gutter and bottom padding, which the
 *    landing does not have.
 *  - The starting points are StarterChips' tiles at the `mt-3` chat-view
 *    gives them, on the same grid (`startingGridClass`): four across from
 *    `sm`, two by two on a phone. A tile is 54px (the 32px mark well, 10px
 *    padding, the hairline) and 56 from `sm`, where the hint line adds a
 *    line under the label.
 *
 * Measured against a replica of the real frame, the composer used to arrive
 * 38px lower than its placeholder on a laptop and 19px lower, and 32px
 * wider, on a phone.
 */
export default function NewChatLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden" role="status" aria-label="Loading Juno">
      <div aria-hidden="true" className="hidden h-11 shrink-0 md:block" />
      <div className="page-gutter mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center py-6 md:py-8">
        <div className="mb-6 grid w-full grid-cols-1 grid-rows-1 justify-items-center sm:mb-8">
          {/* The bar is about the height of the greeting's letters, so it
              reads as a line of type rather than a 52px slab. */}
          <div className="col-start-1 row-start-1 flex w-full items-center justify-center text-display">
            <Skeleton className="h-[0.6em] w-[9.5em] max-w-full rounded-full" />
          </div>
          <div aria-hidden="true" className="invisible col-start-1 row-start-1 flex w-full flex-col items-center justify-center">
            <PrivateGreeting />
          </div>
        </div>
        <div className="w-full max-w-3xl">
          <div className="mx-auto max-w-[calc(48rem-2*var(--page-gutter,0px))]">
            <Skeleton className={cn(composerRestHeightClass, "w-full rounded-composer")} />
          </div>
          <div className={cn(startingGridClass, "mt-3 max-w-[calc(48rem-2*var(--page-gutter,0px))]")}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[54px] rounded-card sm:h-14" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
