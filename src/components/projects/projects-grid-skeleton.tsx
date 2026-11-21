import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import "@/components/projects/projects.css";

export function ProjectsGridSkeleton({ toolbar = true, className }: { toolbar?: boolean; className?: string }) {
  return (
    <div className={cn("pj", className)} role="status" aria-label="Loading projects">
      {toolbar && (
        <div className="pj-toolbar" aria-hidden="true">
          <Skeleton className="h-9 w-full rounded-field coarse:h-11" />
          <div className="pj-toolbar-filters">
            <Skeleton className="h-9 rounded-menu coarse:h-11 @[46rem]/page:w-36" />
            <Skeleton className="h-9 rounded-field coarse:h-11 @[46rem]/page:w-36" />
            <Skeleton className="h-9 w-[4.25rem] rounded-field coarse:h-11" />
          </div>
        </div>
      )}
      <div className="pj-project-results" data-layout="grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="pj-tile pj-tile-project pj-tile-body [animation-fill-mode:backwards] motion-safe:animate-rise-in" style={staggerDelay(index)}>
            <Skeleton className="size-[2.375rem] rounded-field" />
            <div className="pj-name flex h-[1.18em] items-center">
              <Skeleton className="h-4 w-1/2" />
            </div>
            <div className="pj-tile-meta">
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-3 w-1/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
