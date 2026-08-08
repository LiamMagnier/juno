/**
 * One voice call may switch providers, so its safety ceiling must belong to
 * the relay session rather than to an individual provider connection.
 */
export const DEFAULT_RELAY_SESSION_LIMIT_SEC = 60 * 60;
const MAX_RELAY_SESSION_LIMIT_SEC = 24 * 60 * 60;

export function configuredRelaySessionLimitSec(raw = process.env.RELAY_MAX_SESSION_SEC): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RELAY_SESSION_LIMIT_SEC;
  return Math.min(Math.floor(parsed), MAX_RELAY_SESSION_LIMIT_SEC);
}

export function effectiveRelaySessionLimitSec(providerLimitSec: number, raw = process.env.RELAY_MAX_SESSION_SEC): number {
  return Math.min(providerLimitSec, configuredRelaySessionLimitSec(raw));
}
