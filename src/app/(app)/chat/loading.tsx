import { PrivateGreeting } from "@/components/chat/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { composerRestHeightClass } from "@/components/ui/composer-shell";
import { cn } from "@/lib/utils";

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
 *  - The chip row is StarterChips at the `mt-3` chat-view gives it, `h-8`
 *    (`h-10` coarse), each bar the width of its chip, so the row wraps where
 *    the real one does: under about 390px the four chips take two lines.
 *
 * Measured against a replica of the real frame, the composer used to arrive
 * 38px lower than its placeholder on a laptop and 19px lower, and 32px
 * wider, on a phone.
 */
const CHIP_WIDTHS = [
  // Research, Write, Code, Plan: the rendered chips at 13px, plus the 6px
  // their coarse padding adds.
  "w-[6.625rem] coarse:w-[7rem]",
  "w-20 coarse:w-[5.375rem]",
  "w-[5.0625rem] coarse:w-[5.4375rem]",
  "w-[4.625rem] coarse:w-20",
];

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
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {CHIP_WIDTHS.map((width) => (
              <Skeleton key={width} className={cn("h-8 rounded-full coarse:h-10", width)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
