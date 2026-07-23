"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft, Plus, RefreshCw } from "lucide-react";
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

export default function TasksPage() {
  const router = useRouter();
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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="mb-1 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label text-muted-foreground">Tasks</span>
        </div>
        {/* flex-wrap: at ~360px the count + button drop under the title instead
            of squeezing the display h1 into a forced two-line wrap. */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-serif text-display font-medium tracking-tight">Scheduled tasks</h1>
          {!loading && !locked && !empty && (
            <div className="flex items-center gap-2.5 pb-1.5">
              <span className="font-mono text-[10px] text-muted-foreground/60">
                {tasks.length} / {limit}
              </span>
              <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={openCreate} disabled={atLimit}>
                <Plus className="h-3.5 w-3.5" /> New task
              </Button>
            </div>
          )}
        </div>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Prompts Juno runs for you on a schedule — each run lands in the task’s chat thread.
        </p>

        {loadError ? (
          <div className="space-y-2.5 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <p>Couldn’t load your tasks. Check your connection and try again.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-[124px] w-full rounded-lg" style={{ animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        ) : locked ? (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <div className="max-w-sm">
              <p className="font-serif text-heading">Tasks are part of Pro</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Juno can run a prompt for you every morning — a news brief, a metrics check, a language lesson.
              </p>
            </div>
            <Button asChild className="gap-1.5">
              <Link href="/upgrade">Upgrade to Pro</Link>
            </Button>
          </div>
        ) : empty ? (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <div className="max-w-sm">
              <p className="font-serif text-heading">Nothing scheduled</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Juno can run a prompt for you every morning — a news brief, a metrics check, a language lesson.
              </p>
            </div>
            <Button onClick={openCreate} className="gap-1.5">
              <Plus className="h-4 w-4" /> New task
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onToggle={(enabled) => toggle(task, enabled)}
                onEdit={() => openEdit(task)}
                onDelete={() => setDeleting(task)}
              />
            ))}
          </div>
        )}
      </div>

      <TaskDialog open={dialogOpen} onOpenChange={setDialogOpen} task={editing} onSaved={onSaved} />

      {/* Delete confirm */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif">Delete this task?</DialogTitle>
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
