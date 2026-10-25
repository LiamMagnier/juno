import { AppPage, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";

/** The Teach page's two ways in, at the heights the real tiles take. */
export default function TeachSkillLoading() {
  return (
    <AppPage measure="reading" role="status" aria-label="Loading Teach">
      <AppPageHeaderSkeleton nav headingWidth="w-40" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-44 w-full rounded-card" />
        <Skeleton className="h-44 w-full rounded-card" />
      </div>
    </AppPage>
  );
}
