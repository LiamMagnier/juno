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
 *  - The greeting is one `text-display` line box (1.08em), set in the rung
 *    itself so it tracks the clamp at every width, and it keeps the greeting's
 *    `mb-6 sm:mb-8`.
 *  - The composer is `composerRestHeightClass` from composer-shell.tsx, inside
 *    the dock frame's own gutter and bottom padding (composer.tsx, `frame`).
 *    It was a hand-written 68px against a 98px composer, so every chat load
 *    dropped the greeting 30px at the moment the page arrived.
 *  - The chip row is StarterChips at its own `mt-4`, `h-8` (`h-10` coarse).
 */
export default function NewChatLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden" role="status" aria-label="Loading Juno">
      <div aria-hidden="true" className="hidden h-11 shrink-0 md:block" />
      <div className="page-gutter mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center py-6 md:py-8">
        {/* The line box is the greeting's; the bar inside it is about the
            height of its letters, so it reads as a line of type rather than
            a 52px slab. */}
        <div className="mb-6 flex h-[1.08em] w-full items-center justify-center text-display sm:mb-8">
          <Skeleton className="h-[0.6em] w-[9.5em] max-w-full rounded-full" />
        </div>
        <div className="w-full max-w-3xl">
          <div className="page-gutter mx-auto max-w-3xl pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            <Skeleton className={cn(composerRestHeightClass, "w-full rounded-composer")} />
          </div>
          {/* Roughly each chip's own width, so the row reads as four words
              rather than a bar code. */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {["w-[6.5rem]", "w-20", "w-[4.75rem]", "w-[4.5rem]"].map((width) => (
              <Skeleton key={width} className={cn("h-8 rounded-full coarse:h-10", width)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
