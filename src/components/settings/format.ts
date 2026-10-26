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

/**
 * "Sep 18" this year, "Sep 18, 2025" before it: a list that is mostly recent
 * does not spend a fifth of a phone row on the year it is. Pass `nowMs` from
 * a client-only render (it reads the reader's calendar).
 */
export function formatRecentDate(ms: number, nowMs: number, at: FormatLocale = READER_FORMAT): string {
  const year = (t: number) => Number(new Date(t).toLocaleDateString("en-US", { year: "numeric", timeZone: at.timeZone }));
  return new Date(ms).toLocaleDateString(at.locale, {
    month: "short",
    day: "numeric",
    ...(year(ms) === year(nowMs) ? {} : { year: "numeric" }),
    timeZone: at.timeZone,
  });
}

/**
 * A link as a person reads it: no scheme, no trailing slash, and its last
 * segment apart, so a narrow field can let the host give way and keep the
 * part that identifies it ("alevr.com/r/" + "7Q2KM9XA"). The full URL is
 * still what gets copied.
 */
export function splitDisplayLink(url: string): { lead: string; tail: string } {
  const bare = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  const cut = bare.lastIndexOf("/");
  if (cut < 0 || cut === bare.length - 1) return { lead: "", tail: bare };
  return { lead: bare.slice(0, cut + 1), tail: bare.slice(cut + 1) };
}

/**
 * A title kept to about `max` characters, cut after the last whole word with
 * the ellipsis set tight against it ("…about the boiler…", never "…about
 * th…" or "…about the …"), so a row can show the whole of what it keeps
 * instead of letting a CSS clamp end it mid-word. A run with no space to cut
 * at (a pasted URL, a path) is cut before its last separator inside the limit
 * ("…/pull/12345/files…", not "…/files#dif…"); one with neither (a hash) is
 * cut at the limit, by code point.
 */
export function cutAtWord(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  // One past the limit, so a word that ends exactly on it is kept whole.
  const head = chars.slice(0, max + 1).join("");
  const space = head.lastIndexOf(" ");
  let kept: string;
  if (space > head.length / 2) {
    kept = head.slice(0, space);
  } else {
    const separator = lastRunSeparator(head);
    kept = separator > head.length / 2 ? head.slice(0, separator).replace(RUN_SEPARATORS_AT_END, "") : chars.slice(0, max).join("");
  }
  return `${kept.replace(/[\s,;:.\-–—(&/]+$/u, "")}…`;
}

/** Where a URL or a path may be cut: before one of these, never inside a segment. */
const RUN_SEPARATOR = /[/#?&=_.-]/u;
const RUN_SEPARATORS_AT_END = /[/#?&=_.-]+$/u;

function lastRunSeparator(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) if (RUN_SEPARATOR.test(text.charAt(i))) return i;
  return -1;
}

/**
 * Break opportunities inside a pasted URL or path: after each "/", "?", "#"
 * and "&" (but not between the two slashes of "https://"), so it wraps at its
 * separators ("https://github.com/acme/" | "really-long-…") rather than
 * wherever the line runs out ("…/acme/reall" | "y-long-…"). Only tokens that
 * look like a URL or a path are split; ordinary words keep their separators
 * whole ("Q&A", "AT&T", "24/7", "and/or"). Pieces to join with a `<wbr>`;
 * the text itself is unchanged.
 */
export function urlBreakPieces(text: string): string[] {
  const pieces: string[] = [];
  let plain = "";
  for (const token of text.split(/(\s+)/u)) {
    if (!looksLikeUrlOrPath(token)) {
      plain += token;
      continue;
    }
    const parts = token.split(/(?<=[/?#&])(?![/?#&])/u);
    parts[0] = plain + parts[0];
    plain = "";
    pieces.push(...parts);
  }
  if (plain || pieces.length === 0) pieces.push(plain);
  return pieces;
}

/** A URL ("https://…", "www.…") or a path with at least two slashes. */
function looksLikeUrlOrPath(token: string): boolean {
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu.test(token)) return true;
  return (token.match(/\//gu) ?? []).length >= 2;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago": when a device was last seen. */
export function formatAgo(ms: number, nowMs: number): string {
  const s = Math.max(0, (nowMs - ms) / 1000);
  if (!Number.isFinite(s) || s < 90) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  const m = Math.round(s / 60);
  if (m < 60) return unit(m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return unit(h, "hour");
  return unit(Math.round(h / 24), "day");
}

/**
 * An avatar's initials: the first letters of the first and last names ("Liam
 * Magnier" → "LM"), one letter for a one-word name ("Liam" → "L", not the
 * "LI" the first two letters gave), else the email's first letter.
 */
export function initialsFor(name: string | null | undefined, email: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = (word: string | undefined) => (word ? Array.from(word)[0] ?? "" : "");
  if (words.length > 1) return (first(words[0]) + first(words[words.length - 1])).toLocaleUpperCase();
  if (words.length === 1) return first(words[0]).toLocaleUpperCase();
  return (first((email ?? "").trim()) || "U").toLocaleUpperCase();
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
