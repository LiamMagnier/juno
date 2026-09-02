"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { TaskCard } from "@/components/tasks/task-card";
import { TaskDialog } from "@/components/tasks/task-dialog";
import { isCompletedOnce, type TaskItem } from "@/components/tasks/task-model";
import { staggerDelay } from "@/lib/motion";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";

type TaskFilter = "active" | "paused" | "all";

/** A scheduled task is either running on its schedule or it is not — a fired
 *  one-off counts with the paused ones, since nothing further will happen to it. */
function isActive(task: TaskItem) {
  return task.enabled && !isCompletedOnce(task);
}

export default function TasksPage() {
  const [tasks, setTasks] = React.useState<TaskItem[] | null>(null);
  const [limit, setLimit] = React.useState<number>(0);
  const [loadError, setLoadError] = React.useState(false);
  const [filter, setFilter] = React.useState<TaskFilter>("all");

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TaskItem | null>(null);
  const [deleting, setDeleting] = React.useState<TaskItem | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTasks(data.tasks);
      setLimit(data.limit);
    } catch {
      setLoadError(true);
      setTasks((cur) => cur ?? []);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (task: TaskItem) => {
    setEditing(task);
    setDialogOpen(true);
  };

  const onSaved = (saved: TaskItem, isNew: boolean) => {
    setTasks((cur) => (isNew ? [saved, ...(cur ?? [])] : (cur ?? []).map((t) => (t.id === saved.id ? saved : t))));
    toast.success(isNew ? "Task scheduled." : "Task updated.");
  };

  const toggle = async (task: TaskItem, enabled: boolean) => {
    setTasks((cur) => cur?.map((t) => (t.id === task.id ? { ...t, enabled } : t)) ?? cur);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Could not update the task.");
      // Server response carries the recomputed nextRunAt.
      setTasks((cur) => cur?.map((t) => (t.id === task.id ? data.task : t)) ?? cur);
    } catch (err) {
      setTasks((cur) => cur?.map((t) => (t.id === task.id ? { ...t, enabled: !enabled } : t)) ?? cur);
      toast.error(err instanceof Error ? err.message : "Could not update the task.");
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/tasks/${deleting.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setTasks((cur) => cur?.filter((t) => t.id !== deleting.id) ?? cur);
      toast.success("Task deleted.");
      setDeleting(null);
    } catch {
      toast.error("Could not delete the task.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const loading = tasks === null;
  // Locked upsell only when there's nothing to manage — a downgraded user with
  // existing tasks still sees the list (creation stays capped server-side).
  const locked = !loading && !loadError && limit === 0 && tasks.length === 0;
  const empty = !loading && !locked && tasks.length === 0;
  const atLimit = !loading && tasks !== null && tasks.length >= limit;

  const all = tasks ?? [];
  const activeCount = all.filter(isActive).length;
  const visible = all.filter((task) => (filter === "all" ? true : filter === "active" ? isActive(task) : !isActive(task)));

  return (
    <AppPage measure="reading">
      <AppPageHeader
        eyebrow="Tasks"
        heading="Scheduled tasks"
        icon={AppIcons.tasks}
        lede="Prompts Juno runs for you on a schedule — each run lands in the task’s chat thread."
        actions={
          !loading && !locked && !empty ? (
            <>
              <span className="font-mono text-caption tabular-nums text-muted-foreground">
                {tasks.length} / {limit}
              </span>
              <Button size="sm" className="gap-1.5" onClick={openCreate} disabled={atLimit}>
                <Plus className="size-3.5" /> New task
              </Button>
            </>
          ) : null
        }
      />

      {!loading && !locked && !empty && !loadError && (
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<TaskFilter>
            value={filter}
            onChange={setFilter}
            ariaLabel="Filter tasks"
            className="h-9 w-fit max-w-full shrink-0"
            options={[
              { value: "active", label: "Active", count: activeCount },
              { value: "paused", label: "Paused", count: all.length - activeCount },
              { value: "all", label: "All", count: all.length },
            ]}
          />
        </div>
      )}

      {loadError ? (
        <EmptyState
          tone="error"
          icon={StatusIcons.error}
          title="Couldn’t load your tasks"
          description="Check your connection and try again."
          action={
            <Button variant="secondary" size="sm" onClick={() => load()} className="gap-1.5">
              <ActionIcons.refresh className="size-3.5" /> Retry
            </Button>
          }
        />
      ) : loading ? (
        <div className="space-y-1" role="status" aria-label="Loading scheduled tasks">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-2.5" style={staggerDelay(i)}>
              <Skeleton className="size-9 shrink-0 rounded-field" />
              <span className="min-w-0 flex-1 space-y-2">
                <Skeleton className="block h-3 w-48 max-w-full rounded-xs" />
                <Skeleton className="block h-2.5 w-64 max-w-full rounded-xs" />
                <Skeleton className="block h-2.5 w-24 rounded-xs" />
              </span>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          ))}
        </div>
      ) : locked ? (
        <EmptyState
          className="mt-4"
          icon={AppIcons.tasks}
          title="Tasks are part of Pro"
          description="Juno can run a prompt for you every morning — a news brief, a metrics check, a language lesson."
          action={
            <Button asChild className="gap-1.5">
              <Link href="/upgrade">Upgrade to Pro</Link>
            </Button>
          }
        />
      ) : empty ? (
        <EmptyState
          className="mt-4"
          icon={AppIcons.tasks}
          title="Nothing scheduled"
          description="Juno can run a prompt for you every morning — a news brief, a metrics check, a language lesson."
          action={
            <Button onClick={openCreate} className="gap-1.5">
              <Plus className="size-4" /> New task
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          className="mt-5"
          size="panel"
          icon={AppIcons.tasks}
          title={filter === "active" ? "No active tasks" : "No paused tasks"}
          description={filter === "active" ? "Every task is paused or already done." : "Every task is running on its schedule."}
          action={
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setFilter("all")}>
              Show all
            </Button>
          }
        />
      ) : (
        <div className="mt-5 space-y-1">
          {visible.map((task, i) => (
            <div
              key={task.id}
              style={staggerDelay(i)}
              className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              <TaskCard
                task={task}
                onToggle={(enabled) => toggle(task, enabled)}
                onEdit={() => openEdit(task)}
                onDelete={() => setDeleting(task)}
              />
            </div>
          ))}
        </div>
      )}

      <TaskDialog open={dialogOpen} onOpenChange={setDialogOpen} task={editing} onSaved={onSaved} />

      {/* Delete confirm */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this task?</DialogTitle>
            <DialogDescription>
              The schedule stops and its run history is removed. The results chat is kept. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteBusy}>
              {deleteBusy ? "Deleting…" : "Delete task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}
