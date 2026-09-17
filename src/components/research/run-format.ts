/**
 * How a research run's numbers are said, everywhere they are said.
 *
 * The console, the recap, the plan gate and the report reader all describe the
 * same row, and each had started growing its own dollar formatter. Two surfaces
 * disagreeing about what a run cost is not a style drift — it changes what the
 * user believes happened to their money.
 *
 * `runBadge` — the state as a dot-and-word chip — lived here too, for the
 * standalone /research library. That page has been a redirect into chat since
 * research moved into the composer, and the chip's one consumer went with it.
 */

/** Micro-USD as display dollars. `<$0.01` rather than `$0.00` for a nonzero spend — a run that cost something must never claim it was free. */
export function formatMicroUsd(microUsd: string): string {
  const usd = Number(microUsd) / 1_000_000;
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/**
 * Wall-clock span of a FINISHED run, or null while it is still going. The
 * live figure is `workingElapsedMs` in run-clock.ts, which counts only the
 * time the run spent working; this is the receipt's number, first ask to last
 * word, and the two are different facts on purpose.
 */
export function runDuration(createdAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Whether a partially completed run stopped because the money ran out.
 *
 * BigInt, not Number: both columns are micro-USD BigInts serialised as strings,
 * and comparing them as floats would misreport the one case this check exists
 * for — a spend that landed exactly on the ceiling.
 */
export function budgetRanOut(costMicroUsd: string, budgetMicroUsd: string | null): boolean {
  if (budgetMicroUsd === null) return false;
  try {
    return BigInt(costMicroUsd) >= BigInt(budgetMicroUsd);
  } catch {
    return false;
  }
}
