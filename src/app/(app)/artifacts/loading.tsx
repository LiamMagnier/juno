import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * Header, toolbar row, then the list of rows the artifacts resolve to.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function ArtifactsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading artifacts">
      <AppPageHeaderSkeleton headingWidth="w-44" actions />

      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-full max-w-xs rounded-field" />
        <Skeleton className="h-9 w-52 max-w-full rounded-menu" />
      </div>
      <ul className="mt-5 space-y-1">
        {[...Array(6)].map((_, i) => (
          <li
            key={i}
            className="flex items-center gap-3 px-3 py-2.5 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i, "tight")}
          >
            <Skeleton className="size-9 shrink-0 rounded-field" />
            <span className="min-w-0 flex-1 space-y-2">
              <Skeleton className="block h-3 w-48 max-w-full rounded-xs" />
              <Skeleton className="block h-2.5 w-28 rounded-xs" />
            </span>
            <Skeleton className="hidden h-2.5 w-16 rounded-xs sm:block" />
          </li>
        ))}
      </ul>
    </AppPage>
  );
}
