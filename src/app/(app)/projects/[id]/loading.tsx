import { AppPage } from "@/components/app/app-page";
import { ProjectPageSkeleton } from "@/components/projects/project-page-skeleton";

/**
 * The route transition's placeholder. The shape itself lives in
 * `ProjectPageSkeleton`, which the page's own pre-data branch renders too —
 * see that component for why the two cannot be allowed to drift.
 *
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands.
 */
export default function ProjectLoading() {
  return (
    // role="status" with a label, not aria-hidden: a screen-reader user is owed
    // the same "this is loading" the sighted reader gets from the shimmer.
    // The skeleton's measure is the page's measure (page.tsx renders
    // `measure="wide"` in every branch). It was "full", so the column was
    // full-bleed during the load and snapped inward to 64rem the moment the
    // project arrived: a placeholder that reserves the wrong column reserves
    // nothing, and it reads as a layout bug rather than as a load.
    <AppPage measure="wide" role="status" aria-label="Loading project">
      <ProjectPageSkeleton />
    </AppPage>
  );
}
