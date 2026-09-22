import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The app group's fallback, for the segments that do not ship one of their own.
 *
 * Chat and Code each have their own `loading.tsx` tuned to the shape they are
 * about to draw, as do most of the pages beside them. This boundary covers the
 * rest, and Next needs it here to stream at all: without it a navigation held
 * the previous page on screen with no sign that anything was happening, and
 * then swapped it whole.
 *
 * It stands in the real page frame, `AppPage` at the `wide` measure with the
 * shared header placeholder, because every page this can precede opens that
 * way: the gutter, the column and the header's line boxes are the page's own,
 * so the only thing that changes when the page lands is the content. It used
 * to be a `max-w-3xl px-6 py-10` box, narrower and lower than any real page,
 * and every page it preceded moved sideways and up on arrival.
 *
 * Below the header it guesses no more than "rows on hairlines", the shape of
 * almost every list here, and draws them as text on the page rather than as
 * boxes: a row placeholder that predicts a card the page does not have is
 * worse than one that predicts nothing. The bars breathe on the shared
 * stagger (`staggerDelay`, the `tight` rung for dense rows), so the pulse
 * travels down the list rather than blinking as one block.
 */
export default function AppGroupLoading() {
  return (
    <AppPage measure="wide" role="status" aria-label="Loading">
      <AppPageHeaderSkeleton />
      <div aria-hidden="true" className="divide-y divide-border/60">
        {["w-2/5", "w-1/3", "w-1/2", "w-2/5", "w-1/4", "w-1/3"].map((width, i) => (
          <div key={i} className="flex flex-col gap-2 py-3.5">
            <Skeleton className={`h-4 max-w-full rounded-xs ${width}`} style={staggerDelay(i, "tight")} />
            <Skeleton className="h-3 w-40 max-w-full rounded-xs" style={staggerDelay(i, "tight")} />
          </div>
        ))}
      </div>
    </AppPage>
  );
}
