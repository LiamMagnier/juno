import type { CSSProperties } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * One app row before its data, in the row's own anatomy: the 40px logo well
 * and the name over its one-line description, at the 68px the real row
 * settles at and with the same bleed, so nothing moves when the catalog lands.
 * Shared by the route's `loading.tsx`, the page's own pre-data branch and the
 * directory's catalog fetch, so the three agree by construction.
 *
 * Server-component safe: no hooks, no client boundary.
 */
export function ConnectorTileSkeleton({ index = 0, style }: { index?: number; style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      className="-mx-3 flex min-h-[68px] items-center gap-3.5 px-3 py-2.5 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
      style={{ ...staggerDelay(index, "tight"), ...style }}
    >
      <Skeleton className="size-10 shrink-0 rounded-field" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
