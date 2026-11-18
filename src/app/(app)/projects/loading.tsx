import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { ProjectsGridSkeleton } from "@/components/projects/projects-grid-skeleton";

/**
 * A skeleton rather than a spinner, because the two answer different questions:
 * a spinner says only that something is happening, while a placeholder in the
 * page's own shape says what is about to be there and reserves the room for it,
 * so nothing jumps when the data lands. The page's own first fetch draws the
 * same grid (see ProjectsGridSkeleton), so the route and the data arrive as
 * one continuous placeholder.
 *
 * The header placeholder is drawn to this page's measured header, so the grid
 * does not move when the page arrives: a one-line lede on a desktop and on a
 * phone (measured, 24px at 1280 and on an iPhone 13, 17 Nov 2026), and
 * "New project" as a default Button on the heading's line (44px
 * on a touch screen against a 30px heading), so the lede starts under it.
 */
export default function ProjectsLoading() {
  return (
    <AppPage measure="wide">
      <AppPageHeaderSkeleton headingWidth="w-56" ledeLines={1} phoneLedeLines={1} actions="button" />
      <ProjectsGridSkeleton />
    </AppPage>
  );
}
