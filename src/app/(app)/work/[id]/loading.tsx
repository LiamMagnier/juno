import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * The task thread: the same header as the loaded page, then four short blocks for the transcript.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function WorkThreadLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="full" role="status" aria-label="Loading task">
      <div className="mx-auto w-full max-w-[80rem]">
        <AppPageHeaderSkeleton headingWidth="w-2/3" />
        <WorkRowSkeletons count={4} height={64} className="space-y-3" />
      </div>
    </AppPage>
  );
}
