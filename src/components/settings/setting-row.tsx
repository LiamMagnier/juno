import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The three shapes every settings section is built from.
 *
 *   <SettingsGroup>   an eyebrow, an optional lede, then rows on hairlines.
 *   <SettingRow>      label + description on the left, the control on the
 *                     right; stacks when the control is wide.
 *   <SettingBlock>    a labelled full-width control (a picker grid, a
 *                     textarea) that needs the whole measure.
 *
 * Flat, on purpose. The rows sit directly on the pane — the modal is already
 * a floating surface and the page column already has its frame — and the
 * depth is spent on the controls themselves (inset wells, raised tiles),
 * which is where the Soft UI brief says it belongs.
 */
export function SettingsGroup({
  title,
  description,
  aside,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Trailing content on the title row — a save status, a count, a link. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("py-6 first:pt-0", className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="font-mono text-label text-muted-foreground">{title}</h3>
          {description && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </div>
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
            className={cn("block text-sm font-medium", tone === "destructive" ? "text-destructive-ink" : "text-foreground")}
          >
            {label}
          </Label>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
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
          <p className="text-sm font-medium text-foreground">{label}</p>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
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
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
    </header>
  );
}
