"use client";

import * as React from "react";

import { ToolIcons } from "@/lib/app-icons";
import { formatDuration, useUiLocale } from "@/lib/i18n-format";
import { PhraseWithArgs } from "@/lib/i18n-phrase";
import { approvalReceiptLine, isReaderOutcome, toolIconKind, toolLine } from "@/lib/run/presentation";
import type { RunItem } from "@/lib/run/types";
import { cn } from "@/lib/utils";
import type { ToolCallRecord } from "@/types/run";

/*
 * One step of a run (SPEC §7.5, §7.8): a tool row — its icon, its running or
 * done phrase with the argument nodes, the figure, and a status marker — or a
 * one-line reasoning excerpt, or a quoted line of commentary.
 *
 * In the peek every row is one 1.75rem slot and its running marker is the
 * STATIC ring (`data-loop="off"`): the page's one loop belongs to the line
 * above it (§7.9.1). The row never re-keys on a status change, so a call that
 * finishes updates in place instead of re-entering.
 */

type ToolItem = Extract<RunItem, { kind: "tool" }>;

export type MarkerState = "running" | "waiting" | "done" | "failed";

export function markerState(call: Pick<ToolCallRecord, "status">): MarkerState {
  switch (call.status) {
    case "queued":
    case "running":
      return "running";
    case "awaiting_approval":
      return "waiting";
    case "succeeded":
      return "done";
    default:
      return isReaderOutcome(call) ? "done" : "failed";
  }
}

/** The status marker: an open ring while running (static here), accent while waiting, a dot when done. */
export function StepMarker({ state, className }: { state: MarkerState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("run-marker grid size-3.5 shrink-0 place-items-center", className)}
      data-state={state}
      data-loop="off"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "failed" ? "bg-warning" : state === "waiting" ? "bg-primary" : "bg-muted-foreground/60",
          state === "running" && "opacity-0",
        )}
      />
    </span>
  );
}

export function ToolStepRow({
  item,
  variant,
  className,
}: {
  item: ToolItem;
  variant: "peek" | "timeline";
  className?: string;
}) {
  const locale = useUiLocale();
  const { call } = item;
  const Icon = ToolIcons[toolIconKind(call)];
  const state = markerState(call);
  const failed = state === "failed";
  // Running phrase while it works, done phrase and figure once it succeeded, the failure phrase otherwise.
  const line = toolLine(call);
  const duration = variant === "timeline" && typeof call.durationMs === "number" ? formatDuration(call.durationMs, "narrow", locale) : null;
  return (
    <span className={cn("flex min-w-0 items-center gap-2 text-caption", failed ? "text-warning-foreground" : "text-muted-foreground", className)}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <PhraseWithArgs spec={line} className="min-w-0 truncate" />
      {duration ? (
        <span aria-hidden="true" data-no-auto-translate className="ms-auto shrink-0 font-mono text-micro tabular-nums">
          {duration}
        </span>
      ) : null}
      {variant === "peek" ? <StepMarker state={state} className="ms-auto" /> : null}
    </span>
  );
}

/** The receipt a call's approval left, as one muted line: "Allowed once · 14:02". */
export function ReceiptLine({ approval, className }: { approval: NonNullable<ToolCallRecord["approval"]>; className?: string }) {
  return <PhraseWithArgs spec={approvalReceiptLine(approval)} className={cn("text-caption text-muted-foreground", className)} />;
}

/** The icon a record wears, for callers that lay the row out themselves (the Activity panel). */
export function toolIcon(call: Pick<ToolCallRecord, "tool">) {
  return ToolIcons[toolIconKind(call)];
}
