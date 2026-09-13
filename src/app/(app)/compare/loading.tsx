import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
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
      {/* Compare DOES use AppPageHeader now, so this borrows its skeleton
          rather than redrawing it. The note this replaced said the opposite —
          that the view owned a header the component could not produce, so the
          skeleton had to be drawn to that one instead, because "a skeleton
          that does not match its page is worse than no skeleton". The premise
          was wrong (the fixed-height shell is the FRAME, not the header) and
          the consequence was the bug the note was trying to avoid: this
          skeleton put the heading where `<AppPage>` puts it and the real view
          put it 31px higher, so the page jumped when the data landed. One
          component on both sides is what makes them agree. */}
      <AppPageHeaderSkeleton className="shrink-0" headingWidth="w-40" lede={false} actions />
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
