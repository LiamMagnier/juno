/*
 * The text the Apple connector tools hand back to the model. Pure (types only
 * from the server modules) so tests can pin it: an empty answer must say what
 * was searched, in which zone, and what could not be read, or the model tells
 * the person their day is free.
 */
import type { CalendarOccurrence, EventSearch } from "@/lib/apple/caldav";
import { formatDateInZone, formatInZone, zoneLabel, type Zone } from "@/lib/apple/ical";

/** Who is asking, as far as the tools need: the user's zone, when the caller sent it. */
export interface CallContext {
  zone: Zone;
  /** False when no valid zone arrived and UTC stands in. */
  zoneKnown: boolean;
}

function describeWhen(o: CalendarOccurrence, zone: Zone): string {
  if (o.allDay) {
    const first = formatDateInZone(o.startMs, zone);
    const last = formatDateInZone(o.endMs - 1, zone);
    return first === last ? `${first} (all day)` : `${first} → ${last} (all day)`;
  }
  const start = formatInZone(o.startMs, zone);
  if (o.endMs <= o.startMs) return start;
  const end = formatInZone(o.endMs, zone);
  // Same day: show the end as a clock time only.
  return end.slice(0, 10) === start.slice(0, 10) ? `${start} → ${end.slice(11, 16)}` : `${start} → ${end}`;
}

function formatOccurrence(o: CalendarOccurrence, zone: Zone): string {
  const extras = [o.location, o.recurring ? "recurring" : undefined, o.status === "TENTATIVE" ? "tentative" : undefined]
    .filter(Boolean)
    .join(" · ");
  return `• ${o.summary} — ${describeWhen(o, zone)}${extras ? ` (${extras})` : ""} · calendar: ${o.calendar} · uid: ${o.uid}`;
}

function quoteList(names: string[]): string {
  return names.map((n) => `“${n}”`).join(", ");
}

/** What list_events reads back. */
export function renderEventSearch(
  result: EventSearch,
  window: { fromMs: number; toMs: number },
  ctx: CallContext,
  limit: number
): string {
  const span = `from ${formatInZone(window.fromMs, ctx.zone)} to ${formatInZone(window.toMs, ctx.zone)} (${zoneLabel(ctx.zone)}${
    ctx.zoneKnown ? "" : " — the user's time zone was not provided"
  })`;
  const notes: string[] = [];
  if (result.failed.length > 0) {
    notes.push(
      `Could not read ${result.failed.length === 1 ? "this calendar" : "these calendars"}: ${result.failed
        .map((f) => `“${f.name}” (${f.reason})`)
        .join(", ")} — do not assume ${result.failed.length === 1 ? "it is" : "they are"} empty.`
    );
  }
  const scope =
    result.searched.length > 0
      ? `the ${result.searched.length} calendar${result.searched.length === 1 ? "" : "s"} searched: ${quoteList(result.searched)}`
      : "no readable calendars";
  if (result.occurrences.length === 0) {
    return [
      `No events ${span} in ${scope}.`,
      ...notes,
      "Only iCloud calendars are visible to this connector; calendars stored “On My Mac” or in other accounts (Google, Exchange, a school account) are not.",
    ].join("\n");
  }
  const shown = result.occurrences.slice(0, limit);
  const more = result.occurrences.length - shown.length;
  return [
    `${result.occurrences.length} event${result.occurrences.length === 1 ? "" : "s"} ${span}, from ${scope}:`,
    ...shown.map((o) => formatOccurrence(o, ctx.zone)),
    ...(more > 0 ? [`…and ${more} more not shown. Narrow the range or raise the limit to see them.`] : []),
    ...notes,
  ].join("\n");
}

