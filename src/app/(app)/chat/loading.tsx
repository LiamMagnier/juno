import { Skeleton } from "@/components/ui/skeleton";

/**
 * The greeting and the composer, centred, in the shell chat-view opens with.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. Exactly the two objects the empty state
 * draws, and no more: a row of suggestion pills used to be sketched here that
 * the real page never rendered, so the skeleton promised a UI that then failed
 * to arrive.
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
        </div>
      </div>
    </div>
  );
}
