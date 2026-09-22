import type { CSSProperties } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * One connector tile before its data — the tile's own anatomy in placeholder
 * form: the 40px logo well, the name over its one-line description, and the
 * hairline footer with the status on the left and the action on the right.
 *
 * It was a bare 144px slab. The real tile is a raised card with a footer rule,
 * so every slab stepped up a material and grew a line the moment the catalog
 * landed; a placeholder that changes shape on arrival reserves the room and
 * nothing else. Shared by the route's `loading.tsx`, the page's own pre-data
 * branch and the directory's catalog fetch, so the three agree by construction.
 *
 * Server-component safe: no hooks, no client boundary.
 */
export function ConnectorTileSkeleton({ index = 0, style }: { index?: number; style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      className="surface-raised flex min-h-36 flex-col gap-3 rounded-card p-3.5 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
      style={{ ...staggerDelay(index, "tight"), ...style }}
    >
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 shrink-0 rounded-field" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>
      <div className="mt-auto flex min-h-8 items-center justify-between border-t border-border/60 pt-2.5">
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="h-7 w-20" />
      </div>
    </div>
  );
}
