"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronRight, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import {
  WORK_SYNC_EVENT,
  patchWorkSchedule,
  runWorkScheduleNow,
} from "@/components/work/work-transport";
import { describeTrigger } from "@/components/work/work-triggers";
import { workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * One schedule in a list, with the two controls somebody actually reaches for.
 *
 * Pause and Run now are here rather than one page deeper because they are what
 * a list of schedules is for: a person opens this because something is about to
 * fire and they want it not to, or because something did not fire and they want
 * it to now. Everything else — the trigger set, the instructions, the policies —
 * is editing, and editing is a page.
 *
 * They are also two genuinely different requests and the row says so. Pausing
 * cancels the fires that were queued and cannot touch a run already under way;
 * Run now starts one attempt and deliberately does NOT move the schedule, so
 * this evening's run still happens. Both sentences come back from the server and
 * are shown as they arrive.
 */

/**
 * When this fires next, as a sentence.
 *
 * A paused schedule keeps its `nextRunAt` — the column is inert while `enabled`
 * is false, and the dispatcher's due query filters on both — so the row can say
 * "paused; would have run tomorrow at 09:00", which is the one thing somebody
 * deciding whether to resume actually wants.
 */
function nextFireSentence(schedule: ClientWorkSchedule): string {
  if (schedule.nextRunAt === null) {
    return schedule.enabled
      ? "Nothing on the clock — this one waits for an event."
      : "Paused. Nothing on the clock either way.";
  }
  const when = new Date(schedule.nextRunAt);
  if (Number.isNaN(when.getTime())) return "Next run unknown.";
  // Rendered in the reader's own locale rather than the schedule's zone: the
  // schedule fires at 09:00 in Europe/Paris, and somebody reading this in
  // Lisbon needs to know that is 08:00 for them.
  const formatted = when.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return schedule.enabled ? `Next: ${formatted}` : `Paused. Would have run ${formatted}`;
}

/**
 * What this schedule will send, in three words.
 *
 * On the row rather than only in the editor because this list is where somebody
 * notices that the hourly sweep they set up last month is the reason their inbox
 * is full — and because the opposite mistake is quieter and worse: a schedule
 * that has been failing for a week reads exactly like one that has been working,
 * unless the row says nothing was ever going to tell them.
 *
 * `none` is the only one that gets a sentence, because it is the only one whose
 * consequence is silence. The other three are stated flatly; the editor carries
 * the full explanation, including the blocked-run exception that `none` cannot
 * silence.
 */
function notifySentence(notifyPolicy: string): string | null {
  switch (notifyPolicy) {
    case "none":
      return "No email unless a run gets stuck";
    case "on_attention":
      return "Emails when it needs you";
    case "on_finish":
      return "Emails on every run";
    case "all":
      return "Emails on everything";
    default:
      return null;
  }
}

export function WorkScheduleRow({
  schedule,
  index = 0,
  onChanged,
}: {
  schedule: ClientWorkSchedule;
  index?: number;
  onChanged: (schedule: ClientWorkSchedule) => void;
}) {
  const [busy, setBusy] = React.useState<"toggle" | "run" | null>(null);
  const notify = notifySentence(schedule.notifyPolicy);

  const toggle = async () => {
    setBusy("toggle");
    const result = await patchWorkSchedule(schedule.id, { enabled: !schedule.enabled });
    setBusy(null);
    if (result.kind === "ok") {
      onChanged(result.value.schedule);
      // What pausing did to the runs it had queued, and to the one it could not
      // stop. Nothing else in the response says it, and a schedule that reads
      // "paused" over a run still writing to somebody's Documents folder has
      // told them the opposite of the truth.
      const notes = [result.value.runs, result.value.scheduling].filter(
        (note): note is string => note !== null
      );
      toast.success(
        notes.length > 0
          ? notes.join(" ")
          : schedule.enabled
            ? "Paused. Nothing new will start."
            : "Resumed."
      );
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : "Couldn’t change this schedule. It is exactly as it was."
    );
  };

  const runNow = async () => {
    setBusy("run");
    const result = await runWorkScheduleNow(schedule.id);
    setBusy(null);
    if (result.kind === "ok") {
      window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
      toast.success("Started. This run is extra — the schedule still fires when it was going to.");
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : "Couldn’t start this. Nothing was queued, so trying again is safe."
    );
  };

  return (
    <div
      className={cn(
        "group flex items-start rounded-xl border border-border/60 bg-card/60 transition-[background-color,border-color] duration-base ease-out-soft hover:border-border hover:bg-card motion-safe:animate-rise-in",
        "[animation-fill-mode:backwards]",
        !schedule.enabled && "opacity-75"
      )}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <Link
        href={`/work/schedules/${schedule.id}`}
        className="flex min-w-0 flex-1 items-start gap-3 px-3.5 py-3"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {schedule.name}
            </span>
            {!schedule.enabled && (
              <span className="shrink-0 rounded-full border border-border/70 bg-background/50 px-2 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                Paused
              </span>
            )}
          </span>
          <span className="mt-1 block truncate text-[13px] leading-relaxed text-muted-foreground">
            {schedule.triggers.map((trigger) => describeTrigger(trigger)).join(" · ")}
          </span>
          <span className="mt-1.5 block font-mono text-[10px] text-muted-foreground/70">
            {nextFireSentence(schedule)}
            {schedule.lastRunAt !== null && ` · last ran ${workTimeAgo(schedule.lastRunAt)}`}
            {notify !== null && ` · ${notify}`}
          </span>
        </span>
        <ChevronRight
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform duration-base ease-out-soft group-hover:translate-x-0.5 group-hover:text-foreground"
          aria-hidden="true"
        />
      </Link>

      <div className="flex shrink-0 items-center gap-1 py-3 pr-2.5">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => void runNow()}
          className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground"
        >
          {busy === "run" ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <Play className="h-3 w-3" aria-hidden="true" />
          )}
          Run now
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy !== null}
          onClick={() => void toggle()}
          aria-label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
          className="h-7 w-7 text-muted-foreground/70 hover:text-foreground"
        >
          {busy === "toggle" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : schedule.enabled ? (
            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  );
}
