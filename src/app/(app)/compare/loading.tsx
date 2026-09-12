import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * Compare owns a fixed-height shell: header, one composer, then the panes.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The panes come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function CompareLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage
      measure="full"
      scroll={false}
      className="flex h-full min-h-0 flex-col"
      contentClassName="flex min-h-0 flex-1 flex-col"
      role="status"
      aria-label="Loading Compare"
    >
      {/* Compare does NOT use AppPageHeader — its view owns a fixed-height
          shell with an eyebrow over a page-title and a quiet note on the right,
          no back arrow and no rule. So this is drawn to THAT header rather than
          borrowing AppPageHeaderSkeleton: a skeleton that does not match its
          page is worse than no skeleton. `h-[1.15em]` on a `text-page-title`
          element is the heading's line box expressed in the token, so it tracks
          the clamp at every viewport. */}
      <div className="mb-4 flex shrink-0 items-end justify-between gap-3">
        <div className="min-w-0">
          <Skeleton className="h-3 w-36 rounded-xs" />
          <Skeleton className="mt-1 h-[1.15em] w-40 max-w-full text-page-title" />
        </div>
        <Skeleton className="mb-0.5 h-3 w-40 shrink-0 rounded-xs" />
      </div>
      <Skeleton className="h-28 w-full shrink-0 rounded-panel" />
      <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2">
        {[...Array(2)].map((_, i) => (
          <Skeleton
            key={i}
            className="h-full min-h-48 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i, "base")}
          />
        ))}
      </div>
    </AppPage>
  );
}
