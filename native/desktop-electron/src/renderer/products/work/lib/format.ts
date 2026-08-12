/**
 * Rendering numbers, clocks and untrusted strings.
 *
 * Two rules here are not style, they are behaviour:
 *
 *   · **Nothing reads the clock during render.** Every relative time takes an
 *     explicit `now`, supplied by a ticking hook. A component that called
 *     `Date.now()` while rendering would produce a different tree on every
 *     paint for reasons React cannot see, and — more importantly here — it would
 *     make "2 seconds ago" true at paint and quietly false for the next thirty.
 *     The freshness affordance is the whole point of this surface; it has to be
 *     driven by something that actually ticks.
 *
 *   · **`prose` refuses anything path-shaped.** Executors hand back display
 *     labels, but not every one of them does, and a run that leaks
 *     `/Users/liam/…` into a status line has leaked it into every screenshot,
 *     every support ticket and every phone that renders the same event. The web
 *     surface makes the same refusal for the same reason.
 */

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now" / "12s ago" / "4 min ago" / "2 hr ago" / "3 days ago".
 *
 * Deliberately coarse above a minute and deliberately precise below one: a
 * polled surface is read at the scale of seconds when it is fresh and at the
 * scale of hours when it is not.
 */
export function timeAgo(iso: string | null, now: number): string {
  const at = parseInstant(iso);
  if (at === null) return 'never';
  const delta = Math.max(0, now - at);
  if (delta < 3 * SECOND) return 'just now';
  if (delta < MINUTE) return `${Math.floor(delta / SECOND)}s ago`;
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} min ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} hr ago`;
  const days = Math.floor(delta / DAY);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** "in 4s" / "in 2 min". Returns `now` for anything already due. */
export function timeUntil(iso: string | null, now: number): string {
  const at = parseInstant(iso);
  if (at === null) return 'unscheduled';
  const delta = at - now;
  if (delta <= 0) return 'now';
  if (delta < MINUTE) return `in ${Math.ceil(delta / SECOND)}s`;
  if (delta < HOUR) return `in ${Math.round(delta / MINUTE)} min`;
  return `in ${Math.round(delta / HOUR)} hr`;
}

/** "1m 04s" / "12s" / "1h 06m". Used for elapsed and for ceilings alike. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < MINUTE) return `${Math.max(0, Math.floor(ms / SECOND))}s`;
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    const seconds = Math.floor((ms % MINUTE) / SECOND);
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * A duration in whole units, for prose: "12 minutes", "an hour", "3 hours".
 * Used by the quiet-run sentence, where "1h 06m" would read as machine output.
 */
export function spellDuration(ms: number): string {
  if (ms < HOUR) {
    const minutes = Math.max(1, Math.round(ms / MINUTE));
    return minutes === 1 ? 'a minute' : `${minutes} minutes`;
  }
  const hours = Math.round(ms / HOUR);
  return hours === 1 ? 'an hour' : `${hours} hours`;
}

/** Absolute time, for an audit row where "3 days ago" is not good enough. */
export function formatInstant(iso: string | null): string {
  const at = parseInstant(iso);
  if (at === null) return '—';
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Milliseconds since epoch, or null for anything unparseable. */
export function parseInstant(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Elapsed between two stamps, or null on a half-open interval.
 *
 * Null rather than zero, and never `Date.now()` as a fallback: a run with no
 * `startedAt` did not take 0s, and printing "0s" for it is a lie a reader
 * cannot detect.
 */
export function elapsedBetween(startIso: string | null, endIso: string | null): number | null {
  const start = parseInstant(startIso);
  const end = parseInstant(endIso);
  if (start === null || end === null) return null;
  return Math.max(0, end - start);
}

/* -------------------------------------------------------------------------- */
/* Quantities                                                                  */
/* -------------------------------------------------------------------------- */

/** Costs arrive as integer micro-USD. Never floats on the wire. */
export function formatMicroUsd(microUsd: number): string {
  if (!Number.isFinite(microUsd)) return '—';
  const usd = microUsd / 1_000_000;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '—';
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** `1` → "1 file", `3` → "3 files". No pluralisation library for one rule. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${pluralForm ?? `${singular}s`}`;
}

/** "a, b and c". Oxford-free, because these are labels rather than a sentence. */
export function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  const head = items.slice(0, -1).join(', ');
  return `${head} and ${items[items.length - 1] ?? ''}`;
}

/* -------------------------------------------------------------------------- */
/* Untrusted strings                                                           */
/* -------------------------------------------------------------------------- */

const PATH_SHAPED = /(^|\s)(\/(Users|home|var|tmp|etc|private)\/|~\/|[A-Za-z]:\\)/;

/**
 * A string an executor produced, made safe to render as prose.
 *
 * Returns null — not a redacted placeholder — for anything path-shaped, so the
 * caller has to decide what to say instead. A placeholder would still tell the
 * reader "there was a path here", and the callers that matter have a better
 * sentence available ("3 files changed" beats "‹path removed›").
 */
export function prose(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (PATH_SHAPED.test(trimmed)) return null;
  return trimmed;
}

/**
 * A URL that is safe to put in an `href`.
 *
 * Parsed rather than prefix-matched: `javascript:` and `data:` are why. A
 * citation whose source is not http(s) renders as a plain name.
 */
export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
