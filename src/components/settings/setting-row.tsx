import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The three shapes every settings section is built from.
 *
 *   <SettingsGroup>   an optional eyebrow and lede, then rows on hairlines.
 *   <SettingRow>      label + description on the left, the control on the
 *                     right; stacks when the control is wide.
 *   <SettingBlock>    a labelled full-width control (a picker grid, a
 *                     textarea) that needs the whole measure.
 *
 * Flat, on purpose. The rows sit directly on the pane — the modal is already
 * a floating surface and the page column already has its frame — and the
 * depth is spent on the controls themselves (inset wells, raised tiles),
 * which is where the Soft UI brief says it belongs.
 *
 * Two rungs of type, not four. A row is `text-body` (15) over `text-ui` (13):
 * the label one step above the controls beside it, the description on the
 * same rung as those controls. It used to be Tailwind's 14 over 12 — two
 * sizes the scale does not name, sitting between an 11px badge and a 13px
 * chip in the same row, which is what made a settings row read as four
 * sizes in three pixels.
 */
export function SettingsGroup({
  title,
  description,
  aside,
  children,
  className,
}: {
  /**
   * Optional, because a pane's FIRST group often has nothing to say that the
   * pane header did not just say. Memory opened with the h2 "Memory", the
   * registry lede, then a mono eyebrow "Memory" and a paraphrase of the same
   * lede — the one word at two rungs and two sentences that differed just
   * enough ("may remember" / "is allowed to remember about you") that a
   * careful reader stopped to look for a distinction that was not there. An
   * untitled group is rows on hairlines under the pane's own lede.
   */
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Trailing content on the title row — a save status, a count, a link. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  // `Boolean(description)`, not `!= null`, because the render below tests
  // truthiness: a call site that passes `description={cond && "…"}` (the
  // pattern voice.tsx uses on SettingRow) hands `false` in, and an untitled
  // group would then reserve an empty header block and its `mb-2` — the dead
  // space an untitled group exists to not have.
  const hasHeader = title != null || Boolean(description) || aside != null;
  return (
    <section className={cn("py-6 first:pt-0", className)}>
      {hasHeader && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            {title != null && <h3 className="font-mono text-label text-muted-foreground">{title}</h3>}
            {description && <p className="mt-1 max-w-prose text-body text-muted-foreground">{description}</p>}
          </div>
          {aside}
        </div>
      )}
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  htmlFor,
  control,
  tone = "default",
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Wire the label to the control's id when the control is a native field. */
  htmlFor?: string;
  control?: React.ReactNode;
  tone?: "default" | "destructive";
  /** Full-width content under the label row — a note, a nested list. */
  children?: React.ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "p";
  return (
    <div className={cn("py-3.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <Label
            htmlFor={htmlFor}
            className={cn("block text-body font-medium", tone === "destructive" ? "text-destructive-ink" : "text-foreground")}
          >
            {label}
          </Label>
          {description && <p className="mt-0.5 text-ui text-muted-foreground">{description}</p>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function SettingBlock({
  label,
  description,
  aside,
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("py-3.5", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-body font-medium text-foreground">{label}</p>
          {description && <p className="mt-0.5 text-ui text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** The pane's opening: the section name at heading size and its one-line lede. */
export function SettingsPaneHeader({ title, description }: { title: React.ReactNode; description?: React.ReactNode }) {
  return (
    <header className="mb-4 border-b border-border pb-4">
      <h2 className="text-title">{title}</h2>
      {description && <p className="mt-1 text-body text-muted-foreground">{description}</p>}
    </header>
  );
}

/**
 * The pane header's placeholder, drawn from the header's own metrics.
 *
 * `/settings/loading.tsx` used to hand-copy this block and got all three
 * numbers wrong: an `h-6` bar (24px) for a `text-title` line box that is
 * 1.375rem × 1.25 = 27.5px, an `h-4` bar (16px) for a `text-body` lede that is
 * 24px, and `mt-2` between them where the header has `mt-1`. The skeleton was
 * 48px of content against the header's 55.5, so everything under it dropped
 * 7.5px the moment the pane landed — under a comment promising that nothing
 * jumps. Same lesson as AppPageHeaderSkeleton: metrics copied by hand drift,
 * metrics shared by import cannot. `h-[1.25em]` on an element carrying
 * `text-title` is that rung's line box expressed in the token itself.
 */
export function SettingsPaneHeaderSkeleton() {
  return (
    <header className="mb-4 border-b border-border pb-4" aria-hidden="true">
      <Skeleton className="h-[1.25em] w-32 text-title" />
      <Skeleton className="mt-1 h-6 w-72 max-w-full rounded-xs" />
    </header>
  );
}

/**
 * One SettingRow's placeholder, drawn from the row's own metrics for the same
 * reason the header's is. `/settings/loading.tsx` stood four `h-16` cards on
 * `space-y-4` in for a pane that draws no cards at all: every section is rows
 * on hairlines, `py-3.5` around a `text-body` label (1.6em) over a `text-ui`
 * description (1.5em) at `mt-0.5`. Stack these under `divide-y
 * divide-border/60`, as SettingsGroup stacks the real rows, and the pane lands
 * on its own outline instead of a different page's.
 */
export function SettingRowSkeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cn("py-3.5", className)} style={style} aria-hidden="true">
      <Skeleton className="h-[1.6em] w-40 max-w-full rounded-xs text-body" />
      <Skeleton className="mt-0.5 h-[1.5em] w-64 max-w-full rounded-xs text-ui" />
    </div>
  );
}
