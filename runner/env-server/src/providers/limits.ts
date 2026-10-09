/**
 * Usage-limit classification (SPEC §2: "Usage-limit stops become a Limited
 * state with Resume at reset").
 *
 * Vendors report an exhausted subscription window in different shapes: a
 * structured code (Codex `usageLimitExceeded`), a streamed event (Claude
 * `rate_limit_event` with status `rejected`), or only prose ("You've hit your
 * usage limit… try again at 3:05 PM", "Claude AI usage limit reached|<epoch>",
 * Gemini `RESOURCE_EXHAUSTED`). This module turns all of them into one answer:
 * limited or not, and when the window resets if anyone said.
 *
 * Transient throttling ("429 Too Many Requests, retrying") is NOT a limit: the
 * vendor runtime retries those itself, and showing "Limited" for a 2-second
 * backoff would be a lie.
 */

export interface LimitClassification {
  limited: boolean;
  /** ISO-8601 reset time when the vendor stated one. */
  resetsAt?: string;
  /** Which window, when known ("five_hour", "seven_day", "primary"). */
  windowId?: string;
}

const LIMIT_CODES = new Set(["usageLimitExceeded", "usage_limit_exceeded", "usage_limit_reached", "insufficient_quota", "quota_exceeded"]);

const LIMIT_PATTERNS: RegExp[] = [
  /usage limit (?:reached|exceeded|hit)/i,
  /(?:hit|reached|exceeded) (?:your|the) (?:usage|weekly|daily|5[- ]hour|five[- ]hour|session|plan) limit/i,
  /claude ai usage limit reached/i,
  /\b(?:5|five)[- ]hour limit\b/i,
  /\bweekly limit\b/i,
  /out of (?:credits|usage)/i,
  /quota (?:exceeded|exhausted)/i,
  /RESOURCE_EXHAUSTED/,
  /insufficient[_ ]quota/i,
  /plan limit (?:reached|exceeded)/i,
  /\blimit reached\b.*\b(?:resets?|try again)\b/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [/retrying in \d/i, /will retry/i, /overloaded/i, /server is busy/i];

export function classifyUsageLimit(input: {
  message?: string;
  code?: string | null;
  /** Epoch seconds or ms, or ISO. */
  resetsAt?: number | string | null;
  now?: Date;
}): LimitClassification {
  const now = input.now ?? new Date();
  const message = input.message ?? "";
  const explicitReset = normalizeReset(input.resetsAt, now);
  if (input.code && LIMIT_CODES.has(input.code)) {
    return withReset({ limited: true }, explicitReset ?? parseResetFromText(message, now));
  }
  if (!message) return { limited: false };
  if (TRANSIENT_PATTERNS.some((p) => p.test(message)) && !/usage limit|weekly limit|quota/i.test(message)) {
    return { limited: false };
  }
  // "Claude AI usage limit reached|1760000000" — the CLI's classic machine-readable form.
  const piped = message.match(/usage limit reached\|(\d{9,13})/i);
  if (piped) return withReset({ limited: true }, normalizeReset(Number(piped[1]), now));
  if (!LIMIT_PATTERNS.some((p) => p.test(message))) return { limited: false };
  return withReset({ limited: true }, explicitReset ?? parseResetFromText(message, now));
}

function withReset(c: LimitClassification, resetsAt: string | undefined): LimitClassification {
  return resetsAt ? { ...c, resetsAt } : c;
}

/** Epoch seconds / ms / ISO → ISO, or undefined. */
export function normalizeReset(value: number | string | null | undefined, now = new Date()): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    // A reset in the distant past is a parsing accident, not a reset time.
    if (date.getTime() < now.getTime() - 24 * 3600_000) return undefined;
    return date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Best-effort reset time from prose: "try again in 2 hours 13 minutes",
 * "resets in 45m", "try again at 3:05 PM", "resets at 15:05", "resets Oct 9, 3pm".
 */
export function parseResetFromText(text: string, now = new Date()): string | undefined {
  if (!text) return undefined;
  const UNIT = "(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\\b";
  const rel = text.match(new RegExp(`(?:in|after)\\s+((?:\\d+\\s*${UNIT}\\s*(?:and\\s*)?,?\\s*)+)`, "i"));
  if (rel && /(?:try again|resets?|available|retry)/i.test(text)) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const u = unit.toLowerCase();
      const k = u.startsWith("d") ? 86400_000 : u.startsWith("h") ? 3600_000 : u.startsWith("m") ? 60_000 : 1000;
      ms += Number(n) * k;
    }
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  const at = text.match(/(?:at|after|until)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (at && /(?:try again|resets?|available|retry|limit)/i.test(text)) {
    let hour = Number(at[1]);
    const minute = at[2] ? Number(at[2]) : 0;
    const meridiem = at[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59 && (at[2] !== undefined || meridiem)) {
      const d = new Date(now);
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
  }
  return undefined;
}

/** The earliest future reset among windows that are exhausted (≥ 100 %). */
export function earliestExhaustedReset(windows: { usedPct?: number; resetsAt?: string }[], now = new Date()): string | undefined {
  const resets = windows
    .filter((w) => (w.usedPct ?? 0) >= 100 && w.resetsAt)
    .map((w) => new Date(w.resetsAt!).getTime())
    .filter((t) => Number.isFinite(t) && t > now.getTime())
    .sort((a, b) => a - b);
  return resets.length ? new Date(resets[0]).toISOString() : undefined;
}
