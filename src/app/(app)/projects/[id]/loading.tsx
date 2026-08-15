import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * Mirrors the page's own pre-data shape — back link, eyebrow, title, meta, then
 * the content column beside the files rail — so the layout does not reflow at
 * the moment the project resolves.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function ProjectLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading project">
      <div className="app-page-content max-w-6xl">
        <Skeleton className="mb-8 h-8 w-32 rounded-field" />
        <Skeleton className="mb-3 h-3 w-20 rounded-sm" />
        <Skeleton className="mb-3 h-10 w-72 max-w-full" />
        <Skeleton className="mb-8 h-3 w-56 max-w-full rounded-sm" />
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem] lg:gap-8">
          <Skeleton
            className="h-40 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(0, "base")}
          />
          <Skeleton
            className="h-64 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(1, "base")}
          />
        </div>
      </div>
    </div>
  );
}
