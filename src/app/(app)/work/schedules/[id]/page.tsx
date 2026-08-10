"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Play, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import type { ClientWorkHost, ClientWorkRun } from "@/lib/work/serializers";
import { WorkPageFrame } from "@/components/work/work-nav";
import { WorkScheduleEditor } from "@/components/work/work-schedule-editor";
import {
  deleteWorkSchedule,
  fetchWorkHosts,
  fetchWorkSchedule,
  fetchWorkScheduleRuns,
  runWorkScheduleNow,
  WORK_SYNC_EVENT,
} from "@/components/work/work-transport";
import { WorkStateNote, WorkStatusPill, workTimeAgo } from "@/components/work/work-vocabulary";
import { staggerDelay } from "@/lib/motion";

/**
 * One schedule: what it does, and what it has actually done.
 *
 * The history is the half that is hard to get from anywhere else. The scheduler
 * writes a finished run for a fire it dropped — the Mac was away, the budget was
 * spent — so "it has been skipping every morning for a fortnight" appears here
 * as rows rather than as the absence of them. Runs that were merely delayed are
 * not in it and should not be: they happen a few minutes later, and a row per
 * attempt to start would bury the ones that matter.
 */
export default function WorkSchedulePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [schedule, setSchedule] = React.useState<ClientWorkSchedule | null>(null);
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [runs, setRuns] = React.useState<ClientWorkRun[] | null>(null);
  const [missing, setMissing] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    const result = await fetchWorkSchedule(id);
    if (result.kind === "ok") {
      setSchedule(result.value);
      return;
    }
    if (result.kind === "failed" && result.cause === "not_found") {
      setMissing(true);
      return;
    }
    setFailed(true);
  }, [id]);

  const loadRuns = React.useCallback(async () => {
    const result = await fetchWorkScheduleRuns(id);
    // A failed history load leaves the list null, which renders as "couldn't be
    // read" rather than as "it has never run" — two very different statements
    // about a schedule somebody is deciding whether to trust.
    if (result.kind === "ok") setRuns(result.value);
  }, [id]);

  React.useEffect(() => {
    void load();
    void loadRuns();
    void fetchWorkHosts().then((result) => {
      if (result.kind === "ok") setHosts(result.value);
    });
  }, [load, loadRuns]);

  const runNow = async () => {
    setBusy(true);
    const result = await runWorkScheduleNow(id);
    setBusy(false);
    if (result.kind === "ok") {
      window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
      toast.success("Started. This run is extra — the schedule still fires when it was going to.");
      void loadRuns();
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : "Couldn’t start this. Nothing was queued, so trying again is safe."
    );
  };

  const destroy = async () => {
    setBusy(true);
    const result = await deleteWorkSchedule(id);
    setBusy(false);
    setConfirmingDelete(false);
    if (result.kind === "ok") {
      // The server's own sentence about what happened to the fires it had
      // queued, and to any run it could not stop. A "Deleted." of our own would
      // drop the only part of that a user has to act on.
      toast.success(result.value ?? "Deleted.");
      router.push("/work/schedules");
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : "Couldn’t delete this schedule. It is exactly as it was."
    );
  };

  if (missing) {
    return (
      <WorkPageFrame
        title="Schedule not found"
        back={{ href: "/work/schedules", label: "Back to schedules" }}
      >
        <WorkStateNote tone="error">
          This schedule no longer exists. It may have been deleted from another device.
        </WorkStateNote>
      </WorkPageFrame>
    );
  }

  if (failed) {
    return (
      <WorkPageFrame
        title="Schedule"
        back={{ href: "/work/schedules", label: "Back to schedules" }}
      >
        <WorkStateNote
          tone="error"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
            </Button>
          }
        >
          Couldn’t load this schedule. Nothing has been changed by the attempt, and it is still
          running to whatever clock it was set to.
        </WorkStateNote>
      </WorkPageFrame>
    );
  }

  if (schedule === null) {
    return (
      <WorkPageFrame title="Schedule" back={{ href: "/work/schedules", label: "Back to schedules" }}>
        <div className="space-y-3">
          {[...Array(4)].map((_, index) => (
            <Skeleton
              key={index}
              className="h-16 w-full rounded-field"
              style={staggerDelay(index, "tight")}
            />
          ))}
        </div>
      </WorkPageFrame>
    );
  }

  return (
    <WorkPageFrame
      title={schedule.name}
      description={schedule.enabled ? undefined : "Paused. Nothing new will start until you resume it."}
      back={{ href: "/work/schedules", label: "Back to schedules" }}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void runNow()}
            className="gap-1.5"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Run now
          </Button>
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            className="gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
          </Button>
        </div>
      }
    >
      <WorkScheduleEditor
        // Remounted whenever the saved row changes, so the form is re-seeded
        // from what the server actually stored — the trigger set it normalised,
        // the fire it recomputed — rather than from what was typed at it. The
        // two differ often enough to matter: a config with a stray field is
        // stored as the parser's version of it, not as the one submitted.
        key={schedule.updatedAt}
        schedule={schedule}
        hosts={hosts}
        onSaved={(saved) => {
          setSchedule(saved);
          void loadRuns();
        }}
        onCancel={() => router.push("/work/schedules")}
      />

      <section className="mt-9">
        <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-mono text-label text-muted-foreground">Recent runs</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadRuns()}
            className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh
          </Button>
        </div>
        {runs === null ? (
          <p className="rounded-field border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            This schedule’s history couldn’t be read just now, which says nothing about whether it
            has run.
          </p>
        ) : runs.length === 0 ? (
          <p className="rounded-field border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            It has not run yet. Fires that were skipped — a Mac that was away, a budget that was
            spent — appear here too, so this staying empty means nothing has fired at all.
          </p>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/work/${run.sessionId}`}
                  className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-field border border-border/60 bg-card/50 px-3.5 py-2.5 transition-colors duration-base ease-out-soft hover:border-border hover:bg-card"
                >
                  <WorkStatusPill status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {run.terminalDetail ?? `Attempt ${run.attempt}`}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {run.origin} · {workTimeAgo(run.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{schedule.name}”?</DialogTitle>
            <DialogDescription>
              Fires that have not started are cancelled. A run already under way carries on to the
              end — deleting a schedule stops it starting anything new, and cannot reach into work
              that has begun. The tasks it has already produced stay where they are.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void destroy()} disabled={busy}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WorkPageFrame>
  );
}
