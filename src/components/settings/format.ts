import * as React from "react";

/*
 * Number and date formatting for the settings sections, in the reader's own
 * locale. The euro amounts used to be built by hand ("1,23 €": a comma decimal
 * and a trailing sign for everybody), which is right in Paris and wrong in
 * Dublin; `Intl.NumberFormat` puts the separator and the symbol where the
 * reader expects them.
 *
 * THE SERVER DOES NOT KNOW THE READER'S LOCALE OR CLOCK. `/settings?section=
 * billing` is rendered on the server, where "the default locale" and "local
 * time" are the Node process's, and hydrated in a browser whose own may differ: a
 * German browser read "20 €" where the server had written "€20", a reader in
 * Tokyo saw a renewal date a day later than the server's, and React threw the
 * whole pane away as a hydration failure. So every function here takes the
 * `FormatLocale` that `useFormatLocale` hands out: a fixed locale and time
 * zone for the server render and the hydration pass that has to match it, the
 * reader's own everywhere else.
 */

export interface FormatLocale {
  /** Undefined: the reader's own. */
  locale?: string;
  /** Undefined: the reader's own. */
  timeZone?: string;
}

/** What the server render and its hydration pass both format in. */
const SERVER_FORMAT: FormatLocale = { locale: "en-US", timeZone: "UTC" };
const READER_FORMAT: FormatLocale = {};

const subscribeNever = () => () => {};

/**
 * How to format: the reader's own locale and clock once the page is live, and
 * SERVER_FORMAT while it is being rendered on the server or hydrated. A
 * section opened client-side (the modal, a navigation) formats the reader's
 * way from its first frame; only a full load of the page shows the fixed
 * format, for the frame between hydration and the re-render.
 */
export function useFormatLocale(): FormatLocale {
  const live = React.useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  );
  return live ? READER_FORMAT : SERVER_FORMAT;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(at: FormatLocale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = at.locale;
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

const EUR: Intl.NumberFormatOptions = { style: "currency", currency: "EUR" };
const EUR_WHOLE: Intl.NumberFormatOptions = { style: "currency", currency: "EUR", maximumFractionDigits: 0 };

/** Euros, with enough precision to be believed at the low end: "<€0.01" rather than "€0.00". */
export function formatEur(amount: number, at: FormatLocale = READER_FORMAT): string {
  const format = numberFormat(at, EUR);
  if (amount > 0 && amount < 0.01) return `<${format.format(0.01)}`;
  return format.format(amount);
}

/** Whole euros, for prices and ceilings that are whole by construction. */
export function formatEurWhole(amount: number, at: FormatLocale = READER_FORMAT): string {
  return Number.isInteger(amount) ? numberFormat(at, EUR_WHOLE).format(amount) : formatEur(amount, at);
}

/** "May 3, 2026" in the reader's order. */
export function formatDate(ms: number, at: FormatLocale = READER_FORMAT): string {
  return new Date(ms).toLocaleDateString(at.locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: at.timeZone,
  });
}

/** "Sep 14": a day inside the last month, without the year. */
export function formatShortDay(ms: number, at: FormatLocale = READER_FORMAT): string {
  return new Date(ms).toLocaleDateString(at.locale, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Fri 6:59 PM": the moment a rolling window next frees up, in local time. */
export function formatResetMoment(ms: number, at: FormatLocale = READER_FORMAT): string {
  return new Date(ms).toLocaleString(at.locale, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: at.timeZone,
  });
}

/** "4 hr 47 min", "12 min", "2 days": the time until a rolling window frees up. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.round(h / 24);
    return d === 1 ? "1 day" : `${d} days`;
  }
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
}

/** 1.2k, 34k, 5.6M: counts where the exact figure is noise. */
export function compactCount(n: number, at: FormatLocale = READER_FORMAT): string {
  return numberFormat(at, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
