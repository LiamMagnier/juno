import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The tiles carry their surface rather than being bare blocks: the thing they
 * stand in for is a raised Card, and an unfilled outline on the ground means
 * every tile steps up a rung the moment the data lands.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function ProjectsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading projects">
      <AppPageHeaderSkeleton headingWidth="w-56" actions />

      {/* Toolbar: search · filter · sort */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-full max-w-xs rounded-field" />
        <Skeleton className="h-9 w-36 rounded-menu" />
        <Skeleton className="h-9 w-44 rounded-field" />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="surface-raised flex min-h-40 flex-col rounded-card p-4 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i)}
          >
            <div className="flex items-start gap-3">
              <Skeleton className="size-9 shrink-0 rounded-field" />
              <div className="min-w-0 flex-1 space-y-2 pt-1">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            </div>
            <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-3">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-2.5 w-20" />
            </div>
          </div>
        ))}
      </div>
    </AppPage>
  );
}
