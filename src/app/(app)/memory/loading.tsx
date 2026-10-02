import { CustomizeFrame } from "@/components/customize/customize-nav";
import { MemoryPageSkeleton } from "@/components/memory/memory-skeleton";
import "@/components/memory/memory.css";

/**
 * The page's own shape while its code loads: the hero and the two-column body,
 * from the same component the manager shows while its data loads, so the two
 * hand over without a jump (see MemoryPageSkeleton).
 */
export default function MemoryLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div role="status" aria-label="Loading memory" className="contents">
      <CustomizeFrame current="memory">
        <MemoryPageSkeleton />
      </CustomizeFrame>
    </div>
  );
}
