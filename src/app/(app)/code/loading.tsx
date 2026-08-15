import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/code` while the shell resolves.
 *
 * The page's own shape, not a spinner: a placeholder that reserves the room the
 * header, the view switcher and the first four rows will occupy means nothing
 * jumps when the data lands. The rows come up on the shared stagger (STAGGER in
 * src/lib/motion.ts) rather than repainting as one flat block.
 */
export default function CodeRunsLoading() {
  return (
    // role="status" with a label rather than aria-hidden: a screen-reader user
    // is owed the same "this is loading" the sighted reader gets from the
    // shimmer.
    <div className="app-page-scroll" role="status" aria-label="Loading your Juno Code runs">
      <div className="app-page-content max-w-6xl">
        <div className="mb-6 border-b border-border pb-5">
          <Skeleton className="mb-3 h-8 w-24 rounded-control" />
          <Skeleton className="h-9 w-48 rounded-control" />
          <Skeleton className="mt-2 h-4 w-full max-w-md rounded-control" />
        </div>
        <Skeleton className="mb-5 h-11 w-64 rounded-menu" />
        <Skeleton className="mb-4 h-9 w-full rounded-field" />
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton
              key={i}
              className="h-[112px] w-full rounded-card"
              style={{ animationDelay: `${i * 60}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
