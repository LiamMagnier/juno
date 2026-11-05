/**
 * Phone numbers for the iMessage channel.
 *
 * One canonical form, E.164 ("+14155550100"), because the number is looked up
 * by an HMAC of its text: "+1 (415) 555-0100" and "+14155550100" have to hash
 * the same or a linked person's texts would reach nobody. No country is ever
 * guessed for a number typed without one; a wrong guess would link somebody
 * else's phone.
 *
 * Pure, so the tests import it directly.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

/** The number in E.164, or null when it is not one (no country code, letters, too short or long). */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().replace(/[\s().\- ]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  return E164.test(value) ? value : null;
}

/** Whether a stored value decrypted to a real number, not a placeholder or a damaged row. */
export function isE164(value: unknown): value is string {
  return typeof value === "string" && E164.test(value);
}

/** The last four digits, for "Ending in 0100". Never the whole number in a response. */
export function phoneLastFour(phone: string): string {
  return isE164(phone) ? phone.slice(-4) : "";
}
