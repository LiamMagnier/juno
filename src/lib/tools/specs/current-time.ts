/**
 * `current_time` (SPEC §3.8.7): the date, time, weekday and zone for the user,
 * and optionally the same instant somewhere else.
 *
 * A model's sense of "today" is its training cut-off, and every answer that
 * depends on a date — how long until, what day is, how old — is wrong by
 * exactly that gap unless it asks. This is the asking. Pure: no network, no
 * broker, allowed everywhere including private chats and lockdown.
 */

import { convertedLine, invalidZoneText, nowLine, UNKNOWN_ZONE_LINE } from "@/lib/tools/specs/current-time.prompt";
import { failed, oneLine, stringArg, succeeded } from "@/lib/tools/specs/shared";
import { defineTool, type ToolSpec } from "@/lib/tools/types";
import type { ToolPresentArgs } from "@/types/run";

export interface CurrentTimeArgs extends Record<string, unknown> {
  time_zone?: unknown;
}

/** True when `Intl` accepts the zone. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** `2026-09-23T19:07:00+02:00` and `Wednesday 23 September 2026, 19:07` for one instant in one zone. */
export function describeInstant(date: Date, zone: string): { iso: string; readable: string } {
  const numeric = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const y = part(numeric, "year");
  const mo = part(numeric, "month");
  const d = part(numeric, "day");
  const h = part(numeric, "hour");
  const mi = part(numeric, "minute");
  const s = part(numeric, "second");

  // The zone's offset at this instant, from the wall clock it shows.
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const offsetMinutes = Math.round((wall - Math.floor(date.getTime() / 1_000) * 1_000) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;

  const words = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const readable = `${part(words, "weekday")} ${part(words, "day")} ${part(words, "month")} ${part(words, "year")}, ${h}:${mi}`;
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`, readable };
}

export function createCurrentTimeSpec(deps: { now?: () => Date } = {}): ToolSpec<CurrentTimeArgs> {
  const now = deps.now ?? (() => new Date());
  return defineTool<CurrentTimeArgs>({
    id: "current_time",
    title: "Current time",
    description:
      "Returns the current date, time, weekday and time zone for the user, and optionally the same instant in another time zone. Use it whenever the answer depends on today's date or the time: \"how long until\", \"what day is\", deadlines, ages, schedules, or converting a time between zones. Do not guess the date from your training data. Give another zone as an IANA name such as \"America/New_York\" to convert. It returns ISO 8601 plus a readable form.",
    input: {
      type: "object",
      properties: {
        time_zone: { type: "string", description: "An IANA time zone to also report, e.g. Asia/Tokyo." },
      },
    },
    risk: "read",
    parallelSafe: true,
    timeoutMs: 1_000,
    icon: "clock",
    broker: "none",
    dedupe: false,
    present(args) {
      const out: ToolPresentArgs = {};
      const zone = stringArg(args.time_zone);
      if (zone) out.time_zone = oneLine(zone);
      return out;
    },
    async execute(args, ctx) {
      const other = stringArg(args.time_zone);
      if (other && !isTimeZone(other)) return failed("invalid_args", invalidZoneText(oneLine(other, 64)));

      const known = ctx.timeZone && isTimeZone(ctx.timeZone) ? ctx.timeZone : null;
      const zone = known ?? "UTC";
      const instant = now();
      const here = describeInstant(instant, zone);
      const lines = [nowLine(here.iso, here.readable, zone)];
      if (!known) lines.push(UNKNOWN_ZONE_LINE);
      if (other) {
        const there = describeInstant(instant, other);
        lines.push(convertedLine(other, there.iso, there.readable));
      }
      return succeeded(lines.join("\n"), { figure: { kind: "value", value: here.iso } });
    },
  });
}

export const currentTimeSpec = createCurrentTimeSpec();
