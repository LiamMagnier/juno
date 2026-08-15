import { Skeleton } from "@/components/ui/skeleton";

/**
 * The Code greeting over the composer, in the same centred 44rem column.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function NewCodeSessionLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="relative flex h-full min-h-full w-full flex-col overflow-y-auto overflow-x-clip" role="status" aria-label="Loading Juno Code">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-14 sm:px-6">
        <div className="flex w-full max-w-[44rem] flex-col items-center gap-7 sm:gap-9">
          <Skeleton className="h-9 w-64 max-w-full rounded-full" />
          {/* Taller than the chat composer: this one carries a second tier with
              the machine, the checkout and the branch on it. */}
          <Skeleton className="h-[104px] w-full rounded-composer" />
        </div>
      </div>
    </div>
  );
}
