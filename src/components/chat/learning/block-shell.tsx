"use client";

/**
 * Shared chrome for the inline learning blocks (learning-card, process
 * timeline, comparison, quiz, deep dive). Purely presentational.
 *
 * Layout note: these render inside `.juno-visual`, whose prose reset
 * (globals.css) zeroes margins on p/h3/h4/ol/ul/li with higher specificity
 * than Tailwind margin utilities — so blocks space their internals with
 * flex/grid gaps and padding, never `mt-*` on those elements.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Consistent outer frame for learning objects. Deliberately flat and quiet — a
 * hairline-bordered panel that reads as an inserted note in the transcript, not
 * a floating, textured "card". Restraint is the point: type and spacing carry it.
 */
export function BlockShell({ className, children, ...props }: React.ComponentPropsWithoutRef<"section">) {
  return (
    <section
      className={cn(
        "relative my-4 overflow-hidden rounded-[14px] border border-border/60 bg-card/35 text-foreground",
        "transition-colors duration-base ease-out-soft",
        "motion-safe:animate-rise-in [animation-fill-mode:backwards]",
        className
      )}
      {...props}
    >
      {children}
    </section>
  );
}

/** Mono microcap label — "PROCESS", "QUICK CHECK", … */
export function Microcap({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("font-mono text-[11px] font-semibold uppercase text-muted-foreground", className)}>
      {children}
    </span>
  );
}

export function LessonKicker({
  className,
  children,
  accent = "bg-primary",
}: {
  className?: string;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className={cn("h-px w-5 rounded-full", accent)} />
      <Microcap className={className}>{children}</Microcap>
    </span>
  );
}

/** Height-animated reveal via the grid-rows 0fr -> 1fr trick. */
export function Reveal({
  open,
  className,
  innerClassName,
  children,
  ...props
}: {
  open: boolean;
  innerClassName?: string;
} & React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        "grid motion-safe:transition-[grid-template-rows,opacity] duration-slow ease-out-soft",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className
      )}
      {...props}
    >
      <div className={cn("min-h-0 overflow-hidden", innerClassName)}>{children}</div>
    </div>
  );
}
