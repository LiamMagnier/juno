import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Name, description and the instructions box, at the heights the real fields take.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function NewWorkSkillLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="reading" role="status" aria-label="Loading the skill editor">
      <AppPageHeaderSkeleton headingWidth="w-32" />
      <div className="space-y-6">
        <Skeleton className="h-10 w-full rounded-field" />
        <Skeleton className="h-10 w-full rounded-field" />
        <Skeleton className="h-64 w-full rounded-field" />
      </div>
    </AppPage>
  );
}
