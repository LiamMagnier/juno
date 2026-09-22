import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The repository field, at the height the real one takes.
 *
 * Nothing below it, and that is the honest shape: the list of skills does not
 * exist until somebody has pasted a repository and Juno has walked it. A
 * skeleton standing in for rows that no request has been made for would promise
 * content that is not coming.
 */
export default function ImportSkillsLoading() {
  return (
    <AppPage measure="wide" role="status" aria-label="Loading the skill importer">
      <AppPageHeaderSkeleton ledeLines={2} headingWidth="w-44" />
      <div className="space-y-6">
        <Skeleton className="h-10 w-full max-w-md rounded-field" />
      </div>
    </AppPage>
  );
}
