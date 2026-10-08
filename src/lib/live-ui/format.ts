/**
 * Number and date formatting for Live UI.
 *
 * Two formatters behind one interface. `canonicalFormatter` is deterministic
 * en-US and exists so the TypeScript and Swift evaluators can be held to the
 * same fixture strings (contracts/live-ui/fixtures). `platformFormatter` is
 * what a reader sees: the browser's own `Intl` in their locale, exactly as the
 * native apps use `NumberFormatter` in theirs.
 */

export type LiveFormat = "number" | "integer" | "currency" | "percent" | "compact" | "date";

export const LIVE_FORMATS: readonly LiveFormat[] = ["number", "integer", "currency", "percent", "compact", "date"];

export interface LiveFormatOptions {
  currency?: string;
  digits?: number;
}

export interface LiveFormatter {
  number(value: number, format: LiveFormat, options?: LiveFormatOptions): string;
  date(iso: string): string;
}

/** What an absent or failed value shows as. */
export const LIVE_NULL_TEXT = "–";

export function isLiveFormat(value: unknown): value is LiveFormat {
  return typeof value === "string" && (LIVE_FORMATS as readonly string[]).includes(value);
}

/** Half away from zero, the one rounding rule both platforms implement. */
export function roundHalfAway(value: number, digits = 0): number {
  const d = Math.max(0, Math.min(10, Math.trunc(digits)));
  const f = Math.pow(10, d);
  const r = (Math.sign(value) * Math.floor(Math.abs(value) * f + 0.5)) / f;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * The canonical number-to-string: integers plain, others to at most ten
 * decimals with trailing zeros trimmed, huge magnitudes in exponent form.
 */
export function canonicalNumberString(value: number): string {
  if (!Number.isFinite(value)) return LIVE_NULL_TEXT;
  if (Object.is(value, -0)) return "0";
  if (Math.abs(value) >= 1e15) return value.toExponential(3);
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return fixed === "-0" ? "0" : fixed;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "CN¥",
  INR: "₹",
  CAD: "CA$",
  AUD: "A$",
  KRW: "₩",
  BRL: "R$",
  MXN: "MX$",
};
const ZERO_DECIMAL = new Set(["JPY", "KRW"]);

/** Group an unsigned digit string with commas. */
function group(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `value` with between `min` and `max` fraction digits, en-US grouping. */
function fixedGrouped(value: number, min: number, max: number): string {
  const rounded = roundHalfAway(value, max);
  const negative = rounded < 0;
  let text = Math.abs(rounded).toFixed(max);
  if (max > min) {
    // Trim trailing zeros down to the minimum.
    const [int, frac = ""] = text.split(".");
    let f = frac;
    while (f.length > min && f.endsWith("0")) f = f.slice(0, -1);
    text = f ? `${int}.${f}` : int;
  }
  const [int, frac] = text.split(".");
  const body = frac !== undefined ? `${group(int)}.${frac}` : group(int);
  return negative ? `-${body}` : body;
}

function clampDigits(digits: number | undefined, fallback: number): number {
  if (digits === undefined || !Number.isFinite(digits)) return fallback;
  return Math.max(0, Math.min(6, Math.trunc(digits)));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const canonicalFormatter: LiveFormatter = {
  number(value, format, options = {}) {
    if (!Number.isFinite(value)) return LIVE_NULL_TEXT;
    switch (format) {
      case "integer":
        return fixedGrouped(value, 0, 0);
      case "currency": {
        const code = (options.currency ?? "USD").toUpperCase();
        const digits = clampDigits(options.digits, ZERO_DECIMAL.has(code) ? 0 : 2);
        const body = fixedGrouped(Math.abs(value), digits, digits);
        const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
        const sign = roundHalfAway(value, digits) < 0 ? "-" : "";
        return `${sign}${symbol}${body}`;
      }
      case "percent":
        return `${fixedGrouped(value * 100, 0, clampDigits(options.digits, 1))}%`;
      case "compact": {
        const abs = Math.abs(value);
        const digits = clampDigits(options.digits, 1);
        const [div, suffix] = abs >= 1e12 ? [1e12, "T"] : abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
        return `${fixedGrouped(value / div, 0, digits)}${suffix}`;
      }
      case "date":
        return LIVE_NULL_TEXT;
      default:
        return fixedGrouped(value, 0, clampDigits(options.digits, 2));
    }
  },
  date(iso) {
    const parts = parseISODate(iso);
    if (!parts) return LIVE_NULL_TEXT;
    return `${MONTHS[parts.month - 1]} ${parts.day}, ${parts.year}`;
  },
};

/**
 * The reader's own locale. Falls back to the canonical formatter for any
 * currency code `Intl` refuses.
 */
export function platformFormatter(locale?: string): LiveFormatter {
  const cache = new Map<string, Intl.NumberFormat>();
  const get = (key: string, make: () => Intl.NumberFormat) => {
    let f = cache.get(key);
    if (!f) {
      f = make();
      cache.set(key, f);
    }
    return f;
  };
  return {
    number(value, format, options = {}) {
      if (!Number.isFinite(value)) return LIVE_NULL_TEXT;
      try {
        const digits = options.digits;
        switch (format) {
          case "integer":
            return get("i", () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })).format(roundHalfAway(value, 0));
          case "currency": {
            const code = (options.currency ?? "USD").toUpperCase();
            return get(`c${code}${digits ?? ""}`, () =>
              new Intl.NumberFormat(locale, {
                style: "currency",
                currency: code,
                ...(digits !== undefined ? { minimumFractionDigits: clampDigits(digits, 2), maximumFractionDigits: clampDigits(digits, 2) } : {}),
              }),
            ).format(value);
          }
          case "percent":
            return get(`p${digits ?? ""}`, () =>
              new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: clampDigits(digits, 1) }),
            ).format(value);
          case "compact":
            return get(`k${digits ?? ""}`, () =>
              new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: clampDigits(digits, 1) }),
            ).format(value);
          case "date":
            return LIVE_NULL_TEXT;
          default:
            return get(`n${digits ?? ""}`, () =>
              new Intl.NumberFormat(locale, { maximumFractionDigits: clampDigits(digits, 2) }),
            ).format(value);
        }
      } catch {
        return canonicalFormatter.number(value, format, options);
      }
    },
    date(iso) {
      const parts = parseISODate(iso);
      if (!parts) return LIVE_NULL_TEXT;
      try {
        return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
          new Date(Date.UTC(parts.year, parts.month - 1, parts.day)),
        );
      } catch {
        return canonicalFormatter.date(iso);
      }
    },
  };
}

// ── Dates: civil-day arithmetic, identical in Swift ─────────────────────────

export function parseISODate(text: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const dim = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > dim) return null;
  return { year, month, day };
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Days since 1970-01-01 (Howard Hinnant's days_from_civil). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): string {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
