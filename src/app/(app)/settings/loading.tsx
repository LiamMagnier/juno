import { AppPage } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The settings page in its own shape: the rail well on the left, the pane's
 * heading and a few rows on the right — so nothing jumps when the real
 * sections land.
 */
export default function SettingsLoading() {
  return (
    <AppPage measure="wide" role="status" aria-label="Loading settings">
      <div className="mb-6 border-b border-border pb-5">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="size-8 shrink-0" />
          <Skeleton className="h-3 w-16 rounded-sm" />
        </div>
        <Skeleton className="h-8 w-40 max-w-full" />
        <Skeleton className="mt-2.5 h-4 w-full max-w-md rounded-sm" />
      </div>

      <div className="md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-10">
        <div className="surface-inset mb-6 flex gap-1 rounded-card p-1.5 md:mb-0 md:flex-col">
          {[...Array(9)].map((_, i) => (
            <Skeleton
              key={i}
              className="h-9 w-28 shrink-0 rounded-control [animation-fill-mode:backwards] motion-safe:animate-rise-in md:w-full"
              style={staggerDelay(i, "tight")}
            />
          ))}
        </div>
        <div className="min-w-0 max-w-3xl">
          <div className="mb-4 border-b border-border pb-4">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="mt-2 h-4 w-72 max-w-full rounded-sm" />
          </div>
          <div className="space-y-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton
                key={i}
                className="h-16 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i, "base")}
              />
            ))}
          </div>
        </div>
      </div>
    </AppPage>
  );
}
