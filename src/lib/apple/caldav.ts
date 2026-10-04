import "server-only";
import { randomUUID } from "crypto";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { fetchPinnedPublicUrl } from "@/lib/search/pinned-fetch";
import {
  parseCalendarHome,
  parseCalendarQuery,
  tagBlocks,
  tagContent,
  xmlEscape,
  xmlUnescape,
  type CalendarCollection,
  type CalendarHomeListing,
} from "@/lib/apple/caldav-xml";
import { occurrencesInRange, type EventOccurrence, type Zone } from "@/lib/apple/ical";

/*
 * Minimal hand-rolled CalDAV client for iCloud (caldav.icloud.com), enough for
 * discovery, listing calendars/events, and creating/deleting events. Auth is
 * HTTP Basic with an Apple ID + app-specific password. The XML is read in
 * caldav-xml.ts and the iCalendar (zones, recurrence) in ical.ts, both pure so
 * they are tested against recorded iCloud payloads.
 */

export interface CalDavCredentials {
  appleId: string;
  appPassword: string;
}

export type CalDavCalendar = CalendarCollection;

const USER_AGENT = `${PRODUCT_NAME}/1.0 (CalDAV)`;

/** Thrown when iCloud rejects the Basic credentials (401/403). */
export class CalDavAuthError extends Error {
  constructor() {
    super("iCloud rejected the Apple ID or app-specific password");
    this.name = "CalDavAuthError";
  }
}

const ICLOUD_CALDAV_ROOT = "https://caldav.icloud.com/";
const MAX_REDIRECTS = 5;

async function davRequest(
  url: string,
  init: { method: string; depth?: string; body?: string; contentType?: string; headers?: Record<string, string> },
  creds: CalDavCredentials
): Promise<{ status: number; text: string; url: string }> {
  const auth = "Basic " + Buffer.from(`${creds.appleId}:${creds.appPassword}`).toString("base64");
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      method: init.method,
      // Follow redirects by hand so the method + body survive cross-host hops
      // (iCloud bounces requests to per-user partition hosts, pXX-caldav.icloud.com).
      redirect: "manual",
      headers: {
        Authorization: auth,
        "User-Agent": USER_AGENT,
        "Content-Type": init.contentType ?? "text/xml; charset=utf-8",
        ...(init.depth !== undefined ? { Depth: init.depth } : {}),
        ...init.headers,
      },
      body: init.body,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`CalDAV redirect (${res.status}) without a Location header`);
      await res.text().catch(() => {});
      const next = new URL(loc, current);
      const host = next.hostname.toLowerCase();
      const trusted =
        next.protocol === "https:" &&
        (host === "icloud.com" || host.endsWith(".icloud.com") || host.endsWith(".apple.com"));
      if (!trusted) {
        throw new Error(`Refusing CalDAV redirect to untrusted host: ${next.host}`);
      }
      current = next.toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new CalDavAuthError();
    return { status: res.status, text: await res.text(), url: current };
  }
  throw new Error("Too many redirects from the CalDAV server");
}

/* ---------- Discovery ---------- */

/** PROPFIND the root for the principal, then the principal for the calendar home. */
export async function discoverCalendarHome(creds: CalDavCredentials): Promise<string> {
  const principalRes = await davRequest(
    ICLOUD_CALDAV_ROOT,
    {
      method: "PROPFIND",
      depth: "0",
      body: `<?xml version="1.0" encoding="UTF-8"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`,
    },
    creds
  );
  if (principalRes.status >= 400) throw new Error(`CalDAV principal lookup failed (${principalRes.status})`);
  const principalHref = tagContent(tagContent(principalRes.text, "current-user-principal") ?? "", "href");
  if (!principalHref) throw new Error("CalDAV server returned no principal");

  const homeRes = await davRequest(
    new URL(xmlUnescape(principalHref), principalRes.url).toString(),
    {
      method: "PROPFIND",
      depth: "0",
      body: `<?xml version="1.0" encoding="UTF-8"?><propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><c:calendar-home-set/></prop></propfind>`,
    },
    creds
  );
  if (homeRes.status >= 400) throw new Error(`CalDAV calendar-home lookup failed (${homeRes.status})`);
  const homeHref = tagContent(tagContent(homeRes.text, "calendar-home-set") ?? "", "href");
  if (!homeHref) throw new Error("CalDAV server returned no calendar home");
  return new URL(xmlUnescape(homeHref), homeRes.url).toString();
}

/** Cheap live check used when the user first submits credentials. */
export async function validateCalDavCredentials(creds: CalDavCredentials): Promise<void> {
  await discoverCalendarHome(creds);
}

export async function listCalendarHome(creds: CalDavCredentials): Promise<CalendarHomeListing> {
  const home = await discoverCalendarHome(creds);
  const res = await davRequest(
    home,
    {
      method: "PROPFIND",
      depth: "1",
      body:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">` +
        `<prop><displayname/><resourcetype/><c:supported-calendar-component-set/><cs:source/></prop></propfind>`,
    },
    creds
  );
  if (res.status >= 400) throw new Error(`CalDAV calendar listing failed (${res.status})`);
  return parseCalendarHome(res.text, res.url);
}

/** The calendars the user can read events from: iCloud calendars and iCloud-stored subscriptions. */
export async function listCalendars(creds: CalDavCredentials): Promise<CalDavCalendar[]> {
  return (await listCalendarHome(creds)).calendars;
}

/* ---------- ICS building ---------- */

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function msToIcsUtc(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date");
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/* ---------- Reading events ---------- */

function calendarQueryBody(range: { fromMs: number; toMs: number } | null): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
    (range ? `<c:time-range start="${msToIcsUtc(range.fromMs)}" end="${msToIcsUtc(range.toMs)}"/>` : "") +
    `</c:comp-filter></c:comp-filter></c:filter>` +
    `</c:calendar-query>`
  );
}

/**
 * The ICS objects of one iCloud calendar that have an instance in the window
 * (server-side time-range), or every event object when `range` is null.
 * Recurring events come back as their MASTER: expansion happens in ical.ts.
 */
async function queryCalendarObjects(
  creds: CalDavCredentials,
  calendarUrl: string,
  range: { fromMs: number; toMs: number } | null
): Promise<string[]> {
  const res = await davRequest(calendarUrl, { method: "REPORT", depth: "1", body: calendarQueryBody(range) }, creds);
  if (res.status >= 400) throw new Error(`CalDAV event query failed (${res.status})`);
  return parseCalendarQuery(res.text);
}

const FEED_MAX_BYTES = 8 * 1024 * 1024;
const FEED_TIMEOUT_MS = 15_000;
const FEED_MAX_REDIRECTS = 3;

/**
 * Fetch a subscribed calendar's ICS feed. The URL comes from the user's own
 * iCloud account but is still an arbitrary URL dialled from our network, so
 * every hop goes through the pinned public-address fetcher (no private,
 * loopback or metadata hosts; no DNS rebinding) and no credential is sent.
 */
async function fetchFeed(url: string): Promise<string> {
  let current = url;
  const signal = AbortSignal.timeout(FEED_TIMEOUT_MS);
  for (let hop = 0; hop <= FEED_MAX_REDIRECTS; hop++) {
    const res = await fetchPinnedPublicUrl(
      current,
      { headers: { Accept: "text/calendar, */*;q=0.5", "User-Agent": USER_AGENT } },
      signal,
      { maxBytes: FEED_MAX_BYTES }
    );
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new Error(`feed redirect (${res.status}) without a Location`);
      current = new URL(loc.replace(/^webcals?:\/\//i, "https://"), current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`feed answered ${res.status}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("feed is not an iCalendar file");
    return text;
  }
  throw new Error("feed redirected too many times");
}

export interface CalendarOccurrence extends EventOccurrence {
  calendar: string;
}

export interface EventSearch {
  occurrences: CalendarOccurrence[];
  /** Every calendar actually read, in order. */
  searched: string[];
  /** Calendars that could not be read, with why. */
  failed: Array<{ name: string; reason: string }>;
  /** Collections that are not event calendars (reminders lists…). */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Every event occurrence overlapping [fromMs, toMs) across the user's
 * calendars — iCloud calendars over CalDAV, iCloud-stored subscriptions from
 * their feeds — expanded and placed in `zone`. One unreadable calendar is
 * reported, never allowed to sink the others or to read as "no events".
 */
export async function searchEvents(
  creds: CalDavCredentials,
  opts: { fromMs: number; toMs: number; zone: Zone; calendar?: string },
  /** Test seam: how a subscribed calendar's feed is fetched. */
  deps: { fetchFeed?: (url: string) => Promise<string> } = {}
): Promise<EventSearch> {
  const readFeed = deps.fetchFeed ?? fetchFeed;
  const home = await listCalendarHome(creds);
  let calendars = home.calendars;
  if (opts.calendar) calendars = [pickCalendar(calendars, opts.calendar)];
  const range = { fromMs: opts.fromMs, toMs: opts.toMs };
  const failed: EventSearch["failed"] = [];

  const read = async (cal: CalDavCalendar, filtered: boolean): Promise<CalendarOccurrence[]> => {
    const payloads =
      cal.kind === "subscribed" && cal.sourceUrl
        ? [await readFeed(cal.sourceUrl)]
        : await queryCalendarObjects(creds, cal.url, filtered ? range : null);
    return payloads.flatMap((ics) =>
      occurrencesInRange(ics, opts.fromMs, opts.toMs, opts.zone).map((o) => ({ ...o, calendar: cal.name }))
    );
  };

  const settle = async (filtered: boolean, which: CalDavCalendar[]) =>
    Promise.all(
      which.map(async (cal) => {
        try {
          return await read(cal, filtered);
        } catch (err) {
          if (err instanceof CalDavAuthError) throw err;
          failed.push({ name: cal.name, reason: err instanceof Error ? err.message : String(err) });
          return [];
        }
      })
    );

  let occurrences = (await settle(true, calendars)).flat();
  // Belt and braces: when the server-side time-range found nothing anywhere,
  // read the iCloud calendars whole once and filter here. A wrong empty answer
  // is the failure that makes the model tell someone their day is free.
  const caldavCalendars = calendars.filter((c) => c.kind === "calendar" && !failed.some((f) => f.name === c.name));
  if (occurrences.length === 0 && caldavCalendars.length > 0) {
    occurrences = (await settle(false, caldavCalendars)).flat();
  }

  const seen = new Set<string>();
  occurrences = occurrences
    .filter((o) => {
      const key = `${o.calendar}|${o.uid}|${o.startMs}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startMs - b.startMs || a.calendar.localeCompare(b.calendar));

  return {
    occurrences,
    searched: calendars.filter((c) => !failed.some((f) => f.name === c.name)).map((c) => c.name),
    failed,
    skipped: home.skipped,
  };
}

/** Exact name first, then a substring match. */
export function pickCalendar(calendars: CalDavCalendar[], name: string): CalDavCalendar {
  if (calendars.length === 0) throw new Error("No calendars found on this iCloud account.");
  const t = name.trim().toLowerCase();
  const hit = calendars.find((c) => c.name.toLowerCase() === t) ?? calendars.find((c) => c.name.toLowerCase().includes(t));
  if (!hit) throw new Error(`No calendar named “${name}”. Available: ${calendars.map((c) => c.name).join(", ")}.`);
  return hit;
}

/** Fold an ICS content line at 74 octets per RFC 5545 (continuation = leading space). */
function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    parts.push(rest.slice(0, 74));
    rest = " " + rest.slice(74);
  }
  parts.push(rest);
  return parts.join("\r\n");
}

export async function createEvent(
  creds: CalDavCredentials,
  calendarUrl: string,
  input: { title: string; startMs: number; endMs: number; location?: string; notes?: string }
): Promise<{ uid: string }> {
  if (!(input.endMs > input.startMs)) throw new Error("The event must end after it starts.");
  const uid = randomUUID().toUpperCase();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${PRODUCT_NAME}//Connector//EN`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${msToIcsUtc(Date.now())}`,
    `DTSTART:${msToIcsUtc(input.startMs)}`,
    `DTEND:${msToIcsUtc(input.endMs)}`,
    `SUMMARY:${icsEscape(input.title)}`,
    ...(input.location ? [`LOCATION:${icsEscape(input.location)}`] : []),
    ...(input.notes ? [`DESCRIPTION:${icsEscape(input.notes)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const ics = lines.map(foldIcsLine).join("\r\n") + "\r\n";
  const res = await davRequest(
    `${calendarUrl.replace(/\/$/, "")}/${uid}.ics`,
    { method: "PUT", body: ics, contentType: "text/calendar; charset=utf-8", headers: { "If-None-Match": "*" } },
    creds
  );
  if (res.status >= 400) throw new Error(`CalDAV event creation failed (${res.status})`);
  return { uid };
}

export async function deleteEvent(creds: CalDavCredentials, calendarUrl: string, uid: string): Promise<void> {
  // Find the resource by UID — the .ics filename doesn't always match it.
  const res = await davRequest(
    calendarUrl,
    {
      method: "REPORT",
      depth: "1",
      body:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
        `<d:prop><d:getetag/></d:prop>` +
        `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
        `<c:prop-filter name="UID"><c:text-match collation="i;octet">${xmlEscape(uid)}</c:text-match></c:prop-filter>` +
        `</c:comp-filter></c:comp-filter></c:filter>` +
        `</c:calendar-query>`,
    },
    creds
  );
  let target: string | null = null;
  if (res.status < 400) {
    for (const block of tagBlocks(res.text, "response")) {
      const href = tagContent(block, "href");
      if (href) {
        target = new URL(xmlUnescape(href), res.url).toString();
        break;
      }
    }
  }
  if (!target) target = `${calendarUrl.replace(/\/$/, "")}/${encodeURIComponent(uid)}.ics`;

  const del = await davRequest(target, { method: "DELETE" }, creds);
  if (del.status === 404) throw new Error(`No event with UID ${uid} in this calendar`);
  if (del.status >= 400) throw new Error(`CalDAV event deletion failed (${del.status})`);
}
