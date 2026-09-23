import * as React from "react";

/*
 * Numbers, durations, dates, lists and money in the reader's UI locale
 * (SPEC §10.2). Every figure the run UI, the Activity panel and Research show
 * goes through here, so "12s", "1:04", "3 Oct" and "€2.50" follow the reader's
 * conventions instead of being assembled by hand.
 *
 * Pure `Intl` wrappers, safe on the server, plus one hook. An unknown or
 * malformed locale or time zone never throws: it falls back to "en" / the
 * runtime's zone, because a formatting error must not take a row down with it.
 *
 * `useUiLocale` reads `<html lang>` until the translation store exists
 * (WS5 wires it to AutoTranslate's resolved locale).
 */

const FALLBACK_LOCALE = "en";

const canonical = new Map<string, string>();

/** The locale as Intl will accept it, or "en". */
function localeOf(locale: string | undefined): string {
  if (!locale) return FALLBACK_LOCALE;
  let known = canonical.get(locale);
  if (known === undefined) {
    try {
      known = Intl.getCanonicalLocales(locale)[0] ?? FALLBACK_LOCALE;
    } catch {
      known = FALLBACK_LOCALE;
    }
    canonical.set(locale, known);
  }
  return known;
}

const formatters = new Map<string, unknown>();

/** One formatter per (kind, locale, options): Intl constructors are the expensive part. */
function cached<T>(kind: string, locale: string, options: object, make: () => T): T {
  const key = `${kind}|${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key) as T | undefined;
  if (!formatter) {
    formatter = make();
    formatters.set(key, formatter);
  }
  return formatter;
}

function validTimeZone(timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat(FALLBACK_LOCALE, { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

// ── Locale ────────────────────────────────────────────────────────────────────

const subscribeLang = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  return () => observer.disconnect();
};
const readLang = () => document.documentElement.lang || FALLBACK_LOCALE;
const serverLang = () => FALLBACK_LOCALE;

/** The reader's UI locale; "en" during SSR and hydration, so the first client pass matches the server. */
export function useUiLocale(): string {
  return React.useSyncExternalStore(subscribeLang, readLang, serverLang);
}

// ── Numbers and money ─────────────────────────────────────────────────────────

export function formatNumber(n: number, locale: string, opts: Intl.NumberFormatOptions = {}): string {
  const at = localeOf(locale);
  return cached("number", at, opts, () => new Intl.NumberFormat(at, opts)).format(n);
}

/** Money is only ever shown in the plan's currency. `eurPerUsd`: how many EUR one USD costs. */
export function formatCurrencyEur(microUsd: bigint | number, eurPerUsd: number, locale: string): string {
  const usd = Number(microUsd) / 1_000_000;
  const eur = usd * (Number.isFinite(eurPerUsd) && eurPerUsd > 0 ? eurPerUsd : 1);
  const at = localeOf(locale);
  const options: Intl.NumberFormatOptions = { style: "currency", currency: "EUR" };
  const format = cached("number", at, options, () => new Intl.NumberFormat(at, options));
  // "<€0.01", not "€0.00": a real charge must not read as free.
  if (eur > 0 && eur < 0.01) return `<${format.format(0.01)}`;
  return format.format(eur);
}

// ── Durations ─────────────────────────────────────────────────────────────────

type DurationStyle = "narrow" | "long" | "digital";

interface DurationFormatLike {
  format(duration: Partial<Record<"hours" | "minutes" | "seconds", number>>): string;
}
type DurationFormatCtor = new (locale: string, options: { style: "narrow" | "long" }) => DurationFormatLike;

/** Not in the TypeScript lib yet; present in every current engine. */
const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatCtor }).DurationFormat;

const UNITS = [
  ["hours", "hour", 3_600],
  ["minutes", "minute", 60],
  ["seconds", "second", 1],
] as const;

/**
 * "12s", "1m 4s" (narrow); "1 minute, 4 seconds" (long); "1:04" (digital).
 *
 * `narrow` and `long` round to the second and then show the two largest
 * non-zero units, so a duration is never "1m 60s" and never three units long.
 * `digital` floors, so a ticking figure never runs ahead of the time it
 * measures; a live caller that shows `narrow` under a minute floors to the
 * second before calling, for the same reason.
 */
export function formatDuration(ms: number, style: DurationStyle, locale: string): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const at = localeOf(locale);

  if (style === "digital") {
    const total = Math.floor(safe / 1000);
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    const seconds = total % 60;
    const plain = (n: number) => formatNumber(n, at, { useGrouping: false });
    const padded = (n: number) => formatNumber(n, at, { minimumIntegerDigits: 2, useGrouping: false });
    return hours > 0
      ? `${plain(hours)}:${padded(minutes)}:${padded(seconds)}`
      : `${plain(minutes)}:${padded(seconds)}`;
  }

  let rest = Math.round(safe / 1000);
  const amounts = UNITS.map(([key, unit, size]) => {
    const amount = Math.floor(rest / size);
    rest -= amount * size;
    return { key, unit, amount };
  });
  const nonZero = amounts.filter((part) => part.amount > 0);
  const shown = nonZero.length ? nonZero.slice(0, 2) : [amounts[2]];

  if (DurationFormat && nonZero.length) {
    const format = cached("duration", at, { style }, () => new DurationFormat(at, { style }));
    return format.format(Object.fromEntries(shown.map((part) => [part.key, part.amount])));
  }
  return shown
    .map((part) => formatNumber(part.amount, at, { style: "unit", unit: part.unit, unitDisplay: style }))
    .join(style === "long" ? ", " : " ");
}

// ── Lists, clock times and dates ──────────────────────────────────────────────

export function formatList(items: string[], locale: string, type: "conjunction" | "unit" = "conjunction"): string {
  const at = localeOf(locale);
  const options = { type, style: "long" } as const;
  return cached("list", at, options, () => new Intl.ListFormat(at, options)).format(items);
}

/** "14:02" / "2:02 PM", in the reader's convention. */
export function formatClock(date: Date, locale: string, timeZone?: string): string {
  if (Number.isNaN(date.getTime())) return "";
  const at = localeOf(locale);
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZone: validTimeZone(timeZone) };
  return cached("clock", at, options, () => new Intl.DateTimeFormat(at, options)).format(date);
}

/** "Researched {date}", citation-card dates, `current_time` figures. An unreadable date is "". */
export function formatDate(
  date: Date | string,
  style: "short" | "medium" | "long",
  locale: string,
  timeZone?: string,
): string {
  const value = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return "";
  const at = localeOf(locale);
  const options: Intl.DateTimeFormatOptions = { dateStyle: style, timeZone: validTimeZone(timeZone) };
  return cached("date", at, options, () => new Intl.DateTimeFormat(at, options)).format(value);
}
