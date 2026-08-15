import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * One block per surface it stands in for — the back link, the title, the
 * metadata card, the filter row, then the passages — mirroring the inspector's
 * own in-component skeleton so the two hand over without a reflow.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The rows come up on the shared stagger
 * (see STAGGER in src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function KnowledgeDocumentLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading document">
      <div className="app-page-content max-w-3xl">
        <Skeleton className="h-5 w-24 rounded-control" />
        <Skeleton className="mt-4 h-16 w-2/3 rounded-control" style={staggerDelay(1, "loose")} />
        <Skeleton className="mt-6 h-24 w-full rounded-card" style={staggerDelay(2, "loose")} />
        <Skeleton className="mt-5 h-10 w-full rounded-field" style={staggerDelay(3, "loose")} />
        <div className="mt-5 space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton
              key={i}
              className="h-28 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "loose", 240)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
