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
import { workStatusForCodeTask } from "@/lib/work/code-routine";
import type { WorkStatus } from "@/lib/work/domain";
import type { ClientWorkHost } from "@/lib/work/serializers";
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
  type WorkScheduleHistory,
} from "@/components/work/work-transport";
import { ScheduleFireCard } from "@/components/work/schedules/fire-card";
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
export default function AutomationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [schedule, setSchedule] = React.useState<ClientWorkSchedule | null>(null);
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [history, setHistory] = React.useState<WorkScheduleHistory | null>(null);
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
    if (result.kind === "ok") setHistory(result.value);
  }, [id]);

  React.useEffect(() => {
    void load();
    void loadRuns();
    void fetchWorkHosts().then((result) => {
      if (result.kind === "ok") setHosts(result.value);
    });
  }, [load, loadRuns]);

  /**
   * The two histories as one column, newest first.
   *
   * Interleaved here rather than by the server, because they are different
   * shapes and a merged wire format would be a third shape neither product
   * speaks — see the runs route. What they do share is an instant, which is the
   * only ordering a reader wants: "what did this automation do, in order".
   */
  const rows = React.useMemo<HistoryRow[]>(() => {
    if (history === null) return [];
    const workRows = history.runs.map((run) => ({
      key: run.id,
      status: run.status,
      // The scheduler's own sentence for a fire it did not run, and the attempt
      // number for one it did. Both are the most specific true thing there is.
      label: run.terminalDetail ?? `Attempt ${run.attempt}`,
      origin: run.origin,
      createdAt: run.createdAt,
      href: `/work/${run.sessionId}`,
    }));
    const codeRows = history.codeRuns.map((task) => ({
      key: task.id,
      status: workStatusForCodeTask(task.status),
      // The pull request when there is one, because that is what a finished
      // Code run IS — and the branch while it is still pushing to it.
      label: task.prUrl ?? task.branch ?? task.title,
      origin: "code",
      createdAt: task.createdAt,
      // Straight to the session this fire opened. A Code run carries its own
      // conversation, so there is nothing for the server to resolve.
      href: task.conversationId ? `/chat/${task.conversationId}` : "/code",
    }));
    return [...workRows, ...codeRows].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }, [history]);

  const runNow = async () => {
    setBusy(true);
    const result = await runWorkScheduleNow(id);
    setBusy(false);
    if (result.kind === "ok") {
      window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
      toast.success("Started. This run is extra — the automation still fires when it was going to.");
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
      router.push("/automations");
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : "Couldn’t delete this automation. It is exactly as it was."
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
        onCancel={() => router.push("/automations")}
      />

      {/* Below the editor and above the history, which is where it belongs in
          both directions: the trigger that makes it real is in the form above,
          and the runs it produces are in the list below. It draws nothing at
          all unless that trigger is saved on the automation. */}
      <div className="mt-8">
        <ScheduleFireCard schedule={schedule} />
      </div>

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
        {history === null ? (
          // Error tone, because this is a request that failed rather than a
          // schedule that has not fired — the two were the same dashed
          // paragraph, which is the distinction EmptyState exists to keep.
          <EmptyState
            size="panel"
            tone="error"
            title="Couldn’t read the history"
            description="This automation’s history couldn’t be read just now, which says nothing about whether it has run."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            size="panel"
            title="No runs yet"
            description="It has not run yet. Fires that were skipped — a Mac that was away, a budget that was spent — appear here too, so this staying empty means nothing has fired at all."
          />
        ) : (
          <WorkList>
            <ul className="space-y-0.5">
              {rows.map((row) => (
                <li key={row.key}>
                  {/*
                    A Work run opens through `/work/<sessionId>`, deliberately,
                    and it is the one URL under `/work` that is a live resolver
                    rather than a legacy redirect. A run row carries a session
                    id and nothing else; turning one into the conversation it
                    writes into is a per-account lookup only the server can do
                    (src/lib/work-url-migration.ts), and a conversation id baked
                    into a link here would be stale the moment the conversation
                    was deleted. Every run of a Work automation shares that one
                    session, so all of those rows open the same transcript —
                    which is the point: the fires accumulate in it.

                    A Code run opens its own session instead, and it already
                    carries the conversation id, so it links straight there:
                    each fire is a separate branch and a separate pull request,
                    and there is no accumulating transcript to resolve to.
                  */}
                  <Link
                    href={row.href}
                    className="group flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control border border-transparent px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft hover:border-transparent hover:bg-accent motion-reduce:transition-none"
                  >
                    <WorkStatusPill status={row.status} />
                    <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                      {row.label}
                    </span>
                    <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
                      {row.origin} · {workTimeAgo(row.createdAt)}
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

/** One line of an automation's history, whichever kind of run produced it. */
interface HistoryRow {
  key: string;
  status: WorkStatus;
  label: string;
  origin: string;
  createdAt: string;
  href: string;
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
        eyebrow="Automations"
        heading={heading}
        lede={lede}
        actions={actions}
        backHref="/automations"
        backLabel="Back to automations"
      />
      {children}
    </AppPage>
  );
}
