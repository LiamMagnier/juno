/*
 * Dates on the memory page, in words a reader uses.
 *
 * The page used to borrow `timeAgo` from the roadmap, which answers "3d ago"
 * and "2mo ago": a developer's shorthand, in English only, and too coarse for
 * a summary that was rebuilt ten minutes ago ("today"). Intl's relative
 * formatter says "3 days ago", "yesterday" and "2 hours ago" in the reader's
 * own language, and the document's `lang` is the locale the rest of the
 * interface was rendered in, so the two agree.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function locale(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.documentElement.lang || undefined;
}

let cached: { locale: string | undefined; format: Intl.RelativeTimeFormat } | null = null;

function relativeFormat(): Intl.RelativeTimeFormat {
  const current = locale();
  if (!cached || cached.locale !== current) {
    cached = { locale: current, format: new Intl.RelativeTimeFormat(current, { numeric: "auto" }) };
  }
  return cached.format;
}

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const elapsed = Math.max(0, now - then);
  const format = relativeFormat();
  if (elapsed < MINUTE) return format.format(0, "second");
  if (elapsed < HOUR) return format.format(-Math.round(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return format.format(-Math.round(elapsed / HOUR), "hour");
  const days = Math.round(elapsed / DAY);
  if (days < 7) return format.format(-days, "day");
  if (days < 30) return format.format(-Math.round(days / 7), "week");
  if (days < 365) return format.format(-Math.round(days / 30), "month");
  return format.format(-Math.round(days / 365), "year");
}

/** A calendar date without the year when it is this year: "3 Oct", "3 Oct 2025". */
export function shortDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale(), {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * The bucket a date falls in, for the list's "Newest" grouping. Counted from
 * midnight rather than from this instant: "Yesterday" means the day before
 * today, not 24 to 48 hours ago, which is how a reader counts.
 */
export type DateBucket = "today" | "yesterday" | "week" | "month" | "earlier";

export function dateBucket(iso: string, now = new Date()): DateBucket {
  const date = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = date.getTime();
  if (time >= startOfToday) return "today";
  if (time >= startOfToday - DAY) return "yesterday";
  if (time >= startOfToday - 6 * DAY) return "week";
  if (time >= startOfToday - 29 * DAY) return "month";
  return "earlier";
}

export const DATE_BUCKETS: readonly { id: DateBucket; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "Last 7 days" },
  { id: "month", label: "Last 30 days" },
  { id: "earlier", label: "Older" },
];
