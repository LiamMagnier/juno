import type { IconComponent } from "@/components/ui/icons";

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
 *
 * THE GLYPH SITS IN A TILE (docs/design/ICONS_AND_MOTION.md §3): one muted
 * mark on a small card-fill square with a hairline, the way Claude and Linear
 * set theirs. A bare glyph floating over a sentence read as a stray icon; in a
 * tile it reads as the object the page is about, set down where the content
 * will be. The tile is the only thing with a fill in the well, so it is the
 * one place the eye lands, and the sentence under it does the rest.
 *
 * The mark does not articulate (`motion="none"`): an empty state is sometimes
 * rendered inside a link or a clickable row, and a glyph that tilts because
 * the page around it is hoverable is saying something about an action that
 * is not there.
 *
 * It arrives on the workhorse entrance (`rise-in`) — an empty state appears
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
  /** The thing that resolves it — create the first one, or retry. */
  action?: React.ReactNode;
  tone?: "empty" | "error";
  size?: "panel" | "page";
  className?: string;
}) {
  const isError = tone === "error";
  const page = size === "page";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center motion-safe:animate-rise-in",
        // `border-dashed` is a utility, so it wins the border-style over
        // `.surface-inset`'s shorthand while the recess and fill stay.
        isError
          ? "rounded-card border border-solid border-destructive/35 bg-destructive/[0.07]"
          : "surface-inset rounded-card border-dashed border-border/80",
        page ? "min-h-64 px-6 py-12" : "px-4 py-7",
        className
      )}
      // A failed load is a status message; an empty list is just the page.
      role={isError ? "status" : undefined}
    >
      {Icon && (
        <span
          aria-hidden="true"
          className={cn(
            "grid shrink-0 place-items-center border",
            page ? "size-12 rounded-field" : "size-9 rounded-control",
            isError
              ? "border-destructive/25 bg-destructive/[0.06] text-destructive"
              : "border-border/70 bg-card text-muted-foreground"
          )}
        >
          <Icon motion="none" className={page ? "size-6" : "size-5"} />
        </span>
      )}
      <p
        className={cn(
          "font-semibold tracking-[-0.01em]",
          page ? "text-body-lg" : "text-body",
          Icon && (page ? "mt-4" : "mt-3"),
          isError && "text-destructive"
        )}
      >
        {title}
      </p>
      {description && (
        <p className="mt-1.5 max-w-sm text-pretty text-body text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
