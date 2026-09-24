import { Skeleton } from "@/components/ui/skeleton";

/**
 * An artifact in its own window, before the row has been read: the header row
 * and the stage, and nothing the type would decide.
 *
 * This boundary runs before the page knows what it is opening. A design lands
 * as the editor, with a toolbar and two rails; a page, a doc or code lands as
 * one stage under the same header. Borrowing `/design/{id}`'s skeleton here
 * would draw the rails for everything, and every page and every doc would
 * open with two columns that then vanished — a placeholder that predicts a
 * shape the page does not have is worse than one that predicts nothing. What
 * IS common to every type is drawn exactly: the header, at the height and
 * gutter both windows share, and a plain plane where the body goes. A design
 * adds its toolbar and rails on arrival; nothing that was drawn moves.
 *
 * A skeleton rather than a spinner, because the two answer different
 * questions: a spinner says only that something is happening, while a
 * placeholder in the page's own shape says what is about to be there.
 */
export default function ArtifactLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    <div className="flex h-full min-h-0 flex-col overflow-hidden" role="status" aria-label="Loading">
      {/* The header both windows open with (artifact-read-view.tsx and
          design-workspace.tsx): the back control, the name, the version, then
          the one action at the far end. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Skeleton className="size-8 shrink-0" />
        <Skeleton className="h-4 w-44 max-w-full rounded-sm" />
        <Skeleton className="h-3 w-8 rounded-sm" />
        <div className="flex-1" />
        <Skeleton className="h-7 w-24 rounded-control" />
      </div>

      <div className="min-h-0 flex-1 bg-muted/40" />
    </div>
  );
}
