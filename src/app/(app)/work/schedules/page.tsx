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
 * Everything that starts without the reader typing a fresh prompt.
 *
 * This route is still `/work/schedules` for compatibility, but the product name
 * is **Automations**. A schedule is only one trigger family: Juno can also start
 * Work from email filters, calendar windows, topic monitors, connector events,
 * folder changes and manual one-click runs. "Recurring work" hid those event
 * triggers and made a capability that already existed look missing next to
 * ChatGPT Work, Claude Cowork and Gemini/Antigravity.
 *
 * Each automation points at one durable Work session, so repeated executions
 * add to one transcript and one deliverable history instead of producing a pile
 * of disconnected jobs. Live and paused automations stay split so `nextRunAt`
 * never makes a paused row look like it is about to fire.
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

  const active = (schedules ?? []).filter((schedule) => schedule.enabled);
  const paused = (schedules ?? []).filter((schedule) => !schedule.enabled);

  return (
    <WorkPageFrame
      title="Automations"
      description="Let Work start itself — at a time you choose or when something changes. Automations can react to email, meetings, monitored topics, connected-app events and granted folders, and every run stays attached to the same task so context compounds instead of resetting."
      action={
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/work/schedules/new">
            <Plus className="size-3.5" aria-hidden="true" /> New automation
          </Link>
        </Button>
      }
    >
      {failed ? (
        <WorkLoadError onRetry={() => void load()}>
          Couldn’t load your automations. Existing automations keep their server-side state; this
          page is empty because the read failed, not because they were removed.
        </WorkLoadError>
      ) : schedules === null ? (
        <WorkRowSkeletons />
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={AppIcons.tasks}
          title="No automations yet"
          description="Run a task every weekday at eight, when an invoice arrives, before a meeting, when a topic starts moving, or when a granted folder changes. Juno can work while you are elsewhere and stops for approvals when the policy requires it."
          action={
            <Button asChild size="sm" className="gap-1.5">
              <Link href="/work/schedules/new">
                <Plus className="size-3.5" aria-hidden="true" /> New automation
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          {active.length > 0 && (
            <section>
              {paused.length > 0 && (
                <h2 className="mb-2.5 font-mono text-label text-muted-foreground">Active</h2>
              )}
              <div className="space-y-2.5">
                {active.map((schedule, index) => (
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
            <section className={active.length > 0 ? "mt-9" : undefined}>
              {active.length > 0 && (
                <h2 className="mb-2.5 font-mono text-label text-muted-foreground">Paused</h2>
              )}
              <div className="space-y-2.5">
                {paused.map((schedule, index) => (
                  <WorkScheduleRow
                    key={schedule.id}
                    index={active.length + index}
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
