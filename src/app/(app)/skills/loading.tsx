import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkList } from "@/components/work/shell/work-section";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * Three skill rows at the height the real ones settle at, under the header.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 *
 * The eyebrow row and the four-tab track this used to draw are gone with
 * `WorkNav`: the page no longer sits inside a section with siblings, so
 * reserving a band for a tab row that never arrives would be the skeleton
 * promising a control the page does not have.
 */
export default function SkillsLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="wide" role="status" aria-label="Loading skills">
      {/* AppPageHeader at its own metrics: the display-size heading, its lede,
          the trailing action, and the rule it ends on. Anything looser here and
          the whole page steps sideways at the moment the real header lands on
          top of it. */}
      <div className="mb-6 border-b border-border pb-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-8 w-24 max-w-full" />
            <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
          </div>
          <Skeleton className="h-8 w-24 shrink-0" />
        </div>
      </div>
      <WorkList>
        <WorkRowSkeletons count={3} />
      </WorkList>
    </AppPage>
  );
}
