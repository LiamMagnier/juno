import { Card } from "@/components/ui/card";
import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The flag queue: a filter bar over a single card of rows.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function AdminModerationLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" contentClassName="flex flex-col gap-6" role="status" aria-label="Loading moderation queue">
        <AppPageHeaderSkeleton headingWidth="w-56" actions className="mb-0" />

        <Card className="overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            <Skeleton className="h-8 w-56 max-w-full rounded-full" />
            <Skeleton className="h-3 w-16 rounded-sm" />
          </div>
          <div className="flex flex-col gap-2 p-4">
            {[...Array(8)].map((_, i) => (
              <Skeleton
                key={i}
                className="h-14 w-full rounded-field [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i, "tight")}
              />
            ))}
          </div>
        </Card>
    </AppPage>
  );
}
