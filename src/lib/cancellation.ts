/**
 * Online cancellation (Code de la consommation L215-1-1, D215-1 to D215-3).
 *
 * The law asks for three things this module and /api/stripe/cancel carry:
 *
 *   1. A function labelled "résilier votre contrat" or an unambiguous
 *      equivalent, directly reachable from where people subscribe. That is
 *      the "Cancel subscription" control (src/components/settings/
 *      cancel-subscription.tsx), which the i18n catalogue renders in French.
 *   2. A recap the person can check before notifying (D215-3): who, which
 *      contract (reference), and when it ends — `cancellationRecap` below.
 *   3. A confirmation on a durable medium, in reasonable time, of receipt, the
 *      end date and the effects (L215-1-1 al. 3) — `cancellationEmail`.
 *
 * The end date is the end of the period already paid for, which the person
 * picks in the dialog: that is their request for the cancellation to take
 * effect more than ten days after notice, which L224-25-9 allows. A request to
 * end sooner, with a refund of the unused days, goes to support (CGV art. 9).
 *
 * Pure: no Prisma, no Stripe, so tests drive it directly.
 */

export interface CancellationRecap {
  /** The contract reference shown to the person and repeated in the email. */
  reference: string;
  name: string | null;
  email: string | null;
  planName: string;
  interval: "month" | "year" | null;
  /** When access to the paid plan ends, ISO. Null when Stripe has not told us yet. */
  endsAt: string | null;
}

/**
 * The reference a person can quote to support. The Stripe subscription id is
 * stable, unique and already printed on Stripe's invoices, so the person sees
 * the same string in both places.
 */
export function contractReference(stripeSubscriptionId: string): string {
  return stripeSubscriptionId;
}

/** "31 octobre 2026" in French, "31 October 2026" otherwise. */
export function formatEndDate(iso: string, locale: "fr" | "en"): string {
  return new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  }).format(new Date(iso));
}

export interface CancellationEmail {
  subject: string;
  /** Plain-text body, French first (the language of the contract), then English. */
  text: string;
  /** Paragraphs for the HTML layout, already plain text (the caller escapes). */
  paragraphs: string[];
}

/**
 * The confirmation of a cancellation notice. Bilingual: the contract is in
 * French and the interface may not be, and a durable record the person cannot
 * read is not much of a record.
 */
export function cancellationEmail(recap: CancellationRecap, productName: string): CancellationEmail {
  const frDate = recap.endsAt ? formatEndDate(recap.endsAt, "fr") : null;
  const enDate = recap.endsAt ? formatEndDate(recap.endsAt, "en") : null;
  const fr = [
    `Nous avons bien reçu, le ${formatEndDate(new Date().toISOString(), "fr")}, la notification de résiliation de votre abonnement ${productName} ${recap.planName} (référence ${recap.reference}).`,
    frDate
      ? `Votre abonnement prend fin le ${frDate}. Jusqu'à cette date, vous conservez l'accès à votre offre ; aucun nouveau paiement ne sera prélevé.`
      : "Votre abonnement prend fin au terme de la période de facturation en cours ; aucun nouveau paiement ne sera prélevé.",
    "Ensuite, votre compte passe à l'offre Free : vos conversations et vos fichiers sont conservés. Vous pouvez annuler cette résiliation avant sa date d'effet depuis Réglages → Plan & usage.",
    "Pour qu'elle prenne effet plus tôt, avec le remboursement des jours non utilisés, répondez à cet e-mail.",
  ];
  const en = [
    `We received your notice cancelling your ${productName} ${recap.planName} subscription (reference ${recap.reference}).`,
    enDate
      ? `It ends on ${enDate}. Until then you keep your plan, and you will not be charged again.`
      : "It ends at the end of the current billing period, and you will not be charged again.",
    "After that your account moves to Free; your conversations and files stay. You can undo this before it takes effect from Settings → Plan & usage.",
  ];
  return {
    subject: `Résiliation de votre abonnement ${productName} / Your ${productName} subscription is cancelled`,
    paragraphs: [...fr, "—", ...en],
    text: [...fr, "", "—", "", ...en].join("\n\n"),
  };
}
