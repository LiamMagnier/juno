"use client";

import { CustomizeFrame } from "@/components/customize/customize-nav";
import * as React from "react";
import Link from "next/link";
import { Plus } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import { EditorialSection, PageHero } from "@/components/app/editorial";
import { RoutinesWeek } from "@/components/work/routines-week";
import { WorkScheduleRow } from "@/components/work/work-schedule-row";
import { WorkRowSkeletons } from "@/components/work/shell/work-states";
import { fetchWorkSchedules } from "@/components/work/work-transport";
import { EmptyState } from "@/components/ui/empty-state";
import { FEATURE_NAMES } from "@/lib/brand/names";

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
/**
 * The last list this tab loaded, kept for the next visit: switching Customize
 * tabs shows the routines at once and refreshes them behind, instead of a
 * skeleton every time the reader comes back.
 */
let lastSchedules: ClientWorkSchedule[] | null = null;

export default function AutomationsPage() {
  const [schedules, setSchedulesState] = React.useState<ClientWorkSchedule[] | null>(lastSchedules);
  const setSchedules = React.useCallback((next: React.SetStateAction<ClientWorkSchedule[] | null>) => {
    setSchedulesState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      if (value !== null) lastSchedules = value;
      return value;
    });
  }, []);
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
  }, [setSchedules]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const replace = React.useCallback((saved: ClientWorkSchedule) => {
    setSchedules((current) =>
      current === null
        ? current
        : current.map((schedule) => (schedule.id === saved.id ? saved : schedule))
    );
  }, [setSchedules]);

  const active = (schedules ?? []).filter((schedule) => schedule.enabled);
  const paused = (schedules ?? []).filter((schedule) => !schedule.enabled);

  const action = (
    <Button asChild size="sm" className="gap-1.5">
      <Link href="/automations/new">
        <Plus className="size-3.5" aria-hidden="true" /> New routine
      </Link>
    </Button>
  );

  const next = active
    .map((schedule) => schedule.nextRunAt)
    .filter((at): at is string => at !== null)
    .sort()[0];

  const list = (rows: ClientWorkSchedule[], offset: number) => (
    <div className="ed-stagger -mx-3 space-y-0.5">
      {rows.map((schedule, index) => (
        <WorkScheduleRow key={schedule.id} schedule={schedule} index={offset + index} onChanged={replace} />
      ))}
    </div>
  );

  return (
    <CustomizeFrame current="routines">
      <PageHero
        heading={FEATURE_NAMES.routines.label}
        lede="Tasks that start themselves, on a schedule or when something changes."
        actions={action}
        figures={
          schedules && schedules.length > 0
            ? [
                { label: "Active", value: active.length },
                { label: "Paused", value: paused.length },
                { label: "Next run", value: next ? nextIn(next) : "None set", small: true },
              ]
            : undefined
        }
        aside={schedules && active.some((schedule) => schedule.nextRunAt) ? <RoutinesWeek schedules={schedules} /> : undefined}
      />
      <div className="h-14" aria-hidden="true" />
      {failed ? (
        <LoadError
          title="Couldn’t load your routines"
          description="They keep running. Check your connection and try again."
          onRetry={() => void load()}
        />
      ) : schedules === null ? (
        <EditorialSection title="Active">
          <div className="-mx-3">
            <WorkRowSkeletons />
          </div>
        </EditorialSection>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={AppIcons.automations}
          title="No routines yet"
          description="Run a task on a schedule, or when something happens, like an invoice arriving or a meeting about to start."
          action={action}
        />
      ) : (
        <div className="space-y-16">
          {active.length > 0 && (
            <EditorialSection
              title="Active"
              meta={<span>{active.length === 1 ? "1 routine" : `${active.length} routines`}</span>}
            >
              {list(active, 0)}
            </EditorialSection>
          )}
          {paused.length > 0 && (
            <EditorialSection
              title="Paused"
              meta={<span>{paused.length === 1 ? "1 routine" : `${paused.length} routines`}</span>}
            >
              <p className="mb-4 max-w-[34rem] text-ui text-muted-foreground">
                These keep their history and start again from their next run when you turn them back on.
              </p>
              {list(paused, active.length)}
            </EditorialSection>
          )}
        </div>
      )}
    </CustomizeFrame>
  );
}

/** "in 3 hours", "tomorrow": the next run as a reader says it. */
function nextIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 60_000) return "Now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `In ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `In ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Tomorrow" : `In ${days} days`;
}
