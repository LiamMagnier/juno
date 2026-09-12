import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";

/**
 * The editor, before its host list has arrived.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function NewWorkScheduleLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="reading" role="status" aria-label="Loading the automation editor">
      <AppPageHeaderSkeleton ledeLines={2} headingWidth="w-48" />
      <WorkRowSkeletons count={4} height={64} className="space-y-3" />
    </AppPage>
  );
}
