import type { IconComponent } from "@/components/ui/icons";
import { EmptyMark } from "@/components/ui/empty-mark";

import { cn } from "@/lib/utils";

/**
 * The shape of "there is nothing here yet", and of "that did not load"
 * (spec §6.13).
 *
 * ANATOMY. A neutral dot-construction mark (48px on a page, 32 in a panel), a
 * Newsreader title (the page-title rung on a page, 22px in a panel), a 15px
 * muted body capped at 44ch, one primary action and an optional quiet one.
 *
 *   "page"   The state owns the content column, so it is drawn OPEN: no box,
 *            no edge.
 *   "panel"  The state sits inside a card, a sidebar section or a list: a
 *            tonal recess (muted, radius 16), never dashed — a dashed well
 *            reads as a drop zone.
 *
 * An ERROR keeps a glyph instead of the mark (`icon`, tinted destructive, with
 * the circle-x vocabulary of status), a solid hairline instead of the recess,
 * and role="status": a failure is not a placeholder and must not look like
 * one.
 *
 * THE PAGE TITLE IS AN `<h2>`: the route's `<h1>` is the page header above
 * it. A panel's title stays a paragraph.
 *
 * It arrives on the workhorse entrance (`rise-in`): an empty state appears
 * because the reader filtered, searched or opened something. Reduced motion
 * keeps the fade; the mark is static.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  tone = "empty",
  size = "page",
  className,
}: {
  icon?: IconComponent;
  title: React.ReactNode;
  /** One or two sentences. Say what would put something here, not just that it is empty. */
  description?: React.ReactNode;
  /** The one primary action: create the first one, or retry. */
  action?: React.ReactNode;
  /** An optional quiet second action. */
  secondaryAction?: React.ReactNode;
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
        page ? "px-6 py-16" : cn("rounded-panel px-4 py-7", isError ? "border border-border bg-background" : "bg-muted"),
        className
      )}
      data-empty-state={size}
      // A failed load is a status message; an empty list is just the page.
      role={isError ? "status" : undefined}
    >
      {isError ? (
        Icon && (
          <span
            aria-hidden="true"
            className={cn(
              "grid shrink-0 place-items-center bg-destructive/10 text-destructive",
              page ? "size-12 rounded-field" : "size-8 rounded-control"
            )}
          >
            <Icon motion="none" className={page ? "size-6" : "size-4"} />
          </span>
        )
      ) : (
        <EmptyMark size={size} />
      )}
      <Title
        className={cn(
          "text-balance font-serif text-foreground",
          page ? "text-page-title" : "text-title font-normal",
          (Icon || !isError) && (page ? "mt-4" : "mt-3")
        )}
      >
        {title}
      </Title>
      {description && <p className={cn("max-w-[44ch] text-pretty text-body text-muted-foreground", page ? "mt-2" : "mt-1")}>{description}</p>}
      {(action || secondaryAction) && (
        // An empty state's actions are where the page sends you next, so their glyphs answer the pointer (icons.css).
        <div data-jicon-articulate="within" className={cn("flex flex-wrap items-center justify-center gap-2", page ? "mt-6" : "mt-4")}>
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
