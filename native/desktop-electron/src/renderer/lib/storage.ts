/**
 * Window-local persistence for layout and appearance preferences.
 *
 * Deliberately *not* Zod, even though the renderer could import it: everything
 * validated here is written by this same module, and pulling a validator into
 * the renderer bundle to read two integers and an enum would be the only reason
 * Zod appears in the renderer graph at all (the shared contract is imported
 * type-only, so today it does not). The parsers below are hand-written, total,
 * and return `null` on anything unexpected.
 *
 * `localStorage` throws rather than returning null in a surprising number of
 * situations — a partition with storage disabled, quota exhaustion on write,
 * a private-mode-like session. None of them should cost the user their window.
 */

export const STORAGE_KEYS = {
  /** Sidebar/inspector geometry and the active product mode. */
  shell: 'juno.shell.v2',
  /** Last known theme, replayed before first paint to avoid a light flash. */
  appearance: 'juno.appearance.v1',
} as const;

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Persistence is a convenience. Losing it must not surface as an error. */
  }
}

/** Parse stored JSON into an unknown, never throwing. */
export function readStoredJson(key: string): unknown {
  const raw = readStored(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  try {
    writeStored(key, JSON.stringify(value));
  } catch {
    /* A value that cannot be serialised is a programming error, not a user
       error; dropping it keeps the render path clean and the next write will
       overwrite it. */
  }
}

/* -------------------------------------------------------------------------- */
/* Total parsers                                                               */
/* -------------------------------------------------------------------------- */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Clamps as well as validates: a stored width from an older build may be out of range. */
export function asNumberInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function asMember<T extends string>(value: unknown, members: readonly T[], fallback: T): T {
  return typeof value === 'string' && (members as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
