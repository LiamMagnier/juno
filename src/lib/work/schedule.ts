/**
 * When a Work schedule fires next, what a scheduler should do about it, and
 * what an unattended run is allowed to do when nobody is watching.
 *
 * Generalises `src/lib/scheduled-tasks.ts`'s `computeNextRunAt` from four
 * cadences to eight, adds cron, and fixes the two things the older function
 * could not express: it never advances a schedule as a side effect of anything
 * (the caller decides), and it resolves DST against the zone at computation
 * time rather than by adding a day. Adding 24 hours to a fire is how a daily
 * 09:00 task becomes 08:00 for half the year, and nobody reports it as a bug
 * because it looks like the schedule was always meant to be 08:00.
 *
 * Everything here is pure and takes its clock as an argument. That is not a
 * stylistic preference: the interesting cases are the hour that does not exist
 * in March, the hour that happens twice in October, the 31st of April and a
 * scheduler that was switched off for three days, and none of them can be
 * exercised by a test that reads `Date.now()`.
 *
 * Deliberately free of Prisma, `server-only` and any database import, like
 * `src/app/api/work/protocol.ts`. The row shapes below are structural for the
 * same reason: a Prisma model type would drag the generated client into a
 * module whose whole value is being testable without one.
 */

import { z } from "zod";
import {
  ALWAYS_CONFIRM_ACTIONS,
  WORK_CAPABILITIES,
  WORK_HOST_OFFLINE_POLICIES,
  WORK_MISSED_RUN_POLICIES,
  WORK_PERMISSION_POLICIES,
  WORK_TARGETS,
  WORK_TRIGGER_KINDS,
  WORK_UNATTENDED_POLICIES,
  requiresExplicitApproval,
  selectTarget,
  type HostCapabilityView,
  type WorkCapability,
  type WorkDegradation,
  type WorkEffectiveTarget,
  type WorkHostOfflinePolicy,
  type WorkHostState,
  type WorkMissedRunPolicy,
  type WorkPermissionPolicy,
  type WorkRiskLevel,
  type WorkTarget,
  type WorkTriggerKind,
  type WorkUnattendedPolicy,
} from "@/lib/work/domain";
import { WORK_NOTIFY_POLICIES } from "@/lib/work/notifications";

// ---------------------------------------------------------------------------
// Wall clock in a zone
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CalendarDate {
  year: number;
  /** 1-12. Months are 1-based here and 0-based in `Date`; the conversion is
   *  done once, at each `Date.UTC` call site, rather than carried around. */
  month: number;
  day: number;
}

export interface WallClock extends CalendarDate {
  hour: number;
  minute: number;
}

/**
 * One `Intl.DateTimeFormat` per zone, kept.
 *
 * `nextFireAfter` renders between four and several hundred instants per call,
 * and constructing a formatter is the single most expensive thing in this
 * file — roughly two orders of magnitude more than formatting with one. The
 * cache is keyed by zone and never invalidated because a zone's formatter is
 * immutable; the tzdata a process was started with is the tzdata it keeps.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // "h23" and not "h24": at midnight `h24` renders hour 24 of the previous
    // day, which reads back as a valid number and silently shifts a midnight
    // schedule by a day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  FORMATTERS.set(timeZone, formatter);
  return formatter;
}

/** True when Intl accepts the string as an IANA zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** What a clock on the wall in `timeZone` reads at `instant`. */
export function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const value: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") value[part.type] = Number(part.value);
  }
  return {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
  };
}

/** The wall clock read as though it were UTC. Only ever compared, never shown. */
function wallAsUtcMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
}

/** The zone's offset from UTC at an instant, in ms, positive east of Greenwich. */
function offsetMsAt(instantMs: number, timeZone: string): number {
  return wallAsUtcMs(wallClockAt(new Date(instantMs), timeZone)) - instantMs;
}

/**
 * How a requested wall time relates to the zone's actual timeline.
 *
 * Three outcomes rather than one instant, because the caller genuinely needs to
 * tell them apart: `gap` and `ambiguous` are the two hours a year when a
 * schedule does something a user would call surprising, and a UI that can name
 * what happened is the difference between "Juno ran at the wrong time" and
 * "the clocks changed".
 */
export type WallResolution =
  | { kind: "exact"; instant: Date }
  /** The wall time does not exist: the clocks jumped over it. */
  | { kind: "gap"; instant: Date }
  /** The wall time happens twice. `instant` is the first. */
  | { kind: "ambiguous"; instant: Date; repeat: Date };

/**
 * Resolves a wall time in a zone to the instant a schedule should fire.
 *
 * The candidate construction is the standard one: a wall time can only be
 * produced by the offset in force shortly before it or shortly after it, so
 * probing a day either side yields every possibility, and a candidate is real
 * only when the zone agrees that it renders back to the wall time asked for.
 *
 * Both edges are decided here, once, rather than left to each caller:
 *
 *   Spring, the hour that does not exist. Neither candidate is real. The
 *   schedule fires shifted forward by exactly the gap — 02:30 on a day whose
 *   02:00 became 03:00 fires at 03:30 — which fires once and keeps the
 *   minutes the user chose. Skipping the day instead would silently drop a
 *   daily backup once a year, and firing at both candidates would run it twice.
 *
 *   Autumn, the hour that happens twice. Both candidates are real and the
 *   earlier one wins. The later one is deliberately unreachable: a daily 02:30
 *   job on that day runs once, at the first 02:30, because "my 02:30 job ran
 *   twice and sent two emails" is a worse outcome than "it ran at the first of
 *   the two 02:30s".
 */
export function resolveWallTime(wall: WallClock, timeZone: string): WallResolution {
  const target = wallAsUtcMs(wall);
  const offsetBefore = offsetMsAt(target - DAY_MS, timeZone);
  const offsetAfter = offsetMsAt(target + DAY_MS, timeZone);

  const candidates =
    offsetBefore === offsetAfter ? [target - offsetBefore] : [target - offsetBefore, target - offsetAfter];
  const real = candidates.filter((candidate) => offsetMsAt(candidate, timeZone) === target - candidate);

  if (real.length === 0) {
    // A gap only ever opens when the offset increases, so `offsetBefore` is the
    // smaller one and `target - offsetBefore` is the later candidate — the
    // instant whose wall clock reads the requested time plus the gap.
    return { kind: "gap", instant: new Date(target - offsetBefore) };
  }
  if (real.length === 1) return { kind: "exact", instant: new Date(real[0]) };

  const [first, second] = real[0] <= real[1] ? [real[0], real[1]] : [real[1], real[0]];
  return { kind: "ambiguous", instant: new Date(first), repeat: new Date(second) };
}

/** Weekday (0 = Sunday) of a calendar date. A date's weekday has no timezone. */
function weekdayOf(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** How many days a month has, including February in a leap year. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Time-based trigger specs
// ---------------------------------------------------------------------------

/**
 * The trigger kinds that fire on a clock rather than on something happening.
 *
 * A subset of `WORK_TRIGGER_KINDS`, not a second copy of it: the event-driven
 * kinds live in `triggers.ts` and have no next-fire time at all, so a function
 * that promised one for them would have to return a lie.
 */
export const TIME_TRIGGER_KINDS = [
  "once",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "yearly",
  "cron",
] as const satisfies readonly WorkTriggerKind[];

export type TimeTriggerKind = (typeof TIME_TRIGGER_KINDS)[number];

const TIME_KINDS = new Set<string>(TIME_TRIGGER_KINDS);

export function isTimeTriggerKind(value: string): value is TimeTriggerKind {
  return TIME_KINDS.has(value);
}

export interface CronFields {
  minutes: number[];
  hours: number[];
  monthdays: number[];
  months: number[];
  weekdays: number[];
  /** Whether the day-of-month field was narrowed from `*`. See `dayMatches`. */
  monthdayRestricted: boolean;
  weekdayRestricted: boolean;
}

export type TimeTriggerSpec =
  | { kind: "once"; timezone: string; date: CalendarDate; hour: number; minute: number }
  | { kind: "hourly"; timezone: string; minute: number }
  | { kind: "daily"; timezone: string; hour: number; minute: number }
  | { kind: "weekdays"; timezone: string; hour: number; minute: number }
  | { kind: "weekly"; timezone: string; weekday: number; hour: number; minute: number }
  | { kind: "monthly"; timezone: string; monthday: number; hour: number; minute: number }
  | { kind: "yearly"; timezone: string; month: number; monthday: number; hour: number; minute: number }
  | { kind: "cron"; timezone: string; expression: string; fields: CronFields };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export const TIME_TRIGGER_PARSE_ERRORS = [
  "unknown_kind",
  "unknown_timezone",
  "malformed_config",
  "malformed_cron",
] as const;

export type TimeTriggerParseError = (typeof TIME_TRIGGER_PARSE_ERRORS)[number];

export type TimeTriggerParse =
  | { ok: true; spec: TimeTriggerSpec }
  /** `message` is addressed to whoever is editing the schedule. */
  | { ok: false; error: TimeTriggerParseError; message: string };

function record(config: unknown): Record<string, unknown> | null {
  return typeof config === "object" && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : null;
}

function integerIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= min && value <= max ? value : null;
}

/**
 * Expands one cron field into the values it matches.
 *
 * Supports `*`, a single number, `a-b`, and any of those with a `/step`, which
 * is the whole of the syntax a crontab line uses in practice. Three-letter
 * names (`MON`, `JAN`) are deliberately NOT accepted: half of the schedulers
 * that take them disagree about whether `SUN` is 0 or 7, and silently matching
 * the wrong day is worse than refusing the expression with a message that says
 * to use a number.
 */
function expandCronField(raw: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangePart, stepPart, ...extra] = part.split("/");
    if (extra.length > 0) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [from, to, ...rest] = rangePart.split("-");
      if (rest.length > 0) return null;
      start = Number(from);
      end = Number(to);
    } else {
      start = Number(rangePart);
      // `5/15` means "from 5 to the end of the field, every 15", which is how
      // Vixie cron reads a bare number with a step. Without a step it is the
      // single value 5.
      end = stepPart === undefined ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size === 0 ? null : [...values].sort((a, b) => a - b);
}

/**
 * Parses a five-field cron expression.
 *
 * Day-of-week 7 is folded onto 0 so both Sunday conventions land on the same
 * day rather than on nothing.
 */
export function parseCron(expression: string): CronFields | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = expandCronField(fields[0], 0, 59);
  const hours = expandCronField(fields[1], 0, 23);
  const monthdays = expandCronField(fields[2], 1, 31);
  const months = expandCronField(fields[3], 1, 12);
  const rawWeekdays = expandCronField(fields[4], 0, 7);
  if (!minutes || !hours || !monthdays || !months || !rawWeekdays) return null;

  const weekdays = [...new Set(rawWeekdays.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b);
  return {
    minutes,
    hours,
    monthdays,
    months,
    weekdays,
    monthdayRestricted: fields[2] !== "*",
    weekdayRestricted: fields[4] !== "*",
  };
}

/**
 * Reads a stored `WorkTrigger.config` back into a spec, or says why it cannot.
 *
 * Used by the routes to validate what a user submitted and by the scheduler to
 * read what is already in the column. Both go through here so a config that a
 * newer deployment wrote and this one cannot understand produces a named
 * refusal in one place, rather than a schedule that quietly never fires.
 */
export function parseTimeTrigger(kind: string, config: unknown, timezone: string): TimeTriggerParse {
  if (!isTimeTriggerKind(kind)) {
    return { ok: false, error: "unknown_kind", message: `${kind} does not fire on a clock.` };
  }
  if (!isValidTimeZone(timezone)) {
    return {
      ok: false,
      error: "unknown_timezone",
      message: `Unknown timezone "${timezone}" — use an IANA name like Europe/Paris.`,
    };
  }

  const body = record(config);
  if (!body) {
    return { ok: false, error: "malformed_config", message: "The trigger configuration is not an object." };
  }

  const minute = integerIn(body.minute, 0, 59);
  if (kind !== "cron" && minute === null) {
    return { ok: false, error: "malformed_config", message: "This trigger needs a minute, 0 to 59." };
  }
  const hour = integerIn(body.hour, 0, 23);
  if (kind !== "cron" && kind !== "hourly" && hour === null) {
    return { ok: false, error: "malformed_config", message: "This trigger needs an hour, 0 to 23." };
  }
  // Both are non-null on every path that reads them; the two guards above are
  // what establish that, and the locals carry it into the branches so no case
  // has to assert it again.
  const clockHour = hour ?? 0;
  const clockMinute = minute ?? 0;

  switch (kind) {
    case "once": {
      const year = integerIn(body.year, 1970, 9999);
      const month = integerIn(body.month, 1, 12);
      const day = year !== null && month !== null ? integerIn(body.day, 1, daysInMonth(year, month)) : null;
      if (year === null || month === null || day === null) {
        return {
          ok: false,
          error: "malformed_config",
          message: "A one-off trigger needs a real calendar date: year, month and day.",
        };
      }
      return {
        ok: true,
        spec: { kind, timezone, date: { year, month, day }, hour: clockHour, minute: clockMinute },
      };
    }
    case "hourly":
      return { ok: true, spec: { kind, timezone, minute: clockMinute } };
    case "daily":
      return { ok: true, spec: { kind, timezone, hour: clockHour, minute: clockMinute } };
    case "weekdays":
      return { ok: true, spec: { kind, timezone, hour: clockHour, minute: clockMinute } };
    case "weekly": {
      const weekday = integerIn(body.weekday, 0, 6);
      if (weekday === null) {
        return {
          ok: false,
          error: "malformed_config",
          message: "A weekly trigger needs a weekday, 0 (Sunday) to 6 (Saturday).",
        };
      }
      return { ok: true, spec: { kind, timezone, weekday, hour: clockHour, minute: clockMinute } };
    }
    case "monthly": {
      // 1-31 rather than the legacy 1-28 cap. The cap existed because the old
      // day-walk had no way to express "the 31st of a month with 30 days";
      // `clampMonthday` below does, so a user asking for the 31st gets the last
      // day of every month instead of being told to pick the 28th.
      const monthday = integerIn(body.monthday, 1, 31);
      if (monthday === null) {
        return {
          ok: false,
          error: "malformed_config",
          message: "A monthly trigger needs a day of the month, 1 to 31.",
        };
      }
      return { ok: true, spec: { kind, timezone, monthday, hour: clockHour, minute: clockMinute } };
    }
    case "yearly": {
      const month = integerIn(body.month, 1, 12);
      const monthday = month === null ? null : integerIn(body.monthday, 1, 31);
      if (month === null || monthday === null) {
        return {
          ok: false,
          error: "malformed_config",
          message: "A yearly trigger needs a month (1-12) and a day of the month (1-31).",
        };
      }
      return {
        ok: true,
        spec: { kind, timezone, month, monthday, hour: clockHour, minute: clockMinute },
      };
    }
    case "cron": {
      const expression = typeof body.expression === "string" ? body.expression : "";
      const fields = expression ? parseCron(expression) : null;
      if (!fields) {
        return {
          ok: false,
          error: "malformed_cron",
          message:
            "Expected five cron fields: minute hour day-of-month month day-of-week. " +
            "Use numbers rather than names, and 0 or 7 for Sunday.",
        };
      }
      return { ok: true, spec: { kind, timezone, expression, fields } };
    }
  }
}

// ---------------------------------------------------------------------------
// Next fire
// ---------------------------------------------------------------------------

/**
 * The calendar and clock fields a spec matches, in one shape.
 *
 * Every kind reduces to this, which is what stops `nextFireAfter` from being
 * eight nearly-identical loops. `daily` is "every day, one hour, one minute";
 * `weekdays` is a weekday list; cron is the general case the others are
 * special cases of.
 */
interface FirePlan {
  /** Null means every month. */
  months: number[] | null;
  monthdays: number[] | null;
  weekdays: number[] | null;
  hours: number[];
  minutes: number[];
  /**
   * Whether a day-of-month past the end of a month lands on that month's last
   * day. True for `monthly`/`yearly`, false for cron.
   *
   * The two need opposite answers. A person choosing "the 31st" in a monthly
   * picker means the end of the month — a February that simply never fires is
   * not what they asked for. A cron `0 9 31 * *` means exactly the 31st, and
   * every other cron implementation skips the short months; silently moving it
   * would make Juno's cron disagree with the crontab it was copied from.
   */
  clampMonthday: boolean;
}

function firePlan(spec: TimeTriggerSpec): FirePlan {
  switch (spec.kind) {
    case "once":
      return {
        months: [spec.date.month],
        monthdays: [spec.date.day],
        weekdays: null,
        hours: [spec.hour],
        minutes: [spec.minute],
        clampMonthday: false,
      };
    case "hourly":
      return {
        months: null,
        monthdays: null,
        weekdays: null,
        hours: Array.from({ length: 24 }, (_, hour) => hour),
        minutes: [spec.minute],
        clampMonthday: false,
      };
    case "daily":
      return {
        months: null,
        monthdays: null,
        weekdays: null,
        hours: [spec.hour],
        minutes: [spec.minute],
        clampMonthday: false,
      };
    case "weekdays":
      return {
        months: null,
        monthdays: null,
        weekdays: [1, 2, 3, 4, 5],
        hours: [spec.hour],
        minutes: [spec.minute],
        clampMonthday: false,
      };
    case "weekly":
      return {
        months: null,
        monthdays: null,
        weekdays: [spec.weekday],
        hours: [spec.hour],
        minutes: [spec.minute],
        clampMonthday: false,
      };
    case "monthly":
      return {
        months: null,
        monthdays: [spec.monthday],
        weekdays: null,
        hours: [spec.hour],
        minutes: [spec.minute],
        clampMonthday: true,
      };
    case "yearly":
      return {
        months: [spec.month],
        monthdays: [spec.monthday],
        weekdays: null,
        hours: [spec.hour],
        minutes: [spec.minute],
        clampMonthday: true,
      };
    case "cron":
      return {
        months: spec.fields.months,
        monthdays: spec.fields.monthdayRestricted ? spec.fields.monthdays : null,
        weekdays: spec.fields.weekdayRestricted ? spec.fields.weekdays : null,
        hours: spec.fields.hours,
        minutes: spec.fields.minutes,
        clampMonthday: false,
      };
  }
}

/**
 * Whether a calendar day is one this plan fires on.
 *
 * When both the day-of-month and the weekday are narrowed, a day matching
 * EITHER counts. That is cron's rule, not an invention: `0 9 1 * MON` has meant
 * "the first of the month and every Monday" since Vixie cron, and reading it as
 * "Mondays that fall on the 1st" turns a monthly report into an annual one.
 * The fixed kinds each narrow at most one of the two fields, so the rule is
 * indistinguishable from AND for them.
 */
function dayMatches(plan: FirePlan, date: CalendarDate): boolean {
  if (plan.months && !plan.months.includes(date.month)) return false;

  const lastDay = daysInMonth(date.year, date.month);
  const monthdayOk =
    !plan.monthdays ||
    plan.monthdays.some((day) => (plan.clampMonthday ? Math.min(day, lastDay) : day) === date.day);
  const weekdayOk = !plan.weekdays || plan.weekdays.includes(weekdayOf(date));

  if (plan.monthdays && plan.weekdays) return monthdayOk || weekdayOk;
  return monthdayOk && weekdayOk;
}

/**
 * How far the day walk will look before giving up.
 *
 * Four years and change, which is what a cron expression restricted to
 * 29 February needs. Every other kind resolves inside a year.
 */
const MAX_DAYS_SEARCHED = 1_500;

/**
 * The first instant strictly after `from` at which this spec fires, or null
 * when it never will again.
 *
 * Null is a real answer, not an error: a `once` trigger whose moment has passed
 * has no next fire, and a caller that invented one would re-run it forever.
 *
 * Walks calendar days in the schedule's own zone and resolves each candidate
 * wall time through `resolveWallTime`, so the DST rules are applied exactly
 * once and in one place. Because the walk is in wall time and the comparison is
 * in absolute time, the autumn repeat resolves to an instant that is not after
 * `from` and is therefore skipped — which is what makes a daily job fire once
 * on the 25-hour day without a special case for it.
 */
export function nextFireAfter(spec: TimeTriggerSpec, from: Date): Date | null {
  if (spec.kind === "once") {
    const at = resolveWallTime({ ...spec.date, hour: spec.hour, minute: spec.minute }, spec.timezone).instant;
    return at.getTime() > from.getTime() ? at : null;
  }

  const plan = firePlan(spec);
  const start = wallClockAt(from, spec.timezone);

  for (let offset = 0; offset < MAX_DAYS_SEARCHED; offset++) {
    // Day arithmetic on a UTC midnight, purely as a calendar: adding to
    // `day` rolls months and years correctly and cannot be perturbed by a DST
    // transition, because no zone is involved until `resolveWallTime`.
    const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const date: CalendarDate = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
    };
    if (!dayMatches(plan, date)) continue;

    for (const hour of plan.hours) {
      for (const minute of plan.minutes) {
        const at = resolveWallTime({ ...date, hour, minute }, spec.timezone).instant;
        if (at.getTime() > from.getTime()) return at;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Catching up after downtime
// ---------------------------------------------------------------------------

/**
 * How late a fire may be and still count as this tick's rather than a missed
 * one.
 *
 * Without a grace period every fire is a missed fire the instant it becomes
 * due, and `missedRunPolicy: "skip"` would mean a schedule that never runs at
 * all. Five minutes is comfortably longer than a scheduler tick and far shorter
 * than any cadence a person would call a schedule.
 */
export const MISSED_RUN_GRACE_MS = 5 * 60 * 1000;

/**
 * Ceiling on the runs one catch-up may start.
 *
 * `run_all` after a week of downtime on an hourly schedule is 168 runs, all
 * charged to the user's budget within a minute of the scheduler coming back.
 * The cap is what stops a recovery from being more damaging than the outage.
 */
export const MAX_CATCH_UP_RUNS = 25;

export interface MissedRunInput {
  spec: TimeTriggerSpec;
  /** The fire the schedule was owed: `WorkSchedule.nextRunAt`. */
  dueAt: Date | null;
  now: Date;
  policy: WorkMissedRunPolicy;
}

export interface MissedRunPlan {
  /** Fires that are owed and older than the grace period, oldest first. */
  missed: Date[];
  /** Which fires to actually start, oldest first. */
  run: Date[];
  /**
   * Owed fires the policy or the cap decided not to run.
   *
   * A floor rather than an exact count when the backlog outran the enumeration
   * cap below. Producing the true figure would mean walking a year of fires to
   * report a number nobody acts on beyond "a lot were missed".
   */
  dropped: number;
  /** The next fire strictly after `now`, computed from now — never by adding a
   *  period to the previous one. Null when the schedule will not fire again. */
  nextRunAt: Date | null;
}

/**
 * Works out what a schedule owes after a period in which nobody dispatched it.
 *
 * The split between "missed" and "current" is what makes the three policies
 * mean what their names say. A fire inside the grace window is this tick's work
 * and runs under every policy; anything older is a consequence of downtime, and
 * that is the only thing `missedRunPolicy` gets a say over.
 *
 * `run_once` deliberately picks the MOST RECENT missed fire rather than the
 * oldest. Yesterday's 09:00 report run at 15:00 today reports on today's data
 * whichever fire it is nominally for, so the oldest is the one whose label is
 * furthest from the truth.
 */
function catchUpFires(
  policy: WorkMissedRunPolicy,
  missed: readonly Date[],
  hasCurrentFire: boolean
): Date[] {
  switch (policy) {
    case "skip":
      return [];
    case "run_once":
      // The current fire already IS one run. Adding a catch-up on top of it
      // would make `run_once` mean two.
      if (hasCurrentFire || missed.length === 0) return [];
      return [missed[missed.length - 1]];
    case "run_all":
      return missed.slice(-MAX_CATCH_UP_RUNS);
  }
}

export function planMissedRuns(input: MissedRunInput): MissedRunPlan {
  const nextRunAt = nextFireAfter(input.spec, input.now);
  if (!input.dueAt || input.dueAt.getTime() > input.now.getTime()) {
    return { missed: [], run: [], dropped: 0, nextRunAt };
  }

  const owed: Date[] = [input.dueAt];
  // One past the cap, so a catch-up that was truncated can say so rather than
  // reporting a suspiciously round number as if it were complete.
  while (owed.length <= MAX_CATCH_UP_RUNS) {
    const following = nextFireAfter(input.spec, owed[owed.length - 1]);
    if (!following || following.getTime() > input.now.getTime()) break;
    owed.push(following);
  }

  const freshFrom = input.now.getTime() - MISSED_RUN_GRACE_MS;
  const missed = owed.filter((fire) => fire.getTime() < freshFrom);
  // At most one: a schedule that fires more often than the scheduler ticks
  // would otherwise start a handful of runs every tick simply for being busy.
  const current = owed.length > missed.length ? owed[owed.length - 1] : null;

  const caught = catchUpFires(input.policy, missed, current !== null);
  const run = current === null ? caught : [...caught, current];
  return { missed, run, dropped: missed.length - caught.length, nextRunAt };
}

// ---------------------------------------------------------------------------
// Unattended safety
// ---------------------------------------------------------------------------

/**
 * What a scheduled run does when it reaches an action a person would normally
 * be asked about.
 *
 * There is no member of this union that grants permission, and that is the
 * point rather than an oversight. A scheduled run must not acquire authority it
 * would not have had with the user watching; "nobody is here to say no" is not
 * consent. Adding an auto-approve outcome would mean adding a member to this
 * type, which is a change no reviewer can miss — as opposed to a boolean
 * argument somewhere that defaults to true in one call site.
 */
export type UnattendedOutcome =
  /** Nothing here needs a person. */
  | "proceed"
  /** Park the run in `waiting_approval` and tell the user. */
  | "pause_for_approval"
  /** Do not do this one thing; carry on and report it as skipped. */
  | "skip"
  /** End the attempt. The user asked for this to be an error. */
  | "refuse";

export interface UnattendedDecision {
  outcome: UnattendedOutcome;
  /** One sentence, addressed to the user, for the event and the summary. */
  explanation: string;
}

/**
 * The two actions in `ALWAYS_CONFIRM_ACTIONS` that destroy data outright.
 *
 * A subset rather than a second list: everything else on that list is
 * irreversible in the sense that Juno cannot undo it, while these two are
 * irreversible in the sense that the bytes are gone. `allowsPermanentDelete()`
 * in domain.ts returns `false` unconditionally for the same reason.
 */
const PERMANENT_DELETE_ACTIONS = new Set(["work.file.permanent_delete", "work.file.empty_trash"]);

const ALWAYS_CONFIRM = new Set(ALWAYS_CONFIRM_ACTIONS);

/**
 * Decides what an unattended run may do with one action.
 *
 * A permanent delete always pauses, under every policy. The alternatives are
 * both worse: skipping it leaves the run reporting success while the thing the
 * user scheduled did not happen, and refusing ends an entire attempt over a
 * step a person would have approved in two seconds. Pausing grants nothing — it
 * is the one outcome that leaves the decision with the person who owns the
 * files, which is where a permanent delete belongs.
 *
 * Everything else irreversible follows the policy, and `sensitive` actions
 * always pause: `skip_irreversible` says what it covers in its name, and
 * quietly extending it to sensitive-but-reversible work would be widening a
 * permission the user chose by name.
 */
export function decideUnattendedAction(input: {
  action: string;
  risk: WorkRiskLevel;
  policy: WorkUnattendedPolicy;
}): UnattendedDecision {
  if (PERMANENT_DELETE_ACTIONS.has(input.action)) {
    return {
      outcome: "pause_for_approval",
      explanation: "This would delete something permanently, so the run is waiting for you to confirm it.",
    };
  }

  const irreversible = input.risk === "irreversible" || ALWAYS_CONFIRM.has(input.action);
  if (irreversible) {
    switch (input.policy) {
      case "pause_for_approval":
        return {
          outcome: "pause_for_approval",
          explanation: "This cannot be undone, so the scheduled run is waiting for your approval.",
        };
      case "skip_irreversible":
        return {
          outcome: "skip",
          explanation: "Skipped because it cannot be undone and this schedule runs without you.",
        };
      case "disallow_irreversible":
        return {
          outcome: "refuse",
          explanation: "This schedule is set to treat anything it cannot undo as an error.",
        };
    }
  }

  if (requiresExplicitApproval(input.action, input.risk)) {
    return {
      outcome: "pause_for_approval",
      explanation: "This needs your say-so, and a scheduled run cannot give it on your behalf.",
    };
  }

  return { outcome: "proceed", explanation: "Nothing about this needs a person." };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** How long a scheduler holds a schedule while it works out what to dispatch. */
export const SCHEDULE_LOCK_MS = 60 * 1000;
/** How long to wait before re-examining a schedule held back by concurrency. */
export const CONCURRENCY_RETRY_MS = 60 * 1000;
/** How long to wait before re-examining a local schedule whose Mac is away. */
export const HOST_WAIT_RETRY_MS = 5 * 60 * 1000;

/**
 * How many Work runs one account may have in flight from schedules at once.
 *
 * Per-account and not just per-schedule, because ten schedules each capped at
 * one still start ten simultaneous runs, and the account's budget and the
 * user's attention are shared across all of them.
 */
export const DEFAULT_USER_CONCURRENCY_CAP = 3;

export interface ScheduleDispatchState {
  enabled: boolean;
  /** cloud | local | automatic. */
  target: WorkTarget;
  hostId: string | null;
  nextRunAt: Date | null;
  lockedUntil: Date | null;
  missedRunPolicy: WorkMissedRunPolicy;
  hostOfflinePolicy: WorkHostOfflinePolicy;
  maxConcurrentRuns: number;
}

export interface ScheduleDispatchInput {
  now: Date;
  schedule: ScheduleDispatchState;
  spec: TimeTriggerSpec;
  /** Runs of THIS schedule in a live status right now. */
  inFlightForSchedule: number;
  /** Runs the account has in flight from any schedule. */
  inFlightForUser: number;
  userConcurrencyCap: number;
  /** The account's Work hosts, preferred first. */
  hosts: readonly HostCapabilityView[];
  requiredCapabilities: readonly WorkCapability[];
  cloudAvailable: boolean;
  /** Micro-USD the account may still spend, or null when it is not metered. */
  remainingBudgetMicroUsd: number | null;
}

/**
 * Every way a due schedule can end a tick.
 *
 * Six outcomes rather than "ran" and "error", because they need six different
 * things from the user and five of them are not failures. A run held back by
 * concurrency will happen by itself; one skipped by a policy will not; one
 * blocked by a budget needs a plan change; a failure needs a look at the logs.
 * Collapsing them into one error state is how a schedule that has been silently
 * skipping for a fortnight looks exactly like one that ran fine.
 */
/**
 * Why a fire was held back or dropped, in a form something other than a person
 * can read.
 *
 * The explanation beside it is written for the user and will be rewritten the
 * first time someone improves the wording; a dispatcher that decided what to
 * record by looking for the word "Mac" in it would break silently that day.
 */
export type ScheduleDelayCause = "schedule_concurrency" | "account_concurrency" | "host_offline";
export type ScheduleSkipCause = "host_offline" | "missed_run_policy";

export type ScheduleDispatchDecision =
  | {
      outcome: "dispatch";
      /** The fires to start, oldest first. Usually one. */
      fireAt: Date[];
      nextRunAt: Date | null;
      effectiveTarget: WorkEffectiveTarget;
      hostId: string | null;
      degradation: WorkDegradation[];
      /** Owed fires the missed-run policy or the cap dropped. */
      dropped: number;
      explanation: string;
    }
  /** Owed, not started, nextRunAt untouched so the fire is not lost. */
  | { outcome: "delayed"; cause: ScheduleDelayCause; retryAt: Date; explanation: string }
  /** Deliberately not run. The schedule moves on. */
  | {
      outcome: "skipped";
      cause: ScheduleSkipCause;
      nextRunAt: Date | null;
      dropped: number;
      explanation: string;
    }
  | { outcome: "budget_blocked"; nextRunAt: Date | null; explanation: string }
  | { outcome: "not_due"; explanation: string }
  /** Another scheduler holds the lease. */
  | { outcome: "contended"; explanation: string };

/**
 * Decides what to do with one due schedule, without touching a database.
 *
 * The order of the checks is the substance. Concurrency and an absent host are
 * tested before the missed-run policy, because both mean "not now" rather than
 * "not at all": a schedule held back must keep its `nextRunAt`, so the fire is
 * still owed when the slot or the Mac comes back, and the catch-up it then gets
 * is the one its own policy asked for. Advancing the schedule first — which is
 * what the legacy scheduled-task PATCH does on every write — is precisely how a
 * run that was merely late becomes a run that never happened.
 */
export function planScheduleDispatch(input: ScheduleDispatchInput): ScheduleDispatchDecision {
  const { schedule, now } = input;

  if (!schedule.enabled) {
    return { outcome: "not_due", explanation: "The schedule is paused." };
  }
  if (schedule.lockedUntil && schedule.lockedUntil.getTime() > now.getTime()) {
    return { outcome: "contended", explanation: "Another scheduler is already dispatching this schedule." };
  }
  if (!schedule.nextRunAt) {
    return { outcome: "not_due", explanation: "The schedule has no next run — it has already fired for the last time." };
  }
  if (schedule.nextRunAt.getTime() > now.getTime()) {
    return { outcome: "not_due", explanation: "Not due yet." };
  }

  if (input.inFlightForSchedule >= Math.max(1, schedule.maxConcurrentRuns)) {
    return {
      outcome: "delayed",
      cause: "schedule_concurrency",
      retryAt: new Date(now.getTime() + CONCURRENCY_RETRY_MS),
      explanation: "The previous run of this schedule has not finished, so this one is waiting for it.",
    };
  }
  if (input.inFlightForUser >= input.userConcurrencyCap) {
    return {
      outcome: "delayed",
      cause: "account_concurrency",
      retryAt: new Date(now.getTime() + CONCURRENCY_RETRY_MS),
      explanation: "You already have as many scheduled runs going as Juno will run at once.",
    };
  }

  if (input.remainingBudgetMicroUsd !== null && input.remainingBudgetMicroUsd <= 0) {
    // The schedule DOES advance here. Holding `nextRunAt` at a fire the budget
    // will not permit turns every subsequent tick into another attempt at the
    // same blocked run, and the backlog then all fires at once the moment the
    // budget resets.
    return {
      outcome: "budget_blocked",
      nextRunAt: nextFireAfter(input.spec, now),
      explanation: "This run was skipped because the account has used its budget for the period.",
    };
  }

  // Applied once the target is settled, so the missed-run policy is evaluated
  // exactly once no matter which of the target branches got here.
  const withMissedRuns = (
    effectiveTarget: WorkEffectiveTarget,
    hostId: string | null,
    degradation: readonly WorkDegradation[],
    explanation: string
  ): ScheduleDispatchDecision => {
    const missed = planMissedRuns({
      spec: input.spec,
      dueAt: schedule.nextRunAt,
      now,
      policy: schedule.missedRunPolicy,
    });
    if (missed.run.length === 0) {
      return {
        outcome: "skipped",
        cause: "missed_run_policy",
        nextRunAt: missed.nextRunAt,
        dropped: missed.dropped,
        explanation:
          missed.dropped === 1
            ? "One run was missed while Juno was not dispatching, and this schedule skips missed runs."
            : `${missed.dropped} runs were missed while Juno was not dispatching, and this schedule skips missed runs.`,
      };
    }
    return {
      outcome: "dispatch",
      fireAt: missed.run,
      nextRunAt: missed.nextRunAt,
      effectiveTarget,
      hostId,
      degradation: [...degradation],
      dropped: missed.dropped,
      explanation,
    };
  };

  const required = [...input.requiredCapabilities];
  const selection = selectTarget({
    requested: schedule.target,
    required,
    hosts: input.hosts,
    cloudAvailable: input.cloudAvailable,
  });

  if (selection.target === null) {
    switch (schedule.hostOfflinePolicy) {
      case "wait":
        // `nextRunAt` is deliberately left where it is. The fire stays owed, and
        // when the Mac comes back the missed-run policy decides how much of the
        // backlog to work through — which is the decision the user already made.
        return {
          outcome: "delayed",
          cause: "host_offline",
          retryAt: new Date(now.getTime() + HOST_WAIT_RETRY_MS),
          explanation: `${selection.explanation} This schedule is set to wait for it.`,
        };
      case "skip":
        return {
          outcome: "skipped",
          cause: "host_offline",
          nextRunAt: nextFireAfter(input.spec, now),
          dropped: 1,
          explanation: `${selection.explanation} This schedule is set to skip rather than wait.`,
        };
      case "cloud_subset": {
        // `automatic` is the request that lets `selectTarget` return the cloud
        // with a `local_portion_skipped` degradation. Asking it again rather
        // than assembling the fallback here keeps one implementation of what
        // the cloud can cover and of the sentence the user is shown.
        const fallback = selectTarget({
          requested: "automatic",
          required,
          hosts: input.hosts,
          cloudAvailable: input.cloudAvailable,
        });
        if (fallback.target === null) {
          return {
            outcome: "skipped",
            cause: "host_offline",
            nextRunAt: nextFireAfter(input.spec, now),
            dropped: 1,
            explanation: `${selection.explanation} There is no part of this the cloud can do on its own.`,
          };
        }
        return withMissedRuns(fallback.target, fallback.hostId, fallback.degradation, fallback.explanation);
      }
    }
  }

  return withMissedRuns(selection.target, selection.hostId, selection.degradation, selection.explanation);
}

/**
 * The idempotency key a scheduled run is created with.
 *
 * Derived from the schedule and the exact fire it is for, so two schedulers
 * racing on the same fire — or one scheduler retrying after a lost response —
 * resolve to the same `WorkRun` through the `(userId, idempotencyKey)` unique
 * index rather than to two runs. The lease on `lockedUntil` makes the race
 * rare; this makes it harmless.
 */
export function scheduleRunIdempotencyKey(scheduleId: string, fireAt: Date): string {
  return `wsch:${scheduleId}:${fireAt.toISOString()}`;
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/**
 * The `WorkSchedule` columns this module reads.
 *
 * Structural rather than the Prisma model type, so the module — and the tests
 * that pin the DST behaviour — never need a generated client. A Prisma row
 * satisfies it by having the columns.
 */
export interface WorkScheduleRow {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  instructions: string;
  instructionsVersion: number;
  target: string;
  hostId: string | null;
  timezone: string;
  runConfig: unknown;
  runConfigVersion: number;
  maxCostMicroUsd: number;
  maxTokens: number;
  maxRuntimeMs: number;
  unattendedPolicy: string;
  hostOfflinePolicy: string;
  maxConcurrentRuns: number;
  notifyPolicy: string;
  missedRunPolicy: string;
  retryPolicy: unknown;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  legacyScheduledTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The `WorkTrigger` columns this module reads. */
export interface WorkTriggerRow {
  id: string;
  kind: string;
  config: unknown;
  configVersion: number;
  enabled: boolean;
  lastEventKey: string | null;
  lastFiredAt: Date | null;
  dedupeWindowSec: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientWorkTrigger {
  id: string;
  kind: string;
  config: unknown;
  configVersion: number;
  enabled: boolean;
  lastFiredAt: string | null;
  dedupeWindowSec: number;
}

export interface ClientWorkSchedule {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  instructions: string;
  instructionsVersion: number;
  target: string;
  hostId: string | null;
  timezone: string;
  runConfig: unknown;
  runConfigVersion: number;
  budget: { maxCostMicroUsd: number; maxTokens: number; maxRuntimeMs: number };
  unattendedPolicy: string;
  hostOfflinePolicy: string;
  maxConcurrentRuns: number;
  notifyPolicy: string;
  missedRunPolicy: string;
  retryPolicy: unknown;
  lastRunAt: string | null;
  nextRunAt: string | null;
  legacyScheduledTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  triggers: ClientWorkTrigger[];
}

/**
 * The schedule as a client sees it.
 *
 * `lockedUntil` is absent deliberately, exactly as `serializeRun` omits
 * `leaseExpiresAt`: it says when Juno's own dispatcher can be raced, which is
 * infrastructure detail no client acts on. `lastEventKey` is absent for a
 * different reason — it is a producer's internal identifier for somebody's
 * email or calendar entry, and echoing it to every reader of the schedule
 * leaks which specific message a trigger last matched.
 */
export function serializeSchedule(
  schedule: WorkScheduleRow,
  triggers: readonly WorkTriggerRow[]
): ClientWorkSchedule {
  return {
    id: schedule.id,
    sessionId: schedule.sessionId,
    name: schedule.name,
    enabled: schedule.enabled,
    instructions: schedule.instructions,
    instructionsVersion: schedule.instructionsVersion,
    target: schedule.target,
    hostId: schedule.hostId,
    timezone: schedule.timezone,
    runConfig: schedule.runConfig,
    runConfigVersion: schedule.runConfigVersion,
    budget: {
      maxCostMicroUsd: schedule.maxCostMicroUsd,
      maxTokens: schedule.maxTokens,
      maxRuntimeMs: schedule.maxRuntimeMs,
    },
    unattendedPolicy: schedule.unattendedPolicy,
    hostOfflinePolicy: schedule.hostOfflinePolicy,
    maxConcurrentRuns: schedule.maxConcurrentRuns,
    notifyPolicy: schedule.notifyPolicy,
    missedRunPolicy: schedule.missedRunPolicy,
    retryPolicy: schedule.retryPolicy,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    legacyScheduledTaskId: schedule.legacyScheduledTaskId,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
    triggers: triggers.map((trigger) => ({
      id: trigger.id,
      kind: trigger.kind,
      config: trigger.config,
      configVersion: trigger.configVersion,
      enabled: trigger.enabled,
      lastFiredAt: trigger.lastFiredAt?.toISOString() ?? null,
      dedupeWindowSec: trigger.dedupeWindowSec,
    })),
  };
}

/**
 * The trigger fields a next-fire question needs.
 *
 * Narrower than `WorkTriggerRow` on purpose: the schedule routes have to ask
 * "when would this fire next" about a trigger set the user has submitted but
 * which is not in the database yet, and a parameter typed as the full row would
 * force them to invent an id and two timestamps to ask it.
 */
export interface TimeTriggerSource {
  kind: string;
  config: unknown;
  enabled: boolean;
}

/**
 * The earliest next fire across a schedule's time-based triggers.
 *
 * A schedule may carry several (daily at 08:00 AND every Monday at 17:00), and
 * `WorkSchedule.nextRunAt` is one column, so the schedule is due when the
 * soonest of them is. Event triggers contribute nothing here — they have no
 * next fire — and a trigger whose config this build cannot parse is skipped
 * rather than treated as "never", so one bad row cannot stop the others.
 */
export function nextFireForTriggers(
  triggers: readonly TimeTriggerSource[],
  timezone: string,
  from: Date
): Date | null {
  let earliest: Date | null = null;
  for (const trigger of triggers) {
    if (!trigger.enabled || !isTimeTriggerKind(trigger.kind)) continue;
    const parsed = parseTimeTrigger(trigger.kind, trigger.config, timezone);
    if (!parsed.ok) continue;
    const fire = nextFireAfter(parsed.spec, from);
    if (fire && (!earliest || fire.getTime() < earliest.getTime())) earliest = fire;
  }
  return earliest;
}

/**
 * The trigger that owns a fire the schedule is currently due for.
 *
 * `WorkSchedule.nextRunAt` is one column over a set of triggers, so once it
 * comes due the dispatcher has to work out which trigger put it there before it
 * can enumerate a backlog or advance anything. Asking each trigger for its first
 * fire strictly after the instant just before `dueAt` identifies the one that
 * produced it exactly, and the millisecond of slack is what makes the question
 * answerable at all — `nextFireAfter` is strictly-after by design, so asking it
 * from `dueAt` itself would return the fire AFTER the one being matched.
 *
 * Null when the triggers have been edited since the fire was computed and none
 * of them claims it. The caller must not treat that as "never fires": the fire
 * is real and owed, and the honest fallback is the soonest-firing trigger,
 * which is what the dispatcher uses.
 */
export function triggerOwningFire<T extends TimeTriggerSource>(
  triggers: readonly T[],
  timezone: string,
  dueAt: Date
): { trigger: T; spec: TimeTriggerSpec } | null {
  const probe = new Date(dueAt.getTime() - 1);
  for (const trigger of triggers) {
    if (!trigger.enabled || !isTimeTriggerKind(trigger.kind)) continue;
    const parsed = parseTimeTrigger(trigger.kind, trigger.config, timezone);
    if (!parsed.ok) continue;
    const fire = nextFireAfter(parsed.spec, probe);
    if (fire && fire.getTime() === dueAt.getTime()) return { trigger, spec: parsed.spec };
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON columns
// ---------------------------------------------------------------------------

/**
 * A JSON value, spelled out rather than imported from the generated Prisma
 * client.
 *
 * `Prisma.InputJsonObject` is the type these end up assigned to, and importing
 * it would be a type-only import that erases at runtime — but it would still
 * make this module unbuildable without `prisma generate`, and the whole reason
 * the row shapes above are structural is that the schedule maths must be
 * testable without one.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Reading TEXT columns back into the vocabulary
// ---------------------------------------------------------------------------

/**
 * Narrows a stored string to a known value, or falls back.
 *
 * The same discipline `serializers.ts` applies to every enum-shaped TEXT
 * column: a value written by a newer deployment must resolve to something this
 * build can act on, and it must never resolve to something more permissive than
 * what was written. Each caller below picks its fallback on that basis and says
 * so.
 */
function narrow<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Falls back to `cloud`: an unreadable target must not be resolved into
 *  permission to drive the user's Mac. */
export function scheduleTargetOf(value: string): WorkTarget {
  return narrow(WORK_TARGETS, value, "cloud");
}

/**
 * Falls back to `pause_for_approval`.
 *
 * The three policies differ in how much of the run survives an action nobody
 * can approve, not in how much authority it has — none of them grants any — so
 * the fallback is chosen for the user's work rather than for safety: pausing
 * loses nothing and can be resumed, where the other two throw the step or the
 * attempt away on a value this build simply could not read.
 */
export function unattendedPolicyOf(value: string): WorkUnattendedPolicy {
  return narrow(WORK_UNATTENDED_POLICIES, value, "pause_for_approval");
}

/** Falls back to `skip`: an unreadable value must not authorise a burst of
 *  catch-up runs the account is then billed for. */
export function missedRunPolicyOf(value: string): WorkMissedRunPolicy {
  return narrow(WORK_MISSED_RUN_POLICIES, value, "skip");
}

/** Falls back to `skip`, which is also the column's default. */
export function hostOfflinePolicyOf(value: string): WorkHostOfflinePolicy {
  return narrow(WORK_HOST_OFFLINE_POLICIES, value, "skip");
}

/**
 * Falls back to `conservative`, the narrowest policy there is.
 *
 * Unlike the four above, this one reads a column that decides what a run may do
 * without asking, so the fallback is the only one available: a value this build
 * cannot read must not be resolved into more permission than the narrowest.
 * `src/app/api/work/sessions/[id]/runs/route.ts` holds an equivalent private
 * copy; the two must not disagree about that fallback.
 */
export function permissionPolicyOf(value: string): WorkPermissionPolicy {
  return narrow(WORK_PERMISSION_POLICIES, value, "conservative");
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/** The `WorkHost` columns target selection reads. Structural, like the rows
 *  above, and for the same reason. */
export interface WorkHostRow {
  id: string;
  displayName: string;
  enabled: boolean;
  revokedAt: Date | null;
  allowsFileWork: boolean;
  allowsBrowser: boolean;
  allowsComputerUse: boolean;
  allowsShell: boolean;
  allowsBackground: boolean;
  /** JSONB. A list of bundle identifiers when the user filled one in. */
  allowedApps: unknown;
}

/**
 * What a host can currently do, from what the host itself advertised.
 *
 * Nothing is inferred: a capability the Mac did not claim is a capability it
 * does not have, because the failure of guessing is a run queued at a machine
 * that cannot do the work, which looks exactly like a run about to start.
 *
 * `state` is taken as an argument rather than read off the row. The state to act
 * on is not always the stored one — a Mac closed mid-afternoon leaves `online`
 * in that column — and `effectiveHostState` in the API protocol module already
 * owns that narrowing. Passing it in is what keeps one definition of it instead
 * of a second one here that drifts.
 */
export function hostCapabilityView(host: WorkHostRow, state: WorkHostState): HostCapabilityView {
  const capabilities: WorkCapability[] = [];
  if (host.allowsFileWork) capabilities.push("local_files");
  if (host.allowsBrowser) capabilities.push("local_browser");
  if (host.allowsComputerUse) capabilities.push("local_computer_use");
  if (host.allowsShell) capabilities.push("local_shell");
  if (host.allowsBackground) capabilities.push("background_continuation");
  // Derived from the list the user filled in rather than from a toggle: app
  // control with an empty allowlist can drive nothing, so advertising it would
  // offer a capability whose every use is refused.
  if (Array.isArray(host.allowedApps) && host.allowedApps.length > 0) capabilities.push("local_apps");

  return {
    hostId: host.id,
    displayName: host.displayName,
    state,
    enabled: host.enabled,
    revoked: host.revokedAt !== null,
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Run configuration
// ---------------------------------------------------------------------------

/**
 * The parts of `WorkSchedule.runConfig` a dispatcher acts on.
 *
 * The column is typed and versioned rather than a bag precisely so that a
 * schedule which silently follows the current version of a skill cannot change
 * behaviour when the skill is edited. This reader is the other half of that: it
 * takes only the keys it understands, and anything a newer deployment added is
 * left in the column untouched for the deployment that knows what it means.
 */
export interface ScheduleRunConfig {
  /** Canonical "provider:model", or null to inherit the session's. */
  model: string | null;
  reasoningEffort: string | null;
  /** What the schedule's work needs, which decides where it can run. */
  requiredCapabilities: WorkCapability[];
  /** Skill versions pinned by id, never by "latest". */
  skillVersionIds: string[];
}

const CAPABILITY_SET = new Set<string>(WORK_CAPABILITIES);
/** A sanity bound on a JSONB list, not a product limit. */
const MAX_PINNED_SKILLS = 20;

export function parseScheduleRunConfig(runConfig: unknown): ScheduleRunConfig {
  const body = record(runConfig) ?? {};
  const capabilities = Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities : [];
  const skills = Array.isArray(body.skillVersionIds) ? body.skillVersionIds : [];
  return {
    model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : null,
    reasoningEffort:
      typeof body.reasoningEffort === "string" && body.reasoningEffort.trim()
        ? body.reasoningEffort.trim()
        : null,
    // Filtered rather than rejected. A capability this build does not know is
    // one it cannot check a host against, and carrying it into `selectTarget`
    // would make every target fail to satisfy it — turning a schedule that
    // should run in the cloud into one that never runs anywhere.
    requiredCapabilities: capabilities.filter((entry): entry is WorkCapability =>
      typeof entry === "string" ? CAPABILITY_SET.has(entry) : false
    ),
    skillVersionIds: skills
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, MAX_PINNED_SKILLS),
  };
}

/**
 * Renders a parsed spec back into the flat shape `WorkTrigger.config` holds.
 *
 * The routes store this rather than the body the client sent, so what is in the
 * column is exactly what the scheduler will read back. Storing the raw body
 * instead means a config with a stray `hour: "9"` is accepted at write time and
 * refused at fire time, which surfaces as a schedule that was created without
 * complaint and then never ran.
 */
export function configForTimeTrigger(spec: TimeTriggerSpec): JsonObject {
  switch (spec.kind) {
    case "once":
      return {
        year: spec.date.year,
        month: spec.date.month,
        day: spec.date.day,
        hour: spec.hour,
        minute: spec.minute,
      };
    case "hourly":
      return { minute: spec.minute };
    case "daily":
    case "weekdays":
      return { hour: spec.hour, minute: spec.minute };
    case "weekly":
      return { weekday: spec.weekday, hour: spec.hour, minute: spec.minute };
    case "monthly":
      return { monthday: spec.monthday, hour: spec.hour, minute: spec.minute };
    case "yearly":
      return { month: spec.month, monthday: spec.monthday, hour: spec.hour, minute: spec.minute };
    case "cron":
      // The expression, not the expanded fields. Expanding `*/15` into ninety-six
      // numbers would show the user something they did not write and could not
      // edit back into a crontab line.
      return { expression: spec.expression };
  }
}

// ---------------------------------------------------------------------------
// Editing a schedule
// ---------------------------------------------------------------------------

export interface ScheduleEditInput {
  now: Date;
  /** `WorkSchedule.nextRunAt` before the edit. */
  currentNextRunAt: Date | null;
  /** Whether the edit changed the timezone or any trigger. */
  firingChanged: boolean;
  enabledBefore: boolean;
  enabledAfter: boolean;
  /** The soonest fire of the triggers as they are AFTER the edit, from `now`. */
  recomputed: Date | null;
}

export interface ScheduleEditPlan {
  nextRunAt: Date | null;
  /** Whether the column must actually be written. */
  write: boolean;
  explanation: string;
}

/**
 * Decides whether an edit moves the schedule's next fire.
 *
 * This exists because the legacy scheduled-task PATCH recomputes `nextRunAt`
 * from now on EVERY write, including a body of just `{ name }`. If the worker
 * was down and a fire is overdue, renaming the task — or the list page's
 * optimistic pause toggle — moves the schedule forward and that run never
 * happens, silently, with nothing anywhere recording that it was dropped.
 *
 * So the rule is that only two things move a fire, and both are the user saying
 * so. Changing when it fires obviously replaces the fire that the old
 * definition produced. Resuming a paused schedule starts from now, because
 * pausing is an instruction to stop: catching up a fire from the middle of a
 * two-week pause would run work the user explicitly suspended. Everything else
 * — a rename, a budget, a notification preference, pausing itself — leaves the
 * column exactly where it was, so an overdue fire stays overdue and the
 * missed-run policy remains the only thing that decides its fate.
 */
export function planScheduleEdit(input: ScheduleEditInput): ScheduleEditPlan {
  if (!input.enabledAfter) {
    return {
      nextRunAt: input.currentNextRunAt,
      write: false,
      explanation: "The schedule is paused, so its next fire is left where it is.",
    };
  }
  if (!input.enabledBefore) {
    return {
      nextRunAt: input.recomputed,
      write: true,
      explanation: "The schedule was resumed, so it starts again from now rather than catching up the pause.",
    };
  }
  if (input.firingChanged) {
    return {
      nextRunAt: input.recomputed,
      write: true,
      explanation: "The triggers changed, so the next fire comes from the new ones.",
    };
  }
  return {
    nextRunAt: input.currentNextRunAt,
    write: false,
    explanation: "Nothing about when this fires changed, so an overdue run stays owed.",
  };
}

// ---------------------------------------------------------------------------
// Migrating a legacy scheduled task
// ---------------------------------------------------------------------------

/** The default `ScheduledTask.timezone`, repeated here because the migration
 *  must reproduce the legacy fallback rather than invent a new one. */
export const LEGACY_TASK_TIMEZONE = "Europe/Paris";

/**
 * Weekday and day-of-month a legacy row falls back to when the column is null.
 *
 * `computeNextRunAt` reads `task.weekday ?? 1` and `task.monthday ?? 1`, so a
 * WEEKLY task with no weekday has been firing on Mondays and a MONTHLY one with
 * no monthday on the 1st. Picking anything else here would migrate the task onto
 * a different day from the one it has actually been running on, which is the
 * one thing a migration must never do quietly.
 */
const LEGACY_DEFAULT_WEEKDAY = 1;
const LEGACY_DEFAULT_MONTHDAY = 1;

/** The `ScheduledTask` columns the migration reads. */
export interface LegacyScheduledTaskRow {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  model: string;
  /** DAILY | WEEKDAYS | WEEKLY | MONTHLY. */
  cadence: string;
  hour: number;
  minute: number;
  weekday: number | null;
  monthday: number | null;
  timezone: string;
  webSearch: boolean;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date;
  conversationId: string | null;
}

export interface ScheduleMigrationPlan {
  session: {
    title: string;
    goal: string;
    /** The results thread the task already writes into, kept so the migrated
     *  schedule's history is continuous with the task's. */
    conversationId: string | null;
  };
  schedule: {
    name: string;
    enabled: boolean;
    instructions: string;
    timezone: string;
    target: WorkTarget;
    runConfig: JsonObject;
    unattendedPolicy: WorkUnattendedPolicy;
    hostOfflinePolicy: WorkHostOfflinePolicy;
    missedRunPolicy: WorkMissedRunPolicy;
    maxConcurrentRuns: number;
    notifyPolicy: string;
    lastRunAt: Date | null;
    /** Copied verbatim. See `planTaskMigration`. */
    nextRunAt: Date;
    legacyScheduledTaskId: string;
  };
  trigger: { kind: TimeTriggerKind; config: JsonObject };
}

const LEGACY_CADENCE_KINDS: Record<string, TimeTriggerKind> = {
  DAILY: "daily",
  WEEKDAYS: "weekdays",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
};

/**
 * Turns one `ScheduledTask` into the schedule that replaces it.
 *
 * `nextRunAt` is copied verbatim rather than recomputed, and that is the whole
 * point of the function. A task that was due at 09:00 and is being migrated at
 * 09:04 has a fire owed; recomputing would move it to tomorrow and the run would
 * be lost in the migration itself — the exact failure the missed-run policy
 * exists to prevent, introduced by the thing that was supposed to preserve it.
 *
 * Returns null for a cadence this build cannot express. That is deliberate and
 * it is why the scheduler leaves such a task alone: mapping an unrecognised
 * cadence onto `daily` would produce a schedule that fires at a different time
 * from the task it claims to be, and the user would have no way to tell.
 */
export function planTaskMigration(task: LegacyScheduledTaskRow): ScheduleMigrationPlan | null {
  const kind = LEGACY_CADENCE_KINDS[task.cadence];
  if (!kind) return null;

  const timezone = isValidTimeZone(task.timezone) ? task.timezone : LEGACY_TASK_TIMEZONE;
  const clock: JsonObject = { hour: task.hour, minute: task.minute };
  const config: JsonObject =
    kind === "weekly"
      ? { ...clock, weekday: task.weekday ?? LEGACY_DEFAULT_WEEKDAY }
      : kind === "monthly"
        ? { ...clock, monthday: task.monthday ?? LEGACY_DEFAULT_MONTHDAY }
        : clock;

  return {
    session: {
      title: task.name,
      goal: task.prompt,
      conversationId: task.conversationId,
    },
    schedule: {
      name: task.name,
      enabled: task.enabled,
      instructions: task.prompt,
      timezone,
      // Legacy tasks are a prompt and a model. Nothing about them touches a
      // Mac, so migrating them to `automatic` would offer the planner a local
      // host the user never chose for this work.
      target: "cloud",
      runConfig: {
        model: task.model,
        requiredCapabilities: task.webSearch ? ["web_research"] : [],
        webSearch: task.webSearch,
      },
      // The strictest policy that still finishes the run. A migrated task gains
      // access to approvals it never had; starting it anywhere other than
      // "ask me" would hand it authority the user never granted the task.
      unattendedPolicy: "pause_for_approval",
      hostOfflinePolicy: "skip",
      // What the legacy runner already did: it ran the single overdue fire on
      // the next tick and then advanced. Faithful, not chosen.
      missedRunPolicy: "run_once",
      maxConcurrentRuns: 1,
      // The legacy task could never need a person, so it never notified. A
      // migrated one can stop for an approval, and silence about that is a run
      // that sits until the approval expires.
      notifyPolicy: "on_attention",
      lastRunAt: task.lastRunAt,
      nextRunAt: task.nextRunAt,
      legacyScheduledTaskId: task.id,
    },
    trigger: { kind, config },
  };
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

/*
 * The schedule half of the Work API's request vocabulary, kept beside the maths
 * it validates rather than in `src/app/api/work/protocol.ts`, exactly as
 * `skills.ts` keeps its own. The routes stay thin and every rule below is
 * reachable from a test that needs no database and no request.
 */

/** Ids in this codebase are cuids; the cap is a sanity bound, not a format. */
const MAX_ID_CHARS = 200;
const MAX_NAME_CHARS = 120;
/** A schedule's instructions are re-read on every fire, so they are prose, not
 *  a transcript. The bound matches the legacy task prompt with room to grow. */
const MAX_INSTRUCTIONS_CHARS = 8_000;
/** More than a handful of triggers on one schedule is a sign the user wanted
 *  several schedules; the cap keeps `nextFireForTriggers` cheap either way. */
const MAX_TRIGGERS = 8;
/** A dedupe window longer than a week would suppress a genuinely new event. */
const MAX_DEDUPE_WINDOW_SEC = 7 * 24 * 60 * 60;
/** Concurrent runs of ONE schedule. Beyond this the account cap governs. */
const MAX_SCHEDULE_CONCURRENCY = 5;

const idSchema = z.string().trim().min(1).max(MAX_ID_CHARS);

const budgetSchema = z.object({
  // Zero means "no per-run ceiling" throughout Work, and the account's own
  // budget still applies — `budgetExceeded` in domain.ts reads it the same way.
  maxCostMicroUsd: z.int().min(0).default(0),
  maxTokens: z.int().min(0).default(0),
  maxRuntimeMs: z.int().min(0).default(0),
});

/**
 * One trigger as a client submits it.
 *
 * `config` is deliberately un-narrowed here: what a valid configuration is
 * depends entirely on `kind`, and the two parsers that already know —
 * `parseTimeTrigger` and `parseTriggerConfig` — return a message written for
 * whoever is editing the schedule. Re-expressing those rules as a zod union
 * would be a second, less specific copy that disagrees with the scheduler.
 */
export const triggerInputSchema = z.object({
  kind: z.enum(WORK_TRIGGER_KINDS),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  dedupeWindowSec: z.int().min(0).max(MAX_DEDUPE_WINDOW_SEC).optional(),
});

export const createScheduleSchema = z.object({
  // The session the schedule runs in. Optional: a schedule created from
  // scratch gets a session of its own, made from `name` and `instructions`.
  sessionId: idSchema.optional(),
  name: z.string().trim().min(1).max(MAX_NAME_CHARS),
  instructions: z.string().trim().min(1).max(MAX_INSTRUCTIONS_CHARS),
  timezone: z.string().trim().min(1).max(MAX_ID_CHARS),
  // Required rather than defaulted, for the reason `createSessionSchema` gives:
  // `automatic` is what lets scheduled work silently move off the user's Mac.
  target: z.enum(WORK_TARGETS),
  hostId: idSchema.optional(),
  enabled: z.boolean().default(true),
  triggers: z.array(triggerInputSchema).min(1).max(MAX_TRIGGERS),
  budget: budgetSchema.optional(),
  // The three unattended policies are all ways of NOT acting; there is no
  // fourth. See `WORK_UNATTENDED_POLICIES`.
  unattendedPolicy: z.enum(WORK_UNATTENDED_POLICIES).default("pause_for_approval"),
  hostOfflinePolicy: z.enum(WORK_HOST_OFFLINE_POLICIES).default("skip"),
  missedRunPolicy: z.enum(WORK_MISSED_RUN_POLICIES).default("run_once"),
  notifyPolicy: z.enum(WORK_NOTIFY_POLICIES).default("on_attention"),
  maxConcurrentRuns: z.int().min(1).max(MAX_SCHEDULE_CONCURRENCY).default(1),
  model: z.string().trim().min(1).max(MAX_ID_CHARS).optional(),
  requiredCapabilities: z.array(z.enum(WORK_CAPABILITIES)).max(WORK_CAPABILITIES.length).optional(),
});

export const patchScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_CHARS).optional(),
    instructions: z.string().trim().min(1).max(MAX_INSTRUCTIONS_CHARS).optional(),
    timezone: z.string().trim().min(1).max(MAX_ID_CHARS).optional(),
    target: z.enum(WORK_TARGETS).optional(),
    // Explicitly nullable: clearing the host is how a local schedule is moved
    // back to "any of my Macs", and an absent key cannot express that.
    hostId: idSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    /** A full replacement of the trigger set, never a partial merge. */
    triggers: z.array(triggerInputSchema).min(1).max(MAX_TRIGGERS).optional(),
    budget: budgetSchema.optional(),
    unattendedPolicy: z.enum(WORK_UNATTENDED_POLICIES).optional(),
    hostOfflinePolicy: z.enum(WORK_HOST_OFFLINE_POLICIES).optional(),
    missedRunPolicy: z.enum(WORK_MISSED_RUN_POLICIES).optional(),
    notifyPolicy: z.enum(WORK_NOTIFY_POLICIES).optional(),
    maxConcurrentRuns: z.int().min(1).max(MAX_SCHEDULE_CONCURRENCY).optional(),
    model: z.string().trim().min(1).max(MAX_ID_CHARS).optional(),
    requiredCapabilities: z.array(z.enum(WORK_CAPABILITIES)).max(WORK_CAPABILITIES.length).optional(),
  })
  // An empty patch is a client bug, and answering it with 200 and an unchanged
  // schedule hides that bug for as long as it takes somebody to notice the
  // rename never happened. Unknown keys are stripped by zod, so `{ nmae: "x" }`
  // arrives here as `{}` and is refused, which is the point.
  .refine((body) => Object.keys(body).length > 0, { message: "no_recognised_fields" });

export const runNowSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(MAX_ID_CHARS).optional(),
});

export const SCHEDULE_LIST_DEFAULT_LIMIT = 30;
export const SCHEDULE_LIST_MAX_LIMIT = 100;
export const SCHEDULE_RUN_LIST_DEFAULT_LIMIT = 20;
export const SCHEDULE_RUN_LIST_MAX_LIMIT = 100;

export interface ScheduleListQuery {
  enabled?: boolean;
  sessionId?: string;
  limit: number;
}

export type ScheduleListQueryResult =
  | { ok: true; query: ScheduleListQuery }
  | { ok: false; parameter: string };

/** Absent means "either"; anything that is not the literal true/false is a
 *  client bug worth naming rather than silently reading as false. */
function booleanParam(raw: string | null): boolean | undefined | null {
  if (raw === null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/** Unparseable falls back to the default rather than 400ing, and anything
 *  parseable is clamped — the repo's query-param idiom, and what stops
 *  `?limit=100000` turning a list view into a full-table read. */
function limitParam(raw: string | null, fallback: number, max: number): number {
  const value = Number(raw ?? String(fallback));
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), max) : fallback;
}

export function parseScheduleListQuery(params: URLSearchParams): ScheduleListQueryResult {
  const enabled = booleanParam(params.get("enabled"));
  if (enabled === null) return { ok: false, parameter: "enabled" };

  const sessionId = params.get("sessionId");
  if (sessionId !== null && (sessionId.length === 0 || sessionId.length > MAX_ID_CHARS)) {
    return { ok: false, parameter: "sessionId" };
  }

  return {
    ok: true,
    query: {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(sessionId !== null ? { sessionId } : {}),
      limit: limitParam(params.get("limit"), SCHEDULE_LIST_DEFAULT_LIMIT, SCHEDULE_LIST_MAX_LIMIT),
    },
  };
}

export interface ScheduleRunListQuery {
  /** Only runs created strictly before this instant, for paging backwards. */
  before?: Date;
  limit: number;
}

export type ScheduleRunListQueryResult =
  | { ok: true; query: ScheduleRunListQuery }
  | { ok: false; parameter: string };

export function parseScheduleRunListQuery(params: URLSearchParams): ScheduleRunListQueryResult {
  const beforeRaw = params.get("before");
  let before: Date | undefined;
  if (beforeRaw !== null) {
    const parsed = new Date(beforeRaw);
    // A cursor that does not parse must be refused rather than dropped. Reading
    // it as "no cursor" hands the client page one again, and a client that
    // pages until it sees a short page would then loop over the first page for
    // ever without either side reporting an error.
    if (Number.isNaN(parsed.getTime())) return { ok: false, parameter: "before" };
    before = parsed;
  }

  return {
    ok: true,
    query: {
      ...(before ? { before } : {}),
      limit: limitParam(
        params.get("limit"),
        SCHEDULE_RUN_LIST_DEFAULT_LIMIT,
        SCHEDULE_RUN_LIST_MAX_LIMIT
      ),
    },
  };
}
