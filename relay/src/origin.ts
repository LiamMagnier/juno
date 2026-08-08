/**
 * Browser-origin policy for the voice relay.
 *
 * Native clients do not send an Origin header, so a missing value remains
 * allowed. A browser origin is allowed only when the operator explicitly
 * lists it; an empty list therefore fails closed for browser connections.
 */
export function parseAllowedOrigins(value: string | undefined): string[] {
  return [...new Set((value ?? "")
    .split(",")
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter(Boolean))];
}

export function isAllowedRelayOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return true;
  return allowedOrigins.includes(normalizeOrigin(origin));
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}
