"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * AIcss "Thinking State" — the shimmering label.
 *
 * One valley of reduced alpha sweeps through the word rather than a bright band
 * travelling over it, which is what separates this from a loading skeleton: a
 * skeleton says "there will be content here", and this says "something is
 * happening now". See `.aicss-shine` in globals.css for the gradient.
 *
 * `settled` is the whole reason this is a component rather than a class. The
 * same node keeps its box and its colour and simply stops moving, so the moment
 * a run completes costs no reflow and no colour jump — which is what let this
 * replace `animate-status-glow` on the live strip, where an opacity breathe was
 * doing the same job less precisely.
 */
export function ThinkingState({
  children = "Thinking",
  settled,
  tone = "muted",
  className,
  ...rest
}: React.ComponentPropsWithoutRef<"span"> & {
  /** Stop the sweep and rest at `tone`. */
  settled?: boolean;
  /** Which token the text settles at. `strong` for a label that leads a block. */
  tone?: "muted" | "strong";
}) {
  return (
    <span
      {...rest}
      data-settled={settled ? "true" : "false"}
      style={{
        // A custom property rather than a class pair: the gradient derives its
        // own valley from this one colour (see .aicss-shine).
        ["--aicss-shine" as string]: tone === "strong" ? "var(--foreground)" : "var(--muted-foreground)",
        ...rest.style,
      }}
      className={cn("aicss-shine aicss-thinking", className)}
    >
      {children}
    </span>
  );
}
