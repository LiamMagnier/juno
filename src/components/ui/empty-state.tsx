import type { IconComponent } from "@/components/ui/icons";
import { EmptyMark } from "@/components/ui/empty-mark";

import { cn } from "@/lib/utils";

/**
 * The shape of "there is nothing here yet", and of "that did not load".
 *
 * TWO SIZES, TWO FRAMES. `size` is about how much room the state is allowed
 * to take, not how important it is.
 *
 *   "page"   The state owns the content column, so it is drawn OPEN: no box,
 *            no edge, the brand's mark, a serif line and a sentence on the
 *            page itself.
 *
 *   "panel"  The state sits inside a card, a sidebar section or a list, where
 *            it needs a boundary to say where the empty part is: a quiet
 *            tonal recess with an inner hairline, the ground a project's
 *            cover plate sits on. It used to be a dashed well, which read as
 *            a drop zone (and a placeholder tile) rather than an answer.
 *
 * THE MARK, NOT A GLYPH IN A TILE. An empty state draws the construction in
 * miniature (empty-mark.tsx): three orbits on the number line and the
 * presence trajectory, in the same dot matrix as Home, Memory and the
 * Projects covers. A glyph in a tonal square was the generic shape every app
 * draws; `icon` is still accepted, and still used, but only by an ERROR,
 * where the glyph takes the destructive tint and says what kind of thing
 * failed. A failure is not a placeholder and must not look like one, so an
 * error panel keeps a solid hairline instead of the recess.
 *
 * THE TITLE IS SERIF. Newsreader is the family for the few things meant to be
 * read as a sentence (editorial.css); "No routines yet" is one. Page size
 * takes `ed-h3`, panel size the 18px rung the folder tiles use.
 *
 * THE PAGE TITLE IS AN `<h2>`. The route's `<h1>` is the page header above it,
 * and a page whose only content is "No projects yet" has to list that line in
 * a screen reader's heading navigation, or the reader lands on an outline with
 * nothing under the title. A panel's title stays a paragraph: it is a line
 * inside a section, not a section of its own.
 *
 * It arrives on the workhorse entrance (`rise-in`): an empty state appears
 * because the reader filtered, searched or opened something, and a 6px settle
 * says "this is the answer" where a cut says "the page broke". Reduced motion
 * keeps the fade, and the mark is drawn still.
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
      ) : (
        <EmptyMark size={size} />
      )}
      <Title
        className={cn(
          "text-balance text-foreground",
          page ? "ed-h3" : "font-serif text-heading",
          (Icon || !isError) && (page ? "mt-4" : "mt-3")
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
        <div className={cn("flex flex-wrap items-center justify-center gap-2", page ? "mt-6" : "mt-4")}>{action}</div>
      )}
    </div>
  );
}
