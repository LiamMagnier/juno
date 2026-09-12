import { Skeleton } from "@/components/ui/skeleton";
import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { staggerDelay } from "@/lib/motion";

/**
 * The four size presets — the page's primary action — then the list of documents.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function DesignLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="reading" role="status" aria-label="Loading designs">
        <AppPageHeaderSkeleton headingWidth="w-40" actions />

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton
              key={i}
              className="h-[58px] w-full rounded-menu [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "tight")}
            />
          ))}
        </div>
        <div className="mt-10 space-y-2">
          {[...Array(3)].map((_, i) => (
            <Skeleton
              key={i}
              className="h-14 w-full rounded-menu [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "loose")}
            />
          ))}
        </div>
    </AppPage>
  );
}
