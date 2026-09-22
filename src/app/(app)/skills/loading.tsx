import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { SkillsLibrarySkeleton } from "@/components/skills/skills-library-view";

/**
 * The library's own placeholder under the header's own placeholder.
 *
 * Both are the components the loaded page is measured by (the header skeleton
 * shares AppPageHeader's metrics, the list skeleton is the one the view draws
 * while its first read is in flight), so the page does not step when the
 * route's code and then its data arrive.
 */
export default function SkillsLoading() {
  return (
    <AppPage measure="reading">
      <AppPageHeaderSkeleton headingWidth="w-24" actions />
      <SkillsLibrarySkeleton />
    </AppPage>
  );
}
