import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The header, the toolbar row, then the inset file browser at the height the
 * real one settles at.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function LibraryLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading your files">
      <AppPageHeaderSkeleton headingWidth="w-52" actions />

      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-full max-w-xs rounded-field" />
        <Skeleton className="h-9 w-56 rounded-menu" />
        <Skeleton className="h-9 w-40 rounded-field" />
        <Skeleton className="ml-auto h-9 w-36 rounded-menu" />
      </div>

      <div className="surface-inset mt-5 rounded-card p-1.5">
        <div className="flex h-9 items-center gap-3 px-3">
          <Skeleton className="size-[18px] rounded-xs" />
          <Skeleton className="h-2.5 w-16 rounded-xs" />
        </div>
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="flex min-h-[68px] items-center gap-3 px-3 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i, "tight")}
          >
            <Skeleton className="size-[18px] rounded-xs" />
            <Skeleton className="size-11 shrink-0 rounded-field" />
            <span className="min-w-0 flex-1 space-y-2">
              <Skeleton className="block h-3 w-32 max-w-full rounded-xs" />
              <Skeleton className="block h-2.5 w-20 rounded-xs" />
            </span>
          </div>
        ))}
      </div>
    </AppPage>
  );
}
