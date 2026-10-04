/*
 * The XML half of the CalDAV client (src/lib/apple/caldav.ts): reading the
 * multistatus bodies iCloud answers PROPFIND and REPORT with. Pure and free of
 * `server-only`, so tests can feed it recorded iCloud responses.
 *
 * Namespace-agnostic on purpose: iCloud declares DAV:, CalDAV and
 * calendarserver.org namespaces inline on each element, with or without
 * prefixes, and a full XML parser would be a dependency for four tags.
 */

export interface CalendarCollection {
  name: string;
  /** Absolute collection URL on the user's iCloud partition host. */
  url: string;
  /**
   * `calendar`: events live on iCloud and are queried with CalDAV.
   * `subscribed`: an ICS feed (webcal) the user subscribed to with iCloud as
   * the location. iCloud keeps only the subscription (name, colour, `source`
   * URL); the events are served by the feed, so they are fetched from there.
   */
  kind: "calendar" | "subscribed";
  /** The feed URL of a subscribed calendar (webcal:// rewritten to https://). */
  sourceUrl?: string;
}

export interface CalendarHomeListing {
  calendars: CalendarCollection[];
  /** Collections seen but not readable as event calendars, with why. */
  skipped: Array<{ name: string; reason: string }>;
}

export function tagContent(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

export function tagBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
  for (const m of xml.matchAll(re)) out.push(m[1]);
  return out;
}

export function hasTag(xml: string, tag: string): boolean {
  return new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?/?>`, "i").test(xml);
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function xmlUnescape(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Text content: CDATA as-is, otherwise entity-decoded. Handles mixed runs. */
export function textContent(s: string): string {
  let out = "";
  let rest = s;
  for (;;) {
    const at = rest.indexOf("<![CDATA[");
    if (at < 0) {
      out += xmlUnescape(rest);
      break;
    }
    out += xmlUnescape(rest.slice(0, at));
    const end = rest.indexOf("]]>", at + 9);
    if (end < 0) {
      out += rest.slice(at + 9);
      break;
    }
    out += rest.slice(at + 9, end);
    rest = rest.slice(end + 3);
  }
  return out;
}

/** The propstat blocks of one response whose status is 2xx (a 404 propstat lists props the server lacks). */
function okProps(responseBlock: string): string {
  const stats = tagBlocks(responseBlock, "propstat");
  if (stats.length === 0) return responseBlock;
  return stats
    .filter((st) => {
      const status = tagContent(st, "status");
      return !status || /\s2\d\d\s/.test(` ${status} `);
    })
    .join("\n");
}

function feedUrl(raw: string): string | undefined {
  const s = xmlUnescape(raw.trim());
  if (!s) return undefined;
  const rewritten = s.replace(/^webcals?:\/\//i, "https://");
  try {
    const u = new URL(rewritten);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Read a Depth-1 PROPFIND of the calendar home. */
export function parseCalendarHome(xml: string, baseUrl: string): CalendarHomeListing {
  const calendars: CalendarCollection[] = [];
  const skipped: CalendarHomeListing["skipped"] = [];
  for (const block of tagBlocks(xml, "response")) {
    const href = tagContent(block, "href");
    if (!href) continue;
    const props = okProps(block);
    const resourceType = tagContent(props, "resourcetype") ?? "";
    const url = new URL(xmlUnescape(href), baseUrl).toString();
    const displayName = tagContent(props, "displayname");
    const fallback = decodeURIComponent(url.replace(/\/$/, "").split("/").pop() ?? "Calendar");
    const name = displayName ? textContent(displayName).trim() || fallback : fallback;

    if (hasTag(resourceType, "subscribed")) {
      const source = tagContent(props, "source");
      const sourceUrl = feedUrl(source ? tagContent(source, "href") ?? textContent(source) : "");
      if (sourceUrl) calendars.push({ name, url, kind: "subscribed", sourceUrl });
      else skipped.push({ name, reason: "subscribed calendar without a readable feed URL" });
      continue;
    }
    if (!hasTag(resourceType, "calendar")) continue; // home, inbox, outbox, notifications, dropbox
    // Skip VTODO-only collections (Reminders) when the server declares its components.
    const components = tagContent(props, "supported-calendar-component-set");
    if (components && /<(?:[\w-]+:)?comp\b/i.test(components) && !/name\s*=\s*["']VEVENT["']/i.test(components)) {
      skipped.push({ name, reason: "reminders list (no events)" });
      continue;
    }
    calendars.push({ name, url, kind: "calendar" });
  }
  return { calendars, skipped };
}

/** The ICS payloads (calendar-data) of a calendar-query REPORT. */
export function parseCalendarQuery(xml: string): string[] {
  const out: string[] = [];
  for (const block of tagBlocks(xml, "response")) {
    const data = tagContent(okProps(block), "calendar-data");
    if (data) out.push(textContent(data));
  }
  return out;
}
