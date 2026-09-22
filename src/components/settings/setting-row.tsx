import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { SaveStatus, type SaveState } from "@/components/settings/save-status";
import { cn } from "@/lib/utils";

/**
 * The shapes every settings section is built from.
 *
 *   <SettingsGroup>   a plain title and a one-line note, then rows on hairlines.
 *   <SettingRow>      label and description on the left, the control on the
 *                     right and vertically centred.
 *   <SettingBlock>    a labelled full-width control (a textarea, a list) that
 *                     needs the whole measure.
 *
 * Flat, on purpose. The rows sit directly on the pane (the modal is already a
 * floating surface, the page column already has its frame), hierarchy comes
 * from weight and size, and the only lines are the hairlines between rows.
 *
 * The type ladder, top down: the pane's section name at `text-title`, a
 * group's title at `text-body` semibold, a row's label at `text-body` medium,
 * and every note, group or row, at `text-ui` in muted ink. A group's note is
 * deliberately quieter than the rows under it; it used to be `text-body`, as
 * loud as the labels it introduced. The group title was a 12px mono eyebrow,
 * which read as developer metadata rather than as the name of a group.
 */
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
    <section
      className={cn(
        "pt-9 first:pt-0",
        tone === "destructive" && "mt-3 border-t border-border first:mt-0 first:border-t-0",
        className
      )}
    >
      {hasHeader && (
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 pb-1">
          <div className="min-w-0">
            {title != null && <h3 className="text-body font-semibold text-foreground">{title}</h3>}
            {description && <p className="mt-0.5 max-w-prose text-ui text-muted-foreground">{description}</p>}
          </div>
          {aside}
        </div>
      )}
      <div className="divide-y divide-border/60">{children}</div>
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
  const Label = htmlFor ? "label" : "p";
  return (
    <div className={cn("py-4", className)}>
      <div
        className={cn(
          "flex items-center justify-between gap-x-6 gap-y-3",
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
          {description && <p className="mt-0.5 text-ui text-muted-foreground">{description}</p>}
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
  return (
    <div className={cn("py-4", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <p className="text-body font-medium text-foreground">{label}</p>
            {status !== undefined && <SaveStatus state={status} />}
          </div>
          {description && <p className="mt-0.5 text-ui text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

/**
 * The pane's opening: the section's name, and nothing else.
 *
 * It used to carry a lede and a full-width rule. The lede was a table of
 * contents for the groups directly below it ("Theme, accent, language and
 * text size." over groups titled Appearance and Language), and on the page
 * the rule sat 80px under the page header's own. The groups name themselves.
 */
export function SettingsPaneHeader({ title }: { title: React.ReactNode }) {
  return (
    <header className="mb-7">
      <h2 className="text-title">{title}</h2>
    </header>
  );
}

/**
 * The pane header's placeholder, drawn from the header's own metrics.
 * `h-[1.25em]` on an element carrying `text-title` is that rung's line box
 * expressed in the token itself, so the placeholder cannot drift from the
 * heading it stands in for.
 */
export function SettingsPaneHeaderSkeleton() {
  return (
    <header className="mb-7" aria-hidden="true">
      <Skeleton className="h-[1.25em] w-32 text-title" />
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
