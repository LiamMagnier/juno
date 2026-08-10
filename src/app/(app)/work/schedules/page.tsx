"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import { WorkPageFrame } from "@/components/work/work-nav";
import { WorkScheduleRow } from "@/components/work/work-schedule-row";
import { fetchWorkSchedules } from "@/components/work/work-transport";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { staggerDelay } from "@/lib/motion";

/**
 * Everything that starts without being asked.
 *
 * The list route orders by soonest fire, with the schedules that will never
 * fire again last — Postgres sorts NULLs last on an ascending order, which is
 * exactly the order a list of schedules wants — so this renders the response as
 * it arrives rather than re-sorting it. A second ordering here would disagree
 * with the paging the route is built for the moment there are more than fifty.
 *
 * There is no poll. A schedule changes when somebody changes it, and the two
 * things that change one from this page — pause and run-now — hand back the row
 * they wrote. A timer here would spend a request a minute to re-learn what the
 * page already knows.
 */
export default function WorkSchedulesPage() {
  const [schedules, setSchedules] = React.useState<ClientWorkSchedule[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setFailed(false);
    const result = await fetchWorkSchedules();
    if (result.kind === "ok") {
      setSchedules(result.value);
      return;
    }
    setFailed(true);
    // An empty list and a failed request look identical on screen unless the
    // page says which it is, so the list is left null and the note below is
    // what gets rendered.
    setSchedules(null);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const replace = React.useCallback((saved: ClientWorkSchedule) => {
    setSchedules((current) =>
      current === null
        ? current
        : current.map((schedule) => (schedule.id === saved.id ? saved : schedule))
    );
  }, []);

  return (
    <WorkPageFrame
      title="Schedules"
      description="Work that starts on its own — on a clock, or when something happens. Every one of them runs while you are somewhere else, which is why each says what it may and may not do unattended."
      action={
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/work/schedules/new">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New schedule
          </Link>
        </Button>
      }
    >
      {failed ? (
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
          Couldn’t load your schedules. This page is empty because the request failed, not because
          you have none — anything already set up is still running to its own clock.
        </WorkStateNote>
      ) : schedules === null ? (
        <div className="space-y-2.5">
          {[...Array(3)].map((_, index) => (
            <Skeleton
              key={index}
              className="h-[86px] w-full rounded-xl"
              style={staggerDelay(index, "tight")}
            />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center">
          <p className="font-serif text-heading">Nothing scheduled</p>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
            A schedule is a task with a trigger on it: every weekday at eight, when an invoice
            arrives, when a folder changes. Juno runs it while you are elsewhere and asks before
            anything it cannot undo.
          </p>
          <Button asChild size="sm" className="mt-4 gap-1.5">
            <Link href="/work/schedules/new">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New schedule
            </Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {schedules.map((schedule, index) => (
            <WorkScheduleRow
              key={schedule.id}
              schedule={schedule}
              index={index}
              onChanged={replace}
            />
          ))}
        </div>
      )}
    </WorkPageFrame>
  );
}
