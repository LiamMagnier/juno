/**
 * Euro formatting for the landing's per-reply prices.
 *
 * The receipt used to print dollars while the plan cards two sections down
 * printed euros — one page, two currencies. Plans are sold in EUR and the
 * meter's budgets are EUR-defined (src/lib/plans.ts), so the marketing
 * surface follows: a USD list price converted at the same `eurPerUsd()` the
 * spend ledger uses, and printed the French way ("0,04 €"), which is how
 * every other euro amount in the product reads.
 *
 * Three precisions, because a reply can cost a cent or a hundredth of one:
 * two decimals from 10c up, three from 1c, four below. The floor says "<"
 * rather than rounding a real cost to zero.
 */
export function formatEur(eur: number): string {
  if (!Number.isFinite(eur) || eur <= 0) return "0 €";
  if (eur < 0.0001) return "<0,0001 €";
  const digits = eur >= 0.1 ? 2 : eur >= 0.01 ? 3 : 4;
  return `${eur.toFixed(digits).replace(".", ",")} €`;
}
