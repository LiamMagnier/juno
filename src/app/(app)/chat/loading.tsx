import { PrivateGreeting } from "@/components/chat/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { composerHomeRestHeightClass } from "@/components/ui/composer-shell";
import "@/components/chat/composer.css";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The new-chat page in its own frame: the header band, the greeting and the
 * composer, where chat-view puts them.
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
 *  - The column is the home's grid (`.chat-home`, composer.css): the composer
 *    at the panel's optical centre, the greeting resting on it from above.
 *  - The greeting row is chat-view's one-cell grid, which stacks the greeting
 *    and the incognito greeting so the two can cross-fade; the incognito one
 *    is drawn here too, invisible, to give the row its real height.
 *  - The composer is `composerHomeRestHeightClass` from composer-shell.tsx, in
 *    the composer's `landing` frame (composer.tsx): the dock's content width
 *    and no padding of its own.
 *  - Nothing under the composer: suggestions come from the person's own state
 *    and are often absent, so the skeleton reserves none.
 */
export default function NewChatLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden" role="status" aria-label={`Loading ${PRODUCT_NAME}`}>
      <div aria-hidden="true" className="hidden h-11 shrink-0 md:block" />
      <div className="chat-home page-gutter">
        <div className="chat-home__greet grid w-full grid-cols-1 grid-rows-1 justify-items-center">
          {/* The bar is about the height of the greeting's letters, so it
              reads as a line of type rather than a slab. */}
          <div className="chat-home__title col-start-1 row-start-1 flex w-full items-center justify-center">
            <Skeleton className="h-[0.6em] w-[7.5em] max-w-full rounded-full" />
          </div>
          <div aria-hidden="true" className="invisible col-start-1 row-start-1 flex w-full flex-col items-center justify-center">
            <PrivateGreeting />
          </div>
        </div>
        <div className="chat-home__composer w-full">
          <div className="mx-auto max-w-[calc(48rem-2*var(--page-gutter,0px))]">
            <Skeleton className={cn(composerHomeRestHeightClass, "w-full rounded-composer")} />
          </div>
        </div>
      </div>
    </div>
  );
}
