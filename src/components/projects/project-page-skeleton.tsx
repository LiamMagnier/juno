import { AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import "@/components/projects/projects.css";

export function ProjectPageSkeleton() {
  return (
    <>
      <AppPageHeaderSkeleton nav headingWidth="w-72" actions="button" />
      <div className="pj-workspace-grid" aria-hidden="true">
        <div className="pj-workspace-main">
          <div className="pj-composer-card">
            <div className="pj-composer-heading"><Skeleton className="h-4 w-16" /></div>
            <Skeleton className="h-28 w-full rounded-panel" />
          </div>
          <div className="pj-workspace-history space-y-2">
            <Skeleton className="mb-3 h-8 w-1/3" />
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-12 w-full rounded-control" />)}
          </div>
        </div>
        <Skeleton className="h-80 w-full rounded-panel" />
      </div>
    </>
  );
}
