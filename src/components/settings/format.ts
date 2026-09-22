/*
 * Number and date formatting for the settings sections, in the reader's own
 * locale. The euro amounts used to be built by hand ("1,23 €": a comma decimal
 * and a trailing sign for everybody), which is right in Paris and wrong in
 * Dublin; `Intl.NumberFormat` puts the separator and the symbol where the
 * reader expects them.
 */

const eurFormatter = new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" });
const eurWholeFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

/** Euros, with enough precision to be believed at the low end: "<€0.01" rather than "€0.00". */
export function formatEur(amount: number): string {
  if (amount > 0 && amount < 0.01) return `<${eurFormatter.format(0.01)}`;
  return eurFormatter.format(amount);
}

/** Whole euros, for prices and ceilings that are whole by construction. */
export function formatEurWhole(amount: number): string {
  return Number.isInteger(amount) ? eurWholeFormatter.format(amount) : eurFormatter.format(amount);
}

/** "May 3, 2026" in the reader's order. */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Sep 14": a day inside the last month, without the year. */
export function formatShortDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Fri 6:59 PM": the moment a rolling window next frees up, in local time. */
export function formatResetMoment(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
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
export function compactCount(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
