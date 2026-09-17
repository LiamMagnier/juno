"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { WorkList } from "@/components/work/shell/work-section";
import { WorkScheduleRow } from "@/components/work/work-schedule-row";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
import { fetchWorkSchedules } from "@/components/work/work-transport";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Everything that starts without the reader typing a fresh prompt.
 *
 * The route is `/automations` and the product name is **Automations**. It was
 * `/work/schedules`, which was wrong twice over: Work is no longer a place
 * (docs/design/TWO_PRODUCTS.md §2), and a schedule is only one trigger family
 * — Juno can also start a task from email filters, calendar windows, topic
 * monitors, connector events, folder changes and manual one-click runs.
 * "Schedules" hid those event triggers and made a capability that already
 * existed look missing next to ChatGPT Work, Claude Cowork and
 * Gemini/Antigravity. The old URL still answers and still lands here; the email
 * footer on every task notification points at it.
 *
 * Each automation points at one durable task, so repeated executions add to one
 * transcript and one deliverable history instead of producing a pile of
 * disconnected jobs. Live and paused automations stay split so `nextRunAt` never
 * makes a paused row look like it is about to fire.
 */
export default function AutomationsPage() {
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

  const action = (
    <Button asChild size="sm" className="gap-1.5">
      <Link href="/automations/new">
        <Plus className="size-3.5" aria-hidden="true" /> New automation
      </Link>
    </Button>
  );

  return (
    <AppPage measure="wide">
      <AppPageHeader
        heading="Automations"
        lede="Let a task start itself — at a time you choose or when something changes — with every run attached to the same task so context compounds."
        actions={action}
      />
      {failed ? (
        <WorkLoadError onRetry={() => void load()}>
          Couldn’t load your automations. Existing automations keep their server-side state; this
          page is empty because the read failed, not because they were removed.
        </WorkLoadError>
      ) : schedules === null ? (
        <WorkList>
          <WorkRowSkeletons />
        </WorkList>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={AppIcons.automations}
          title="No automations yet"
          description="Run a task every weekday at eight, when an invoice arrives, before a meeting, when a topic starts moving, or when a granted folder changes. Juno can work while you are elsewhere and stops for approvals when the policy requires it."
          action={action}
        />
      ) : (
        <>
          {active.length > 0 && (
            <section>
              {paused.length > 0 && <h2 className="mb-3 text-heading">Active</h2>}
              <WorkList>
                {active.map((schedule, index) => (
                  <WorkScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    index={index}
                    onChanged={replace}
                  />
                ))}
              </WorkList>
            </section>
          )}
          {paused.length > 0 && (
            <section className={active.length > 0 ? "mt-8" : undefined}>
              {active.length > 0 && <h2 className="mb-3 text-heading">Paused</h2>}
              <WorkList>
                {paused.map((schedule, index) => (
                  <WorkScheduleRow
                    key={schedule.id}
                    index={active.length + index}
                    schedule={schedule}
                    onChanged={replace}
                  />
                ))}
              </WorkList>
            </section>
          )}
        </>
      )}
    </AppPage>
  );
}
