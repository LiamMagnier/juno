import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The shape of "there is nothing here yet", and of "that did not load".
 *
 * Two tones, because these are two different messages:
 *
 *   "empty"  Nothing is wrong. An inset dashed well — recessed into the page
 *            with a dashed edge, because a dashed recess reads as a space
 *            waiting to be filled rather than a thing that is finished.
 *
 *   "error"  Something failed. Solid border in the destructive tint, flat on
 *            the page: a failure is not a placeholder and must not look like
 *            one.
 *
 * `size` is about how much room the state is allowed to take, not how
 * important it is: `panel` for a state inside a card or a sidebar section,
 * `page` for one that owns the whole content column.
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
  icon?: LucideIcon;
  title: React.ReactNode;
  /** One or two sentences. Say what would put something here, not just that it is empty. */
  description?: React.ReactNode;
  /** The thing that resolves it — create the first one, or retry. */
  action?: React.ReactNode;
  tone?: "empty" | "error";
  size?: "panel" | "page";
  className?: string;
}) {
  const isError = tone === "error";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        // `border-dashed` is a utility, so it wins the border-style over
        // `.surface-inset`'s shorthand while the recess and fill stay.
        isError
          ? "rounded-card border border-solid border-destructive/35 bg-destructive/[0.07]"
          : "surface-inset rounded-card border-dashed border-border/80",
        size === "page" ? "min-h-64 px-6 py-12" : "px-4 py-7",
        className
      )}
      // A failed load is a status message; an empty list is just the page.
      role={isError ? "status" : undefined}
    >
      {Icon && (
        <Icon
          className={cn(
            "shrink-0",
            size === "page" ? "size-5" : "size-4",
            isError ? "text-destructive/75" : "text-muted-foreground",
            // A lighter stroke for the empty-state glyph, as a CSS utility rather
            // than the `strokeWidth` prop: globals.css's optical ladder sets
            // stroke-width in CSS, which beats the attribute.
            "[stroke-width:1.5]"
          )}
          aria-hidden="true"
        />
      )}
      <p
        className={cn(
          "font-semibold tracking-[-0.01em]",
          size === "page" ? "text-base" : "text-sm",
          Icon && "mt-4",
          isError && "text-destructive"
        )}
      >
        {title}
      </p>
      {description && (
        <p className="mt-1.5 max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
