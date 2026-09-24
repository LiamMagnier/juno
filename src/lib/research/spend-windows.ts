/**
 * Research spend and the usage windows (SPEC §9.2, DECISIONS §4c).
 *
 * The five-hour and weekly windows exist to pace chat. Research is sized
 * against the MONTH — its own capped share of it — and a run can spend
 * several euros in one go: summed into the windows like any other row, one
 * €16 run would fill the five-hour window and every chat turn after it would
 * be refused. So the window sums and the window reservations leave
 * `kind: "research"` out, and the monthly total keeps it: research still
 * spends the month, it just does not close the window a person chats in.
 *
 * `spend.ts` is `server-only`; the rule lives here, pure, so the test reads
 * the same filter the queries use.
 */

export const RESEARCH_SPEND_KIND = "research";

/** Ledger kinds the usage windows do not count. The month counts everything. */
export const WINDOW_EXCLUDED_SPEND_KINDS: readonly string[] = [RESEARCH_SPEND_KIND];

export type SpendScope = "window" | "month";

/** The Prisma `where` fragment a sum over `scope` adds: nothing for the month, research out for a window. */
export function spendKindFilter(scope: SpendScope): { kind?: { notIn: string[] } } {
  return scope === "window" ? { kind: { notIn: [...WINDOW_EXCLUDED_SPEND_KINDS] } } : {};
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
