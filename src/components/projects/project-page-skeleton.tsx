import { AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The project page before its data, in the project page's own shape.
 *
 * ONE component, rendered by both things that draw it: the route's
 * `loading.tsx` (the server boundary, shown during the route transition) and
 * the page's own `!data` branch (shown while the client fetch is in flight).
 * They are two different moments in the same load and the reader sees them
 * back to back, so they have to be the same picture — and when they were two
 * files they were not. `loading.tsx` drew the header, the tab row, a composer
 * block and four chat rows beside a rail; the page drew a header and two bare
 * slabs with no tab row at all. The reader got one layout from the transition,
 * a second from the fetch, and the real page third.
 *
 * PREMIUM_AUDIT §2b already wrote the rule this closes — "where a skeleton and
 * a page must agree, they agree by sharing a component, not by two files
 * holding the same numbers". The blocks come up on the shared stagger (see
 * STAGGER in src/lib/motion.ts) rather than repainting at once.
 *
 * The caller supplies the `<AppPage measure="wide">` frame and the
 * `role="status"` on it, so this emits no landmark of its own: the region
 * speaks once, not twice.
 */
export function ProjectPageSkeleton() {
  return (
    <>
      <AppPageHeaderSkeleton headingWidth="w-72" actions />

      {/* Tab row */}
      <Skeleton className="h-9 w-[26rem] max-w-full rounded-menu" />

      {/* The composer spans the column, above the split — as it does loaded. */}
      <Skeleton
        className="mt-6 h-32 w-full rounded-panel [animation-fill-mode:backwards] motion-safe:animate-rise-in"
        style={staggerDelay(0)}
      />

      <div className="mt-8 grid gap-6 @4xl/page:grid-cols-[minmax(0,1fr)_19rem] @4xl/page:gap-8">
        <div className="min-w-0 space-y-4">
          <Skeleton
            className="h-9 w-full max-w-sm rounded-control [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(1)}
          />
          <div className="space-y-1">
            {[...Array(4)].map((_, i) => (
              <Skeleton
                key={i}
                className="h-12 w-full rounded-control [animation-fill-mode:backwards] motion-safe:animate-rise-in"
                style={staggerDelay(i + 2)}
              />
            ))}
          </div>
        </div>
        <Skeleton
          className="h-72 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
          style={staggerDelay(2)}
        />
      </div>
    </>
  );
}
