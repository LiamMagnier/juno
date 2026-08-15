import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * Compare owns a fixed-height shell: header, one composer, then the panes.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function CompareLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="flex h-full min-h-0 flex-col" role="status" aria-label="Loading Compare">
      <header className="flex shrink-0 items-end justify-between gap-3 px-4 pb-3 pt-5 sm:px-6">
        <div>
          <Skeleton className="h-3 w-40 rounded-sm" />
          <Skeleton className="mt-2 h-8 w-40" />
        </div>
        <Skeleton className="mb-1 h-3 w-36 rounded-sm" />
      </header>
      <div className="shrink-0 px-4 pb-4 sm:px-6">
        <Skeleton className="h-[104px] w-full rounded-composer" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 px-4 pb-4 sm:px-6 md:grid-cols-2">
        {[...Array(2)].map((_, i) => (
          <Skeleton
            key={i}
            className="h-full min-h-48 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i, "base")}
          />
        ))}
      </div>
    </div>
  );
}
