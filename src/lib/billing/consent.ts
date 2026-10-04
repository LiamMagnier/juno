/**
 * The pre-contract consent a buyer ticks at Stripe Checkout, in one place so the
 * order-confirmation email (L221-13) repeats it word for word.
 *
 * A subscription and a usage credit are digital SERVICES, not digital content:
 * the consumer keeps the 14-day withdrawal right until the service is fully
 * performed (L221-28 1°) and, withdrawing earlier, owes the share already
 * provided (L221-25). Both texts say exactly that, in English and French.
 */

const TERMS_LABEL = "Terms of Sale";

const SUBSCRIPTION_TAIL =
  " and ask for my subscription to start now, before the 14-day withdrawal period ends. If I withdraw within it, I pay for the service provided until then; I acknowledge that I lose my right of withdrawal once the service has been fully provided. / J'accepte les CGV et demande que mon abonnement commence dès maintenant, avant la fin du délai de rétractation de 14 jours. Si je me rétracte pendant ce délai, je paie le service fourni jusque-là ; je reconnais perdre mon droit de rétractation une fois le service pleinement exécuté.";
const TOP_UP_TAIL =
  " and ask for this usage credit to be available now, before the 14-day withdrawal period ends. If I withdraw within it, I pay for the usage consumed until then; I acknowledge that I lose my right of withdrawal once the credit has been fully used. / J'accepte les CGV et demande que ce crédit d'usage soit disponible dès maintenant, avant la fin du délai de rétractation de 14 jours. Si je me rétracte pendant ce délai, je paie l'usage consommé jusque-là ; je reconnais perdre mon droit de rétractation une fois le crédit entièrement utilisé.";

function termsLink(appUrl: string): string {
  return `[${TERMS_LABEL}](${appUrl.replace(/\/$/, "")}/legal/cgv)`;
}

/** Checkout's markdown version (Stripe renders the link). */
export function subscriptionConsentMarkdown(appUrl: string): string {
  return `I accept the ${termsLink(appUrl)}${SUBSCRIPTION_TAIL}`;
}

export function topUpConsentMarkdown(appUrl: string): string {
  return `I accept the ${termsLink(appUrl)}${TOP_UP_TAIL}`;
}

/** The same sentence as plain text, for the confirmation email. */
export function consentPlainText(kind: "subscription" | "topup"): string {
  return `I accept the ${TERMS_LABEL}${kind === "subscription" ? SUBSCRIPTION_TAIL : TOP_UP_TAIL}`;
}
