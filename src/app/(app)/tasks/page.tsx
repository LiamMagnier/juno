"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertCircle, Plus, RefreshCw } from "lucide-react";
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
import { TaskCard } from "@/components/tasks/task-card";
import { TaskDialog } from "@/components/tasks/task-dialog";
import type { TaskItem } from "@/components/tasks/task-model";
import { staggerDelay } from "@/lib/motion";
import { AppPageHeader } from "@/components/app/app-page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { AppIcons } from "@/lib/app-icons";

export default function TasksPage() {
  const [tasks, setTasks] = React.useState<TaskItem[] | null>(null);
  const [limit, setLimit] = React.useState<number>(0);
  const [loadError, setLoadError] = React.useState(false);

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

  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-2xl">
        <AppPageHeader
          eyebrow="Tasks"
          heading="Scheduled tasks"
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

        {loadError ? (
          <div className="space-y-2.5 rounded-card border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <p>Couldn’t load your tasks. Check your connection and try again.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-[124px] w-full rounded-card" style={staggerDelay(i)} />
            ))}
          </div>
        ) : locked ? (
          <EmptyState
            className="mt-10"
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
            className="mt-10"
            icon={AppIcons.tasks}
            title="Nothing scheduled"
            description="Juno can run a prompt for you every morning — a news brief, a metrics check, a language lesson."
            action={
              <Button onClick={openCreate} className="gap-1.5">
                <Plus className="size-4" /> New task
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {/* The skeletons above stagger and the cards replacing them did not, so
                the loading state was more choreographed than the content — the same
                mismatch the library grid was fixed for. Same rung, same cap. */}
            {tasks.map((task, i) => (
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
      </div>

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
    </div>
  );
}
