import * as React from "react";
import { cn } from "@/lib/utils";
import "@/components/projects/projects.css";

/**
 * The project Settings tab's one shape: a card holding a head (what the
 * group is for, with at most one action on its right), rows divided by
 * hairlines with the label in a fixed left column and the control on the
 * right, and an optional footer where the group's Save sits on the right.
 *
 * Every control in a row is the field height (h-9), and the label column's
 * `pt-2` puts a 20px label line on the centre of a 36px control, so labels and
 * fields read across on one line. Under ~36rem of card the label stacks above
 * its control instead (a container query on the card, not the window).
 */
export function SettingsGroup({
  title,
  description,
  action,
  footer,
  children,
  className,
  style,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    // A hairline card (12) with a 4px frame. The footer's Save sits on the
    // frame in the bottom corner, so its control radius (8) is 12 - 4.
    <section className={cn("pj pj-card nest-card nest-p-1 @container/group", className)} style={style}>
      <div className="flex items-start justify-between gap-4 px-4 pb-4 pt-4">
        <div className="min-w-0">
          <h2 className="pj-name text-foreground">{title}</h2>
          {description && (
            <p className="mt-1.5 max-w-prose text-pretty text-ui text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
      {footer && (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[var(--pj-hair)] pl-4 pt-1">
          {footer}
        </div>
      )}
    </section>
  );
}

/**
 * One labelled row. `as="label"` (the default) makes the whole row the
 * control's label, so a click on the words focuses or opens the field; pass
 * `as="div"` when the right side holds more than one control.
 */
export function SettingsRow({
  label,
  as: Tag = "label",
  children,
  className,
}: {
  label: React.ReactNode;
  as?: "label" | "div";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        "grid gap-x-8 gap-y-2 border-t border-[var(--pj-hair)] px-4 py-4 @[36rem]/group:grid-cols-[12rem_minmax(0,1fr)]",
        className
      )}
    >
      <span className="text-ui font-medium text-foreground @[36rem]/group:pt-2">{label}</span>
      <span className="block min-w-0">{children}</span>
    </Tag>
  );
}

/** The quiet line under a row's control. */
export function SettingsHint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("mt-2 block text-pretty text-caption leading-relaxed text-muted-foreground", className)}>{children}</span>;
}
