import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The greeting and the composer, centred, in the shell chat-view opens with.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function NewChatLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden" role="status" aria-label="Loading Juno">
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-3 py-6 sm:px-5 md:py-8">
        <div className="flex w-full max-w-[44rem] flex-col items-center">
          <Skeleton className="h-9 w-72 max-w-full rounded-full" />
          <Skeleton className="mt-6 h-[68px] w-full rounded-composer" />
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton
                key={i}
                className="h-8 w-28 rounded-full [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i, "tight")}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
