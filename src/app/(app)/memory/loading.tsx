import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The summary card over the controls strip, which is all this page is.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function MemoryLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="reading" role="status" aria-label="Loading memory">
        <AppPageHeaderSkeleton ledeLines={2} headingWidth="w-72" />

        <div className="space-y-3">
          <Skeleton
            className="h-64 w-full rounded-surface [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(0, "base")}
          />
          <Skeleton
            className="h-20 w-full rounded-surface [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(1, "base")}
          />
        </div>
    </AppPage>
  );
}
