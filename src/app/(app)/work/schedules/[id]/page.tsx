"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import type { ClientWorkHost, ClientWorkRun } from "@/lib/work/serializers";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { WorkList } from "@/components/work/shell/work-section";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
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
      <ScheduleFrame heading="Automation not found">
        <WorkStateNote tone="error">
          This automation no longer exists. It may have been deleted from another device.
        </WorkStateNote>
      </ScheduleFrame>
    );
  }

  if (failed) {
    return (
      <ScheduleFrame heading="Automation">
        <WorkLoadError onRetry={() => void load()}>
          Couldn’t load this automation. Nothing has been changed by the attempt, and it is still
          running to whatever clock it was set to.
        </WorkLoadError>
      </ScheduleFrame>
    );
  }

  if (schedule === null) {
    return (
      <ScheduleFrame heading={<Skeleton className="h-8 w-56 max-w-full" />}>
        <WorkRowSkeletons count={4} height={64} className="space-y-3" />
      </ScheduleFrame>
    );
  }

  return (
    <ScheduleFrame
      heading={schedule.name}
      lede={schedule.enabled ? undefined : "Paused. Nothing new will start until you resume it."}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void runNow()}
            className="gap-1.5"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="size-3.5" aria-hidden="true" />
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
            <ActionIcons.delete className="size-3.5" aria-hidden="true" /> Delete
          </Button>
        </>
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

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-heading">Recent runs</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadRuns()}
            className="h-7 gap-1.5 px-2 font-mono text-micro text-muted-foreground"
          >
            <ActionIcons.refresh className="size-3" aria-hidden="true" /> Refresh
          </Button>
        </div>
        {runs === null ? (
          // Error tone, because this is a request that failed rather than a
          // schedule that has not fired — the two were the same dashed
          // paragraph, which is the distinction EmptyState exists to keep.
          <EmptyState
            size="panel"
            tone="error"
            title="Couldn’t read the history"
            description="This schedule’s history couldn’t be read just now, which says nothing about whether it has run."
          />
        ) : runs.length === 0 ? (
          <EmptyState
            size="panel"
            title="No runs yet"
            description="It has not run yet. Fires that were skipped — a Mac that was away, a budget that was spent — appear here too, so this staying empty means nothing has fired at all."
          />
        ) : (
          <WorkList>
            <ul className="space-y-0.5">
              {runs.map((run) => (
                <li key={run.id}>
                  <Link
                    href={`/work/${run.sessionId}`}
                    className="group flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control border border-transparent px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft hover:border-border/60 hover:bg-card hover:shadow-raised motion-reduce:transition-none"
                  >
                    <WorkStatusPill status={run.status} />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {run.terminalDetail ?? `Attempt ${run.attempt}`}
                    </span>
                    <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
                      {run.origin} · {workTimeAgo(run.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </WorkList>
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
    </ScheduleFrame>
  );
}

/**
 * The page frame every state of this route shares — loaded, loading, gone and
 * failed — so the header is in the same place in all four and nothing steps
 * sideways when the schedule resolves.
 */
function ScheduleFrame({
  heading,
  lede,
  actions,
  children,
}: {
  heading: React.ReactNode;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <AppPage measure="reading">
      <AppPageHeader
        eyebrow="Work"
        heading={heading}
        lede={lede}
        actions={actions}
        backHref="/work/schedules"
        backLabel="Back to automations"
      />
      {children}
    </AppPage>
  );
}
