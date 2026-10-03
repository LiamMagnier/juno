import type { Provider } from "@/lib/providers";
import { displayHandle } from "@/lib/username";

/**
 * The profile page's activity, as data and as pure arithmetic.
 *
 * The server half (profile-activity-server.ts) asks Postgres for one row per
 * local calendar day and one row per model, and nothing else; everything the
 * page derives from those rows (streaks, the week columns of the contribution
 * grid, the weekly and cumulative views, the heat levels, the number formats)
 * lives here, with no imports that need a database or a browser, so it is
 * tested directly (tests/profile-activity.test.ts).
 *
 * DAYS ARE CALENDAR KEYS ("2026-10-03"), never instants. The grid is a
 * calendar in the reader's time zone, and a key cannot drift by an hour across
 * a daylight-saving change the way midnight-as-epoch-ms does. Arithmetic on a
 * key goes through UTC midnight of that date, where every day is 24 hours.
 */

export interface ActivityDay {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  tokens: number;
}

export interface ModelUsage {
  /** Ledger model id ("anthropic:claude-opus-5-5"), or "other" for the folded tail. */
  model: string;
  /** Display name ("Claude Opus 5.5"). */
  label: string;
  /** The lab, for its mark; null when the id names none we know. */
  provider: Provider | null;
  tokens: number;
  requests: number;
  /** Share of all model tokens, 0..1. */
  share: number;
}

export interface ProfileActivity {
  /**
   * The account's chosen username, null until it picks one. Optional on the
   * type only so fixtures may omit it; the server always sends both fields.
   */
  username?: string | null;
  /** The @handle to show: the username, or the email-derived fallback (`profileHandle`). */
  handle?: string;
  /** The IANA zone the days were cut in. */
  timeZone: string;
  /** Today in that zone, YYYY-MM-DD. */
  today: string;
  memberSince: string | null;
  lifetimeTokens: number;
  /** The single busiest day, all time. */
  peakDay: ActivityDay | null;
  /**
   * The longest finished run of a Work task or a deep-research run, start to
   * finish. Null when the account has never finished one.
   */
  longestTask: { ms: number; kind: "work" | "research" } | null;
  streak: { current: number; longest: number };
  activeDays: number;
  /** Active days inside the grid's window (the last 53 weeks), ascending. Quiet days are absent. */
  days: ActivityDay[];
  /** Ranked by tokens, the tail folded into one "Other" row. */
  models: ModelUsage[];
  /** How many distinct models were used, before folding. */
  modelCount: number;
}

const DAY_MS = 86_400_000;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Midnight UTC of a calendar key, epoch ms. */
export function keyToUtcMs(key: string): number {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`not a day key: ${key}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function utcMsToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(key: string, n: number): string {
  return utcMsToKey(keyToUtcMs(key) + n * DAY_MS);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((keyToUtcMs(b) - keyToUtcMs(a)) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayMondayFirst(key: string): number {
  return (new Date(keyToUtcMs(key)).getUTCDay() + 6) % 7;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  // IANA names only: letters, digits and _ + - / . Rejects anything that is
  // not a zone before it gets near SQL, even though it is bound as a parameter.
  if (!/^[A-Za-z0-9_+\-/.]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Today's calendar key in `timeZone`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Current and longest runs of consecutive active days.
 *
 * The current streak may end YESTERDAY: someone who has not opened the app
 * yet today has not broken it (the same rule as the account's usage view in
 * usage-breakdown.ts).
 */
export function computeStreaks(activeDates: Iterable<string>, today: string): { current: number; longest: number } {
  const set = new Set(activeDates);
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const date of sorted) {
    run = prev !== null && daysBetween(prev, date) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = date;
  }
  let current = 0;
  let cursor = set.has(today) ? today : addDays(today, -1);
  while (set.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { current, longest };
}

export interface GridCell {
  date: string;
  tokens: number;
}

/** One column of the grid: Monday to Sunday, `null` for days after today. */
export type GridWeek = (GridCell | null)[];

/**
 * The contribution grid: `weeks` columns of seven days, Monday first, the last
 * column holding today. Days after today are null (drawn as nothing).
 */
export function buildWeeks(days: readonly ActivityDay[], today: string, weeks = 53): GridWeek[] {
  const byDate = new Map(days.map((d) => [d.date, d.tokens]));
  const lastMonday = addDays(today, -weekdayMondayFirst(today));
  const firstMonday = addDays(lastMonday, -7 * (weeks - 1));
  const out: GridWeek[] = [];
  for (let w = 0; w < weeks; w++) {
    const col: GridWeek = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(firstMonday, w * 7 + d);
      col.push(date > today ? null : { date, tokens: byDate.get(date) ?? 0 });
    }
    out.push(col);
  }
  return out;
}

/** The first day the grid draws. */
export function gridStart(weeks: readonly GridWeek[]): string | null {
  return weeks[0]?.find((c) => c !== null)?.date ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Month names under the columns where a month begins (the column holding its
 * 1st). A label closer than `minGap` columns to the previous one is dropped,
 * so the partial month at the left edge never collides with the next.
 */
export function monthLabels(weeks: readonly GridWeek[], minGap = 3): { col: number; label: string }[] {
  const out: { col: number; label: string }[] = [];
  weeks.forEach((col, i) => {
    const first = col.find((c) => c !== null && c.date.endsWith("-01"));
    let month: number | null = null;
    if (first) month = Number(first.date.slice(5, 7)) - 1;
    else if (i === 0 && col[0]) month = Number(col[0].date.slice(5, 7)) - 1;
    if (month === null) return;
    const prev = out[out.length - 1];
    if (prev && i - prev.col < minGap) {
      // The leading partial month gives way to the first full one.
      if (prev.col === 0) out.pop();
      else return;
    }
    out.push({ col: i, label: MONTHS[month] });
  });
  return out;
}

export interface WeekTotal {
  /** Monday of the week. */
  start: string;
  /** The last drawn day of the week (today, for the current one). */
  end: string;
  tokens: number;
}

export function weeklyTotals(weeks: readonly GridWeek[]): WeekTotal[] {
  return weeks.map((col) => {
    const cells = col.filter((c): c is GridCell => c !== null);
    return {
      start: cells[0]?.date ?? "",
      end: cells[cells.length - 1]?.date ?? "",
      tokens: cells.reduce((sum, c) => sum + c.tokens, 0),
    };
  });
}

export interface CumulativePoint {
  date: string;
  /** Tokens that day. */
  tokens: number;
  /** Running total from the window's first day through this one. */
  total: number;
}

/** One point per day from `start` through `today`, the total carried across quiet days. */
export function cumulativeSeries(days: readonly ActivityDay[], start: string, today: string): CumulativePoint[] {
  const byDate = new Map(days.map((d) => [d.date, d.tokens]));
  const n = daysBetween(start, today);
  const out: CumulativePoint[] = [];
  let total = 0;
  for (let i = 0; i <= n; i++) {
    const date = addDays(start, i);
    const tokens = byDate.get(date) ?? 0;
    total += tokens;
    out.push({ date, tokens, total });
  }
  return out;
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Cut points for heat levels 2, 3 and 4: the quartiles of the ACTIVE days.
 *
 * Quantiles rather than fractions of the maximum, because token use is
 * heavy-tailed: one 40M-token day would push every ordinary day into the
 * faintest step under a max-fraction scale, and the grid would read as empty.
 * Quiet days never take part, so a sparse year still uses the whole ramp.
 */
export function heatThresholds(values: readonly number[]): [number, number, number] {
  const active = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (active.length === 0) return [Infinity, Infinity, Infinity];
  const q = (p: number) => active[Math.min(active.length - 1, Math.floor(p * active.length))];
  return [q(0.25), q(0.5), q(0.75)];
}

export function heatLevel(value: number, [t2, t3, t4]: readonly [number, number, number]): HeatLevel {
  if (value <= 0) return 0;
  if (value >= t4) return 4;
  if (value >= t3) return 3;
  if (value >= t2) return 2;
  return 1;
}

/** 171.5M, 12.3K, 999, 1.2B: one decimal, trailing ".0" dropped, a unit up at the rollover. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  const units: [number, string][] = [
    [1e3, "K"],
    [1e6, "M"],
    [1e9, "B"],
  ];
  let i = v >= 1e9 ? 2 : v >= 1e6 ? 1 : 0;
  let scaled = Math.round((v / units[i][0]) * 10) / 10;
  // 999,960 rounds to "1000K"; say "1M".
  if (scaled >= 1000 && i < units.length - 1) {
    i += 1;
    scaled = Math.round((v / units[i][0]) * 10) / 10;
  }
  return `${trimZero(scaled)}${units[i][1]}`;
}

function trimZero(x: number): string {
  return x.toFixed(1).replace(/\.0$/, "");
}

/** 1,234,567, for tooltips where the exact count is the point. */
export function formatTokensExact(n: number, locale = "en-US"): string {
  return Math.max(0, Math.round(n)).toLocaleString(locale);
}

/** 42s, 38m, 1h 38m, 2h, 1d 4h. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function formatDays(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** "Thu, Oct 2, 2026" for a calendar key, read as that calendar date (not shifted by any zone). */
export function formatDayLong(key: string, locale = "en-US"): string {
  return new Date(keyToUtcMs(key)).toLocaleDateString(locale, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Oct 2" for a calendar key. */
export function formatDayShort(key: string, locale = "en-US"): string {
  return new Date(keyToUtcMs(key)).toLocaleDateString(locale, { timeZone: "UTC", month: "short", day: "numeric" });
}

/**
 * The @handle under the name: the username the account chose, or, until it
 * has chosen one, a handle derived from the email's local part (never the
 * domain), lowercased, with a "+tag" and anything outside [a-z0-9._-]
 * dropped; failing that, the name as a slug (src/lib/username.ts).
 */
export function profileHandle(user: { username?: string | null; name: string | null; email: string | null }): string {
  return displayHandle(user);
}

/**
 * Rank models by tokens and fold everything past `top` into one "Other" row,
 * so the list is a ranking a reader can take in, not every model ever tried.
 * Shares are of the total across ALL rows, so they sum to 1.
 */
export function rankModels(
  rows: readonly { model: string; label: string; provider: Provider | null; tokens: number; requests: number }[],
  top = 6
): ModelUsage[] {
  const live = rows.filter((r) => r.tokens > 0);
  const total = live.reduce((s, r) => s + r.tokens, 0);
  if (total === 0) return [];
  const ranked = [...live].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || a.label.localeCompare(b.label));
  const head = ranked.slice(0, ranked.length > top ? top - 1 : top);
  const tail = ranked.slice(head.length);
  const out: ModelUsage[] = head.map((r) => ({ ...r, share: r.tokens / total }));
  if (tail.length > 0) {
    const tokens = tail.reduce((s, r) => s + r.tokens, 0);
    out.push({
      model: "other",
      label: tail.length === 1 ? tail[0].label : `${tail.length} other models`,
      provider: tail.length === 1 ? tail[0].provider : null,
      tokens,
      requests: tail.reduce((s, r) => s + r.requests, 0),
      share: tokens / total,
    });
  }
  return out;
}
