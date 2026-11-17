import * as React from "react";
import { cn } from "@/lib/utils";
import { fieldSurfaceClass } from "@/components/ui/field-recipe";

/*
 * The pieces every Customize tab (Apps, Skills, Routines, Instructions) is
 * built from, so the four read as one place, and as the same place as
 * Projects and Memory: the shared page header, sections titled the way the
 * Settings groups are (`body` 15/500, a muted count beside), and lists of rows
 * on hairlines.
 *
 * Still plain. A section is a title, an optional count or note beside it,
 * an optional control on the right, and its content below: no margin column,
 * no display serif, no figures.
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

/**
 * Customize keeps the shared field material; callers vary geometry only.
 */
export const customizeFieldClass = fieldSurfaceClass;

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
          {/* The Settings groups' title (setting-row.tsx, SettingsGroup:
              `body` 15/500), so a section reads the same on every Customize
              tab and in Settings; its count in the same face, muted, not a
              mono side-note (owner, 17 Nov 2026). */}
          <span className="truncate text-body font-medium">{title}</span>
          {meta != null && <span className="shrink-0 text-body font-normal tabular-nums text-muted-foreground">{meta}</span>}
        </h2>
        {controls && <div className="flex shrink-0 items-center gap-2">{controls}</div>}
      </div>
      {children}
    </section>
  );
}
