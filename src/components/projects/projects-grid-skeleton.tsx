import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
// The tile's type rungs (`pj-name`, `pj-annot`) size the placeholder's line
// boxes; the route's loading.tsx renders this before any project component
// has brought the sheet in.
import "@/components/projects/projects.css";

/**
 * The Projects grid in placeholder form: the toolbar row and six tiles, in
 * the tile's own anatomy (cover plate, serif name, excerpt, meta line).
 *
 * One component for both places the grid waits, `loading.tsx` (the route
 * streaming in) and the page's own first fetch, because they had drifted:
 * the route drew the old side-by-side tile with a hairline footer while the
 * page drew its own copy, so the grid changed shape twice on the way in.
 *
 * The tiles carry their surface rather than being bare blocks: the thing they
 * stand in for is a raised Card, and an unfilled outline on the ground would
 * step up a rung the moment the data lands.
 */
export function ProjectsGridSkeleton({ toolbar = true, className }: { toolbar?: boolean; className?: string }) {
  return (
    <div className={cn("pj", className)} role="status" aria-label="Loading projects">
      {toolbar && (
        <>
          {/* The totals line ("8 projects · 4 folders · 35 chats"), drawn
              where the page draws it (40rem and up) in its own `ui` line box.
              Without it the toolbar and the grid dropped 36px when the data
              landed. */}
          <div className="mb-4 hidden h-[1.5em] items-center text-ui @[40rem]/page:flex" aria-hidden="true">
            <Skeleton className="h-3 w-56 rounded-xs" />
          </div>
          {/* The toolbar in the real one's shape: a search that fills the row,
              then the filter and the sort (their own row on a phone), each at
              the controls' own height, 44px on touch. */}
          <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
            <Skeleton className="h-9 w-full rounded-field coarse:h-11 @[40rem]/page:w-auto @[40rem]/page:min-w-64 @[40rem]/page:flex-1" />
            <div className="flex w-full items-center gap-2 @[40rem]/page:w-auto">
              <Skeleton className="h-9 flex-1 rounded-menu coarse:h-11 @[40rem]/page:w-44 @[40rem]/page:flex-none" />
              <Skeleton className="h-9 flex-1 rounded-field coarse:h-11 @[40rem]/page:w-40 @[40rem]/page:flex-none" />
            </div>
          </div>
        </>
      )}
      <div className={cn("grid gap-3 @[30rem]/page:grid-cols-2 @[42rem]/page:grid-cols-3 @[42rem]/page:gap-4 @[64rem]/page:gap-5", toolbar && "mt-6")} aria-hidden="true">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="surface-raised nest-card nest-p-1 flex flex-col [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i)}
          >
            <Skeleton className="aspect-[16/7] w-full rounded-inner" />
            {/* Each bar sits in the line box of the text it stands for (the
                serif name, the excerpt, the meta line), so a tile is as tall
                as the real one. */}
            <div className="flex flex-1 flex-col px-3 pb-3 pt-3.5">
              <div className="pj-name flex h-[1.18em] items-center">
                <Skeleton className="h-5 w-1/2" />
              </div>
              <div className="mt-1 flex h-[1.5em] items-center text-ui">
                <Skeleton className="h-3 w-4/5" />
              </div>
              <div className="pj-annot mt-auto flex h-[1.4em] items-center box-content pt-4">
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
