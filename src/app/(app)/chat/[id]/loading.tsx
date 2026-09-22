import { Skeleton } from "@/components/ui/skeleton";
import { composerRestHeightClass } from "@/components/ui/composer-shell";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The thread, alternating a short user turn against a longer answer, with the
 * composer already in its final place at the foot of the column.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The turns come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 *
 * The frame is the real one, taken from where each part is declared:
 *
 *  - The header band is chat-view's `h-14` (a saved chat has a title) from md
 *    up, with the title bar at its left edge. Below md the shell's own bar
 *    carries the title and the band does not exist.
 *  - The transcript is message-list's column: `.page-gutter`, `max-w-3xl`,
 *    `space-y-6 py-6`.
 *  - Both speakers are on the `reading` rung. The bubble is one line box
 *    (1.7em) plus its `py-2.5`, and each answer bar sits on a 1.7em pitch, the
 *    rung's line height, so three bars are as tall as three lines of reply.
 *  - Under the transcript is the follow-up row's `pb-2`, then the composer at
 *    `composerRestHeightClass` inside the dock frame's gutter and padding.
 */
export default function ConversationLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden" role="status" aria-label="Loading conversation">
      <div aria-hidden="true" className="page-gutter hidden h-14 shrink-0 items-center md:flex">
        <Skeleton className="h-3.5 w-44 rounded-xs" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="page-gutter mx-auto w-full max-w-3xl space-y-6 py-6">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="space-y-6 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "base")}
            >
              {/* The asked turn: one line, right-aligned, in the bubble's shape. */}
              <div className="flex justify-end">
                <Skeleton className="h-[calc(1.7em+1.25rem)] w-2/3 max-w-sm rounded-card rounded-br-md text-reading" />
              </div>
              {/* The answer: full measure, three lines, the last one short. */}
              <div className="space-y-[0.95em] text-reading">
                <Skeleton className="h-[0.75em] w-full rounded-xs" />
                <Skeleton className="h-[0.75em] w-11/12 rounded-xs" />
                <Skeleton className="h-[0.75em] w-2/3 rounded-xs" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div aria-hidden="true" className="h-2 shrink-0" />
      <div className="page-gutter mx-auto w-full max-w-3xl shrink-0 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <Skeleton className={cn(composerRestHeightClass, "w-full rounded-composer")} />
      </div>
    </div>
  );
}
