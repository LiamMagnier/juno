import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { ProjectsGridSkeleton } from "@/components/projects/projects-grid-skeleton";

/**
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The page's own first fetch draws the
 * same grid (see ProjectsGridSkeleton), so the route and the data arrive as
 * one continuous placeholder.
 */
export default function ProjectsLoading() {
  return (
    <AppPage measure="wide">
      <AppPageHeaderSkeleton headingWidth="w-56" actions />
      <ProjectsGridSkeleton />
    </AppPage>
  );
}
