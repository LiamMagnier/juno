import type { ClientWorkSchedule } from "@/lib/work/schedule";
import { describeTrigger } from "@/components/work/work-triggers";

/*
 * How a recurring task describes its own rhythm, in one line.
 *
 * Two facts are available and they answer different questions, so the line uses
 * whichever the reader is actually asking:
 *
 *   `nextRunAt`  when it will happen. This is what somebody looking at an inbox
 *                wants — "is this going to move before my meeting" — and it is a
 *                real timestamp the scheduler maintains, not a guess.
 *   the triggers what makes it happen. This is what somebody looking at the
 *                schedule itself wants, and `describeTrigger` already renders it
 *                for the editor.
 *
 * The list takes the first, the detail pages take the second, and neither
 * restates the other. A row reading "Every weekday at 9:00 · next in 3 hours"
 * spends two thirds of its width saying one thing twice.
 *
 * A DISABLED SCHEDULE STILL HAS A `nextRunAt`. The column is not cleared when
 * somebody pauses a schedule — the scheduler simply skips it — so a row that
 * printed the raw value would promise a run that is not coming. That is the one
 * case this file exists to get right, and it is checked before anything else.
 */

/**
 * The cadence line for a list row, or null when there is nothing honest to say.
 *
 * Null rather than an empty string, so a caller has to decide what an absent
 * cadence looks like rather than rendering a stray separator beside nothing.
 */
export function cadenceLine(schedule: ClientWorkSchedule, now: number = Date.now()): string | null {
  if (!schedule.enabled) return "Paused";
  if (schedule.nextRunAt === null) {
    // Enabled, but nothing scheduled. That is what an event trigger looks like
    // between events — it fires when the mail arrives, not on a clock — and
    // "no next run" would read as broken. The trigger's own description is the
    // honest answer, and it is what the row shows instead.
    const trigger = schedule.triggers.find((candidate) => candidate.enabled);
    return trigger === undefined ? null : describeTrigger(trigger);
  }
  const at = Date.parse(schedule.nextRunAt);
  if (Number.isNaN(at)) return null;
  return `Next ${relativeFuture(at - now)}`;
}

/**
 * A future interval, in the coarsest unit that still means something.
 *
 * Deliberately not `workTimeAgo` inverted. That function is tuned for how long
 * ago something happened, where "3 days ago" is precise enough; a run coming up
 * needs the near end of the scale to be finer, because the difference between
 * "in 5 minutes" and "in an hour" changes whether somebody waits for it.
 *
 * A negative interval is a real state, not a bug: the scheduler is a poller, so
 * `nextRunAt` sits slightly in the past between the moment a fire comes due and
 * the moment the poll picks it up. "Due now" is what that is.
 */
function relativeFuture(ms: number): string {
  if (ms <= 0) return "due now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes === 1) return "in a minute";
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "in an hour";
  if (hours < 24) return `in ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

/**
 * The same interval, phrased for a heading rather than a metadata line.
 *
 * The schedules page puts this under a task's name, where "Next in 3 hours"
 * reading as a fragment beside a title is worse than a sentence. Split out
 * rather than parameterised, because a boolean argument named `long` at the
 * call site tells the reader nothing about which phrasing they are getting.
 */
export function cadenceSentence(schedule: ClientWorkSchedule, now: number = Date.now()): string {
  if (!schedule.enabled) return "Paused. It will not run until you switch it back on.";
  if (schedule.nextRunAt === null) {
    const trigger = schedule.triggers.find((candidate) => candidate.enabled);
    return trigger === undefined
      ? "Nothing will start this. Add a time or an event trigger."
      : `Runs when ${describeTrigger(trigger).toLowerCase()}.`;
  }
  const at = Date.parse(schedule.nextRunAt);
  if (Number.isNaN(at)) return "The next run time could not be read.";
  return `Runs again ${relativeFuture(at - now)}.`;
}
