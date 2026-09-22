import type { IconComponent } from "@/components/ui/icons";

import { cn } from "@/lib/utils";

/**
 * The shape of "there is nothing here yet", and of "that did not load".
 *
 * TWO SIZES, TWO FRAMES. `size` is about how much room the state is allowed
 * to take, not how important it is.
 *
 *   "page"   The state owns the content column, so it is drawn OPEN: no box,
 *            no edge, a glyph tile, a heading and a sentence on the page
 *            itself, the way Claude and ChatGPT draw theirs. It used to sit in
 *            a dashed recess the height of the column, which read as a drop
 *            zone for files rather than as an answer, and at page size the
 *            frame was the loudest thing on the screen.
 *
 *   "panel"  The state sits inside a card, a sidebar section or a list, where
 *            it needs a boundary to say where the empty part is. That is the
 *            one place the dashed well stays: a dashed recess reads as a space
 *            waiting to be filled.
 *
 * TWO TONES, and the difference is the tile, not the page. An error used to be
 * a red-tinted box with a red title, which reads as an alarm for what is
 * usually a retry. Now only the glyph tile takes the destructive tint; the
 * heading stays in foreground ink and the sentence under it says what happened
 * and what is safe. A panel error keeps a solid hairline instead of the dashed
 * one, because a failure is not a placeholder and must not look like one.
 *
 * THE GLYPH SITS IN A TILE (docs/design/ICONS_AND_MOTION.md §3): one muted
 * mark on a small tonal square, the way Claude and Linear set theirs. A bare
 * glyph floating over a sentence read as a stray icon; in a tile it reads as
 * the object the page is about. The mark does not articulate
 * (`motion="none"`): an empty state is sometimes rendered inside a link or a
 * clickable row, and a glyph that tilts because the page around it is
 * hoverable is saying something about an action that is not there.
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
 * keeps the fade.
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
          : // `border-dashed` / `border-solid` are utilities, so they win the
            // border-style over `.surface-inset`'s shorthand while its fill and
            // hairline colour stay.
            cn("surface-inset rounded-card px-4 py-7", isError ? "border-solid" : "border-dashed"),
        className
      )}
      // A failed load is a status message; an empty list is just the page.
      role={isError ? "status" : undefined}
    >
      {Icon && (
        <span
          aria-hidden="true"
          className={cn(
            "grid shrink-0 place-items-center",
            page ? "size-12 rounded-field" : "size-9 rounded-control",
            isError ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground"
          )}
        >
          <Icon motion="none" className={page ? "size-6" : "size-5"} />
        </span>
      )}
      <Title
        className={cn(
          "text-foreground",
          page ? "text-heading" : "text-body font-semibold",
          Icon && (page ? "mt-4" : "mt-3")
        )}
      >
        {title}
      </Title>
      {description && (
        <p className={cn("max-w-sm text-pretty text-body text-muted-foreground", page ? "mt-1.5" : "mt-1")}>
          {description}
        </p>
      )}
      {action && (
        <div className={cn("flex flex-wrap items-center justify-center gap-2", page ? "mt-6" : "mt-4")}>{action}</div>
      )}
    </div>
  );
}
