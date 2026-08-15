import { Skeleton } from "@/components/ui/skeleton";

/**
 * One design in its own window: the editor's chrome bar, then the canvas.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function DesignArtifactLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="flex h-full min-h-0 flex-col overflow-hidden" role="status" aria-label="Loading design">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Skeleton className="size-8 shrink-0" />
        <Skeleton className="h-4 w-44 max-w-full rounded-sm" />
        <Skeleton className="h-3 w-8 rounded-sm" />
        <div className="flex-1" />
        <Skeleton className="h-7 w-16 rounded-control" />
        <Skeleton className="size-8 shrink-0" />
      </div>
      <div className="min-h-0 flex-1 p-4">
        <Skeleton className="h-full w-full rounded-card" />
      </div>
    </div>
  );
}
