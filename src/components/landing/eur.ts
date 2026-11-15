/**
 * Euro formatting for the landing's per-reply prices.
 *
 * Plans are sold in EUR and the meter's budgets are EUR-defined
 * (src/lib/plans.ts), so the marketing surface prints euros: a USD list price
 * converted at the same `eurPerUsd()` the spend ledger uses.
 *
 * In the page's locale, the way the plan cards print theirs
 * (src/lib/price-display.ts): "€0.034" in English, "0,034 €" in French. This
 * used to print the French form on every page, so an English visitor read
 * "0,034 €" two sections above plans at "€10.80": one page, two formats.
 *
 * Three precisions, because a reply can cost a cent or a hundredth of one:
 * two decimals from 10c up, three from 1c, four below. The floor says "<"
 * rather than rounding a real cost to zero.
 */
export function formatEur(eur: number, locale = "en"): string {
  const at = locale.startsWith("fr") ? "fr-FR" : locale.startsWith("de") ? "de-DE" : "en-IE";
  const money = (amount: number, digits: number) =>
    new Intl.NumberFormat(at, { style: "currency", currency: "EUR", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  if (!Number.isFinite(eur) || eur <= 0) return money(0, 0);
  if (eur < 0.0001) return `<${money(0.0001, 4)}`;
  const digits = eur >= 0.1 ? 2 : eur >= 0.01 ? 3 : 4;
  return money(eur, digits);
}
