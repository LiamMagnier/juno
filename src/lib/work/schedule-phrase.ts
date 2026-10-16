/**
 * "Every weekday at 8am", read into a routine trigger.
 *
 * The routine editor asks for a schedule as a form: a cadence, an hour, a
 * minute, a weekday. People do not think in those fields, they think in the
 * sentence, and every competitor that lets you schedule from chat reads the
 * sentence. This module is the one reader, shared by the chat tool that drafts
 * a routine (`propose_routine`), the proposal card's Edit field and the
 * routine editor's "Describe when" box, so a phrase means the same schedule on
 * all three.
 *
 * WHAT IT PRODUCES IS WHAT THE SCHEDULER READS. The output is a trigger kind
 * and a config in exactly the shape `parseTimeTrigger` accepts, and every
 * result is put through that parser before it is returned. A phrase this
 * module understood but the scheduler would refuse is reported as unreadable,
 * never handed on: a routine accepted at the card and refused at the fire is
 * the failure the whole schedule module is written to prevent.
 *
 * DELIBERATELY NARROW. English, recurring schedules only, nothing more often
 * than hourly. A one-off ("tomorrow at 9") is refused with a sentence rather
 * than guessed at, because a routine that runs once is a task, and a phrase
 * read wrongly is a run at four in the morning that nobody asked for. Anything
 * this cannot read is said plainly, and the editor's form is still there.
 *
 * Pure and client-safe: no Prisma, no `server-only`, its clock is an argument.
 */

import {
  configForTimeTrigger,
  nextFireAfter,
  parseCron,
  parseTimeTrigger,
  type JsonObject,
  type TimeTriggerKind,
} from "@/lib/work/schedule";

/** The trigger kinds a phrase can produce. `once` is refused on purpose. */
export type PhraseTriggerKind = Exclude<TimeTriggerKind, "once">;

export interface SchedulePhrase {
  kind: PhraseTriggerKind;
  /** Exactly what `parseTimeTrigger(kind, config, tz)` accepts. */
  config: JsonObject;
  /** True when the phrase named no clock time and the default was used. */
  assumedTime: boolean;
}

export const SCHEDULE_PHRASE_ERRORS = ["empty", "not_recurring", "too_frequent", "unrecognised"] as const;
export type SchedulePhraseError = (typeof SCHEDULE_PHRASE_ERRORS)[number];

export type SchedulePhraseResult =
  | { ok: true; schedule: SchedulePhrase }
  /** `message` is written for the person who typed the phrase. */
  | { ok: false; reason: SchedulePhraseError; message: string };

export const SCHEDULE_PHRASE_MESSAGES: Record<SchedulePhraseError, string> = {
  empty: "Say when it should run, like “every weekday at 8am”.",
  not_recurring: "That reads as a one-off. A routine repeats, so say how often, like “every Monday at 9am”.",
  too_frequent: "Routines run at most once an hour. Try “every hour” or “every 2 hours”.",
  unrecognised: "Couldn’t read that schedule. Try “every weekday at 8am”, “every Monday at 9:30” or “on the 1st of every month”.",
};

function refuse(reason: SchedulePhraseError): SchedulePhraseResult {
  return { ok: false, reason, message: SCHEDULE_PHRASE_MESSAGES[reason] };
}

/** When the phrase names no time at all. */
const DEFAULT_HOUR = 9;

const DAY_PARTS = {
  morning: { hour: 8, pm: false },
  afternoon: { hour: 14, pm: true },
  evening: { hour: 18, pm: true },
  night: { hour: 21, pm: true },
} as const;
type DayPart = keyof typeof DAY_PARTS;

const WEEKDAY_WORDS: readonly [RegExp, number][] = [
  [/\bsun(?:day)?s?\b/, 0],
  [/\bmon(?:day)?s?\b/, 1],
  [/\btue(?:s|sday)?s?\b/, 2],
  [/\bwed(?:nesday)?s?\b/, 3],
  [/\bthu(?:r|rs|rsday)?s?\b/, 4],
  [/\bfri(?:day)?s?\b/, 5],
  [/\bsat(?:urday)?s?\b/, 6],
];

const DAY_INDEX: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const MONTH_WORDS: readonly [RegExp, number][] = [
  [/\bjan(?:uary)?\b/, 1],
  [/\bfeb(?:ruary)?\b/, 2],
  [/\bmar(?:ch)?\b/, 3],
  [/\bapr(?:il)?\b/, 4],
  [/\bmay\b/, 5],
  [/\bjune?\b/, 6],
  [/\bjuly?\b/, 7],
  [/\baug(?:ust)?\b/, 8],
  [/\bsep(?:t|tember)?\b/, 9],
  [/\boct(?:ober)?\b/, 10],
  [/\bnov(?:ember)?\b/, 11],
  [/\bdec(?:ember)?\b/, 12],
];

function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\ba\.m\.?/g, "am")
    .replace(/\bp\.m\.?/g, "pm")
    .replace(/[“”"'’,!?;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/, "")
    .trim();
}

interface ClockRead {
  hour: number;
  minute: number;
  /** am/pm was stated, so a day part must not shift it. */
  meridiem: boolean;
  /** No digits: "noon" or a day part default. */
  rest: string;
}

/**
 * The clock time in the phrase, and the phrase with it removed, so its digits
 * cannot be read again as a day of the month.
 */
function readClock(text: string): ClockRead | null | "invalid" {
  const named: readonly [RegExp, number][] = [
    [/\b(?:at\s+)?(?:noon|midday)\b/, 12],
    [/\b(?:at\s+)?midnight\b/, 0],
  ];
  for (const [pattern, hour] of named) {
    if (pattern.test(text)) return { hour, minute: 0, meridiem: true, rest: text.replace(pattern, " ") };
  }

  // 8am, 8 am, 8:30pm, 8.30 pm, 08h30pm
  const twelve = /\b(?:at\s+)?(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)\b/.exec(text);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (hour < 1 || hour > 12 || minute > 59) return "invalid";
    if (twelve[3] === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
    return { hour, minute, meridiem: true, rest: text.replace(twelve[0], " ") };
  }

  // 08:30, 17:00, 17h30
  const twentyFour = /\b(?:at\s+)?(\d{1,2})[:h](\d{2})\b/.exec(text);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    // A time that cannot exist is a mistake to say back, never a reason to
    // fall through to the nine o'clock default.
    if (hour > 23 || minute > 59) return "invalid";
    return { hour, minute, meridiem: hour >= 13 || hour === 0, rest: text.replace(twentyFour[0], " ") };
  }

  // "at 8", but not "at 8th" or "at 8 minutes past"
  const bare = /\bat\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th|minutes?|mins?|hours?|past|:))/.exec(text);
  if (bare) {
    const hour = Number(bare[1]);
    if (hour > 23) return "invalid";
    return { hour, minute: 0, meridiem: hour >= 13 || hour === 0, rest: text.replace(bare[0], " ") };
  }
  return null;
}

function dayPartOf(text: string): DayPart | null {
  if (/\b(?:morning|mornings)\b/.test(text)) return "morning";
  if (/\b(?:afternoon|afternoons)\b/.test(text)) return "afternoon";
  if (/\b(?:evening|evenings)\b/.test(text)) return "evening";
  if (/\b(?:night|nights|nightly|tonight)\b/.test(text)) return "night";
  return null;
}

/** "15 past", ":15", "quarter past", "half past" — the minute of an hourly routine. */
function hourlyMinute(text: string, clock: ClockRead | null): number {
  const past = /\b(\d{1,2})\s*(?:minutes?\s*)?past\b/.exec(text);
  if (past && Number(past[1]) <= 59) return Number(past[1]);
  const colon = /(?:^|\s):(\d{2})\b/.exec(text);
  if (colon && Number(colon[1]) <= 59) return Number(colon[1]);
  if (/\bquarter past\b/.test(text)) return 15;
  if (/\bhalf past\b/.test(text)) return 30;
  if (/\bquarter to\b/.test(text)) return 45;
  return clock?.minute ?? 0;
}

/** Every weekday named, as cron day numbers, ranges expanded ("mon-wed", "monday to friday"). */
function weekdaysNamed(text: string): number[] {
  const days = new Set<number>();
  const range = /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)s?\s*(?:-|to|through|thru|until)\s*(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)s?\b/;
  let working = text;
  for (let guard = 0; guard < 4; guard++) {
    const match = range.exec(working);
    if (!match) break;
    const from = DAY_INDEX[match[1]];
    const to = DAY_INDEX[match[2]];
    if (from === undefined || to === undefined) break;
    for (let day = from; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === to) break;
    }
    working = working.replace(match[0], " ");
  }
  for (const [pattern, day] of WEEKDAY_WORDS) {
    if (pattern.test(working)) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

function monthNamed(text: string): number | null {
  for (const [pattern, month] of MONTH_WORDS) {
    // "may" is also a verb; only trust it beside a day number.
    if (month === 5 && !/\b(?:\d{1,2}(?:st|nd|rd|th)?\s+may|may\s+\d{1,2}(?:st|nd|rd|th)?)\b/.test(text)) continue;
    if (pattern.test(text)) return month;
  }
  return null;
}

/** "the 1st", "15th", "on the 3", "day 12", "last day" (31, which the scheduler clamps to the month's last day). */
const MONTH_STEM = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";

function monthdayNamed(text: string): number | null {
  if (/\blast day\b/.test(text)) return 31;
  if (/\bfirst day\b/.test(text)) return 1;
  // A number beside a month name: "14 february", "1 may", "march 3".
  const beside =
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_STEM}\\b`).exec(text) ??
    new RegExp(`\\b${MONTH_STEM}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(text);
  if (beside) {
    const value = Number(beside[1]);
    if (value >= 1 && value <= 31) return value;
  }
  const ordinal = /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(text);
  if (ordinal) {
    const value = Number(ordinal[1]);
    return value >= 1 && value <= 31 ? value : null;
  }
  const plain = /\b(?:on the|on|the|day)\s+(\d{1,2})\b/.exec(text);
  if (plain) {
    const value = Number(plain[1]);
    return value >= 1 && value <= 31 ? value : null;
  }
  return null;
}

function finish(kind: PhraseTriggerKind, config: JsonObject, assumedTime: boolean): SchedulePhraseResult {
  // The scheduler's own parser has the last word, in UTC because the zone
  // changes nothing about whether a config is well formed.
  const parsed = parseTimeTrigger(kind, config, "UTC");
  if (!parsed.ok) return refuse("unrecognised");
  return { ok: true, schedule: { kind, config: configForTimeTrigger(parsed.spec), assumedTime } };
}

/**
 * Reads a schedule phrase. See the module note for what it accepts and why it
 * refuses the rest.
 */
export function parseSchedulePhrase(input: string): SchedulePhraseResult {
  const text = normalise(input);
  if (!text) return refuse("empty");

  if (/\bevery\s+(?:\d+\s+)?(?:minutes?|mins?|seconds?)\b|\bevery\s+half\s+(?:an\s+)?hour\b|\bminutely\b/.test(text)) {
    return refuse("too_frequent");
  }

  // Cadences the scheduler cannot express exactly. Refused rather than rounded
  // to the nearest thing it can do: "the first Monday" read as "every Monday"
  // is four runs a month where one was asked for.
  if (
    /\b(?:every other|every (?:two|three|four|2|3|4) (?:days|weeks|months)|fortnight(?:ly)?|bi-?weekly|bi-?monthly)\b/.test(text) ||
    /\b(?:first|second|third|fourth|last|1st|2nd|3rd|4th)\s+(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.test(text) ||
    /\b(?:between|from)\s+\d/.test(text)
  ) {
    return refuse("unrecognised");
  }

  const clockRead = readClock(text);
  if (clockRead === "invalid") return refuse("unrecognised");
  const clock = clockRead;
  const rest = clock ? clock.rest : text;
  const part = dayPartOf(rest);

  // The time of day: what was said, adjusted by "in the evening"; else the day
  // part's default; else nine in the morning, marked as assumed.
  let hour = DEFAULT_HOUR;
  let minute = 0;
  let assumedTime = true;
  if (clock) {
    hour = clock.hour;
    minute = clock.minute;
    assumedTime = false;
    if (!clock.meridiem && part && DAY_PARTS[part].pm && hour < 12) hour += 12;
    // "every night at 12" is midnight, not noon.
    else if (!clock.meridiem && part === "night" && hour === 12) hour = 0;
  } else if (part) {
    hour = DAY_PARTS[part].hour;
  }

  // Every N hours.
  const everyHours = /\bevery\s+(\d{1,2})\s*(?:hours?|hrs?|h)\b/.exec(rest);
  if (everyHours) {
    const n = Number(everyHours[1]);
    if (n < 1 || n > 23) return refuse("unrecognised");
    const m = hourlyMinute(rest, clock);
    if (n === 1) return finish("hourly", { minute: m }, false);
    return finish("cron", { expression: `${m} */${n} * * *` }, false);
  }
  if (/\b(?:hourly|every hour|each hour|on the hour)\b/.test(rest)) {
    return finish("hourly", { minute: hourlyMinute(rest, clock) }, false);
  }

  // Weekdays as a block.
  if (/\b(?:weekdays?|every weekday|workdays?|work days?|working days?|business days?)\b/.test(rest) || /\bmon(?:day)?\s*(?:-|to|through|thru)\s*fri(?:day)?\b/.test(rest)) {
    return finish("weekdays", { hour, minute }, assumedTime);
  }
  if (/\bweekends?\b/.test(rest)) {
    return finish("cron", { expression: `${minute} ${hour} * * 0,6` }, assumedTime);
  }

  const days = weekdaysNamed(rest);
  if (days.length > 0) {
    if (days.length === 7) return finish("daily", { hour, minute }, assumedTime);
    if (days.length === 5 && days.every((day) => day >= 1 && day <= 5)) {
      return finish("weekdays", { hour, minute }, assumedTime);
    }
    if (days.length === 1) return finish("weekly", { weekday: days[0], hour, minute }, assumedTime);
    return finish("cron", { expression: `${minute} ${hour} * * ${days.join(",")}` }, assumedTime);
  }

  // A month named with a day is a yearly date ("every 3 March", "each year on March 3rd").
  const month = monthNamed(rest);
  const monthday = monthdayNamed(rest);
  const yearly = /\b(?:every year|each year|yearly|annually|anniversary|birthday)\b/.test(rest);
  if (month !== null && (monthday !== null || yearly)) {
    return finish("yearly", { month, monthday: monthday ?? 1, hour, minute }, assumedTime);
  }
  if (yearly) return refuse("unrecognised");

  const monthly = /\b(?:every month|each month|monthly|of the month|of every month|of each month|a month)\b/.test(rest);
  if (monthly || (monthday !== null && /\bevery\b/.test(rest))) {
    return finish("monthly", { monthday: monthday ?? 1, hour, minute }, assumedTime);
  }

  if (/\b(?:every week|each week|weekly|once a week)\b/.test(rest)) {
    // No day named: Monday, which the summary states and the card lets the
    // person change.
    return finish("weekly", { weekday: 1, hour, minute }, assumedTime);
  }

  if (/\b(?:every day|each day|daily|every single day|everyday|nightly)\b/.test(rest) || (part && /\b(?:every|each)\b/.test(rest))) {
    return finish("daily", { hour, minute }, assumedTime);
  }

  // A time with no frequency ("at 9am", "tomorrow at 9") is a one-off.
  if (clock || part || /\b(?:tomorrow|today|tonight|next|this)\b/.test(rest)) return refuse("not_recurring");
  return refuse("unrecognised");
}

// ---------------------------------------------------------------------------
// Saying it back
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function intAt(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function clockText(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A clock trigger as one plain sentence, server-safe. The routine editor's
 * `describeTrigger` says the same things for the same kinds; this one also
 * reads back the cron lines a phrase produces ("Every Monday and Thursday at
 * 09:00", "Every 2 hours"), which a person never typed as cron.
 */
export function describeTimeTrigger(kind: string, rawConfig: unknown): string {
  const config =
    rawConfig !== null && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? (rawConfig as Record<string, unknown>)
      : {};
  const at = clockText(intAt(config, "hour", 0), intAt(config, "minute", 0));
  switch (kind) {
    case "hourly":
      return `Every hour at ${String(intAt(config, "minute", 0)).padStart(2, "0")} past`;
    case "daily":
      return `Every day at ${at}`;
    case "weekdays":
      return `Every weekday at ${at}`;
    case "weekly":
      return `Every ${WEEKDAY_NAMES[intAt(config, "weekday", 1)] ?? "week"} at ${at}`;
    case "monthly": {
      const day = intAt(config, "monthday", 1);
      return day >= 31 ? `On the last day of each month at ${at}` : `On the ${ordinal(day)} of each month at ${at}`;
    }
    case "yearly":
      return `Every year on ${intAt(config, "monthday", 1)} ${MONTH_NAMES[intAt(config, "month", 1) - 1] ?? ""} at ${at}`;
    case "cron": {
      const expression = typeof config.expression === "string" ? config.expression : "";
      return describeCron(expression);
    }
    default:
      return kind;
  }
}

function describeCron(expression: string): string {
  const fields = parseCron(expression);
  if (!fields) return expression ? `On the schedule ${expression}` : "No schedule set";
  const parts = expression.trim().split(/\s+/);
  const everyHours = /^\*\/(\d+)$/.exec(parts[1] ?? "");
  if (everyHours && fields.minutes.length === 1 && !fields.monthdayRestricted && !fields.weekdayRestricted && fields.months.length === 12) {
    return `Every ${everyHours[1]} hours at ${String(fields.minutes[0]).padStart(2, "0")} past`;
  }
  if (
    fields.minutes.length === 1 &&
    fields.hours.length === 1 &&
    !fields.monthdayRestricted &&
    fields.months.length === 12 &&
    fields.weekdayRestricted
  ) {
    const at = clockText(fields.hours[0], fields.minutes[0]);
    if (fields.weekdays.length === 2 && fields.weekdays[0] === 0 && fields.weekdays[1] === 6) {
      return `Every Saturday and Sunday at ${at}`;
    }
    return `Every ${listText(fields.weekdays.map((day) => WEEKDAY_NAMES[day] ?? String(day)))} at ${at}`;
  }
  return `On the schedule ${expression}`;
}

/**
 * The next `count` fires of a clock trigger, from `from`, in `timezone`. Empty
 * when the trigger cannot be read: a list of runs for a schedule the scheduler
 * would refuse would be a promise nothing keeps.
 */
export function upcomingFires(
  kind: string,
  config: unknown,
  timezone: string,
  from: Date,
  count = 3
): Date[] {
  const parsed = parseTimeTrigger(kind, config, timezone);
  if (!parsed.ok) return [];
  const fires: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = nextFireAfter(parsed.spec, cursor);
    if (!next) break;
    fires.push(next);
    cursor = next;
  }
  return fires;
}
