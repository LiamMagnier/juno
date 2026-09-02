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
          {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
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
 * Rows are hover-raised — a transparent border at rest, the raised surface on
 * hover — and on a bare page a stack of them has no edge to read as a list.
 * This is the inset frame the sidebar uses for the same job: a recess the rows
 * sit in, `rounded-card` outside with `p-1.5` so the `rounded-control` rows
 * inside are concentric with it.
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
