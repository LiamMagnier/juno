import type { ClientWorkRun } from "@/lib/work/serializers";

/**
 * How long an attempt ran, in milliseconds. Null when it never started, and null
 * while it is still going.
 *
 * Both ends come off the run row rather than from a clock, which is what makes
 * this safe to call during render: a duration measured against `Date.now()`
 * differs between the server's pass and the browser's and is exactly the
 * hydration mismatch this codebase warns about elsewhere. The ticking clock a
 * live run needs is `useElapsedMs`'s job in `work-detail-panels.tsx`, and it
 * runs in an effect for that reason.
 *
 * Null rather than zero on a half-open interval, because "0s" is a claim that
 * the attempt ran instantly and this function has no evidence for it. Every
 * caller omits the figure instead of printing it.
 *
 * Shared by the outcome digest and the attempt history because both are reading
 * the same fact off the same two columns, and a summary that disagreed with the
 * history row directly above it about how long the same run took would be the
 * kind of contradiction this whole surface is built to make impossible.
 */
export function attemptDurationMs(run: ClientWorkRun): number | null {
  if (run.startedAt === null || run.finishedAt === null) return null;
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
