/**
 * How a price is shown to a person. One module, so no surface can drift back
 * to printing the HT figure.
 *
 * The plans are sold HT (PLANS[plan].price) and Stripe Tax adds the buyer's
 * VAT at checkout. A consumer, though, must be shown the price they will pay,
 * tax included (Directive 98/6/EC; Code de la consommation art. L112-1). So the
 * figure on screen is HT × (1 + the French rate), labelled "incl. VAT". A buyer
 * in another EU country pays their own country's rate (OSS) and a business with
 * a valid VAT number pays HT (reverse charge) — checkout states the exact
 * amount before anyone pays, and the pricing page says so in one line
 * (VAT_NOTE).
 */

/** The French standard rate. Overridable for a deployment that sells elsewhere. */
export const DISPLAY_VAT_RATE = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_DISPLAY_VAT_RATE);
  return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.2;
})();

/** Annual billing charges ten months for twelve: two months free. */
export const ANNUAL_MONTHS_BILLED = 10;

/** HT → TTC at the display rate, to the cent. */
export function withVat(htEur: number): number {
  return Math.round(htEur * (1 + DISPLAY_VAT_RATE) * 100) / 100;
}

/** "24 €" / "10,80 €" in French, "€24" / "€10.80" otherwise. Whole euros drop the cents. */
export function formatEur(amount: number, locale = "en"): string {
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale.startsWith("fr") ? "fr-FR" : locale.startsWith("de") ? "de-DE" : "en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export interface DisplayPrice {
  /** Tax-included amount per month, in EUR. */
  monthlyTtc: number;
  /** The same, formatted. */
  monthly: string;
  /** Tax-included amount per year on annual billing. */
  yearlyTtc: number;
  yearly: string;
  /** What a year costs per month on annual billing, formatted. */
  yearlyPerMonth: string;
  /** The HT amount, for a business reader. */
  monthlyHt: string;
}

export function displayPrice(htEurPerMonth: number, locale = "en"): DisplayPrice {
  const monthlyTtc = withVat(htEurPerMonth);
  const yearlyTtc = withVat(htEurPerMonth * ANNUAL_MONTHS_BILLED);
  return {
    monthlyTtc,
    monthly: formatEur(monthlyTtc, locale),
    yearlyTtc,
    yearly: formatEur(yearlyTtc, locale),
    yearlyPerMonth: formatEur(Math.round((yearlyTtc / 12) * 100) / 100, locale),
    monthlyHt: formatEur(htEurPerMonth, locale),
  };
}

/** The suffix after a monthly price. */
export function perMonthSuffix(locale = "en"): string {
  return locale.startsWith("fr") ? "TTC/mois" : locale.startsWith("de") ? "inkl. MwSt./Monat" : "/mo incl. VAT";
}

/** The one line under a price list. */
export function vatNote(locale = "en"): string {
  if (locale.startsWith("fr")) {
    return "Prix TTC, TVA française de 20 % incluse. Le montant exact selon votre pays est affiché avant le paiement ; les entreprises de l'UE avec un numéro de TVA paient HT (autoliquidation).";
  }
  if (locale.startsWith("de")) {
    return "Preise inkl. 20 % französischer MwSt. Der genaue Betrag für Ihr Land wird vor der Zahlung angezeigt; Unternehmen in der EU mit USt-IdNr. zahlen netto (Reverse Charge).";
  }
  return "Prices include 20% French VAT. Checkout shows the exact amount for your country before you pay; EU businesses with a VAT number pay excl. VAT (reverse charge).";
}
