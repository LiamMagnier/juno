/*
 * What `current_time` tells the model (SPEC §3.8.7). English, in a `*.prompt.ts`
 * file so the i18n extractor never harvests it (INV-29). Juno-authored, so it
 * carries no untrusted envelope.
 */

export function nowLine(iso: string, readable: string, zone: string): string {
  return `Now: ${iso} (${readable}, ${zone})`;
}

export function convertedLine(zone: string, iso: string, readable: string): string {
  return `In ${zone}: ${iso} (${readable})`;
}

export const UNKNOWN_ZONE_LINE = "The user's time zone is unknown; this is UTC.";

export function invalidZoneText(zone: string): string {
  return `"${zone}" is not an IANA time zone. Nothing was converted. Use a name such as "America/New_York" or "Asia/Tokyo".`;
}
