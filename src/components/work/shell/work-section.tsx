import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A labelled block of Work's home page.
 *
 * Extracted from `work-session-row.tsx`, which no longer exists: that file was
 * a grouped list's row plus the section wrapper around it, and when the list
 * became an inbox the row was replaced and the wrapper was not. Leaving the
 * wrapper in a file named after a deleted component is the kind of thing that
 * makes a directory unreadable a year later.
 *
 * `meta` is the count, and it goes beside the title rather than under it: a
 * heading that says how many things are beneath it is the most useful two
 * characters on this page.
 *
 * `tone="attention"` is spent on at most one section at a time, and the
 * restraint is the point. Coral means "happening now" everywhere in Work and
 * amber means "this has stopped and is waiting on a person"; if a second
 * section were also coloured there would be no colour left to mean the second
 * thing.
 *
 * Server component — no state, no handlers, no client bundle.
 */
export function WorkSection({
  title,
  hint,
  meta,
  tone = "neutral",
  action,
  /**
   * Overrides the gap above. The default is the rhythm the Work home is set in
   * and is what every caller should want; it is overridable because a stack of
   * these under a shared heading needs a smaller first gap than a section
   * standing on its own.
   */
  className,
  children,
}: {
  title: string;
  hint?: string;
  /** A short mono fact — the count of rows below. Never a sentence. */
  meta?: string | null;
  tone?: "neutral" | "attention";
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const attention = tone === "attention";
  return (
    <section className={cn("mt-8", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          {/* `text-heading`, the rung every in-page section title in the app
              sits on, with the count beside it in the metadata face. */}
          <h2 className="flex items-baseline gap-2">
            <span className={cn("text-heading", attention && "text-warning-foreground")}>{title}</span>
            {meta != null && meta.length > 0 && (
              <span
                className={cn(
                  "font-mono text-caption tabular-nums",
                  attention ? "text-warning-foreground/80" : "text-muted-foreground"
                )}
              >
                {meta}
              </span>
            )}
          </h2>
          {hint && <p className="mt-1 text-ui text-muted-foreground">{hint}</p>}
        </div>
        {action != null && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * The well a list of rows sits in.
 *
 * Rows are text on the well at rest — a transparent border, no fill — and take
 * a tonal fill on hover (`workRowClass`), so on a bare page a stack of them has
 * no edge to read as a list without this. It is the inset frame the sidebar
 * uses for the same job: a recess the rows sit in, `rounded-card` outside with
 * `p-1.5` so the `rounded-control` rows inside are concentric with it.
 */
export function WorkList({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("surface-inset space-y-0.5 rounded-card p-1.5", className)} {...props}>
      {children}
    </div>
  );
}

/**
 * One row inside a `WorkList` — a Mac, a skill, an automation.
 *
 * The three rows are the same object in three lists and used to be three
 * bordered cards, each lifting a pixel on hover over a ring-offset focus halo.
 * Inside an inset well that was a card in a card: two hairlines, two radii, and
 * a lift that no other list in the product makes. They are now what a list row
 * is everywhere else (PREMIUM_AUDIT rule 3): text on the panel at rest, a tonal
 * cross-fade to `--accent` under the pointer, `--secondary` while pressed, and
 * the global `:focus-visible` outline for the keyboard. Nothing travels and
 * nothing scales — a full-width row is a surface, not a key.
 *
 * `px-3.5 py-3` over a title, a subtitle and a mono meta line is the geometry
 * `WorkRowSkeletons` is built to, so the placeholder and the row agree.
 */
export const workRowClass =
  "group flex items-start gap-3 rounded-control border border-transparent px-3.5 py-3 " +
  "transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none";

/**
 * A ghost control that sits inside a hover-filled row: Run now, Pause, Restore,
 * Remove. The row takes `--accent` under the pointer, which is also the ghost
 * button's own hover fill, so a hovered control in a hovered row showed no fill
 * of its own and only its ink changed. A translucent ink tint composes over
 * whatever the row is showing and lands a step past it in either theme. It is
 * the nested-control recipe the sidebar's row actions already use.
 */
export const workRowControlClass = "hover:bg-foreground/5 active:bg-foreground/10";

/** How a row arrives: dealt in on the shared stagger, holding its `from` frame while it waits. */
export const workRowEnterClass = "motion-safe:animate-rise-in [animation-fill-mode:backwards]";

/**
 * The trailing chevron that says a row opens a page.
 *
 * It fades in with the row's hover or focus rather than sitting in every row at
 * rest — a column of identical chevrons is the one mark on the list that says
 * nothing about its row. A short slide in from the left says where the press
 * goes; under reduced motion only the fade remains. On a touch screen, where
 * nothing hovers, it stays.
 */
export const workRowChevronClass =
  "mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 -translate-x-1 " +
  "transition-[opacity,transform] duration-fast ease-out-soft " +
  "group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100 " +
  "motion-reduce:translate-x-0 coarse:translate-x-0 coarse:opacity-100";
