"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronRight, Loader2, Pause, Play } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import { parseCodeRoutineConfig } from "@/lib/work/code-routine";
import {
  WORK_SYNC_EVENT,
  patchWorkSchedule,
  runWorkScheduleNow,
} from "@/components/work/work-transport";
import { describeTrigger } from "@/components/work/work-triggers";
import { IconSwapSet } from "@/components/ui/icon-swap";
import {
  workRowChevronClass,
  workRowClass,
  workRowControlClass,
  workRowEnterClass,
} from "@/components/work/shell/work-section";
import { workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

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
      ? "Runs when its trigger fires"
      : "Paused";
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
  const isCode = schedule.runKind === "code";
  // Nothing emails about a Code run — the notify policy is read by the Work run
  // notifier, which watches `WorkRun` events a Code routine never produces — so
  // the row does not claim it will. What a Code run does instead is appear in
  // the sidebar as its own session, which needs no line here.
  const notify = isCode ? null : notifySentence(schedule.notifyPolicy);
  const parsedCode = isCode ? parseCodeRoutineConfig(schedule.codeConfig) : null;

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
      toast.success("Started. This run is extra, and the schedule still fires when it was going to.");
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
        // The shared list-row recipe (work-section.tsx), with the padding moved
        // onto the anchor: this row is a div wrapping a Link so that its
        // controls are not nested inside an anchor. The press tint is read off
        // that anchor with `:has()`, so pressing Run now does not also darken
        // the whole row; focus is the anchor's own global outline.
        workRowClass,
        workRowEnterClass,
        "gap-0 p-0 [&:has(>a:active)]:bg-secondary",
        // On a phone the controls go under the text instead of beside it, so
        // the name and schedule get the whole width rather than a third of it.
        "max-sm:flex-col max-sm:items-stretch",
        !schedule.enabled && "opacity-75"
      )}
      style={staggerDelay(index, "tight")}
    >
      <Link
        href={`/automations/${schedule.id}`}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-control px-3.5 py-3"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* `text-body`, matching the task row's title — see the note there.
                Four sibling lists were all setting their primary line one pixel
                off the scale and one pixel from their own subtitle. */}
            <span className="min-w-0 truncate text-body font-medium leading-snug text-foreground">
              {schedule.name}
            </span>
            {/* No "Paused" tag: the line under the schedule starts with the
                word, and the row is already dimmed and filed under Paused.
                The repository, because it is the one fact that distinguishes
                two Code routines with similar names and the one a person
                checks before pausing something at eight in the morning. An
                identifier, so mono, and plain text rather than a chip. */}
            {parsedCode?.ok && (
              <span className="truncate font-mono text-caption text-muted-foreground">
                {`${parsedCode.config.repo.owner}/${parsedCode.config.repo.name}`}
              </span>
            )}
          </span>
          <span className="mt-1 block truncate text-ui leading-relaxed text-muted-foreground">
            {schedule.triggers.map((trigger) => describeTrigger(trigger)).join(" · ")}
          </span>
          <span className="mt-1 block truncate text-caption tabular-nums text-muted-foreground">
            {nextFireSentence(schedule)}
            {schedule.lastRunAt !== null && ` · last ran ${workTimeAgo(schedule.lastRunAt)}`}
            {notify !== null && ` · ${notify}`}
          </span>
        </span>
        <ChevronRight className={workRowChevronClass} aria-hidden="true" />
      </Link>

      {/* The row's own controls fade in with the row's hover or focus, as a
          list row's trailing actions do everywhere else — and stay while a
          press is in flight, so a spinner never fades out from under the
          pointer that started it. On a touch screen, where nothing hovers,
          they are always there. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 py-3 pr-2.5 max-sm:-mt-1 max-sm:pb-2.5 max-sm:pl-1.5 max-sm:pt-0",
          "transition-opacity duration-fast ease-out-soft",
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 coarse:opacity-100 max-sm:opacity-100",
          busy !== null && "opacity-100"
        )}
      >
        {/*
          The living task this schedule keeps.
          A schedule points at ONE session and re-runs it, so its transcript and
          its deliverables accumulate across every fire — which is the thing
          about Juno's schedules worth knowing and the thing the UI never said.
          A link rather than a line of prose, because "carries its history
          forward" is only a claim until you can press it and see the history.
          Outside the row's own anchor, like the two controls beside it: an
          anchor nested in an anchor is invalid markup that browsers resolve by
          following the outer one.

          The href goes through `/work/<sessionId>`, deliberately: it is the one
          URL under `/work` that is still a live resolver rather than a legacy
          redirect. A schedule carries a session id and no conversation id
          (`ClientWorkSchedule`), and turning one into the other is an
          owner-scoped lookup only the server can do — see
          src/lib/work-url-migration.ts.

          There is a conversation to resolve to because POST /api/work/schedules
          now creates one with the session it mints, which is what makes the
          history above a thing you can press rather than a claim. A schedule
          created before that landed resolves to the chat index instead: the
          resolver reads the column every time rather than caching an answer, so
          those rows start working the moment a conversation is attached.
        */}
        {/* Absent for a Code routine, and that absence is the honest answer
            rather than a missing feature: a Code routine has no ONE task to
            open. Every fire is a session of its own with its own branch, so
            there is nothing for `/work/<sessionId>` to resolve to — it would
            land on the chat index — and the list of those sessions is on the
            automation's own page, one press away through the row itself. */}
        {!isCode && (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className={cn("h-7 gap-1.5 px-2 font-mono text-micro text-muted-foreground", workRowControlClass)}
          >
            <Link href={`/work/${schedule.sessionId}`}>Its task</Link>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => void runNow()}
          className={cn("h-7 gap-1.5 px-2 font-mono text-micro text-muted-foreground", workRowControlClass)}
        >
          <IconSwapSet
            glyphs={{ idle: Play, busy: Loader2 }}
            show={busy === "run" ? "busy" : "idle"}
            spinning="busy"
            className="size-3"
          />
          Run now
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy !== null}
              onClick={() => void toggle()}
              aria-label={schedule.enabled ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
              className={cn("size-7 text-muted-foreground hover:text-foreground", workRowControlClass)}
            >
              {/* Pause and resume share one slot and cross-fade, through the
                  spinner while the request is out, so the mark the reader
                  pressed turns into its opposite rather than blinking. */}
              <IconSwapSet
                glyphs={{ pause: Pause, resume: Play, busy: Loader2 }}
                show={busy === "toggle" ? "busy" : schedule.enabled ? "pause" : "resume"}
                spinning="busy"
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{schedule.enabled ? "Pause" : "Resume"}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
