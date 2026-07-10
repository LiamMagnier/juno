"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Globe, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
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
import { describeSchedule, type TaskItem } from "@/components/tasks/task-model";

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
  if (!task.enabled && (!run || run.status !== "running")) {
    return <span className="text-xs text-muted-foreground">Paused</span>;
  }
  if (!run) {
    return <span className="text-xs text-muted-foreground">First run {nextRunLabel(task.nextRunAt)}</span>;
  }
  const when = timeAgo(run.finishedAt ?? run.startedAt);
  if (run.status === "running") {
    return <span className="text-xs text-muted-foreground">Running now…</span>;
  }
  if (run.status === "done") {
    return (
      <span className="text-xs text-muted-foreground">
        Ran {when}
        {run.costMicroUsd > 0 && <> · {formatUsd(run.costMicroUsd / 1_000_000)}</>}
      </span>
    );
  }
  // error | budget — the run didn't produce a result; say why, in destructive.
  return (
    <span className="min-w-0 truncate text-xs text-destructive" title={run.error ?? undefined}>
      {run.status === "budget" ? "Skipped" : "Failed"} {when}
      {run.error && <> — {run.error}</>}
    </span>
  );
}

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
    <Card className={cn("p-5 transition-opacity duration-base", !task.enabled && "opacity-70")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
            {describeSchedule(task)}
          </p>
          <h3 className="mt-1 truncate font-serif text-heading">{task.name}</h3>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{task.modelName}</span>
            {task.webSearch && (
              <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground/70">
                · <Globe className="h-3 w-3" aria-hidden="true" /> web
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Switch
            checked={task.enabled}
            onCheckedChange={onToggle}
            aria-label={task.enabled ? `Pause ${task.name}` : `Resume ${task.name}`}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="h-7 w-7 text-muted-foreground hover:text-foreground" aria-label="Task options">
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="h-4 w-4" /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onDelete}
                className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
              >
                <Trash2 className="h-4 w-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/40 pt-3">
        <StatusLine task={task} />
        {task.conversationId && (
          <Link
            href={`/chat/${task.conversationId}`}
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground"
          >
            View results <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </div>
    </Card>
  );
}
