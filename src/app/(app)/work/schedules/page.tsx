"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import { WorkPageFrame } from "@/components/work/work-nav";
import { WorkScheduleRow } from "@/components/work/work-schedule-row";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
import { fetchWorkSchedules } from "@/components/work/work-transport";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Everything that starts without being asked.
 *
 * WHAT THIS PAGE NOW SAYS THAT IT DID NOT. A Juno schedule points at ONE
 * session — `WorkSchedule.sessionId` is a real column and the scheduler has
 * always re-run the same task rather than spawning a fresh orphan per fire — so
 * a weekly report keeps its transcript and its deliverables across every run it
 * has ever had. That is genuinely unusual; the ordinary shape in this category
 * is N disconnected runs you have to correlate by hand. Nothing in the UI said
 * so, and a capability nobody is told about reads as a missing feature. The lede
 * says it, the rows link to the living task, and the inbox files that task under
 * Scheduled rather than pretending it is a one-shot that keeps finishing.
 *
 * UPCOMING AND PAUSED ARE SPLIT. Both were in one list ordered by next fire, and
 * because a paused schedule keeps its `nextRunAt` — the scheduler skips it
 * rather than clearing the column — a paused row could sort above a live one and
 * appear to promise a run that was not coming. Splitting them is what makes the
 * order mean what it looks like it means.
 *
 * Within each group the route's order is kept: soonest fire first, with the ones
 * that will never fire again last (Postgres sorts NULLs last on an ascending
 * order). Re-sorting here would disagree with the paging the route is built for
 * the moment there are more than fifty.
 *
 * There is no poll. A schedule changes when somebody changes it, and the two
 * things that change one from this page — pause and run-now — hand back the row
 * they wrote.
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

  /*
   * Live first, paused second, and the route's order kept inside each.
   *
   * A stable partition rather than a sort, so the "soonest fire first" the route
   * built its index for survives. See the note at the top for why the two cannot
   * share a list: a paused schedule keeps its `nextRunAt`, so mixing them puts a
   * row that is not going to run above one that is.
   */
  const upcoming = (schedules ?? []).filter((schedule) => schedule.enabled);
  const paused = (schedules ?? []).filter((schedule) => !schedule.enabled);

  return (
    <WorkPageFrame
      title="Recurring work"
      description="Work that starts on its own — on a clock, or when something happens. Each one keeps a single task: every run adds to the same transcript and the same set of files, so you can see what changed since last time rather than hunting through separate runs."
      action={
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/work/schedules/new">
            <Plus className="size-3.5" aria-hidden="true" /> New schedule
          </Link>
        </Button>
      }
    >
      {failed ? (
        <WorkLoadError onRetry={() => void load()}>
          Couldn’t load your schedules. This page is empty because the request failed, not because
          you have none — anything already set up is still running to its own clock.
        </WorkLoadError>
      ) : schedules === null ? (
        <WorkRowSkeletons />
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={AppIcons.tasks}
          title="Nothing scheduled"
          description="A schedule is a task with a trigger on it: every weekday at eight, when an invoice arrives, when a folder changes. Juno runs it while you are elsewhere and asks before anything it cannot undo."
          action={
            <Button asChild size="sm" className="gap-1.5">
              <Link href="/work/schedules/new">
                <Plus className="size-3.5" aria-hidden="true" /> New schedule
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          {/* Headings only when both groups exist. A single heading over the
              only list on the page is a label for something with nothing to be
              distinguished from. */}
          {upcoming.length > 0 && (
            <section>
              {paused.length > 0 && (
                <h2 className="mb-2.5 font-mono text-label text-muted-foreground">Upcoming</h2>
              )}
              <div className="space-y-2.5">
                {upcoming.map((schedule, index) => (
                  <WorkScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    index={index}
                    onChanged={replace}
                  />
                ))}
              </div>
            </section>
          )}
          {paused.length > 0 && (
            <section className={upcoming.length > 0 ? "mt-9" : undefined}>
              {upcoming.length > 0 && (
                <h2 className="mb-2.5 font-mono text-label text-muted-foreground">Paused</h2>
              )}
              <div className="space-y-2.5">
                {paused.map((schedule, index) => (
                  <WorkScheduleRow
                    key={schedule.id}
                    // The stagger continues across the two groups rather than
                    // restarting, so the page deals one hand of cards instead of
                    // two that visibly collide in the middle.
                    index={upcoming.length + index}
                    schedule={schedule}
                    onChanged={replace}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </WorkPageFrame>
  );
}
