import { Skeleton } from "@/components/ui/skeleton";
import "@/components/projects/projects.css";

export function ProjectPageSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="pj-workspace-header">
        <div className="flex h-7 items-center"><Skeleton className="h-3 w-20" /></div>
        <div className="pj-title-row">
          <Skeleton className="h-8 w-56 max-w-full self-center" />
          <div className="pj-title-actions">
            <Skeleton className="size-11" />
            <Skeleton className="pj-desktop-settings size-11" />
            <Skeleton className="size-11" />
          </div>
        </div>
      </div>
      <div className="pj-workspace-grid">
        <Skeleton className="pj-workspace-composer h-28 w-full rounded-panel" />
        <div className="pj-workspace-context">
          <div className="pj-context-disclosure"><Skeleton className="h-3.5 w-28" /></div>
          <div className="pj-context-body" data-open={false}>
            <Skeleton className="h-80 w-full rounded-panel" />
          </div>
        </div>
        <div className="pj-workspace-history space-y-2">
          <div className="pj-history-heading"><Skeleton className="h-5 w-20" /></div>
          <Skeleton className="h-11 w-full rounded-full" />
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-12 w-full rounded-control" />)}
        </div>
      </div>
    </div>
  );
}
