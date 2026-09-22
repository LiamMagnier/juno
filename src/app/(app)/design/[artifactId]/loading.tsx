import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/** How wide each placeholder layer row is, as a share of the rail — ragged on
 *  purpose, because a column of identical bars reads as a table, not a tree. */
const LAYER_ROWS = [72, 56, 64, 48, 60, 40];

/** The inspector's first fields: a title, then two-up rows of the 24px field. */
const INSPECTOR_ROWS = 4;

/**
 * One design in its own window: the editor's chrome bar, its toolbar, then the
 * three panes — layers, canvas, inspector — at the sizes the editor opens at.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. It used to be a header and one big card,
 * so the rails the editor then drew on either side arrived as a reflow.
 *
 * The rail rows come up on the shared stagger (see STAGGER in
 * src/lib/motion.ts) rather than repainting as one flat block; the canvas is a
 * plain muted plane, because that is what the canvas is.
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

      {/* The toolbar: seven tools, then the Motion and Export keys at the right. */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/60 bg-card/40 px-2 py-1.5">
        {[...Array(7)].map((_, i) => (
          <Skeleton key={i} className="size-8 shrink-0" />
        ))}
        <div className="flex-1" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-20" />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Always drawn, at every width: on its own window the editor keeps both
            rails (`surface="window"` in design-editor.tsx), so a placeholder
            that hid them on a narrow screen would reflow when they arrived. */}
        <div className="flex w-[208px] shrink-0 flex-col gap-2.5 border-r border-border/60 p-3">
          {/* The entrance rides on a wrapper so each bar keeps its own breathing
              shimmer — an `animate-*` on the skeleton itself would replace it. */}
          {LAYER_ROWS.map((width, i) => (
            <div key={i} className="[animation-fill-mode:backwards] motion-safe:animate-rise-in" style={staggerDelay(i, "tight")}>
              <Skeleton className="h-3.5 rounded-sm" style={{ width: `${width}%` }} />
            </div>
          ))}
        </div>

        <div className="min-h-0 flex-1 bg-muted/40" />

        <div className="flex w-64 shrink-0 flex-col gap-2 border-l border-border/60 p-3">
          <Skeleton className="mb-1 h-3 w-24 rounded-sm" />
          {[...Array(INSPECTOR_ROWS)].map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-2 gap-1.5 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "tight")}
            >
              <Skeleton className="h-6 rounded-md" />
              <Skeleton className="h-6 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
