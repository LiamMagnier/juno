import type { ScheduledTask } from "@prisma/client";

/*
 * Scheduled-task cadence math — pure, no database, no `server-only` in its
 * import chain. Split out of scheduled-tasks.ts for the same reason
 * spend-ceiling.ts was split out of spend.ts: this arithmetic decides WHEN
 * money gets spent, and while it lived next to the executor every path to it
 * went through Prisma and the llm chain, so none of it was testable. The
 * executor re-exports everything here, so callers keep one import site.
 */

/** The schedule columns computeNextRunAt needs; satisfied by a ScheduledTask row. */
export type TaskScheduleInput = Pick<
  ScheduledTask,
  "cadence" | "hour" | "minute" | "weekday" | "monthday" | "onDate" | "timezone"
>;

export const DEFAULT_TASK_TIMEZONE = "Europe/Paris";

/** True when Intl accepts the string as an IANA timezone. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of a UTC instant in a timezone (Intl only — no deps). */
function wallClock(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23", // never "24" for midnight
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const v: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") v[p.type] = Number(p.value);
  return { year: v.year, month: v.month, day: v.day, hour: v.hour, minute: v.minute, second: v.second };
}

/**
 * UTC instant for a wall-clock time in a timezone. Guess-and-correct: treat the
 * wall time as UTC, see what it renders as in the zone, shift by the error —
 * converges in ≤2 rounds for every real offset. A nonexistent local time (DST
 * spring-forward) lands on the adjacent valid instant, which is what a
 * schedule wants.
 */
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = target;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(new Date(utc), timeZone);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    if (asUtc === target) break;
    utc += target - asUtc;
  }
  return new Date(utc);
}

/**
 * The single instant a ONCE schedule names — its calendar date + hour:minute
 * resolved in the task's timezone through the same DST-safe wall-clock math
 * every other cadence uses — or null when onDate is missing or not a real
 * calendar day. Exported so the API routes can refuse a one-off in the past
 * instead of silently accepting a task that will never fire as asked.
 */
export function onceRunInstant(task: TaskScheduleInput): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(task.onDate ?? "");
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Date.UTC silently rolls Feb 31 into March; a date that doesn't round-trip
  // is not a date the user picked.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  const tz = isValidTimezone(task.timezone) ? task.timezone : DEFAULT_TASK_TIMEZONE;
  return zonedTimeToUtc(year, month, day, task.hour, task.minute, tz);
}

/**
 * The next instant STRICTLY AFTER `from` when the task should run: the first
 * calendar day (in the task's timezone) that satisfies the cadence and whose
 * hour:minute hasn't already passed. monthday is capped at 28 by the API, so
 * MONTHLY always lands inside every month. ONCE names exactly one instant;
 * once it has passed, the 24h fallback below answers instead — see the branch.
 */
export function computeNextRunAt(task: TaskScheduleInput, from: Date = new Date()): Date {
  if (task.cadence === "ONCE") {
    const at = onceRunInstant(task);
    if (at && at.getTime() > from.getTime()) return at;
    // Fired (or malformed). Returning `from + 24h` — never the past instant —
    // matters for the runner's atomic claim: the claim bumps nextRunAt to take
    // the task off every worker's due list, and a bump into the past would
    // leave a fired one-off claimable twice. executeTask disables a ONCE task
    // right after its run, so this slot only fires if the process died
    // mid-run — the same next-day make-up a crashed recurring run gets.
    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
  }
  const tz = isValidTimezone(task.timezone) ? task.timezone : DEFAULT_TASK_TIMEZONE;
  const start = wallClock(from, tz);
  // Walk calendar days from `from`'s local date. 62 covers the worst MONTHLY
  // gap (just missed this month's slot) with margin.
  for (let offset = 0; offset <= 62; offset++) {
    // Calendar arithmetic on the pure date at UTC noon — immune to DST edges.
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + offset, 12));
    const weekday = d.getUTCDay(); // weekday of a calendar date is timezone-free
    if (task.cadence === "WEEKDAYS" && (weekday === 0 || weekday === 6)) continue;
    if (task.cadence === "WEEKLY" && weekday !== (task.weekday ?? 1)) continue;
    if (task.cadence === "MONTHLY" && d.getUTCDate() !== (task.monthday ?? 1)) continue;
    const at = zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), task.hour, task.minute, tz);
    if (at.getTime() > from.getTime()) return at;
  }
  // Unreachable for valid inputs — every cadence recurs within 62 days.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}
