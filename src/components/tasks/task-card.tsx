"use client";

import * as React from "react";
import Link from "next/link";
import { Globe } from "lucide-react";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, formatUsd } from "@/lib/utils";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { describeSchedule, isCompletedOnce, type TaskItem } from "@/components/tasks/task-model";

/** "Mon, Jul 13 · 08:00" — when a task will (first) fire. */
function nextRunLabel(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${time}`;
}

/** One line summing up where the task stands (last run, or the first one ahead). */
function StatusLine({ task }: { task: TaskItem }) {
  const run = task.latestRun;
  const shared = "inline-flex min-w-0 items-center gap-1.5 font-mono text-caption tabular-nums";
  // A fired one-off is disabled by the runner but is not "Paused" — fall
  // through so the line reports its run (Ran / Failed / Skipped) instead.
  if (!task.enabled && !isCompletedOnce(task) && (!run || run.status !== "running")) {
    return <span className={cn(shared, "text-muted-foreground")}>Paused</span>;
  }
  if (!run) {
    return <span className={cn(shared, "text-muted-foreground")}>First run {nextRunLabel(task.nextRunAt)}</span>;
  }
  const when = timeAgo(run.finishedAt ?? run.startedAt);
  if (run.status === "running") {
    // A live state needs a live mark.
    return (
      <span className={cn(shared, "text-muted-foreground")}>
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary motion-safe:animate-status-glow" />
        Running now…
      </span>
    );
  }
  if (run.status === "done") {
    return (
      <span className={cn(shared, "text-muted-foreground")}>
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
        Ran {when}
        {run.costMicroUsd > 0 && <> · {formatUsd(run.costMicroUsd / 1_000_000)}</>}
      </span>
    );
  }
  // error | budget — the run didn't produce a result; say why, in destructive.
  return (
    <span className={cn(shared, "truncate text-destructive-ink")} title={run.error ?? undefined}>
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
      {run.status === "budget" ? "Skipped" : "Failed"} {when}
      {run.error && <> — {run.error}</>}
    </span>
  );
}

/**
 * One scheduled task, as a hover-raised row: flat on the page at rest, a raised
 * card under the pointer. The schedule glyph sits on an inset tile; the name and
 * schedule read as one line each; the pause switch and menu stay on the right.
 */
export function TaskCard({
  task,
  onToggle,
  onEdit,
  onDelete,
}: {
  task: TaskItem;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      aria-label={task.name}
      className={cn(
        "group flex w-full items-start gap-3 rounded-control border border-transparent px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow,opacity] duration-fast ease-out-soft hover:border-border/60 hover:bg-card hover:shadow-raised motion-reduce:transition-none",
        !task.enabled && "opacity-70 hover:opacity-100"
      )}
    >
      <span className="surface-inset mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
        <AppIcons.tasks className="size-4" aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium">{task.name}</h3>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-caption tabular-nums text-muted-foreground">
          <span className="truncate">{describeSchedule(task)}</span>
          <span aria-hidden className="size-1 shrink-0 rounded-full bg-border" />
          <span className="truncate">{task.modelName}</span>
          {task.webSearch && (
            <span className="inline-flex shrink-0 items-center gap-1" title="Web search on">
              <span aria-hidden className="size-1 rounded-full bg-border" />
              <Globe className="size-3 shrink-0" aria-hidden="true" /> web
            </span>
          )}
        </p>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <StatusLine task={task} />
          {task.conversationId && (
            <Link
              href={`/chat/${task.conversationId}`}
              className="group/results inline-flex shrink-0 items-center gap-1 font-mono text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
            >
              View results{" "}
              <ActionIcons.external
                className="size-3 shrink-0 transition-transform duration-fast ease-out-soft group-hover/results:-translate-y-0.5 group-hover/results:translate-x-0.5 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </Link>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* No resume switch on a fired one-off: there is no future instant to
            resume to — rescheduling it goes through Edit, which asks for a
            new date. */}
        {!isCompletedOnce(task) && (
          <Switch
            checked={task.enabled}
            onCheckedChange={onToggle}
            aria-label={task.enabled ? `Pause ${task.name}` : `Resume ${task.name}`}
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
              aria-label={`Options for ${task.name}`}
            >
              <ActionIcons.more className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={onEdit}>
              <ActionIcons.edit className="size-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onDelete}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <ActionIcons.delete className="size-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
