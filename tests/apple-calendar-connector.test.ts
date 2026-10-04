import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";

/*
 * Apple Calendar connector: "what's on Monday 5 October" must list the
 * dentist appointment, the weekly university courses and the all-day event,
 * whichever iCloud calendar they live in. Fixtures are shaped like iCloud's
 * own multistatus answers (inline namespaces, &#13; line ends, CDATA, 404
 * propstats, a subscribed calendar, a reminders list).
 */

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const caldav = req("../src/lib/apple/caldav") as typeof import("@/lib/apple/caldav");
const ical = req("../src/lib/apple/ical") as typeof import("@/lib/apple/ical");
const xml = req("../src/lib/apple/caldav-xml") as typeof import("@/lib/apple/caldav-xml");
const text = req("../src/lib/apple/tool-text") as typeof import("@/lib/apple/tool-text");
const mail = req("../src/lib/apple/mail") as typeof import("@/lib/apple/mail");

const PARIS = "Europe/Paris";
/** iCloud names the partition host with an explicit :443; URL() normalises it away. */
const HOST = "https://p68-caldav.icloud.com";
const HOME = `${HOST}/123456789/calendars/`;
const HOME_AS_SENT = "https://p68-caldav.icloud.com:443/123456789/calendars/";

/* ---------- recorded-shape fixtures ---------- */

const PRINCIPAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/123456789/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;

const HOME_SET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:"><response><href>/123456789/principal/</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">${HOME_AS_SENT}</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;

const HOME_LISTING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
<response><href>/123456789/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><displayname/><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"/><source xmlns="http://calendarserver.org/ns/"/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>
<response><href>/123456789/calendars/home/</href><propstat><prop><displayname>Personnel</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VEVENT"/></supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><source xmlns="http://calendarserver.org/ns/"/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>
<response><href>/123456789/calendars/7A1B-COURS/</href><propstat><prop><displayname>Cours L3</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name='VEVENT'/></supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/123456789/calendars/tasks/</href><propstat><prop><displayname>Rappels</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VTODO"/></supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/123456789/calendars/ADE-SUB/</href><propstat><prop><displayname>Emploi du temps</displayname><resourcetype><collection/><subscribed xmlns="http://calendarserver.org/ns/"/></resourcetype><source xmlns="http://calendarserver.org/ns/"><href xmlns="DAV:">webcal://ade.univ.example/jsp/custom/modules/plannings/anonymous_cal.jsp?resources=1234&amp;projectId=1</href></source></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/123456789/calendars/inbox/</href><propstat><prop><resourcetype><collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/123456789/calendars/outbox/</href><propstat><prop><resourcetype><collection/><schedule-outbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/123456789/calendars/notification/</href><propstat><prop><resourcetype><collection/><notification xmlns="http://calendarserver.org/ns/"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`;

const PARIS_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Paris",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "DTSTART:19810329T020000",
  "TZNAME:UTC+2",
  "TZOFFSETTO:+0200",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "DTSTART:19961027T030000",
  "TZNAME:UTC+1",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/** iCloud sends calendar-data entity-encoded with &#13; line ends. */
const encodeIcs = (lines: string[]) =>
  lines.join("\r\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");

const DENTIST_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//macOS 26.0//EN",
  "CALSCALE:GREGORIAN",
  ...PARIS_VTIMEZONE,
  "BEGIN:VEVENT",
  "CREATED:20260920T101500Z",
  "DTEND;TZID=Europe/Paris:20261005T134000",
  "DTSTAMP:20260920T101500Z",
  "DTSTART;TZID=Europe/Paris:20261005T124000",
  "LAST-MODIFIED:20260920T101500Z",
  "SEQUENCE:0",
  "SUMMARY:Dentiste",
  "UID:6F1C5E2A-DENT-4B1A-9C55-0A1B2C3D4E5F",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Rappel",
  "TRIGGER:-PT30M",
  "UID:ALARM-UID-1",
  "X-WR-ALARMUID:ALARM-UID-1",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
];

const ALL_DAY_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//macOS 26.0//EN",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261005",
  "DTEND;VALUE=DATE:20261006",
  "SUMMARY:Rentrée administrative",
  "UID:ALLDAY-0001",
  "END:VEVENT",
  "END:VCALENDAR",
];

/** Weekly Monday course since September; one Monday cancelled, one moved; a long folded DESCRIPTION. */
const COURSE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//macOS 26.0//EN",
  ...PARIS_VTIMEZONE,
  "BEGIN:VEVENT",
  "UID:COURSE-PROBA-0001",
  "DTSTAMP:20260901T080000Z",
  "DTSTART;TZID=Europe/Paris:20260907T090000",
  "DTEND;TZID=Europe/Paris:20260907T103000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261214T235959Z",
  "EXDATE;TZID=Europe/Paris:20260928T090000",
  "SUMMARY:R3-8 PROBA\\, statistiques",
  "LOCATION:Amphi Bloc Central",
  "DESCRIPTION:Cours magistral de probabilités. Groupe A et B. Apporter la calc",
  " ulatrice.",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:COURSE-PROBA-0001",
  "DTSTAMP:20260901T080000Z",
  "RECURRENCE-ID;TZID=Europe/Paris:20261012T090000",
  "DTSTART;TZID=Europe/Paris:20261013T140000",
  "DTEND;TZID=Europe/Paris:20261013T153000",
  "SUMMARY:R3-8 PROBA (déplacé)",
  "END:VEVENT",
  "END:VCALENDAR",
];

/** Afternoon course, two-hourly blocks, ending at 2 occurrences via COUNT (fully before October). */
const FINISHED_SERIES_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:FINISHED-0001",
  "DTSTART;TZID=Europe/Paris:20260907T140000",
  "DTEND;TZID=Europe/Paris:20260907T160000",
  "RRULE:FREQ=WEEKLY;COUNT=2",
  "SUMMARY:Ancien TD",
  "END:VEVENT",
  "END:VCALENDAR",
];

/** An ADE-style university export: UTC times, no VTIMEZONE (the "9AM (7AM GMT)" events). */
const ADE_FEED = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "PRODID:-//ADE/version 6.0",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "BEGIN:VEVENT",
  "DTSTAMP:20261004T120000Z",
  "DTSTART:20261005T070000Z",
  "DTEND:20261005T090000Z",
  "SUMMARY:R3-8 PROBA TD",
  "LOCATION:Amphi Bloc Central",
  "UID:ADE60323032362d323032372d31323334",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20261004T120000Z",
  "DTSTART:20261006T070000Z",
  "DTEND:20261006T090000Z",
  "SUMMARY:Anglais",
  "UID:ADE60323032362d323032372d35363738",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const multistatus = (items: Array<{ href: string; ics: string[]; cdata?: boolean }>) =>
  `<?xml version="1.0" encoding="UTF-8"?><multistatus xmlns="DAV:">${items
    .map(
      (i) =>
        `<response><href>${i.href}</href><propstat><prop><getetag>"abc"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">${
          i.cdata ? `<![CDATA[${i.ics.join("\r\n")}]]>` : encodeIcs(i.ics)
        }</calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`
    )
    .join("")}</multistatus>`;

const EMPTY_MULTISTATUS = `<?xml version="1.0" encoding="UTF-8"?><multistatus xmlns="DAV:"/>`;

/* ---------- a fake iCloud ---------- */

interface Call {
  method: string;
  url: string;
  body: string;
  depth?: string;
}

function fakeICloud(opts: { timeRangeBroken?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers as HeadersInit);
    calls.push({ method, url, body, depth: headers.get("depth") ?? undefined });
    const ok = (xmlBody: string) => new Response(xmlBody, { status: 207, headers: { "content-type": "text/xml" } });

    if (method === "PROPFIND" && url === "https://caldav.icloud.com/") {
      // iCloud bounces to the partition host first.
      return new Response(null, { status: 301, headers: { location: `${HOST}/` } });
    }
    if (method === "PROPFIND" && url === `${HOST}/`) return ok(PRINCIPAL_XML);
    if (method === "PROPFIND" && url.endsWith("/principal/")) return ok(HOME_SET_XML);
    if (method === "PROPFIND" && url === HOME) return ok(HOME_LISTING_XML);
    if (method === "REPORT") {
      const ranged = /time-range/.test(body);
      if (ranged && opts.timeRangeBroken) return ok(EMPTY_MULTISTATUS);
      if (url.endsWith("/calendars/home/")) {
        return ok(
          multistatus([
            { href: "/123456789/calendars/home/DENT.ics", ics: DENTIST_ICS },
            { href: "/123456789/calendars/home/ALLDAY.ics", ics: ALL_DAY_ICS, cdata: true },
          ])
        );
      }
      if (url.endsWith("/calendars/7A1B-COURS/")) {
        // Like iCloud: the time-range selects the resource, and the resource is the master.
        return ok(
          multistatus([
            { href: "/123456789/calendars/7A1B-COURS/PROBA.ics", ics: COURSE_ICS },
            ...(ranged ? [] : [{ href: "/123456789/calendars/7A1B-COURS/OLD.ics", ics: FINISHED_SERIES_ICS }]),
          ])
        );
      }
      return ok(EMPTY_MULTISTATUS);
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const creds = { appleId: "someone@icloud.com", appPassword: "abcd-efgh-ijkl-mnop" };
const at = (iso: string) => Date.parse(iso);

describe("Apple Calendar: Monday 5 October 2026 in Paris", () => {
  it("finds the dentist, the expanded weekly course, the all-day event and the subscribed feed", async () => {
    const icloud = fakeICloud();
    globalThis.fetch = icloud.fetchImpl as typeof fetch;
    const feeds: string[] = [];
    const window = ical.resolveWindow("2026-10-05T00:00:00Z", "2026-10-05T23:59:59Z", PARIS, Date.now(), 14);
    const result = await caldav.searchEvents(
      creds,
      { fromMs: window.fromMs, toMs: window.toMs, zone: PARIS },
      {
        fetchFeed: async (url) => {
          feeds.push(url);
          return ADE_FEED;
        },
      }
    );

    assert.deepEqual(result.searched, ["Personnel", "Cours L3", "Emploi du temps"]);
    assert.deepEqual(result.skipped, [{ name: "Rappels", reason: "reminders list (no events)" }]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(feeds, ["https://ade.univ.example/jsp/custom/modules/plannings/anonymous_cal.jsp?resources=1234&projectId=1"]);

    const got = result.occurrences.map((o) => [o.calendar, o.summary, ical.formatInZone(o.startMs, PARIS), o.allDay]);
    assert.deepEqual(got, [
      ["Personnel", "Rentrée administrative", "2026-10-05T00:00+02:00", true],
      ["Cours L3", "R3-8 PROBA, statistiques", "2026-10-05T09:00+02:00", false],
      ["Emploi du temps", "R3-8 PROBA TD", "2026-10-05T09:00+02:00", false],
      ["Personnel", "Dentiste", "2026-10-05T12:40+02:00", false],
    ]);
    const course = result.occurrences.find((o) => o.uid === "COURSE-PROBA-0001")!;
    assert.equal(course.recurring, true);
    assert.equal(course.location, "Amphi Bloc Central");
    assert.equal(course.description, "Cours magistral de probabilités. Groupe A et B. Apporter la calculatrice.");
    assert.equal(ical.formatInZone(course.endMs, PARIS), "2026-10-05T10:30+02:00");
    // The VALARM's DESCRIPTION/UID did not leak into the event.
    const dentist = result.occurrences.find((o) => o.summary === "Dentiste")!;
    assert.equal(dentist.uid, "6F1C5E2A-DENT-4B1A-9C55-0A1B2C3D4E5F");
    assert.equal(dentist.description, undefined);

    // The query asked iCloud for the user's local day, in UTC basic format, at Depth 1.
    const reports = icloud.calls.filter((c) => c.method === "REPORT");
    assert.equal(reports.length, 2, "both iCloud calendars, not only the first/default one");
    for (const r of reports) {
      assert.equal(r.depth, "1");
      assert.match(r.body, /<c:time-range start="20261004T220000Z" end="20261005T220000Z"\/>/);
    }
  });

  it("reads the calendars whole when the server-side time-range answers nothing anywhere", async () => {
    const icloud = fakeICloud({ timeRangeBroken: true });
    globalThis.fetch = icloud.fetchImpl as typeof fetch;
    const result = await caldav.searchEvents(
      creds,
      { fromMs: at("2026-10-04T22:00:00Z"), toMs: at("2026-10-05T22:00:00Z"), zone: PARIS },
      { fetchFeed: async () => { throw new Error("feed answered 503"); } }
    );
    assert.deepEqual(
      result.occurrences.map((o) => o.summary),
      ["Rentrée administrative", "R3-8 PROBA, statistiques", "Dentiste"]
    );
    // An unreadable calendar is named, not silently dropped.
    assert.deepEqual(result.failed, [{ name: "Emploi du temps", reason: "feed answered 503" }]);
    assert.ok(icloud.calls.some((c) => c.method === "REPORT" && !/time-range/.test(c.body)));
  });

  it("an empty answer names the calendars searched, the zone, and what could not be read", () => {
    const out = text.renderEventSearch(
      {
        occurrences: [],
        searched: ["Personnel", "Cours L3"],
        failed: [{ name: "Emploi du temps", reason: "feed answered 503" }],
        skipped: [],
      },
      { fromMs: at("2026-10-04T22:00:00Z"), toMs: at("2026-10-05T22:00:00Z") },
      { zone: PARIS, zoneKnown: true },
      50
    );
    assert.match(out, /^No events from 2026-10-05T00:00\+02:00 to 2026-10-06T00:00\+02:00 \(Europe\/Paris\) in the 2 calendars searched: “Personnel”, “Cours L3”\./);
    assert.match(out, /Could not read this calendar: “Emploi du temps” \(feed answered 503\) — do not assume it is empty\./);
    assert.match(out, /On My Mac/);
  });

  it("says when the list was cut by the limit", () => {
    const occ = (i: number) => ({
      uid: `u${i}`,
      summary: `E${i}`,
      allDay: false,
      startMs: at("2026-10-05T07:00:00Z") + i * 60_000,
      endMs: at("2026-10-05T08:00:00Z") + i * 60_000,
      recurring: false,
      calendar: "Personnel",
    });
    const out = text.renderEventSearch(
      { occurrences: [occ(1), occ(2), occ(3)], searched: ["Personnel"], failed: [], skipped: [] },
      { fromMs: at("2026-10-04T22:00:00Z"), toMs: at("2026-10-05T22:00:00Z") },
      { zone: PARIS, zoneKnown: true },
      2
    );
    assert.match(out, /^3 events from/);
    assert.match(out, /• E1 — 2026-10-05T09:01\+02:00 → 10:01 · calendar: Personnel/);
    assert.match(out, /…and 1 more not shown/);
  });
});

describe("caldav-xml", () => {
  it("lists event calendars and subscriptions, skips reminders and service collections", () => {
    const listing = xml.parseCalendarHome(HOME_LISTING_XML, HOME);
    assert.deepEqual(
      listing.calendars.map((c) => [c.name, c.kind, c.url]),
      [
        ["Personnel", "calendar", `${HOST}/123456789/calendars/home/`],
        ["Cours L3", "calendar", `${HOST}/123456789/calendars/7A1B-COURS/`],
        ["Emploi du temps", "subscribed", `${HOST}/123456789/calendars/ADE-SUB/`],
      ]
    );
  });

  it("reads entity-encoded and CDATA calendar-data alike", () => {
    const payloads = xml.parseCalendarQuery(
      multistatus([
        { href: "/a.ics", ics: ["BEGIN:VCALENDAR", "SUMMARY:A & B <c>", "END:VCALENDAR"] },
        { href: "/b.ics", ics: ["BEGIN:VCALENDAR", "SUMMARY:x", "END:VCALENDAR"], cdata: true },
      ])
    );
    assert.equal(payloads[0], "BEGIN:VCALENDAR\r\nSUMMARY:A & B <c>\r\nEND:VCALENDAR");
    assert.equal(payloads[1], "BEGIN:VCALENDAR\r\nSUMMARY:x\r\nEND:VCALENDAR");
  });
});

describe("ical expansion", () => {
  const course = COURSE_ICS.join("\r\n");
  const between = (ics: string, from: string, to: string, zone = PARIS) =>
    ical.occurrencesInRange(ics, at(from), at(to), zone).map((o) => `${o.summary}@${ical.formatInZone(o.startMs, zone)}`);

  it("keeps 09:00 Paris across the end of summer time", () => {
    assert.deepEqual(between(course, "2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z"), [
      "R3-8 PROBA, statistiques@2026-11-02T09:00+01:00",
    ]);
  });

  it("honours EXDATE, RECURRENCE-ID moves and UNTIL", () => {
    assert.deepEqual(between(course, "2026-09-27T22:00:00Z", "2026-09-28T22:00:00Z"), []);
    assert.deepEqual(between(course, "2026-10-11T22:00:00Z", "2026-10-13T22:00:00Z"), ["R3-8 PROBA (déplacé)@2026-10-13T14:00+02:00"]);
    assert.deepEqual(between(course, "2026-12-14T00:00:00Z", "2026-12-15T00:00:00Z"), ["R3-8 PROBA, statistiques@2026-12-14T09:00+01:00"]);
    assert.deepEqual(between(course, "2026-12-20T00:00:00Z", "2026-12-23T00:00:00Z"), []);
  });

  it("stops a COUNT series", () => {
    const ics = FINISHED_SERIES_ICS.join("\r\n");
    assert.deepEqual(between(ics, "2026-09-01T00:00:00Z", "2026-10-31T00:00:00Z"), [
      "Ancien TD@2026-09-07T14:00+02:00",
      "Ancien TD@2026-09-14T14:00+02:00",
    ]);
  });

  it("expands monthly last-Friday and yearly all-day rules", () => {
    const monthly = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:m1",
      "DTSTART;TZID=Europe/Paris:20260130T180000",
      "DURATION:PT1H",
      "RRULE:FREQ=MONTHLY;BYDAY=-1FR",
      "SUMMARY:Afterwork",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:y1",
      "DTSTART;VALUE=DATE:19990605",
      "RRULE:FREQ=YEARLY",
      "SUMMARY:Anniversaire",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    assert.deepEqual(between(monthly, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"), ["Afterwork@2026-10-30T18:00+01:00"]);
    assert.deepEqual(between(monthly, "2027-06-04T12:00:00Z", "2027-06-06T00:00:00Z"), ["Anniversaire@2027-06-05T00:00+02:00"]);
  });

  it("resolves Windows and prefixed TZIDs", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:w1",
      "DTSTART;TZID=Romance Standard Time:20261005T090000",
      "DTEND;TZID=Romance Standard Time:20261005T100000",
      "SUMMARY:Outlook",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:w2",
      "DTSTART;TZID=/freeassociation.sourceforge.net/Tzfile/Europe/Paris:20261005T110000",
      "SUMMARY:Mozilla",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    assert.deepEqual(between(ics, "2026-10-04T22:00:00Z", "2026-10-05T22:00:00Z"), [
      "Outlook@2026-10-05T09:00+02:00",
      "Mozilla@2026-10-05T11:00+02:00",
    ]);
  });
});

describe("dates the model passes", () => {
  it("reads a whole-UTC-day window as the user's day", () => {
    const w = ical.resolveWindow("2026-10-05T00:00:00Z", "2026-10-05T23:59:59Z", PARIS, 0, 14);
    assert.deepEqual([new Date(w.fromMs).toISOString(), new Date(w.toMs).toISOString(), w.reinterpreted], [
      "2026-10-04T22:00:00.000Z",
      "2026-10-05T22:00:00.000Z",
      true,
    ]);
    const span = ical.resolveWindow("2026-10-05T00:00:00Z", "2026-10-07T00:00:00Z", PARIS, 0, 14);
    assert.equal(new Date(span.toMs).toISOString(), "2026-10-06T22:00:00.000Z");
  });

  it("reads bare dates and local times on the user's clock, explicit instants as given", () => {
    assert.equal(new Date(ical.parseUserInstant("2026-10-05", PARIS, "start")!).toISOString(), "2026-10-04T22:00:00.000Z");
    assert.equal(new Date(ical.parseUserInstant("2026-10-05", PARIS, "end")!).toISOString(), "2026-10-05T22:00:00.000Z");
    assert.equal(new Date(ical.parseUserInstant("2026-10-05T09:00", PARIS, "start")!).toISOString(), "2026-10-05T07:00:00.000Z");
    assert.equal(new Date(ical.parseUserInstant("2026-10-05T09:00:00+02:00", "UTC", "start")!).toISOString(), "2026-10-05T07:00:00.000Z");
    const exact = ical.resolveWindow("2026-10-05T08:00:00Z", "2026-10-05T12:00:00Z", PARIS, 0, 14);
    assert.equal(exact.reinterpreted, false);
    assert.equal(new Date(exact.fromMs).toISOString(), "2026-10-05T08:00:00.000Z");
  });
});

describe("Apple Mail mailbox names", () => {
  const boxes = [
    { path: "INBOX", name: "INBOX" },
    { path: "Sent Messages", name: "Sent Messages", specialUse: "\\Sent" },
    { path: "Archive", name: "Archive", specialUse: "\\Archive" },
    { path: "Deleted Messages", name: "Deleted Messages", specialUse: "\\Trash" },
    { path: "Junk", name: "Junk", specialUse: "\\Junk" },
    { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
    { path: "Projets/Alevr", name: "Alevr" },
  ];

  it("maps the names a model uses onto iCloud's paths", () => {
    assert.equal(mail.resolveMailboxPath(boxes, "inbox"), "INBOX");
    assert.equal(mail.resolveMailboxPath(boxes, "Sent"), "Sent Messages");
    assert.equal(mail.resolveMailboxPath(boxes, "trash"), "Deleted Messages");
    assert.equal(mail.resolveMailboxPath(boxes, "alevr"), "Projets/Alevr");
    assert.equal(mail.resolveMailboxPath(boxes, "Nope"), null);
  });

  it('"all" searches everything but trash, junk and drafts', () => {
    assert.deepEqual(mail.searchableMailboxes(boxes), ["INBOX", "Sent Messages", "Archive", "Projets/Alevr"]);
  });
});
