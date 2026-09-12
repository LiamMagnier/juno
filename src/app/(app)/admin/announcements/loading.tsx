import { Skeleton } from "@/components/ui/skeleton";
import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { staggerDelay } from "@/lib/motion";

/**
 * The announcement composer beside the list of published popups.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function AdminAnnouncementsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" contentClassName="flex flex-col gap-6" role="status" aria-label="Loading announcements">
        <AppPageHeaderSkeleton headingWidth="w-64" actions className="mb-0" />

        {/* The editor and the published list, side by side above lg. */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          {[...Array(2)].map((_, i) => (
            <Skeleton
              key={i}
              className="h-96 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "base")}
            />
          ))}
        </div>
    </AppPage>
  );
}
