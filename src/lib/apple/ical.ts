/*
 * iCalendar (RFC 5545) reading for the Apple Calendar connector: parse VEVENTs,
 * resolve their time zones, expand recurrences, and answer "which occurrences
 * overlap this window". Pure — no network, no `server-only` — so the tests can
 * drive it with recorded iCloud payloads.
 *
 * Why it exists: a CalDAV `calendar-query` with a time-range returns the
 * RESOURCE that has an instance in the window, not the instance. A weekly
 * course created in September comes back as its master VEVENT with the
 * September DTSTART; reading DTSTART at face value lists it on the wrong day,
 * and a client that also filters by DTSTART drops it entirely. The same goes
 * for an ICS subscription feed, which has no server-side filter at all. So the
 * occurrences are computed here, in each event's own zone (DST-correct), and
 * only then compared with the window.
 */

/** An IANA zone name, or a fixed UTC offset in minutes (an unknown TZID's best guess). */
export type Zone = string | { fixedOffsetMinutes: number };

export interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  name: string;
  props: IcsProp[];
  children: IcsComponent[];
}

export interface EventOccurrence {
  uid: string;
  summary: string;
  location?: string;
  description?: string;
  allDay: boolean;
  /** UTC milliseconds. For an all-day event: local midnight in the reading zone. */
  startMs: number;
  endMs: number;
  /** Part of a recurring series (an expanded instance or a moved one). */
  recurring: boolean;
  status?: string;
}

/* ---------- lines and components ---------- */

export function unfoldIcs(ics: string): string[] {
  return ics
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((l) => l.length > 0);
}

/** `NAME;P1=a;P2="b:c":value` → {name, params, value}; null for a malformed line. */
export function parseIcsLine(line: string): IcsProp | null {
  let i = 0;
  let inQuotes = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = "";
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ";" && !inQuotes) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const name = parts[0].trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/** Parse an ICS payload into its top-level components (normally one VCALENDAR). */
export function parseIcs(ics: string): IcsComponent[] {
  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  for (const line of unfoldIcs(ics)) {
    const prop = parseIcsLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const comp: IcsComponent = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      if (stack.length > 0) stack[stack.length - 1].children.push(comp);
      else roots.push(comp);
      stack.push(comp);
    } else if (prop.name === "END") {
      const name = prop.value.trim().toUpperCase();
      // Pop to the matching BEGIN; tolerate a missing END on an inner component.
      const at = stack.map((c) => c.name).lastIndexOf(name);
      if (at >= 0) stack.length = at;
    } else if (stack.length > 0) {
      stack[stack.length - 1].props.push(prop);
    }
  }
  return roots;
}

function prop(comp: IcsComponent, name: string): IcsProp | undefined {
  return comp.props.find((p) => p.name === name);
}

function props(comp: IcsComponent, name: string): IcsProp[] {
  return comp.props.filter((p) => p.name === name);
}

function allOf(roots: IcsComponent[], name: string): IcsComponent[] {
  const out: IcsComponent[] = [];
  const walk = (c: IcsComponent) => {
    if (c.name === name) out.push(c);
    // A VEVENT's VALARM never holds a VEVENT; don't descend into events.
    if (c.name !== "VEVENT") c.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

export function icsUnescape(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\([\\;,])/g, "$1");
}

/* ---------- zones ---------- */

export function isIanaZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The common Windows (Exchange/Outlook-exported) zone names an ICS feed may carry. */
const WINDOWS_ZONES: Record<string, string> = {
  "romance standard time": "Europe/Paris",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Kiev",
  "gtb standard time": "Europe/Bucharest",
  "eastern standard time": "America/New_York",
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "pacific standard time": "America/Los_Angeles",
  "tokyo standard time": "Asia/Tokyo",
  "china standard time": "Asia/Shanghai",
  "india standard time": "Asia/Kolkata",
  "aus eastern standard time": "Australia/Sydney",
  utc: "UTC",
  "coordinated universal time": "UTC",
};

function parseOffset(value: string): number | null {
  const m = value.trim().match(/^([+-])(\d{2})(\d{2})(\d{2})?$/);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

/** Resolve a TZID to something we can compute with. */
export function resolveZone(tzid: string, vtimezones: Map<string, IcsComponent>, fallback: Zone): Zone {
  const id = tzid.trim();
  if (isIanaZone(id)) return id;
  // "/freeassociation.sourceforge.net/Tzfile/Europe/Paris", "(GMT+01.00) Europe/Paris"…
  const tail = id.match(/([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)\s*$/);
  if (tail && isIanaZone(tail[1])) return tail[1];
  const win = WINDOWS_ZONES[id.toLowerCase()];
  if (win) return win;
  const vtz = vtimezones.get(id);
  if (vtz) {
    const loc = prop(vtz, "X-LIC-LOCATION")?.value.trim();
    if (loc && isIanaZone(loc)) return loc;
    const standard = vtz.children.find((c) => c.name === "STANDARD") ?? vtz.children[0];
    const offset = standard ? parseOffset(prop(standard, "TZOFFSETTO")?.value ?? "") : null;
    if (offset !== null) return { fixedOffsetMinutes: offset };
  }
  return fallback;
}

export interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const DAY_MS = 86_400_000;

/** The wall clock an instant shows in a zone. */
export function utcToWall(ms: number, zone: Zone): Wall {
  if (typeof zone !== "string") {
    const t = new Date(ms + zone.fixedOffsetMinutes * 60_000);
    return {
      y: t.getUTCFullYear(),
      m: t.getUTCMonth() + 1,
      d: t.getUTCDate(),
      h: t.getUTCHours(),
      mi: t.getUTCMinutes(),
      s: t.getUTCSeconds(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const v: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") v[p.type] = Number(p.value);
  return { y: v.year, m: v.month, d: v.day, h: v.hour === 24 ? 0 : v.hour, mi: v.minute, s: v.second };
}

/**
 * The UTC instant of a wall-clock time in a zone. Guess-and-correct; a time
 * that does not exist (DST spring-forward gap) lands on the adjacent instant.
 */
export function wallToUtc(w: Wall, zone: Zone): number {
  const target = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  if (typeof zone !== "string") return target - zone.fixedOffsetMinutes * 60_000;
  let utc = target;
  for (let i = 0; i < 3; i++) {
    const seen = utcToWall(utc, zone);
    const asUtc = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.mi, seen.s);
    if (asUtc === target) break;
    utc += target - asUtc;
  }
  return utc;
}

/** Offset of `zone` at `ms`, as "+02:00". */
export function offsetLabel(ms: number, zone: Zone): string {
  const w = utcToWall(ms, zone);
  const minutes = Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `2026-10-05T09:00+02:00` — the instant as the user's clock shows it. */
export function formatInZone(ms: number, zone: Zone): string {
  const w = utcToWall(ms, zone);
  return `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}${offsetLabel(ms, zone)}`;
}

/** `2026-10-05` in the zone. */
export function formatDateInZone(ms: number, zone: Zone): string {
  const w = utcToWall(ms, zone);
  return `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}`;
}

export function zoneLabel(zone: Zone): string {
  if (typeof zone === "string") return zone;
  const m = zone.fixedOffsetMinutes;
  return `UTC${m < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
}

/* ---------- day arithmetic (proleptic Gregorian day numbers) ---------- */

const dayNum = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
function fromDayNum(n: number): { y: number; m: number; d: number } {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
/** 0 = Sunday … 6 = Saturday. */
const weekday = (n: number) => (((n + 4) % 7) + 7) % 7;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/* ---------- user-supplied instants ---------- */

/**
 * Read a date the model passed, the way a person means it:
 *   "2026-10-05"            → that calendar day in `zone` (start: 00:00, end: next 00:00)
 *   "2026-10-05T09:00"      → 09:00 on the user's clock
 *   "2026-10-05T09:00Z" / "+02:00" → that exact instant
 * Returns null for anything unparseable.
 */
export function parseUserInstant(raw: string, zone: Zone, edge: "start" | "end"): number | null {
  const s = raw.trim();
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    const day = fromDayNum(dayNum(y, m, d) + (edge === "end" ? 1 : 0));
    return wallToUtc({ ...day, h: 0, mi: 0, s: 0 }, zone);
  }
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (local) {
    return wallToUtc(
      {
        y: Number(local[1]),
        m: Number(local[2]),
        d: Number(local[3]),
        h: Number(local[4]),
        mi: Number(local[5]),
        s: Number(local[6] ?? 0),
      },
      zone
    );
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * The window a list call should read. Models that do not know the user's zone
 * ask for "the 5th" as 2026-10-05T00:00:00Z → 2026-10-05T23:59:59Z, which in
 * Paris is 02:00 on the 5th to 01:59 on the 6th — it misses the early morning
 * and leaks the next night. A window that is exactly one or more whole UTC
 * days is therefore read as those calendar days on the user's clock. Any other
 * explicit instant is honoured as given.
 */
export function resolveWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  zone: Zone,
  now: number,
  defaultDays: number
): { fromMs: number; toMs: number; reinterpreted: boolean } {
  const fromMs = fromRaw ? parseUserInstant(fromRaw, zone, "start") : now;
  if (fromMs === null) throw new Error(`Invalid date: ${fromRaw}`);
  let toMs = toRaw ? parseUserInstant(toRaw, zone, "end") : fromMs + defaultDays * DAY_MS;
  if (toMs === null) throw new Error(`Invalid date: ${toRaw}`);
  if (toMs <= fromMs) toMs = fromMs + DAY_MS;

  const utcMidnight = /^\d{4}-\d{2}-\d{2}T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)$/i;
  const utcDayEnd = /^\d{4}-\d{2}-\d{2}T(?:23:59(?::59(?:\.\d+)?)?|24:00(?::00)?|00:00(?::00(?:\.0+)?)?)(?:Z|[+-]00:?00)$/i;
  const zoneIsUtc = typeof zone === "string" ? /^(?:UTC|Etc\/UTC|GMT|Etc\/GMT)$/i.test(zone) : zone.fixedOffsetMinutes === 0;
  if (fromRaw && toRaw && !zoneIsUtc && utcMidnight.test(fromRaw.trim()) && utcDayEnd.test(toRaw.trim())) {
    const fromDay = fromRaw.trim().slice(0, 10);
    // A 23:59 end names that day; a 00:00 end names the day before it.
    const endsAtMidnight = /T00:00/.test(toRaw);
    const lastDayNum = (() => {
      const [y, m, d] = toRaw.trim().slice(0, 10).split("-").map(Number);
      return dayNum(y, m, d) - (endsAtMidnight ? 1 : 0);
    })();
    const [fy, fm, fd] = fromDay.split("-").map(Number);
    if (lastDayNum >= dayNum(fy, fm, fd)) {
      const last = fromDayNum(lastDayNum);
      const start = parseUserInstant(fromDay, zone, "start");
      const end = parseUserInstant(`${pad(last.y, 4)}-${pad(last.m)}-${pad(last.d)}`, zone, "end");
      if (start !== null && end !== null) return { fromMs: start, toMs: end, reinterpreted: true };
    }
  }
  return { fromMs, toMs, reinterpreted: false };
}

/* ---------- event times ---------- */

type IcsTime =
  | { kind: "date"; day: number }
  | { kind: "datetime"; wall: Wall; zone: Zone };

function parseIcsTimeValue(value: string, params: Record<string, string>, ctx: ZoneCtx): IcsTime | null {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!m[4] || params.VALUE?.toUpperCase() === "DATE") return { kind: "date", day: dayNum(y, mo, d) };
  const wall: Wall = { y, m: mo, d, h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0) };
  if (m[7]) return { kind: "datetime", wall, zone: "UTC" };
  const zone = params.TZID ? resolveZone(params.TZID, ctx.vtimezones, ctx.floating) : ctx.floating;
  return { kind: "datetime", wall, zone };
}

function parseIcsTimes(p: IcsProp, ctx: ZoneCtx): IcsTime[] {
  return p.value
    .split(",")
    .map((v) => parseIcsTimeValue(v, p.params, ctx))
    .filter((t): t is IcsTime => t !== null);
}

interface ZoneCtx {
  vtimezones: Map<string, IcsComponent>;
  /** Zone for floating times and all-day dates: the user's own. */
  floating: Zone;
}

function timeToMs(t: IcsTime, floating: Zone): number {
  if (t.kind === "date") {
    const day = fromDayNum(t.day);
    return wallToUtc({ ...day, h: 0, mi: 0, s: 0 }, floating);
  }
  return wallToUtc(t.wall, t.zone);
}

/** Key that identifies an instance (for EXDATE / RECURRENCE-ID matching). */
function instanceKey(t: IcsTime, floating: Zone): string {
  return t.kind === "date" ? `d${t.day}` : `t${timeToMs(t, floating)}`;
}

/** `P1D`, `PT1H30M`, `-PT15M`, `P2W` → milliseconds. */
export function parseIcsDuration(value: string): number | null {
  const m = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return null;
  const ms =
    (Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * DAY_MS +
    Number(m[4] ?? 0) * 3_600_000 +
    Number(m[5] ?? 0) * 60_000 +
    Number(m[6] ?? 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/* ---------- RRULE ---------- */

interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: IcsTime;
  byDay: Array<{ n?: number; wd: number }>;
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  wkst: number;
}

const WD: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(value: string, ctx: ZoneCtx): RRule | null {
  const parts: Record<string, string> = {};
  for (const kv of value.split(";")) {
    const eq = kv.indexOf("=");
    if (eq > 0) parts[kv.slice(0, eq).trim().toUpperCase()] = kv.slice(eq + 1).trim();
  }
  const freq = parts.FREQ?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const nums = (s?: string) =>
    (s ?? "")
      .split(",")
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n !== 0);
  const byDay: RRule["byDay"] = [];
  for (const token of (parts.BYDAY ?? "").split(",")) {
    const m = token.trim().toUpperCase().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (m) byDay.push({ n: m[1] ? Number(m[1]) : undefined, wd: WD[m[2]] });
  }
  const untilVal = parts.UNTIL;
  // UNTIL has no TZID of its own: a bare value is in DTSTART's frame (floating ≈ user zone).
  const until = untilVal ? parseIcsTimeValue(untilVal, {}, ctx) ?? undefined : undefined;
  const count = parts.COUNT ? Number(parts.COUNT) : undefined;
  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
    count: count && count > 0 ? count : undefined,
    until,
    byDay,
    byMonthDay: nums(parts.BYMONTHDAY),
    byMonth: nums(parts.BYMONTH),
    bySetPos: nums(parts.BYSETPOS),
    wkst: WD[(parts.WKST ?? "MO").toUpperCase()] ?? 1,
  };
}

/** Days of one month a MONTHLY/YEARLY rule selects (before BYSETPOS). */
function monthDays(y: number, m: number, rule: RRule, startDom: number): number[] {
  const dim = daysInMonth(y, m);
  const first = dayNum(y, m, 1);
  let days: number[];
  if (rule.byMonthDay.length > 0) {
    days = rule.byMonthDay
      .map((n) => (n > 0 ? n : dim + n + 1))
      .filter((n) => n >= 1 && n <= dim)
      .map((n) => first + n - 1);
    if (rule.byDay.length > 0) days = days.filter((d) => rule.byDay.some((b) => b.wd === weekday(d)));
  } else if (rule.byDay.length > 0) {
    days = [];
    for (const b of rule.byDay) {
      const matching: number[] = [];
      for (let i = 0; i < dim; i++) if (weekday(first + i) === b.wd) matching.push(first + i);
      if (b.n === undefined) days.push(...matching);
      else {
        const pick = b.n > 0 ? matching[b.n - 1] : matching[matching.length + b.n];
        if (pick !== undefined) days.push(pick);
      }
    }
  } else {
    days = startDom <= dim ? [first + startDom - 1] : [];
  }
  days = [...new Set(days)].sort((a, b) => a - b);
  return applySetPos(days, rule.bySetPos);
}

function applySetPos(days: number[], setPos: number[]): number[] {
  if (setPos.length === 0) return days;
  const out = setPos
    .map((p) => (p > 0 ? days[p - 1] : days[days.length + p]))
    .filter((d): d is number => d !== undefined);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Hard ceiling on periods walked for one series, whatever the rule says. */
const MAX_PERIODS = 60_000;

/**
 * The start days (day numbers, in the series' own frame) of a rule's
 * occurrences, in order, starting from DTSTART's day. `visit` returns false to
 * stop. Fast-forwards an uncounted series to near `skipToDay`.
 */
function walkRule(rule: RRule, startDay: number, skipToDay: number, visit: (day: number) => boolean): void {
  const start = fromDayNum(startDay);
  const passesMonth = (d: number) => rule.byMonth.length === 0 || rule.byMonth.includes(fromDayNum(d).m);
  const canSkip = rule.count === undefined;

  if (rule.freq === "DAILY") {
    let k = canSkip ? Math.max(0, Math.floor((skipToDay - startDay) / rule.interval) - 1) : 0;
    for (let i = 0; i < MAX_PERIODS; i++, k++) {
      const d = startDay + k * rule.interval;
      if (!passesMonth(d)) continue;
      if (rule.byMonthDay.length > 0) {
        const { y, m, d: dom } = fromDayNum(d);
        const dim = daysInMonth(y, m);
        if (!rule.byMonthDay.some((n) => (n > 0 ? n : dim + n + 1) === dom)) continue;
      }
      if (rule.byDay.length > 0 && !rule.byDay.some((b) => b.wd === weekday(d))) continue;
      if (!visit(d)) return;
    }
    return;
  }

  if (rule.freq === "WEEKLY") {
    const weekStart0 = startDay - ((weekday(startDay) - rule.wkst + 7) % 7);
    const wds = rule.byDay.length > 0 ? [...new Set(rule.byDay.map((b) => b.wd))] : [weekday(startDay)];
    const offsets = wds.map((wd) => (wd - rule.wkst + 7) % 7).sort((a, b) => a - b);
    let k = canSkip ? Math.max(0, Math.floor((skipToDay - weekStart0) / (7 * rule.interval)) - 1) : 0;
    for (let i = 0; i < MAX_PERIODS; i++, k++) {
      const ws = weekStart0 + k * 7 * rule.interval;
      const days = applySetPos(
        offsets.map((o) => ws + o).filter(passesMonth),
        rule.bySetPos
      );
      for (const d of days) {
        if (d < startDay) continue;
        if (!visit(d)) return;
      }
    }
    return;
  }

  if (rule.freq === "MONTHLY") {
    const m0 = start.y * 12 + (start.m - 1);
    const skip = fromDayNum(skipToDay);
    let k = canSkip ? Math.max(0, Math.floor((skip.y * 12 + skip.m - 1 - m0) / rule.interval) - 1) : 0;
    for (let i = 0; i < MAX_PERIODS; i++, k++) {
      const idx = m0 + k * rule.interval;
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(m)) continue;
      for (const d of monthDays(y, m, rule, start.d)) {
        if (d < startDay) continue;
        if (!visit(d)) return;
      }
    }
    return;
  }

  // YEARLY
  const skipYear = fromDayNum(skipToDay).y;
  let k = canSkip ? Math.max(0, Math.floor((skipYear - start.y) / rule.interval) - 1) : 0;
  for (let i = 0; i < MAX_PERIODS; i++, k++) {
    const y = start.y + k * rule.interval;
    if (y > 9999) return;
    const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [start.m];
    let days: number[] = [];
    for (const m of months) {
      // Without BYMONTH, an ordinal BYDAY (e.g. 20MO) counts within the year;
      // approximating it per DTSTART's month is wrong, so read the year.
      if (rule.byMonth.length === 0 && rule.byDay.some((b) => b.n !== undefined) && rule.byMonthDay.length === 0) {
        const first = dayNum(y, 1, 1);
        const len = dayNum(y + 1, 1, 1) - first;
        for (const b of rule.byDay) {
          const matching: number[] = [];
          for (let j = 0; j < len; j++) if (weekday(first + j) === b.wd) matching.push(first + j);
          const pick = b.n === undefined ? undefined : b.n > 0 ? matching[b.n - 1] : matching[matching.length + b.n];
          if (pick !== undefined) days.push(pick);
        }
        break;
      }
      days.push(...monthDays(y, m, { ...rule, bySetPos: [] }, start.d));
    }
    days = applySetPos([...new Set(days)].sort((a, b) => a - b), rule.bySetPos);
    for (const d of days) {
      if (d < startDay) continue;
      if (!visit(d)) return;
    }
  }
}

/* ---------- occurrences ---------- */

interface MasterLike {
  comp: IcsComponent;
  uid: string;
  start: IcsTime;
  /** ms for timed; days for all-day. */
  length: number;
}

function eventBase(comp: IcsComponent): Omit<EventOccurrence, "startMs" | "endMs" | "allDay" | "recurring"> {
  const text = (name: string) => {
    const v = prop(comp, name)?.value;
    return v ? icsUnescape(v).trim() : undefined;
  };
  return {
    uid: text("UID") ?? "",
    summary: text("SUMMARY") || "(untitled)",
    location: text("LOCATION") || undefined,
    description: text("DESCRIPTION") || undefined,
    status: prop(comp, "STATUS")?.value.trim().toUpperCase() || undefined,
  };
}

function eventShape(comp: IcsComponent, ctx: ZoneCtx): MasterLike | null {
  const uid = prop(comp, "UID")?.value.trim();
  const dtstartProp = prop(comp, "DTSTART");
  if (!uid || !dtstartProp) return null;
  const start = parseIcsTimeValue(dtstartProp.value, dtstartProp.params, ctx);
  if (!start) return null;
  const dtendProp = prop(comp, "DTEND");
  const end = dtendProp ? parseIcsTimeValue(dtendProp.value, dtendProp.params, ctx) : null;
  const duration = prop(comp, "DURATION") ? parseIcsDuration(prop(comp, "DURATION")!.value) : null;
  let length: number;
  if (start.kind === "date") {
    if (end && end.kind === "date") length = Math.max(1, end.day - start.day);
    else if (duration !== null) length = Math.max(1, Math.round(duration / DAY_MS));
    else length = 1;
  } else if (end) {
    length = Math.max(0, timeToMs(end, ctx.floating) - timeToMs(start, ctx.floating));
  } else if (duration !== null) {
    length = Math.max(0, duration);
  } else {
    length = 0;
  }
  return { comp, uid, start, length };
}

function occurrenceAt(shape: MasterLike, start: IcsTime, ctx: ZoneCtx, recurring: boolean): EventOccurrence {
  const base = eventBase(shape.comp);
  if (start.kind === "date") {
    const startMs = timeToMs(start, ctx.floating);
    const endMs = timeToMs({ kind: "date", day: start.day + shape.length }, ctx.floating);
    return { ...base, allDay: true, startMs, endMs, recurring };
  }
  const startMs = timeToMs(start, ctx.floating);
  return { ...base, allDay: false, startMs, endMs: startMs + shape.length, recurring };
}

function overlaps(o: EventOccurrence, fromMs: number, toMs: number): boolean {
  if (o.endMs > o.startMs) return o.startMs < toMs && o.endMs > fromMs;
  return o.startMs >= fromMs && o.startMs < toMs;
}

/** Most instances one series may contribute to a single answer. */
const MAX_INSTANCES_PER_SERIES = 500;

/**
 * Every occurrence of every VEVENT in `ics` that overlaps [fromMs, toMs).
 * `zone` is the user's: it places floating times and all-day dates.
 */
export function occurrencesInRange(ics: string, fromMs: number, toMs: number, zone: Zone): EventOccurrence[] {
  const roots = parseIcs(ics);
  const vtimezones = new Map<string, IcsComponent>();
  for (const tz of allOf(roots, "VTIMEZONE")) {
    const id = prop(tz, "TZID")?.value.trim();
    if (id) vtimezones.set(id, tz);
  }
  const ctx: ZoneCtx = { vtimezones, floating: zone };

  // Group by UID: a master and the instances it moved (RECURRENCE-ID).
  const series = new Map<string, { master?: IcsComponent; overrides: IcsComponent[] }>();
  for (const ev of allOf(roots, "VEVENT")) {
    const uid = prop(ev, "UID")?.value.trim();
    if (!uid) continue;
    const entry = series.get(uid) ?? { overrides: [] };
    if (prop(ev, "RECURRENCE-ID")) entry.overrides.push(ev);
    else if (!entry.master) entry.master = ev;
    series.set(uid, entry);
  }

  const out: EventOccurrence[] = [];
  for (const { master, overrides } of series.values()) {
    const overrideKeys = new Set<string>();
    for (const ov of overrides) {
      const rid = prop(ov, "RECURRENCE-ID")!;
      const t = parseIcsTimeValue(rid.value, rid.params, ctx);
      if (t) overrideKeys.add(instanceKey(t, zone));
      const shape = eventShape(ov, ctx);
      if (!shape) continue;
      const occ = occurrenceAt(shape, shape.start, ctx, true);
      if (occ.status === "CANCELLED") continue;
      if (overlaps(occ, fromMs, toMs)) out.push(occ);
    }
    if (!master) continue;
    const shape = eventShape(master, ctx);
    if (!shape) continue;
    const rruleProp = prop(master, "RRULE");
    const rule = rruleProp ? parseRRule(rruleProp.value, ctx) : null;
    const rdates = props(master, "RDATE").flatMap((p) => parseIcsTimes(p, ctx));
    const isSeries = !!rule || rdates.length > 0 || overrides.length > 0;
    if (eventBase(master).status === "CANCELLED") continue;

    const excluded = new Set(props(master, "EXDATE").flatMap((p) => parseIcsTimes(p, ctx).map((t) => instanceKey(t, zone))));
    const emit = (t: IcsTime) => {
      const key = instanceKey(t, zone);
      if (excluded.has(key) || overrideKeys.has(key)) return;
      const occ = occurrenceAt(shape, t, ctx, isSeries);
      if (overlaps(occ, fromMs, toMs)) out.push(occ);
    };

    if (!rule) {
      emit(shape.start);
    } else {
      const startDay =
        shape.start.kind === "date" ? shape.start.day : dayNum(shape.start.wall.y, shape.start.wall.m, shape.start.wall.d);
      const lengthDays = shape.start.kind === "date" ? shape.length : Math.ceil(shape.length / DAY_MS);
      // Walk in the event's own frame; a window edge in that frame is within a day of the UTC one.
      const skipToDay = Math.floor(fromMs / DAY_MS) - lengthDays - 2;
      const untilMs = rule.until
        ? rule.until.kind === "date"
          ? shape.start.kind === "date"
            ? null
            : timeToMs({ kind: "date", day: rule.until.day + 1 }, shape.start.zone) - 1
          : timeToMs(rule.until, zone)
        : null;
      const untilDay = rule.until?.kind === "date" ? rule.until.day : null;
      // DTSTART is always instance #1 (RFC 5545 §3.8.5.3), whether or not the rule picks its day.
      let produced = 1;
      let visits = 0;
      walkRule(rule, startDay, skipToDay, (day) => {
        if (++visits > 200_000) return false;
        if (day === startDay) return true;
        const t: IcsTime =
          shape.start.kind === "date"
            ? { kind: "date", day }
            : { kind: "datetime", wall: { ...shape.start.wall, ...fromDayNum(day) }, zone: shape.start.zone };
        const ms = timeToMs(t, zone);
        if (untilMs !== null && ms > untilMs) return false;
        if (untilDay !== null && shape.start.kind === "date" && day > untilDay) return false;
        if (ms >= toMs) return false;
        produced++;
        if (rule.count !== undefined && produced > rule.count) return false;
        emit(t);
        return true;
      });
      // DTSTART itself, if the rule didn't land on it (RFC 5545 §3.8.5.3).
      emit(shape.start);
    }
    for (const t of rdates) emit(t);
  }

  // One instance once, however many times it was reached (DTSTART re-emit, RDATE overlap).
  const seen = new Set<string>();
  const unique = out.filter((o) => {
    const key = `${o.uid}|${o.startMs}|${o.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.startMs - b.startMs || a.summary.localeCompare(b.summary));
  // Cap a runaway series (daily for years in a wide window) per UID.
  const perUid = new Map<string, number>();
  return unique.filter((o) => {
    const n = (perUid.get(o.uid) ?? 0) + 1;
    perUid.set(o.uid, n);
    return n <= MAX_INSTANCES_PER_SERIES;
  });
}
