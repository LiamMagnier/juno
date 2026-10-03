import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { SaveStatus, type SaveState } from "@/components/settings/save-status";
import { Button } from "@/components/ui/button";
import { StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * The shapes every settings section is built from.
 *
 *   <SettingsGroup>   a plain title and a one-line note above a grouped card of
 *                     rows on hairlines.
 *   <SettingRow>      label and description on the left, the control on the
 *                     right and vertically centred.
 *   <SettingBlock>    a labelled full-width control (a textarea, a list) that
 *                     needs the whole measure.
 *
 * GROUPED, since the premium pass. The rows used to sit directly on the pane,
 * which made a group a heading followed by lines, and on a long section the
 * eye could not tell where one group stopped and the next began without
 * reading the headings. Each group's rows now sit in one card (the raised
 * rung's hairline and contact shadow, `rounded-card`, a 16px inset), with the
 * group's title and note ABOVE the card, not inside it. That is the shape the
 * Mac's settings already have (`.formStyle(.grouped)` in DesktopSettingsScreen
 * and a `DesktopSettingsGroupHeader` over each section), so the two clients
 * now draw one picture. The only lines inside a card are the hairlines between
 * its rows.
 *
 * The type ladder, top down (the editorial pass, October 2026): the pane's
 * section name in the serif at `ed-h2` with a one-line lede under it, a
 * group's title in the serif at `ed-h3`, a row's label at `text-body` medium,
 * and every note, group or row, at `text-ui` in muted ink. The serif is the
 * document voice the editorial pages (Memory, Instructions, Routines) set, so
 * settings read as the same kind of page; the rows and their controls stay in
 * the interface sans. The `ed-*` classes come from editorial.css, which
 * settings-pane.tsx loads (this module stays free of CSS imports so the
 * render tests can load it under plain Node).
 */
/**
 * The grouped card a SettingsGroup draws its rows in. Exported so a skeleton
 * (settings/loading.tsx) stands its placeholder rows in the same card.
 */
export const SETTINGS_CARD_CLASS = "surface-raised divide-y divide-border/60 rounded-card px-4";

export function SettingsGroup({
  title,
  description,
  aside,
  tone = "default",
  children,
  className,
}: {
  /**
   * Optional, because a pane's FIRST group often has nothing to say that the
   * section's name did not just say. An untitled group is rows on hairlines
   * directly under the pane header, with no header block and no margin
   * reserved for one.
   */
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Trailing content on the title row: a count, a link. */
  aside?: React.ReactNode;
  /**
   * `destructive` is the group of irreversible actions at the bottom of a
   * section. It is set apart by a full-width rule and extra space rather than
   * by a red box: the rows' own destructive ink says what they are.
   */
  tone?: "default" | "destructive";
  children: React.ReactNode;
  className?: string;
}) {
  // `Boolean(description)`, not `!= null`: a call site that passes
  // `description={cond && "…"}` hands `false` in, and an untitled group would
  // then reserve an empty header block.
  const hasHeader = title != null || Boolean(description) || aside != null;
  return (
    // The irreversible group stands a little further off the groups above it.
    <section className={cn("pt-10 first:pt-0", tone === "destructive" && "pt-14", className)}>
      {hasHeader && (
        <div className="flex items-end justify-between gap-x-6 gap-y-1 pb-3">
          <div className="min-w-0 flex-1">
            {title != null && <h3 className="ed-h3 text-foreground">{title}</h3>}
            {description && <p className="mt-1 max-w-[36rem] text-pretty text-ui text-muted-foreground">{description}</p>}
          </div>
          {aside && <div className="flex shrink-0 items-center gap-3">{aside}</div>}
        </div>
      )}
      {/* The irreversible group keeps the same card: its rows' destructive
          ink says what they are, and a red box would read as an error. */}
      <div className={SETTINGS_CARD_CLASS}>{children}</div>
    </section>
  );
}

/**
 * One setting.
 *
 * A compact control (a switch, a button, a short menu) stays on the right at
 * every width, and the label wraps instead. A `wide` control (a select, a
 * segmented control, a slider, a row of swatches) sits on the right once the
 * pane has 34rem, and below the label at full width under that: a 13rem
 * select beside a label in a 248px phone pane left the label no room at all.
 * The breakpoint reads `@container/pane`, which the modal and the page both
 * declare; outside a pane a wide row simply stacks.
 *
 * `status` is the row's save confirmation (see `useSaveStates`), drawn beside
 * the label and outside the <label> element so it never becomes part of the
 * control's accessible name.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  control,
  wide = false,
  status,
  tone = "default",
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Wire the label to the control's id when the control is a native field. */
  htmlFor?: string;
  control?: React.ReactNode;
  /** The control needs width of its own; it drops under the label on a narrow pane. */
  wide?: boolean;
  status?: SaveState;
  tone?: "default" | "destructive";
  /** Full-width content under the label row: a note, a nested list. */
  children?: React.ReactNode;
  className?: string;
}) {
  // A <div>, not a <p>, when there is no field to point at: a label is often
  // more than words (a lab's mark, an "On" badge), and a badge's <div> inside
  // a <p> is invalid HTML that React reports as a hydration error.
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={cn("py-4", className)}>
      <div
        className={cn(
          "flex items-center justify-between gap-x-8 gap-y-3",
          wide && "flex-col items-stretch @[34rem]/pane:flex-row @[34rem]/pane:items-center"
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <Label
              htmlFor={htmlFor}
              className={cn(
                "text-body font-medium",
                tone === "destructive" ? "text-destructive-ink" : "text-foreground"
              )}
            >
              {label}
            </Label>
            {status !== undefined && <SaveStatus state={status} />}
          </div>
          {description && <p className="mt-0.5 max-w-[34rem] text-pretty text-ui text-muted-foreground">{description}</p>}
        </div>
        {control && (
          <div className={cn("flex shrink-0 items-center gap-2", wide && "min-w-0 @[34rem]/pane:justify-end")}>
            {control}
          </div>
        )}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function SettingBlock({
  label,
  description,
  aside,
  status,
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  status?: SaveState;
  children: React.ReactNode;
  className?: string;
}) {
  // Label above the control, helper text below it: the form order, for the
  // one row shape that holds a real field (a textarea, a list). Read top to
  // bottom it is name, the thing, then what the thing does, which is also
  // the order a screen reader meets them in.
  return (
    <div className={cn("py-4", className)}>
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
          <p className="text-body font-medium text-foreground">{label}</p>
          {status !== undefined && <SaveStatus state={status} />}
        </div>
        {aside}
      </div>
      {children}
      {description && <p className="mt-2 text-ui text-muted-foreground">{description}</p>}
    </div>
  );
}

/**
 * The pane's opening: the section's name in the serif, and one line on what
 * the section is FOR (not a list of the groups under it, which name
 * themselves). The lede is optional: a caller with nothing to add passes none.
 */
export function SettingsPaneHeader({ title, lede }: { title: React.ReactNode; lede?: React.ReactNode }) {
  return (
    <header className="mb-10">
      <h2 className="ed-h2 text-foreground">{title}</h2>
      {lede && <p className="mt-2 max-w-[34rem] text-pretty text-body text-muted-foreground">{lede}</p>}
    </header>
  );
}

/**
 * The pane header's placeholder, drawn from the header's own metrics.
 * `h-[1.15em]` on an element carrying `ed-h2` is that heading's line box
 * expressed in the class itself, and the lede bar is one `text-body` line at
 * the lede's `mt-2`, so the placeholder cannot drift from what replaces it.
 */
export function SettingsPaneHeaderSkeleton() {
  return (
    <header className="mb-10" aria-hidden="true">
      <Skeleton className="h-[1.15em] w-40 ed-h2" />
      <Skeleton className="mt-2 h-[1.6em] w-80 max-w-full rounded-xs text-body" />
    </header>
  );
}

/**
 * One SettingRow's placeholder, drawn from the row's own metrics: `py-4`
 * around a `text-body` label (1.6em) over a `text-ui` description (1.5em) at
 * `mt-0.5`. Stack these under `divide-y divide-border/60`, as SettingsGroup
 * stacks the real rows, and the pane lands on its own outline.
 */
export function SettingRowSkeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cn("py-4", className)} style={style} aria-hidden="true">
      <Skeleton className="h-[1.6em] w-40 max-w-full rounded-xs text-body" />
      <Skeleton className="mt-0.5 h-[1.5em] w-64 max-w-full rounded-xs text-ui" />
    </div>
  );
}

/**
 * A read that failed, inside a group's card: what did not load, in the
 * destructive ink with the error mark, and a Try again beside it.
 *
 * One shape for every section. There were four: a panel empty state (a
 * dashed box inside the card, twice on Connectors), a red line with an icon
 * (Shared links), a muted sentence (usage History) and the Work list's own
 * error block (Devices). An inline failure is an attention state, so it gets
 * the colour and the small mark and no container of its own.
 */
export function SettingsInlineError({ children, onRetry }: { children: React.ReactNode; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4" role="status">
      <p className="flex min-w-0 items-start gap-1.5 text-ui text-destructive-ink">
        <StatusIcons.error className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{children}</span>
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="ml-auto">
          Try again
        </Button>
      )}
    </div>
  );
}
