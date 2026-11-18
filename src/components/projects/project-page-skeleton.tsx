import { AppPageHeaderSkeleton } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";

/**
 * The project page before its data, in the project page's own shape.
 *
 * ONE component, rendered by both things that draw it: the route's
 * `loading.tsx` (shown during the route transition) and the page's own
 * `!data` branch (shown while the client fetch is in flight). They are two
 * moments in the same load and the reader sees them back to back, so they
 * agree by sharing a component, not by two files holding the same numbers.
 *
 * The page is two tracks from the top (project/[id]/page.tsx): the header,
 * composer and chats on the left, the knowledge panel on the right with its
 * top level with the title. On a phone the panel stacks under the composer,
 * as the page does.
 *
 * The caller supplies the `<AppPage measure="wide">` frame and the
 * `role="status"` on it, so this emits no landmark of its own.
 */
export function ProjectPageSkeleton() {
  return (
    <div className="flex flex-col gap-6 @4xl/page:grid @4xl/page:grid-cols-[minmax(0,1fr)_20rem] @4xl/page:items-start @4xl/page:gap-10 @6xl/page:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0">
        {/* `nav`: the header opens with its back link and the breadcrumbs. */}
        <AppPageHeaderSkeleton nav headingWidth="w-72" actions />
        <Skeleton
          className="h-28 w-full rounded-panel [animation-fill-mode:backwards] motion-safe:animate-rise-in"
          style={staggerDelay(0)}
        />
        <Skeleton
          className="mt-10 h-9 w-full max-w-sm rounded-control [animation-fill-mode:backwards] motion-safe:animate-rise-in"
          style={staggerDelay(1)}
        />
        <div className="mt-4 space-y-1">
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
        className="h-80 w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
        style={staggerDelay(1)}
      />
    </div>
  );
}
