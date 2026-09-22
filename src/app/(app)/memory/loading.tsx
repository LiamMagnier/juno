import { AppPage } from "@/components/app/app-page";
import { MemoryPageSkeleton } from "@/components/memory/memory-skeleton";

/**
 * The page's own shape while its code loads: the real header and the summary
 * panel over the list, from the same component the manager shows while its
 * data loads, so the two hand over without a jump (see MemoryPageSkeleton).
 */
export default function MemoryLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <AppPage measure="reading" role="status" aria-label="Loading memory">
      <MemoryPageSkeleton />
    </AppPage>
  );
}
