import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The thread, alternating a short user turn against a longer answer, with the
 * composer already in its final place at the foot of the column.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function ConversationLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden" role="status" aria-label="Loading conversation">
      <div className="mx-auto flex w-full max-w-[48rem] flex-1 flex-col gap-7 overflow-hidden px-3 py-6 sm:px-5">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="space-y-7 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i, "base")}
          >
            {/* The asked turn: short, right-aligned, in a bubble. */}
            <div className="flex justify-end">
              <Skeleton className="h-11 w-2/3 max-w-sm rounded-card" />
            </div>
            {/* The answer: full measure, three lines, last one short. */}
            <div className="space-y-2.5">
              <Skeleton className="h-4 w-full rounded-sm" />
              <Skeleton className="h-4 w-11/12 rounded-sm" />
              <Skeleton className="h-4 w-2/3 rounded-sm" />
            </div>
          </div>
        ))}
      </div>
      <div className="mx-auto w-full max-w-[48rem] shrink-0 px-3 pb-5 sm:px-5">
        <Skeleton className="h-[68px] w-full rounded-composer" />
      </div>
    </div>
  );
}
