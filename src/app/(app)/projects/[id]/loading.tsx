import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * Mirrors the page's own pre-data shape — back link, eyebrow, title, lede, the
 * tab row, then the chat column beside the project rail — so the layout does
 * not reflow at the moment the project resolves.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The blocks come up on the shared
 * stagger (see STAGGER in src/lib/motion.ts) rather than repainting at once.
 */
export default function ProjectLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    // The skeleton's measure is the page's measure (page.tsx renders
    // `measure="wide"` in both of its branches). It was "full", so the column
    // was full-bleed during the load and snapped inward to 64rem the moment the
    // project arrived: a placeholder that reserves the wrong column reserves
    // nothing, and it reads as a layout bug rather than as a load.
    <AppPage measure="wide" role="status" aria-label="Loading project">
      <AppPageHeaderSkeleton headingWidth="w-72" actions />

      {/* Tab row */}
      <Skeleton className="mb-6 h-9 w-96 max-w-full rounded-menu" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-8">
        <div className="min-w-0 space-y-6">
          <Skeleton
            className="h-32 w-full rounded-panel [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(0)}
          />
          <div className="space-y-1.5">
            {[...Array(4)].map((_, i) => (
              <Skeleton
                key={i}
                className="h-12 w-full rounded-control [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i + 1)}
              />
            ))}
          </div>
        </div>
        <Skeleton
          className="h-72 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
          style={staggerDelay(1)}
        />
      </div>
    </AppPage>
  );
}
