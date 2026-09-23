import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The skill page's shape before its data: the header, the source line, the
 * two usage options, the tab strip and the instructions document.
 *
 * A placeholder in the page's own shape rather than a spinner, so the page
 * does not step when the skill arrives.
 */
export default function SkillLoading() {
  return (
    <AppPage measure="reading" role="status" aria-label="Loading skill">
      <AppPageHeaderSkeleton nav headingWidth="w-44" actions className="mb-0 border-b-0 pb-0" />
      <div className="mb-7 mt-3 flex items-center gap-3 border-b border-border pb-5">
        <Skeleton className="h-7 w-44 rounded-full" />
        <Skeleton className="h-4 w-28 rounded-sm" />
      </div>
      <div className="space-y-8">
        <div>
          <Skeleton className="h-5 w-16 rounded-sm" />
          <Skeleton className="mt-3 h-[8.5rem] w-full rounded-card" />
        </div>
        <div>
          <Skeleton className="h-9 w-64 rounded-menu" />
          <Skeleton className="mt-4 h-72 w-full rounded-card" />
        </div>
      </div>
    </AppPage>
  );
}
