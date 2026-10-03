import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * The quiet pieces every Customize tab (Apps, Skills, Routines, Instructions)
 * is built from, so the four read as one place: the shared page header with a
 * tighter serif, small stacked sections, and hairline lists.
 *
 * Deliberately plain. A section is a small Inter title, an optional count or
 * note beside it, an optional control on the right, and its content below:
 * no margin column, no display serif per section, no figures.
 */

/**
 * Passed to `AppPageHeader` on these tabs: the homepage's display tracking and
 * optical sizing on the serif title, and the 32px step from header to toolbar every tab shares.
 */
export const customizeHeaderClass =
  "mb-8 @[40rem]/page:mb-8 [&_h1]:tracking-[-0.03em] [&_h1]:[font-optical-sizing:auto]";

/**
 * A list on a hairline: 1px at foreground 8% around it and 6% between rows,
 * clipping the rows' tonal hover to its corners. The rows stay square inside.
 */
export const customizeListClass =
  "overflow-hidden rounded-card border border-foreground/[0.08] divide-y divide-foreground/[0.06]";

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
        <h2 id={headingId} className="flex min-w-0 items-baseline gap-2 text-ui font-medium text-foreground">
          <span className="truncate">{title}</span>
          {meta != null && <span className="shrink-0 font-normal tabular-nums text-muted-foreground">{meta}</span>}
        </h2>
        {controls && <div className="flex shrink-0 items-center gap-2">{controls}</div>}
      </div>
      {children}
    </section>
  );
}
