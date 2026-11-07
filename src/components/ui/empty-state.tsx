import type { IconComponent } from "@/components/ui/icons";

import { cn } from "@/lib/utils";

/** Empty lists and recoverable failures share a readable title and next action.
 * Page states stay open; panel states use a quiet inset. Errors are announced
 * as status messages, while ordinary emptiness stays out of live regions.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "empty",
  size = "page",
  className,
}: {
  icon?: IconComponent;
  title: React.ReactNode;
  /** One or two sentences. Say what would put something here, not just that it is empty. */
  description?: React.ReactNode;
  /** The thing that resolves it: create the first one, or retry. */
  action?: React.ReactNode;
  tone?: "empty" | "error";
  size?: "panel" | "page";
  className?: string;
}) {
  const isError = tone === "error";
  const page = size === "page";
  const Title = page ? "h2" : "p";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center motion-safe:animate-rise-in",
        page
          ? "px-6 py-16"
          : cn(
              "rounded-card px-4 py-7",
              isError ? "border border-border/80 bg-background" : "empty-well"
            ),
        className
      )}
      // A failed load is a status message; an empty list is just the page.
      role={isError ? "status" : undefined}
    >
      {isError ? (
        Icon && (
          <span
            aria-hidden="true"
            className={cn(
              "grid shrink-0 place-items-center bg-destructive/10 text-destructive",
              page ? "size-12 rounded-field" : "size-9 rounded-control"
            )}
          >
            <Icon motion="none" className={page ? "size-6" : "size-5"} />
          </span>
        )
      ) : null}
      <Title
        className={cn(
          "text-balance text-foreground",
          page ? "ed-h3" : "text-heading font-medium",
          isError && Icon && (page ? "mt-4" : "mt-3")
        )}
      >
        {title}
      </Title>
      {description && (
        <p className={cn("max-w-sm text-pretty text-muted-foreground", page ? "mt-2 text-body" : "mt-1 text-ui")}>
          {description}
        </p>
      )}
      {action && (
        // An empty state's actions are where the page sends you next, so their glyphs answer the pointer (icons.css).
        <div data-jicon-articulate="within" className={cn("flex flex-wrap items-center justify-center gap-2", page ? "mt-6" : "mt-4")}>
          {action}
        </div>
      )}
    </div>
  );
}
