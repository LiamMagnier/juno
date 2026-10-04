/**
 * Research spend and the usage windows (RESEARCH_V2 §6, owner 2026-10-04).
 *
 * Research used to be left out of the five-hour and weekly windows and sized
 * against its own capped share of the month, with a per-run ceiling per plan
 * (€2.50 on Pro). The owner's rule replaced that: "the only limit should be
 * your 5h window & weekly limit". So research spend now counts in the windows
 * like every other kind, a run is sized to what is left of them (and of the
 * month), and a run whose window runs out stops its rounds and writes with
 * what it has. The month still counts everything.
 *
 * The exclusion list stays, empty, so the one place a kind could be left out
 * of a window again is this file, and the test reads the same filter the
 * queries use. `spend.ts` is `server-only`; the rule lives here, pure.
 */

export const RESEARCH_SPEND_KIND = "research";

/** Ledger kinds the usage windows do not count. The month counts everything. */
export const WINDOW_EXCLUDED_SPEND_KINDS: readonly string[] = [];

export type SpendScope = "window" | "month";

/** The Prisma `where` fragment a sum over `scope` adds: nothing for the month, the excluded kinds (none today) for a window. */
export function spendKindFilter(scope: SpendScope): { kind?: { notIn: string[] } } {
  return scope === "window" && WINDOW_EXCLUDED_SPEND_KINDS.length > 0 ? { kind: { notIn: [...WINDOW_EXCLUDED_SPEND_KINDS] } } : {};
}

/** The same sum over in-memory rows, so the rule is testable without Postgres. */
export function sumSpendMicroUsd(
  rows: ReadonlyArray<{ kind: string; costMicroUsd: number; createdAt: Date }>,
  since: Date,
  scope: SpendScope
): number {
  return rows
    .filter((row) => row.createdAt >= since)
    .filter((row) => scope === "month" || !WINDOW_EXCLUDED_SPEND_KINDS.includes(row.kind))
    .reduce((total, row) => total + row.costMicroUsd, 0);
}
