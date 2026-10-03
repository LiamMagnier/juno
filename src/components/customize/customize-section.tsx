import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * The pieces every Customize tab (Apps, Skills, Routines, Instructions) is
 * built from, so the four read as one place, and as the same place as
 * Projects and Memory: the shared page header, sections titled in the serif
 * with their count in mono, and lists of rows on hairlines.
 *
 * Still plain. A section is a serif title at the tile-name rung (22px, the
 * size a project's name and a project page's "Folders" and "Chats" use), an
 * optional count or note beside it in mono, an optional control on the right,
 * and its content below: no margin column, no display serif, no figures.
 */

/**
 * Passed to `AppPageHeader` on these tabs: the homepage's display tracking and
 * optical sizing on the serif title, and the 32px step from header to toolbar every tab shares.
 */
export const customizeHeaderClass =
  "mb-8 @[40rem]/page:mb-8 [&_h1]:tracking-[-0.03em] [&_h1]:[font-optical-sizing:auto]";

/**
 * A list of rows on hairlines (editorial.css `.ed-list`): no box round it, a
 * 1px rule between rows that steps aside under a hovered row, and rows that
 * keep their own `rounded-control` hover fill. Pulled out by the rows' 12px
 * inset (`-mx-3`), so a row's text lines up with the section title above it
 * rather than sitting a gutter in from it.
 */
export const customizeListClass = "ed-list -mx-3";

/** A field's resting edge on these tabs: a hairline that firms on hover and focus. */
export const customizeFieldClass =
  "border-foreground/[0.1] hover:border-foreground/20 focus-visible:border-foreground/35";

/** How a row arrives on first load: a 6px rise, dealt on the shared stagger. */
export const customizeEnterClass = "motion-safe:animate-rise-in [animation-fill-mode:backwards]";

export function CustomizeSection({
  title,
  meta,
  controls,
  children,
  className,
  id,
}: {
  title: React.ReactNode;
  /** A count or a short note, muted beside the title. */
  meta?: React.ReactNode;
  /** A save state or a small action, on the title's line at the right. */
  controls?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} id={id} className={cn("min-w-0", className)}>
      <div className="mb-4 flex min-h-6 items-center justify-between gap-3">
        <h2 id={headingId} className="flex min-w-0 items-baseline gap-2 text-foreground">
          <span className="customize-title truncate">{title}</span>
          {meta != null && <span className="ed-annot shrink-0">{meta}</span>}
        </h2>
        {controls && <div className="flex shrink-0 items-center gap-2">{controls}</div>}
      </div>
      {children}
    </section>
  );
}
