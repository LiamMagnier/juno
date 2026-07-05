import "server-only";
import { randomUUID } from "crypto";

/*
 * Minimal hand-rolled CalDAV client for iCloud (caldav.icloud.com), enough for
 * discovery, listing calendars/events, and creating/deleting events. Auth is
 * HTTP Basic with an Apple ID + app-specific password. XML in/out is handled
 * with small namespace-agnostic string helpers — no XML dependency.
 */

export interface CalDavCredentials {
  appleId: string;
  appPassword: string;
}

export interface CalDavCalendar {
  name: string;
  /** Absolute collection URL on the user's iCloud partition host. */
  url: string;
}

export interface CalDavEvent {
  uid: string;
  summary: string;
  start: string;
  end?: string;
  location?: string;
  description?: string;
  /** True when the event carries an RRULE (we flag recurrence, we don't expand it). */
  recurring: boolean;
}

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

/* ---------- Namespace-agnostic XML helpers ---------- */

function tagContent(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function tagBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
  for (const m of xml.matchAll(re)) out.push(m[1]);
  return out;
}

function hasEmptyOrPairedTag(xml: string, tag: string): boolean {
  return new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?/?>`, "i").test(xml);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function unwrapCdata(s: string): string {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  return m ? m[1] : xmlUnescape(s);
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

export async function listCalendars(creds: CalDavCredentials): Promise<CalDavCalendar[]> {
  const home = await discoverCalendarHome(creds);
  const res = await davRequest(
    home,
    {
      method: "PROPFIND",
      depth: "1",
      body: `<?xml version="1.0" encoding="UTF-8"?><propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><displayname/><resourcetype/><c:supported-calendar-component-set/></prop></propfind>`,
    },
    creds
  );
  if (res.status >= 400) throw new Error(`CalDAV calendar listing failed (${res.status})`);

  const calendars: CalDavCalendar[] = [];
  for (const block of tagBlocks(res.text, "response")) {
    const href = tagContent(block, "href");
    if (!href) continue;
    const resourceType = tagContent(block, "resourcetype") ?? "";
    if (!hasEmptyOrPairedTag(resourceType, "calendar")) continue;
    // Skip VTODO-only collections (Reminders) when the server declares components.
    const components = tagContent(block, "supported-calendar-component-set");
    if (components && !/name="VEVENT"/i.test(components)) continue;
    const url = new URL(xmlUnescape(href), res.url).toString();
    const displayName = tagContent(block, "displayname");
    const fallback = decodeURIComponent(url.replace(/\/$/, "").split("/").pop() ?? "Calendar");
    calendars.push({ name: displayName ? xmlUnescape(displayName) : fallback, url });
  }
  return calendars;
}

/* ---------- ICS parsing / building ---------- */

function icsUnescape(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\([\\;,])/g, "$1");
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** 20260705 → 2026-07-05 · 20260705T120000[Z] → 2026-07-05T12:00:00[Z]. */
function icsDateToIso(value: string): string {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return value;
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}`;
}

function isoToIcsUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO 8601 date: ${iso}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Read one property from an unfolded VEVENT body, ignoring parameters (;TZID=…). */
function icsProp(vevent: string, name: string): string | null {
  const m = vevent.match(new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, "im"));
  return m ? m[1].trim() : null;
}

/** Parse the VEVENTs of an ICS payload into our minimal event shape. */
export function parseIcsEvents(ics: string): CalDavEvent[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const events: CalDavEvent[] = [];
  for (const m of unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)) {
    const body = m[1];
    const uid = icsProp(body, "UID");
    const start = icsProp(body, "DTSTART");
    if (!uid || !start) continue;
    const end = icsProp(body, "DTEND");
    const location = icsProp(body, "LOCATION");
    const description = icsProp(body, "DESCRIPTION");
    events.push({
      uid: icsUnescape(uid),
      summary: icsUnescape(icsProp(body, "SUMMARY") ?? "(untitled)"),
      start: icsDateToIso(start),
      end: end ? icsDateToIso(end) : undefined,
      location: location ? icsUnescape(location) : undefined,
      description: description ? icsUnescape(description) : undefined,
      recurring: /^RRULE(?:;|:)/im.test(body) || /^RECURRENCE-ID(?:;|:)/im.test(body),
    });
  }
  return events;
}

export async function listEvents(
  creds: CalDavCredentials,
  calendarUrl: string,
  fromIso: string,
  toIso: string
): Promise<CalDavEvent[]> {
  const res = await davRequest(
    calendarUrl,
    {
      method: "REPORT",
      depth: "1",
      body:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
        `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
        `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
        `<c:time-range start="${isoToIcsUtc(fromIso)}" end="${isoToIcsUtc(toIso)}"/>` +
        `</c:comp-filter></c:comp-filter></c:filter>` +
        `</c:calendar-query>`,
    },
    creds
  );
  if (res.status >= 400) throw new Error(`CalDAV event query failed (${res.status})`);

  const events: CalDavEvent[] = [];
  const seen = new Set<string>();
  for (const block of tagBlocks(res.text, "response")) {
    const data = tagContent(block, "calendar-data");
    if (!data) continue;
    for (const event of parseIcsEvents(unwrapCdata(data))) {
      if (seen.has(event.uid)) continue; // recurrence overrides share the master's UID
      seen.add(event.uid);
      events.push(event);
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
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
  input: { title: string; start: string; end: string; location?: string; notes?: string }
): Promise<{ uid: string }> {
  const uid = randomUUID().toUpperCase();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Juno//Connector//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${isoToIcsUtc(new Date().toISOString())}`,
    `DTSTART:${isoToIcsUtc(input.start)}`,
    `DTEND:${isoToIcsUtc(input.end)}`,
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
