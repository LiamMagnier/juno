import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * Header, the filter row, then three task rows at the height the real ones
 * settle at.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function TasksLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="reading" role="status" aria-label="Loading scheduled tasks">
      <div className="mb-6 border-b border-border pb-5">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-3 w-16 rounded-xs" />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-8 w-64 max-w-full" />
            <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-xs" />
          </div>
          <Skeleton className="h-8 w-36 shrink-0" />
        </div>
      </div>

      <Skeleton className="h-9 w-64 max-w-full rounded-menu" />

      <div className="mt-5 space-y-1">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="flex items-start gap-3 px-3 py-2.5 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i, "base")}
          >
            <Skeleton className="size-9 shrink-0 rounded-field" />
            <span className="min-w-0 flex-1 space-y-2">
              <Skeleton className="block h-3 w-48 max-w-full rounded-xs" />
              <Skeleton className="block h-2.5 w-64 max-w-full rounded-xs" />
              <Skeleton className="block h-2.5 w-24 rounded-xs" />
            </span>
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        ))}
      </div>
    </AppPage>
  );
}
