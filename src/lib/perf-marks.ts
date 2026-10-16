/**
 * The latency marks the wave 2 budgets are measured on (spec §9). Each one is
 * a `performance.mark("alevr:<name>")`; P0's harness (e2e/support/perf-marks.ts)
 * reads them back, takes the gap between a pair and gates its p95.
 *
 *   enter → bubble-painted        Enter to the user bubble on screen (≤ 100ms)
 *   enter → status-visible        Enter to TurnStatus readable (≤ 300ms)
 *   palette-open → palette-painted   ⌘K to rows painted (≤ 1 frame warm)
 *   route-click → shell-visible   a route click to the new shell (≤ 100ms)
 *
 * The names are a closed union, so a typo is a type error rather than a
 * budget that silently never measures. Every helper is a no-op where the
 * User Timing API is missing (the server, an old browser) and never throws:
 * a mark is instrumentation, and instrumentation must not break the action
 * it measures.
 */

export const PERF_MARK_PREFIX = "alevr:";

export const PERF_MARKS = [
  "enter",
  "bubble-painted",
  "status-visible",
  "palette-open",
  "palette-painted",
  "route-click",
  "shell-visible",
  "layout-settled",
] as const;

export type PerfMarkName = (typeof PERF_MARKS)[number];

/** The full mark name as it appears in the performance timeline. */
export function perfMarkName(name: PerfMarkName): `alevr:${PerfMarkName}` {
  return `${PERF_MARK_PREFIX}${name}` as `alevr:${PerfMarkName}`;
}

function perf(): Performance | null {
  return typeof performance !== "undefined" && typeof performance.mark === "function" ? performance : null;
}

/** Records `alevr:<name>` now. Returns the mark's start time, or null where marks are unavailable. */
export function perfMark(name: PerfMarkName, detail?: Record<string, unknown>): number | null {
  const p = perf();
  if (!p) return null;
  try {
    const entry = p.mark(perfMarkName(name), detail ? { detail } : undefined);
    return entry?.startTime ?? p.now();
  } catch {
    return null;
  }
}

/**
 * Records `alevr:<name>` on the next painted frame: two animation frames
 * after the call, which is when a change committed now has reached the
 * screen. Falls back to a plain mark where rAF is missing (a hidden tab
 * still pauses rAF, which is correct: nothing was painted).
 */
export function perfMarkAfterPaint(name: PerfMarkName, detail?: Record<string, unknown>): void {
  if (typeof requestAnimationFrame !== "function") {
    perfMark(name, detail);
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => perfMark(name, detail)));
}

/** The time from the last `from` mark to the last `to` mark after it, in ms; null if either is missing. */
export function perfMeasure(from: PerfMarkName, to: PerfMarkName): number | null {
  const p = perf();
  if (!p || typeof p.getEntriesByName !== "function") return null;
  const starts = p.getEntriesByName(perfMarkName(from), "mark");
  const ends = p.getEntriesByName(perfMarkName(to), "mark");
  const start = starts[starts.length - 1];
  if (!start) return null;
  const end = ends.filter((e) => e.startTime >= start.startTime).pop();
  return end ? end.startTime - start.startTime : null;
}

/** Typed shorthands for the call sites (P4, P5 and the view transition). */
export const markEnter = () => perfMark("enter");
export const markBubblePainted = () => perfMarkAfterPaint("bubble-painted");
export const markStatusVisible = () => perfMarkAfterPaint("status-visible");
export const markPaletteOpen = () => perfMark("palette-open");
export const markPalettePainted = () => perfMarkAfterPaint("palette-painted");
export const markRouteClick = (href?: string) => perfMark("route-click", href ? { href } : undefined);
export const markShellVisible = (pathname?: string) => perfMarkAfterPaint("shell-visible", pathname ? { pathname } : undefined);
